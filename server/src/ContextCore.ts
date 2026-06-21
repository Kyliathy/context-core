/**
 * ContextCore – entry point.
 * Runs full ingestion pipeline and starts the API server.
 *
 * Architecture: server/zz-reach2/architecture/archi-context-core-level0.md
 * Logging: server/zz-reach2/upgrades/2026-06/r2wl-winston-logging.md
 *
 * API Endpoints Definition: ../interop/insomnia-context-core.json
 */

import { getHostname } from "./config.js";
import { getLogger, serializeError } from "./logging/logger.js";
import { existsSync, writeFileSync, unlinkSync } from "fs";
import { resolve } from "path";
import type { Server } from "http";
import { createMessageStore, type IMessageStore } from "./db/IMessageStore.js";
import { startServer } from "./server/ContextServer.js";
import { CCSettings } from "./settings/CCSettings.js";
import { GlobalSettingsStore } from "./settings/GlobalSettingsStore.js";
import { StorageWriter } from "./storage/StorageWriter.js";
import { getHarnessNames } from "./types.js";
import { isQdrantEnabled, isQdrantUpdateSkipped, isQdrantUsageDisabled, getVectorConfig } from "./vector/VectorConfig.js";
import { EmbeddingService } from "./vector/EmbeddingService.js";
import { QdrantService } from "./vector/QdrantService.js";
import { SummaryEmbeddingCache } from "./vector/SummaryEmbeddingCache.js";
import { VectorPipeline } from "./vector/VectorPipeline.js";
import { TopicStore } from "./settings/TopicStore.js";
import { ScopeStore } from "./settings/ScopeStore.js";
import { FavoriteStore } from "./settings/FavoriteStore.js";
import { TopicSummarizer } from "./analysis/TopicSummarizer.js";
import { MCPServer } from "./mcp/MCPServer.js";
import { mountMcpSse } from "./mcp/transports/sse.js";
import { FileWatcher } from "./watcher/FileWatcher.js";
import { IncrementalPipeline } from "./watcher/IncrementalPipeline.js";
import { AgentBuilder } from "./agentBuilder/AgentBuilder.js";
import { AgentPublisher } from "./agentPublisher/AgentPublisher.js";
import { CanonicalAgentStore } from "./agentPublisher/CanonicalAgentStore.js";
import { collectDbFingerprint, validateDbFingerprint } from "./ingest/DbFingerprint.js";
import { StartupIngestCoordinator } from "./ingest/StartupIngestCoordinator.js";

const logger = getLogger("ContextCore");
const startupDbLoadLogger = getLogger("startup-db-load");
const startupIngestPlanLogger = getLogger("startup-ingest-plan");
const messageDbLogger = getLogger("MessageDB");
const topicLogger = getLogger("analysis:TopicSummarizer");
const vectorLogger = getLogger("vector:VectorPipeline");
const agentBuilderLogger = getLogger("agentBuilder:AgentBuilder");

/** Active HTTP server handle for lifecycle hooks and cleanup wiring. */
let activeServer: Server | null = null;
/** Keep-alive timer used to prevent early process exit on this runtime. */
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Executes the full pipeline from harness read through API start.
 *
 * Pipeline stages:
 * 1) Resolve machine-specific configuration.
 * 2) Read and normalize harness chats.
 * 3) Group messages by session and persist to storage.
 * 4) Load persisted storage into in-memory SQLite.
 * 5) Start the API server.
 */
