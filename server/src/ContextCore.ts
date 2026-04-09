/**
 * ContextCore – entry point.
 * Runs full ingestion pipeline and starts the API server.
 *
 * API Endpoints Definition: ../interop/insomnia-context-core.json
 */

import { getHostname } from "./config.js";
import { existsSync, writeFileSync, unlinkSync } from "fs";
import { join, relative, resolve } from "path";
import type { Server } from "http";
import type { AgentMessage } from "./models/AgentMessage.js";
import { createMessageStore, type IMessageStore } from "./db/IMessageStore.js";
import { readHarnessChats } from "./harness/index.js";
import { startServer } from "./server/ContextServer.js";
import { CCSettings } from "./settings/CCSettings.js";
import { StorageWriter } from "./storage/StorageWriter.js";
import { getHarnessEntries, getHarnessNames } from "./types.js";
import { deriveProjectName } from "./utils/pathHelpers.js";
import { HarnessMatcher } from "./harness/HarnessMatcher.js";
import { loadCursorProjectRuleSet } from "./harness/cursor-matcher.js";
import { isQdrantEnabled, isQdrantUpdateSkipped, isQdrantUsageDisabled, getVectorConfig } from "./vector/VectorConfig.js";
import { EmbeddingService } from "./vector/EmbeddingService.js";
import { QdrantService } from "./vector/QdrantService.js";
import { SummaryEmbeddingCache } from "./vector/SummaryEmbeddingCache.js";
import { VectorPipeline } from "./vector/VectorPipeline.js";
import { TopicStore } from "./settings/TopicStore.js";
import { ScopeStore } from "./settings/ScopeStore.js";
import { TopicSummarizer } from "./analysis/TopicSummarizer.js";
import { MCPServer } from "./mcp/MCPServer.js";
import { mountMcpSse } from "./mcp/transports/sse.js";
import { FileWatcher } from "./watcher/FileWatcher.js";
import { IncrementalPipeline } from "./watcher/IncrementalPipeline.js";
import { AgentBuilder } from "./agentBuilder/AgentBuilder.js";

type HarnessStats = {
	/** Harness name from machine configuration (e.g. ClaudeCode, Cursor). */
	harness: string;
	/** Number of distinct sessions discovered after message grouping. */
	sessionsFound: number;
	/** Number of messages written to storage for this harness run. */
	messagesWritten: number;
	/** Number of recoverable failures encountered for this harness. */
	errors: number;
};

/** Active HTTP server handle for lifecycle hooks and cleanup wiring. */
let activeServer: Server | null = null;
/** Keep-alive timer used to prevent early process exit on this runtime. */
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Groups normalized messages into sessions for one harness.
 * @param messages - Flat message collection from a harness reader.
 * @returns Map keyed by "sessionId::project" with all messages for that session.
 */