async function main(): Promise<void>
{
	// Capture startup duration for coarse performance visibility in logs.
	const startMs = Date.now();
	const hostname = getHostname();

	// Check for cc.json before attempting to load it — a missing config file is
	// the most common first-run error and deserves a clear, actionable message.
	const ccJsonPath = resolve(process.cwd(), "cc.json");
	if (!existsSync(ccJsonPath))
	{
		//Intentional console exception: first-run guidance is user-facing CLI output, not runtime diagnostics.
		console.error(`\ncc.json not found at: ${ccJsonPath}`);
		console.error(`\nRun the interactive setup wizard to generate it:\n`);
		console.error(`  bun run setup\n`);
		console.error(`This will scan your machine for IDE chat data and create a ready-to-use config.\n`);
		process.exit(1);
	}

	const settings = CCSettings.getInstance();
	const machine = settings.getMachineConfig(hostname);
	const storageWriter = new StorageWriter(settings.storage);

	logger.info(`ContextCore – hostname: ${hostname}`);
	logger.info(`Storage root: ${settings.storage}`);

	if (!machine)
	{
		//Missing machine config is a valid state during setup; exit gracefully with guidance.
		logger.warn(`No config for hostname "${hostname}". No matching machine entry in cc.json.`);
		logger.warn(`Run "bun run setup" to add a config for this machine, or add one manually.`);
		return;
	}

	logger.info(`Selected machine config: ${machine.machine}`);

	const globalSettingsStore = new GlobalSettingsStore(settings.storage, machine.machine);
	globalSettingsStore.load();

	const messageDB: IMessageStore = await createMessageStore(settings);
	logger.info(`Database mode: ${settings.IN_MEMORY_DB ? "in-memory" : `disk (${settings.databaseFile})`}`);
	//Load the persisted corpus into the query database.
	const loadedCount = messageDB.loadFromStorage(settings.storage);
	const initialFingerprint = collectDbFingerprint(settings.databaseFile, messageDB);
	startupDbLoadLogger.info(
		`loadedFromStorage=${loadedCount}, dbMessages=${initialFingerprint.messageCount}, ` +
		`sessions=${initialFingerprint.sessionCount}, dbFileBytes=${initialFingerprint.fileSizeBytes}`
	);
	const storedFingerprint = globalSettingsStore.getDbFingerprint();
	const fingerprintValidation = validateDbFingerprint(storedFingerprint, initialFingerprint);
	const dbFingerprintValid = !!storedFingerprint && fingerprintValidation.ok;
	const dbFingerprintFailed = !!storedFingerprint && !fingerprintValidation.ok;
	// Business logic: a stored active-machine fingerprint that no longer matches
	// means only this machine's local DB-dependent ingest decisions are unsafe.
	if (storedFingerprint && !fingerprintValidation.ok)
	{
		startupDbLoadLogger.warn(
			`DB fingerprint invalid: ${fingerprintValidation.reason}. ` +
			"Resetting ingest bookmarks; next startup ingest will be recovery full."
		);
		globalSettingsStore.resetAllIngestBookmarks();
	}
	let recoveryRequired = dbFingerprintFailed;
	let previousRunInProgress = globalSettingsStore.isRunInProgress();
	if (previousRunInProgress)
	{
		if (dbFingerprintValid)
		{
			//Bookmarks commit only after each harness stage succeeds, so a kill mid-pipeline
			//usually leaves bookmarks consistent with the loaded DB — no need for recovery-full.
			startupIngestPlanLogger.warn(
				"Previous startup ingest did not call endIngestRun() (process likely killed mid-pipeline). " +
				"DB fingerprint matches stored state; trusting existing harness bookmarks."
			);
			globalSettingsStore.clearStaleIngestRun();
			previousRunInProgress = false;
		}
		else
		{
			startupIngestPlanLogger.warn("Previous ingest run did not complete. Startup will use conservative compatibility reads.");
			recoveryRequired = true;
		}
	}

	let startupIngestSucceeded = false;
	let ingestPipelineActive = true;

	/**
	 * Handles finalizeIngestRun behavior for this CXC module.
	 * @param success - Value consumed by finalizeIngestRun.
	 */
	const finalizeIngestRun = (success: boolean): void =>
	{
		if (!ingestPipelineActive)
		{
			return;
		}
		ingestPipelineActive = false;
		const finalFingerprint = collectDbFingerprint(settings.databaseFile, messageDB);
		globalSettingsStore.endIngestRun(success, finalFingerprint);
	};

	/**
	 * Handles abortIngestOnSignal behavior for this CXC module.
	 * @param signal - Value consumed by abortIngestOnSignal.
	 */
	const abortIngestOnSignal = (signal: NodeJS.Signals): void =>
	{
		if (!ingestPipelineActive)
		{
			return;
		}
		startupIngestPlanLogger.warn(`Received ${signal} during startup ingest; clearing runInProgress flag.`);
		finalizeIngestRun(false);
		process.exit(signal === "SIGTERM" ? 0 : 130);
	};
	process.once("SIGINT", abortIngestOnSignal);
	process.once("SIGTERM", abortIngestOnSignal);

	globalSettingsStore.beginIngestRun();
	try
	{
		const startupIngest = new StartupIngestCoordinator(
			messageDB,
			storageWriter,
			settings.storage,
			machine,
			globalSettingsStore,
			recoveryRequired,
			dbFingerprintValid
		);
		startupIngest.run();
		startupIngestSucceeded = true;
	}
	finally
	{
		finalizeIngestRun(startupIngestSucceeded);
	}

	// Load persisted AI topic summaries (isolated from AgentMessage storage)
	const topicStore = new TopicStore(settings.storage);
	topicStore.load();
	topicLogger.info(`Loaded ${topicStore.count} topic entries from topics.json`);

	const scopeStore = new ScopeStore(settings.storage);
	scopeStore.load();
	logger.info(`Loaded ${scopeStore.list().length} scope entries from scopes.json`);

	const favoriteStore = new FavoriteStore(settings.storage);
	favoriteStore.load();
	logger.info(
		`Loaded ${favoriteStore.list().length} favorite rows and ${favoriteStore.listFavoriteViews().length} favorite view snapshots from favorites.json`,
	);

	//Log breakdown by harness for startup diagnostics visible in the MessageDB namespace.
	const harnessCounts = messageDB.getHarnessCounts();
	messageDbLogger.info(
		`Breakdown by harness: ${harnessCounts.map((h) => `${h.harness}=${h.count}`).join(", ")}`
	);

	//Log date ranges per harness so operators can spot stale or empty sources at startup.
	const harnessDateRanges = messageDB.getHarnessDateRanges();
	messageDbLogger.info(`Date ranges per harness (newest first):`);
	// Business logic: this iteration walks every relevant item so ContextCore runtime behavior reflects the complete source set instead of a partial snapshot.

	for (const range of harnessDateRanges)
	{
		messageDbLogger.info(`  ${range.harness}: ${range.earliest} → ${range.latest} (${range.count} messages)`);
	}

	// === AI Topic Summarization ===
	// Runs BEFORE vector initialization so freshly generated summaries are available
	// for both the summary embedding cache and Qdrant payload enrichment (R2BQ — T23/T24).
	// Dependency chain: TopicSummarizer → SummaryEmbeddingCache → VectorPipeline.
	let topicSummarizer: TopicSummarizer | undefined;
	const skipSummarization = (process.env.SKIP_AI_SUMMARIZATION ?? "true").trim().toLowerCase() !== "false";
	if (skipSummarization)
	{
		topicLogger.info("AI summarization skipped (set SKIP_AI_SUMMARIZATION=false to enable).");
	} else
	{
		const pass1Model = (process.env.AI_SUMMARIZATION_MODEL_PASS_1 ?? "gpt-5-nano").trim();
		try
		{
			topicSummarizer = new TopicSummarizer(topicStore, messageDB, undefined, pass1Model);
			await topicSummarizer.runPipeline();
		} catch (error)
		{
			topicLogger.warn(`Summarization pipeline failed: ${(error as Error).message}`);
			topicLogger.warn("Continuing without topic summaries...");
			topicSummarizer = undefined;
		}

		//Pass 2: re-summarize entries whose aiSummary exceeds 1500 chars using a smarter model.
		const skipPass2 = (process.env.SKIP_AI_SUMMARIZATION_PASS_2 ?? "false").trim().toLowerCase() === "true";
		if (skipPass2)
		{
			topicLogger.info("Pass 2 skipped (set SKIP_AI_SUMMARIZATION_PASS_2=false to enable).");
		} else
		{
			const pass2Model = (process.env.AI_SUMMARIZATION_MODEL_PASS_2 ?? "gpt-5-mini").trim();
			try
			{
				const pass2Summarizer = new TopicSummarizer(topicStore, messageDB, undefined, pass2Model);
				await pass2Summarizer.runPass2(1500);
			} catch (error)
			{
				topicLogger.warn(`Pass 2 re-summarization pipeline failed: ${(error as Error).message}`);
				topicLogger.warn("Continuing without pass 2 summaries...");
			}
		}
	}

	// === Vector Search Initialization ===
	// Runs AFTER summarization so the summary embedding cache picks up freshly generated aiSummary entries.
	let embeddingService: EmbeddingService | undefined;
	let qdrantService: QdrantService | undefined;
	// Kept in outer scope so FileWatcher's IncrementalPipeline can use it for live updates.
	let vectorPipeline: VectorPipeline | undefined;
	let summaryEmbeddingCache: SummaryEmbeddingCache | undefined;
	const skipStartupQdrantUpdate = isQdrantUpdateSkipped();

	if (isQdrantUsageDisabled())
	{
		vectorLogger.info("Qdrant usage disabled (DO_NOT_USE_QDRANT=true).");
	} else if (isQdrantEnabled())
	{
		const vectorConfig = getVectorConfig();
		const vectorStartMs = Date.now();

		try
		{
			vectorLogger.info("Qdrant enabled, initializing vector services...");

			// Initialize services
			embeddingService = new EmbeddingService(vectorConfig.openaiApiKey!);
			qdrantService = new QdrantService(
				vectorConfig.qdrantUrl!,
				vectorConfig.qdrantApiKey,
				hostname
			);

			// Health check: probe first harness collection
			const firstHarness = getHarnessNames(machine.harnesses)[0];
			if (firstHarness)
			{
				const info = await qdrantService.getCollectionInfo(firstHarness);
				// Business logic: collection details are meaningful only when Qdrant returned
				// a response and that response confirms the active harness collection exists.
				if (info && info.exists)
				{
					vectorLogger.info(
						`Qdrant connected. Collection "${qdrantService.getCollectionName(firstHarness)}" has ${info.pointsCount} points.`
					);
				} else
				{
					vectorLogger.info(
						`Qdrant connected. Collection "${qdrantService.getCollectionName(firstHarness)}" does not exist yet.`
					);
				}
			}

			summaryEmbeddingCache = new SummaryEmbeddingCache(settings.storage);
			summaryEmbeddingCache.load();
			summaryEmbeddingCache.loadSynced();

			if (skipStartupQdrantUpdate)
			{
				vectorLogger.info("Startup vector indexing skipped (SKIP_STARTUP_UPDATING_QDRANT=true).");
			} else
			{
				// Summary embedding pass: pre-compute session summary vectors before chunk indexing.
				// Now picks up freshly generated aiSummary entries from the summarization pass above.
				const cacheStats = await summaryEmbeddingCache.embedNewSummaries(
					topicStore.getAll(),
					embeddingService,
					vectorConfig.batchDelayMs
				);
				vectorLogger.info(
					`Summary embeddings: embedded=${cacheStats.summariesEmbedded}, ` +
					`skipped=${cacheStats.summariesSkipped}, failed=${cacheStats.summariesFailed}`
				);

				// Create pipeline after cache is populated so it can attach summary vectors during indexing.
				vectorPipeline = new VectorPipeline(
					embeddingService,
					qdrantService,
					topicStore,
					summaryEmbeddingCache,
					50, // batch size
					vectorConfig.batchDelayMs
				);

				// Run embedding pipeline.
				// Force-reindex sessions that need summary vector backfill:
				//  - newlyEmbeddedSessionIds: sessions just embedded this run (hot path)
				//  - unsyncedSessionIds: sessions cached in a prior run but never confirmed applied
				//    to Qdrant (e.g., SKIP_STARTUP_UPDATING_QDRANT was true, or Qdrant was disabled)
				const unsyncedSessionIds = summaryEmbeddingCache.getUnsyncedSessionIds();
				const forceSessionIds = new Set([
					...cacheStats.newlyEmbeddedSessionIds,
					...unsyncedSessionIds,
				]);
				if (unsyncedSessionIds.size > 0)
				{
					vectorLogger.info(
						`Summary vector backfill: ${unsyncedSessionIds.size} sessions cached but not yet applied to Qdrant.`
					);
				}
				const allMessages = messageDB.getAllMessages();
				const stats = await vectorPipeline.processMessages(allMessages, forceSessionIds);

				const vectorElapsedMs = Date.now() - vectorStartMs;
				vectorLogger.info(
					`Vector indexing complete: processed=${stats.messagesProcessed}, ` +
					`enhanced=${stats.messagesEnhanced}, forceEmbed=${stats.forceFullEmbed}, ` +
					`chunks=${stats.chunksGenerated}, embeddings=${stats.embeddingsCreated}, ` +
					`skipped=${stats.skipped}, errors=${stats.errors}, ` +
					`collections=[${stats.collectionsCreated.join(", ")}], ` +
					`time=${vectorElapsedMs}ms`
				);
			}
		} catch (error)
		{
			vectorLogger.warn(`Vector initialization failed: ${(error as Error).message}`);
			vectorLogger.warn("Continuing without vector search...");
			embeddingService = undefined;
			qdrantService = undefined;
			vectorPipeline = undefined;
			summaryEmbeddingCache = undefined;
		}
	} else
	{
		vectorLogger.info("Qdrant not enabled (QDRANT_URL or OPENAI_API_KEY missing).");
	}

	// === AgentBuilder Initialization ===
	let agentBuilder: AgentBuilder | undefined;
	let agentPublisher: AgentPublisher | undefined;
	agentBuilderLogger.info(`cc.json loaded from: ${settings.configPath}`);
	agentBuilderLogger.info(`matched machine: "${machine.machine}", hostname: "${hostname}"`);
	agentBuilderLogger.info(`dataSources keys: ${Object.keys(machine.dataSources ?? {}).join(", ") || "(none)"}`);
	const agentBuilderSources = Object.values(machine.dataSources ?? {})
		.flat()
		.filter((s) => s.purpose === "AgentBuilder");
	if (agentBuilderSources.length > 0)
	{
		const canonicalAgentStore = new CanonicalAgentStore(settings.storage);
		const storeWarning = canonicalAgentStore.load();
		if (storeWarning) agentBuilderLogger.warn(storeWarning);
		agentBuilder = new AgentBuilder(machine, canonicalAgentStore);
		await agentBuilder.index();
		agentPublisher = new AgentPublisher(
			agentBuilderSources,
			settings.storage,
			agentBuilder,
			(sourceName, artifacts) => agentBuilder!.upsertPublishedArtifacts(sourceName, artifacts),
			canonicalAgentStore,
		);
		agentBuilderLogger.info("AgentPublisher initialized with publish ledger and index callback.");
	} else
	{
		agentBuilderLogger.info("No AgentBuilder data sources configured — skipping.");
	}

	const portFile = resolve(process.cwd(), ".cxc-port");
	const { server: httpServer, app, actualPort } = await startServer(
		messageDB,
		settings.PORT,
		embeddingService && qdrantService ? { embeddingService, qdrantService } : undefined,
		topicStore,
		agentBuilder,
		agentPublisher,
		scopeStore,
		favoriteStore,
		summaryEmbeddingCache
	);
	activeServer = httpServer;
	// Write actual port so Vite dev proxy and other tools can discover it.
	writeFileSync(portFile, String(actualPort), "utf-8");

	// Business logic: the network MCP transport is mounted only when both the MCP
	// subsystem and its SSE transport are enabled for this local process.
	if (settings.MCP_ENABLED && settings.MCP_SSE_ENABLED)
	{
		// Mount MCP SSE transport on the Express app (network MCP clients).
		// Optional auth via MCP_AUTH_TOKEN env var.
		mountMcpSse(
			app,
			messageDB,
			topicStore,
			embeddingService && qdrantService ? { embeddingService, qdrantService } : undefined,
			scopeStore
		);
	}
	else if (!settings.MCP_ENABLED)
	{
		logger.info("MCP disabled (MCP_ENABLED=false)");
	}
	else
	{
		logger.info("MCP/SSE disabled (set MCP_SSE_ENABLED=true to enable)");
	}

	// Keep a lightweight timer so Bun does not exit after startup on this runtime.
	keepAliveTimer = setInterval(() =>
	{
		// No-op heartbeat.
	}, 60_000);
	// Ensure heartbeat cleanup when server is stopped.
	activeServer.on("close", () =>
	{
		if (keepAliveTimer)
		{
			clearInterval(keepAliveTimer);
			keepAliveTimer = null;
		}
	});

	if (settings.MCP_ENABLED)
	{
		// Start MCP server on stdio (shares MessageDB/TopicStore with Express).
		// Note: MCP diagnostic output goes to stderr to avoid stdio protocol pollution.
		const mcpServer = new MCPServer(messageDB, topicStore, undefined, settings.MCP_LOGGING, scopeStore);
		await mcpServer.start();

		// Ensure MCP is closed when the HTTP server stops.
		activeServer.on("close", () =>
		{
			mcpServer.close().catch(() =>
			{
				// Ignore close errors during shutdown.
			});
		});
	}

	// === File System Watcher ===
	// Starts after all servers are up so the initial pipeline cannot race with live ingestion.
	const incrementalPipeline = new IncrementalPipeline(
		messageDB,
		storageWriter,
		machine.machine,
		settings.storage,
		topicSummarizer ?? null,
		vectorPipeline ?? null,
		topicStore,
		globalSettingsStore,
		summaryEmbeddingCache ?? null,
		embeddingService ?? null
	);

	const fileWatcher = new FileWatcher(settings, machine, incrementalPipeline);
	fileWatcher.start();

	let isShuttingDown = false;

	/**
	 * Handles gracefulShutdown behavior for this CXC module.
	 * @param signal - Value consumed by gracefulShutdown.
	 * @returns Result produced by gracefulShutdown.
	 */
	const gracefulShutdown = async (signal: string): Promise<void> =>
	{
		if (isShuttingDown)
		{
			return;
		}
		isShuttingDown = true;

		logger.info(`Received ${signal}. Stopping services...`);

		const fallbackTimer = setTimeout(() =>
		{
			logger.warn("Timed out waiting for clean close, forcing exit.");
			process.exit(0);
		}, 10_000);
		fallbackTimer.unref();

		try
		{
			fileWatcher.stop();

			if (keepAliveTimer)
			{
				clearInterval(keepAliveTimer);
				keepAliveTimer = null;
			}

			if (activeServer)
			{
				const closableServer = activeServer as Server & {
					closeIdleConnections?: () => void;
					closeAllConnections?: () => void;
				};

				closableServer.closeIdleConnections?.();
				closableServer.closeAllConnections?.();

				await new Promise<void>((resolve) =>
				{
					activeServer?.close(() => resolve());
				});
				activeServer = null;
			}

			messageDB.close();
			try { unlinkSync(portFile); } catch { /* already gone */ }
			clearTimeout(fallbackTimer);
			logger.info("Shutdown complete.");
			process.exit(0);
		}
		catch (error)
		{
			clearTimeout(fallbackTimer);
			logger.error(`Shutdown error: ${(error as Error).message}`, { error: serializeError(error) });
			process.exit(1);
		}
	};

	process.once("SIGINT", () =>
	{
		void gracefulShutdown("SIGINT");
	});
	process.once("SIGTERM", () =>
	{
		void gracefulShutdown("SIGTERM");
	});

	const elapsedMs = Date.now() - startMs;
	logger.info(`Loaded ${loadedCount} messages into DB (${messageDB.getMessageCount()} total).`);
	logger.info(`Total wall-clock time: ${elapsedMs} ms`);


}

/**
 * Process-level startup guard.
 * Logs any unhandled initialization error and exits with non-zero status.
 */
main().catch((err) =>
{
	logger.error("ContextCore startup failed.", { error: serializeError(err) });
	process.exit(1);
});