function groupBySession(messages: Array<AgentMessage>): Map<string, Array<AgentMessage>>
{
	const sessions = new Map<string, Array<AgentMessage>>();
	for (const message of messages)
	{
		// SessionId alone is not sufficient because some sources can reuse ids across projects.
		// Include project in the key so persisted session files remain correctly partitioned.
		const groupKey = `${message.sessionId}::${message.project || "project"}`;
		if (!sessions.has(groupKey))
		{
			sessions.set(groupKey, []);
		}
		sessions.get(groupKey)?.push(message);
	}
	return sessions;
}

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
		console.error(`\ncc.json not found at: ${ccJsonPath}`);
		console.error(`\nRun the interactive setup wizard to generate it:\n`);
		console.error(`  bun run setup\n`);
		console.error(`This will scan your machine for IDE chat data and create a ready-to-use config.\n`);
		process.exit(1);
	}

	const settings = CCSettings.getInstance();
	const machine = settings.getMachineConfig(hostname);
	const storageWriter = new StorageWriter(settings.storage);

	console.log(`ContextCore – hostname: ${hostname}`);
	console.log(`Storage root: ${settings.storage}`);

	if (!machine)
	{
		// Missing machine config is a valid state during setup; exit gracefully with guidance.
		console.warn(`No config for hostname "${hostname}". No matching machine entry in cc.json.`);
		console.warn(`Run "bun run setup" to add a config for this machine, or add one manually.`);
		return;
	}

	console.log(`Selected machine config: ${machine.machine}`);

	const harnessStats: Array<HarnessStats> = [];
	for (const [harnessName, harnessConfig] of getHarnessEntries(machine.harnesses))
	{
		// Track each harness independently so one failing source does not hide others.
		const stats: HarnessStats = {
			harness: harnessName,
			sessionsFound: 0,
			messagesWritten: 0,
			errors: 0,
		};

		try
		{
			// Read + normalize all messages for the current harness.
			const rawBase = join(settings.storage, `${machine.machine}-RAW`, harnessName);
			const messages = readHarnessChats(harnessName, harnessConfig, rawBase);
			for (const message of messages)
			{
				// Stamp runtime context before persistence for cross-machine traceability.
				message.machine = machine.machine;
				message.harness = harnessName;
				if (message.source)
				{
					message.source = relative(settings.storage, message.source);
				}
			}

			// Build and write per-session + per-project symbol frequency maps for rule-matched Cursor projects.
			if (harnessName === "Cursor" && messages.length > 0)
			{
				const ruleSet = loadCursorProjectRuleSet();
				const ruleMatchedProjects = ruleSet.projectMappingRules.map((r) => r.newProjectName);
				if (ruleMatchedProjects.length > 0)
				{
					const matcher = new HarnessMatcher(messages, ruleMatchedProjects);
					matcher.buildSessionSymbolMaps();
					matcher.buildProjectSymbolMaps();
					matcher.logDiagnostics();
					const sessionFiles = matcher.writeSessionSymbolFiles(settings.storage, machine.machine, harnessName);
					const projectFiles = matcher.writeProjectSymbolFiles(settings.storage, machine.machine, harnessName);
					console.log(`[Pipeline] Cursor symbol maps: ${sessionFiles} session files, ${projectFiles} project files written`);
				}
			}

			const sessions = groupBySession(messages);
			stats.sessionsFound = sessions.size;

			for (const [groupKey, sessionMessages] of sessions.entries())
			{
				try
				{
					const first = sessionMessages[0];
					// Prefer explicit project extracted by harness; fallback to path-derived heuristic.
					const project = first?.project || deriveProjectName(harnessName, groupKey);
					const outPath = storageWriter.writeSession(
						sessionMessages,
						machine.machine,
						harnessName,
						project
					);
					if (outPath)
					{
						// Count messages only when a new file is written (writer may skip duplicates).
						stats.messagesWritten += sessionMessages.length;
					}
				} catch
				{
					// Session-level errors are isolated so remaining sessions can still be persisted.
					stats.errors += 1;
				}
			}
		} catch (error)
		{
			// Harness-level failure should not abort startup; continue with other configured harnesses.
			stats.errors += 1;
			console.warn(`[Pipeline] Harness "${harnessName}" failed: ${(error as Error).message}`);
		}

		harnessStats.push(stats);
		console.log(
			`[Pipeline] ${stats.harness}: sessions=${stats.sessionsFound}, messagesWritten=${stats.messagesWritten}, errors=${stats.errors}`
		);
	}

	const messageDB: IMessageStore = await createMessageStore(settings);
	console.log(`[Pipeline] Database mode: ${settings.IN_MEMORY_DB ? "in-memory" : `disk (${settings.databaseFile})`}`);
	// Load the persisted corpus into the query database.
	const loadedCount = messageDB.loadFromStorage(settings.storage);

	// Load persisted AI topic summaries (isolated from AgentMessage storage)
	const topicStore = new TopicStore(settings.storage);
	topicStore.load();
	console.log(`[Topics] Loaded ${topicStore.count} topic entries from topics.json`);

	const scopeStore = new ScopeStore(settings.storage);
	scopeStore.load();
	console.log(`[Scopes] Loaded ${scopeStore.list().length} scope entries from scopes.json`);

	// Log breakdown by harness for diagnostics
	const harnessCounts = messageDB.getHarnessCounts();
	console.log(
		`[MessageDB] Breakdown by harness: ${harnessCounts.map((h) => `${h.harness}=${h.count}`).join(", ")}`
	);

	// Log date ranges per harness
	const harnessDateRanges = messageDB.getHarnessDateRanges();
	console.log(`[MessageDB] Date ranges per harness (newest first):`);
	for (const range of harnessDateRanges)
	{
		console.log(`  ${range.harness}: ${range.earliest} → ${range.latest} (${range.count} messages)`);
	}

	// === AI Topic Summarization ===
	// Runs BEFORE vector initialization so freshly generated summaries are available
	// for both the summary embedding cache and Qdrant payload enrichment (R2BQ — T23/T24).
	// Dependency chain: TopicSummarizer → SummaryEmbeddingCache → VectorPipeline.
	let topicSummarizer: TopicSummarizer | undefined;
	const skipSummarization = (process.env.SKIP_AI_SUMMARIZATION ?? "true").trim().toLowerCase() !== "false";
	if (skipSummarization)
	{
		console.log("[Topics] AI summarization skipped (set SKIP_AI_SUMMARIZATION=false to enable).");
	} else
	{
		const pass1Model = (process.env.AI_SUMMARIZATION_MODEL_PASS_1 ?? "gpt-5-nano").trim();
		try
		{
			topicSummarizer = new TopicSummarizer(topicStore, messageDB, undefined, pass1Model);
			await topicSummarizer.runPipeline();
		} catch (error)
		{
			console.warn(`[Topics] Summarization pipeline failed: ${(error as Error).message}`);
			console.warn("[Topics] Continuing without topic summaries...");
			topicSummarizer = undefined;
		}

		// Pass 2: re-summarize entries whose aiSummary exceeds 1500 chars using a smarter model.
		const skipPass2 = (process.env.SKIP_AI_SUMMARIZATION_PASS_2 ?? "false").trim().toLowerCase() === "true";
		if (skipPass2)
		{
			console.log("[Topics/Pass2] Skipped (set SKIP_AI_SUMMARIZATION_PASS_2=false to enable).");
		} else
		{
			const pass2Model = (process.env.AI_SUMMARIZATION_MODEL_PASS_2 ?? "gpt-5-mini").trim();
			try
			{
				const pass2Summarizer = new TopicSummarizer(topicStore, messageDB, undefined, pass2Model);
				await pass2Summarizer.runPass2(1500);
			} catch (error)
			{
				console.warn(`[Topics/Pass2] Re-summarization pipeline failed: ${(error as Error).message}`);
				console.warn("[Topics/Pass2] Continuing without pass 2 summaries...");
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
		console.log("[Pipeline] Qdrant usage disabled (DO_NOT_USE_QDRANT=true).");
	} else if (isQdrantEnabled())
	{
		const vectorConfig = getVectorConfig();
		const vectorStartMs = Date.now();

		try
		{
			console.log("[Pipeline] Qdrant enabled, initializing vector services...");

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
				if (info && info.exists)
				{
					console.log(
						`[Pipeline] Qdrant connected. Collection "${qdrantService.getCollectionName(firstHarness)}" has ${info.pointsCount} points.`
					);
				} else
				{
					console.log(
						`[Pipeline] Qdrant connected. Collection "${qdrantService.getCollectionName(firstHarness)}" does not exist yet.`
					);
				}
			}

			summaryEmbeddingCache = new SummaryEmbeddingCache(settings.storage);
			summaryEmbeddingCache.load();
			summaryEmbeddingCache.loadSynced();

			if (skipStartupQdrantUpdate)
			{
				console.log("[Pipeline] Startup vector indexing skipped (SKIP_STARTUP_UPDATING_QDRANT=true).");
			} else
			{
				// Summary embedding pass: pre-compute session summary vectors before chunk indexing.
				// Now picks up freshly generated aiSummary entries from the summarization pass above.
				const cacheStats = await summaryEmbeddingCache.embedNewSummaries(
					topicStore.getAll(),
					embeddingService,
					vectorConfig.batchDelayMs
				);
				console.log(
					`[Pipeline] Summary embeddings: embedded=${cacheStats.summariesEmbedded}, ` +
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
					console.log(
						`[Pipeline] Summary vector backfill: ${unsyncedSessionIds.size} sessions cached but not yet applied to Qdrant.`
					);
				}
				const allMessages = messageDB.getAllMessages();
				const stats = await vectorPipeline.processMessages(allMessages, forceSessionIds);

				const vectorElapsedMs = Date.now() - vectorStartMs;
				console.log(
					`[Pipeline] Vector indexing complete: processed=${stats.messagesProcessed}, ` +
					`enhanced=${stats.messagesEnhanced}, forceEmbed=${stats.forceFullEmbed}, ` +
					`chunks=${stats.chunksGenerated}, embeddings=${stats.embeddingsCreated}, ` +
					`skipped=${stats.skipped}, errors=${stats.errors}, ` +
					`collections=[${stats.collectionsCreated.join(", ")}], ` +
					`time=${vectorElapsedMs}ms`
				);
			}
		} catch (error)
		{
			console.warn(`[Pipeline] Vector initialization failed: ${(error as Error).message}`);
			console.warn("[Pipeline] Continuing without vector search...");
			embeddingService = undefined;
			qdrantService = undefined;
			vectorPipeline = undefined;
			summaryEmbeddingCache = undefined;
		}
	} else
	{
		console.log("[Pipeline] Qdrant not enabled (QDRANT_URL or OPENAI_API_KEY missing).");
	}

	// === AgentBuilder Initialization ===
	let agentBuilder: AgentBuilder | undefined;
	console.log(`[AgentBuilder] cc.json loaded from: ${settings.configPath}`);
	console.log(`[AgentBuilder] matched machine: "${machine.machine}", hostname: "${hostname}"`);
	console.log(`[AgentBuilder] dataSources keys: ${Object.keys(machine.dataSources ?? {}).join(", ") || "(none)"}`);
	const agentBuilderSources = Object.values(machine.dataSources ?? {})
		.flat()
		.filter((s) => s.purpose === "AgentBuilder");
	if (agentBuilderSources.length > 0)
	{
		agentBuilder = new AgentBuilder(machine);
		await agentBuilder.index();
	} else
	{
		console.log("[AgentBuilder] No AgentBuilder data sources configured — skipping.");
	}

	const portFile = resolve(process.cwd(), ".cxc-port");
	const { server: httpServer, app, actualPort } = await startServer(
		messageDB,
		settings.PORT,
		embeddingService && qdrantService ? { embeddingService, qdrantService } : undefined,
		topicStore,
		agentBuilder,
		scopeStore,
		summaryEmbeddingCache
	);
	activeServer = httpServer;
	// Write actual port so Vite dev proxy and other tools can discover it.
	writeFileSync(portFile, String(actualPort), "utf-8");

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
		console.log("[MCP] Disabled (MCP_ENABLED=false)");
	}
	else
	{
		console.log("[MCP/SSE] Disabled (set MCP_SSE_ENABLED=true to enable)");
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
		summaryEmbeddingCache ?? null,
		embeddingService ?? null
	);

	const fileWatcher = new FileWatcher(settings, machine, incrementalPipeline);
	fileWatcher.start();

	let isShuttingDown = false;
	const gracefulShutdown = async (signal: string): Promise<void> =>
	{
		if (isShuttingDown)
		{
			return;
		}
		isShuttingDown = true;

		console.log(`[Shutdown] Received ${signal}. Stopping services...`);

		const fallbackTimer = setTimeout(() =>
		{
			console.warn("[Shutdown] Timed out waiting for clean close, forcing exit.");
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
			console.log("[Shutdown] Complete.");
			process.exit(0);
		}
		catch (error)
		{
			clearTimeout(fallbackTimer);
			console.error(`[Shutdown] Error: ${(error as Error).message}`);
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
	console.log(`[Pipeline] Loaded ${loadedCount} messages into DB (${messageDB.getMessageCount()} total).`);
	console.log(`[Pipeline] Total wall-clock time: ${elapsedMs} ms`);


}

/**
 * Process-level startup guard.
 * Logs any unhandled initialization error and exits with non-zero status.
 */
main().catch((err) =>
{
	console.error("ContextCore startup failed.");
	console.error(err);
	process.exit(1);
});
