/**
 * IncrementalPipeline - re-ingests a single harness path and pushes new sessions
 * through the full downstream stack: StorageWriter -> MessageDB -> TopicSummarizer -> VectorPipeline.
 *
 * Called by FileWatcher after a debounced file-change event.
 *
 * Architecture: server/zz-reach2/architecture/archi-context-core-level0.md
 * Logging: server/zz-reach2/upgrades/2026-06/r2wl-winston-logging.md
 */

import { readFileSync } from "fs";
import { getLogger } from "../logging/logger.js";
import { AgentMessage } from "../models/AgentMessage.js";
import type { IMessageStore } from "../db/IMessageStore.js";
import type { StorageWriter } from "../storage/StorageWriter.js";
import type { HarnessConfig } from "../types.js";
import { readHarnessChats } from "../harness/index.js";
import { getCursorRowIdCheckpoint, readCursorChatsIncremental } from "../harness/cursor.js";
import { getOpenCodeRowIdCheckpoint, readOpenCodeChatsIncremental, resolveOpenCodeDbPath } from "../harness/opencode.js";
import type { TopicSummarizer } from "../analysis/TopicSummarizer.js";
import { isReadyForSummarization } from "../analysis/TopicSummarizer.js";
import type { GlobalSettingsStore } from "../settings/GlobalSettingsStore.js";
import type { TopicStore } from "../settings/TopicStore.js";
import type { EmbeddingService } from "../vector/EmbeddingService.js";
import type { SummaryEmbeddingCache } from "../vector/SummaryEmbeddingCache.js";
import type { VectorPipeline } from "../vector/VectorPipeline.js";
import { persistIngestBatch } from "../ingest/BatchPersistence.js";
import { collectSourceIdentity } from "../ingest/BookmarkValidation.js";

const logger = getLogger("IncrementalPipeline");

export type IngestResult = {
	harnessName: string;
	sessionsScanned: number;
	newSessionsFound: number;
	messagesAdded: number;
	topicsSummarized: number;
	embeddingsCreated: number;
	durationMs: number;
};

export type StorageIngestResult = {
	/** Machine directory name, e.g. "SUSAN2". */
	source: string;
	filesScanned: number;
	newSessionsLoaded: number;
	messagesAdded: number;
	topicsSummarized: number;
	embeddingsCreated: number;
	durationMs: number;
};

/**
 * Formats a Cursor row-id checkpoint for diagnostic log lines.
 * @param checkpoint - CursorDiskKV and ItemTable row identifiers.
 * @returns Human-readable checkpoint summary.
 */
function formatCursorCheckpoint(checkpoint: { cursorDiskKVRowId: number; itemTableRowId: number }): string
{
	return `cursorDiskKV=${checkpoint.cursorDiskKVRowId}, ItemTable=${checkpoint.itemTableRowId}`;
}

/**
 * Orchestrates incremental ingestion of a single harness path.
 * Designed to run repeatedly in response to file-change events.
 */
export class IncrementalPipeline
{
	/**
	 * @param messageDB - Local message store for inserts and session reads.
	 * @param storageWriter - Persists normalized session JSON artifacts.
	 * @param machineName - Current machine identifier stamped on messages.
	 * @param storagePath - CXC storage root for relative source paths.
	 * @param topicSummarizer - Optional AI topic summarizer (null when disabled).
	 * @param vectorPipeline - Optional Qdrant embedding pipeline (null when disabled).
	 * @param topicStore - Topic persistence for summarization output.
	 * @param globalSettingsStore - Harness bookmarks and Cursor checkpoints.
	 * @param summaryEmbeddingCache - Optional summary vector cache (null when disabled).
	 * @param embeddingService - Embedding provider used by the summary cache.
	 */
	constructor(
		private readonly messageDB: IMessageStore,
		private readonly storageWriter: StorageWriter,
		private readonly machineName: string,
		private readonly storagePath: string,
		private readonly topicSummarizer: TopicSummarizer | null,
		private readonly vectorPipeline: VectorPipeline | null,
		private readonly topicStore: TopicStore,
		private readonly globalSettingsStore: GlobalSettingsStore,
		private readonly summaryEmbeddingCache: SummaryEmbeddingCache | null,
		private readonly embeddingService: EmbeddingService | null = null
	) {}

	/**
	 * Re-reads a harness path and pushes any new sessions/messages downstream.
	 * @param harnessName - e.g. "ClaudeCode", "Cursor", "Kiro", "VSCode"
	 * @param harnessConfig - Config with the specific path(s) to re-read.
	 * @param rawBase - Raw archive base for this harness.
	 * @returns Ingest counters and timing for the harness pass.
	 */
	async ingest(
		harnessName: string,
		harnessConfig: HarnessConfig,
		rawBase: string
	): Promise<IngestResult>
	{
		const startMs = Date.now();
		const result: IngestResult = {
			harnessName,
			sessionsScanned: 0,
			newSessionsFound: 0,
			messagesAdded: 0,
			topicsSummarized: 0,
			embeddingsCreated: 0,
			durationMs: 0,
		};

		const paths = Array.isArray(harnessConfig.paths) ? harnessConfig.paths : [harnessConfig.paths];
		const pathLabel = paths[0];
		logger.info(`Change detected: ${harnessName} @ ${pathLabel}`);

		try
		{
			// 1. Re-read harness source - file-based harnesses skip unchanged files automatically.
			let messages: Array<AgentMessage> = [];
			let pendingCheckpoint: unknown | null = null;
			if (harnessName === "Cursor")
			{
				const cursorDbPath = paths[0];
				if (!cursorDbPath)
				{
					throw new Error("Cursor incremental ingest requires a database path.");
				}

				const checkpoint = this.globalSettingsStore.getCursorCheckpoint();
				logger.info(`[Cursor][Checkpoint] Watcher start: ${formatCursorCheckpoint(checkpoint)}`);
				// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting incremental ingest and checkpoint safety from partial or invalid state.

				if (checkpoint.cursorDiskKVRowId <= 0 && checkpoint.itemTableRowId <= 0)
				{
					const seededCheckpoint = getCursorRowIdCheckpoint(cursorDbPath);
					pendingCheckpoint = seededCheckpoint;
				}
				else
				{
					const incremental = readCursorChatsIncremental(cursorDbPath, rawBase, checkpoint);
					pendingCheckpoint = incremental.checkpoint;
					messages = incremental.messages;
				}
			}
			else if (harnessName === "OpenCode")
			{
				const opencodePath = paths[0];
				const bookmark = this.globalSettingsStore.getHarnessBookmark("OpenCode");
				const checkpoint = {
					sessionRowId: Number(bookmark?.rowids?.session ?? 0),
					messageRowId: Number(bookmark?.rowids?.message ?? 0),
					partRowId: Number(bookmark?.rowids?.part ?? 0),
				};
				// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting incremental ingest and checkpoint safety from partial or invalid state.

				if (checkpoint.sessionRowId <= 0 && checkpoint.messageRowId <= 0 && checkpoint.partRowId <= 0)
				{
					pendingCheckpoint = getOpenCodeRowIdCheckpoint(opencodePath);
				}
				else
				{
					const incremental = readOpenCodeChatsIncremental(opencodePath, rawBase, checkpoint);
					pendingCheckpoint = incremental.checkpoint;
					messages = incremental.messages;
				}
			}
			else
			{
				messages = readHarnessChats(harnessName, harnessConfig, rawBase);
			}

			// Stamp machine + harness, relativize source path (same as startup pipeline).
			const persistResult = persistIngestBatch(
				{
					harnessName,
					messages,
					checkpointCandidate: pendingCheckpoint ?? undefined,
					isFinalBatch: true,
				},
				{
					messageDB: this.messageDB,
					storageWriter: this.storageWriter,
					machineName: this.machineName,
					storagePath: this.storagePath,
					preferExistingCursorProject: true,
				}
			);
			result.sessionsScanned = persistResult.sessionsScanned;
			result.newSessionsFound = persistResult.newSessionsFound;
			result.messagesAdded = persistResult.messagesAdded;
			// Business logic: this iteration walks every relevant item so incremental ingest and checkpoint safety reflects the complete source set instead of a partial snapshot.


			// Shared batch persistence handles grouping, storage writes, DB inserts, and session overwrites.
			for (const sessionError of persistResult.sessionErrors)
			{
				logger.warn(`Session error (${harnessName}/${sessionError.sessionId}): ${sessionError.error}`);
			}
			if (persistResult.fatalError)
			{
				throw new Error("Batch persistence failed.");
			}			// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting incremental ingest and checkpoint safety from partial or invalid state.

			if ((harnessName === "Cursor" || harnessName === "OpenCode") && pendingCheckpoint && persistResult.sessionErrors.length > 0)
			{
				throw new Error(`${harnessName} batch persistence had session errors; checkpoint was not advanced.`);
			}			// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting incremental ingest and checkpoint safety from partial or invalid state.


			if (harnessName === "Cursor" && pendingCheckpoint)
			{
				const previousCheckpoint = this.globalSettingsStore.getCursorCheckpoint();
				const cursorCheckpoint = pendingCheckpoint as { cursorDiskKVRowId: number; itemTableRowId: number };
				this.globalSettingsStore.setCursorState(cursorCheckpoint);
				logger.info(
					`[Cursor][Checkpoint] Watcher end: ` +
					`${formatCursorCheckpoint(previousCheckpoint)} -> ${formatCursorCheckpoint(cursorCheckpoint)}`
				);
			}
			else			// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting incremental ingest and checkpoint safety from partial or invalid state.
 if (harnessName === "OpenCode" && pendingCheckpoint)
			{
				const checkpoint = pendingCheckpoint as { sessionRowId: number; messageRowId: number; partRowId: number };
				const sourcePath = paths[0] ? resolveOpenCodeDbPath(paths[0]) : "";
				this.globalSettingsStore.commitHarnessBookmark("OpenCode", {
					...(this.globalSettingsStore.getHarnessBookmark("OpenCode") ?? { mode: "rowid" as const }),
					mode: "rowid",
					lastSuccessfulIngestAt: new Date().toISOString(),
					sourceIdentity: sourcePath ? collectSourceIdentity(sourcePath) ?? undefined : undefined,
					rowids: {
						session: checkpoint.sessionRowId,
						message: checkpoint.messageRowId,
						part: checkpoint.partRowId,
					},
				});
				logger.info(
					`[OpenCode][Checkpoint] Watcher end: session=${checkpoint.sessionRowId}, message=${checkpoint.messageRowId}, part=${checkpoint.partRowId}`
				);
			}

			const newSessionIds = persistResult.touchedSessionIds;
			const allNewMessages = persistResult.allNewMessages;

			logger.info(
				`${harnessName}: scanned=${result.sessionsScanned} sessions, ` +
				`new=${result.newSessionsFound}, messages added=${result.messagesAdded}`
			);
			// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting incremental ingest and checkpoint safety from partial or invalid state.


			// Three-step dependency chain (R2BQ - T25):
			//   Step 4:  TopicSummarizer       -> generates aiSummary in TopicStore
			//   Step 4b: SummaryEmbeddingCache -> embeds fresh summaries into the cache
			//   Step 5:  VectorPipeline        -> attaches cached summary vectors to Qdrant points
			// This ordering ensures freshly summarized sessions get both summary metadata
			// and summary vectors in their Qdrant points on the same ingestion pass.

			// 4. AI topic summarization for new sessions (if enabled).
			if (this.topicSummarizer && newSessionIds.size > 0)
			{
				// Business logic: this iteration walks every relevant item so incremental ingest and checkpoint safety reflects the complete source set instead of a partial snapshot.

				for (const sessionId of newSessionIds)
				{
					try
					{
						// Readiness gate: skip sessions that are too new and have too few user messages.
						const allMsgs = this.messageDB.getBySessionId(sessionId);
						const firstDateTimeIso = allMsgs[0]?.dateTime.toISO() ?? "";
						const userCount = allMsgs.filter(m => m.role === "user").length;
						if (!isReadyForSummarization(firstDateTimeIso, userCount))
						{
							logger.debug(`${sessionId}: not yet ready for summarization`);
							continue;
						}

						const entry = await this.topicSummarizer.summarizeSession(sessionId);
						if (entry)
						{
							this.topicStore.upsert(entry);
							this.topicStore.save();
							result.topicsSummarized++;
						}
					}
					catch (err)
					{
						logger.warn(`Topic error for ${sessionId}: ${(err as Error).message}`);
					}
				}
				logger.info(`Topics: summarized ${result.topicsSummarized}/${newSessionIds.size} sessions`);
			}			// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting incremental ingest and checkpoint safety from partial or invalid state.


			// 4b. Summary embedding cache pass for newly summarized sessions.
			// Runs after summarization so fresh aiSummary entries are picked up.
			// Step 5 dependency: summary vectors must be cached before chunk indexing.
			if (this.summaryEmbeddingCache && this.embeddingService && newSessionIds.size > 0)
			{
				try
				{
					const newTopicEntries = this.topicStore.getAll().filter(e => newSessionIds.has(e.sessionId));
					await this.summaryEmbeddingCache.embedNewSummaries(
						newTopicEntries,
						this.embeddingService,
						0 // no extra delay for incremental pass
					);
				}
				catch (err)
				{
					logger.warn(`Summary cache error: ${(err as Error).message}`);
				}
			}			// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting incremental ingest and checkpoint safety from partial or invalid state.


			// 5. Vector embedding for new messages (if enabled).
			if (this.vectorPipeline && allNewMessages.length > 0)
			{
				try
				{
					// VectorPipeline already skips already-indexed messages via Qdrant ID preload.
					const vectorStats = await this.vectorPipeline.processMessages(allNewMessages);
					result.embeddingsCreated = vectorStats.embeddingsCreated;
					logger.info(
						`Qdrant: embedded ${vectorStats.embeddingsCreated} chunks from ${allNewMessages.length} messages`
					);
				}
				catch (err)
				{
					logger.warn(`Vector error: ${(err as Error).message}`);
				}
			}
		}
		catch (err)
		{
			logger.warn(`Harness error for ${harnessName}: ${(err as Error).message}`);
		}

		result.durationMs = Date.now() - startMs;

		if (result.messagesAdded > 0)
		{
			logger.info(
				`Done in ${result.durationMs}ms - topics=${result.topicsSummarized}, embeddings=${result.embeddingsCreated}`
			);
		}

		return result;
	}

	/**
	 * Loads already-processed session JSON files from a remote machine's storage directory
	 * into the local MessageDB, then runs summarization and embedding for new sessions.
	 *
	 * These files were produced by StorageWriter on another machine and arrived here via
	 * file sync (rsync, OneDrive, Syncthing, etc.). No harness reader or StorageWriter
	 * step is needed - the files are the storage artifact.
	 *
	 * @param source - Machine directory name, e.g. "SUSAN2" (used for logging only).
	 * @param filePaths - Absolute paths of the .json files that were created/modified.
	 * @returns Storage ingest counters and timing for the remote sync burst.
	 */
	async ingestFromStorage(source: string, filePaths: string[]): Promise<StorageIngestResult>
	{
		const startMs = Date.now();
		const result: StorageIngestResult = {
			source,
			filesScanned: filePaths.length,
			newSessionsLoaded: 0,
			messagesAdded: 0,
			topicsSummarized: 0,
			embeddingsCreated: 0,
			durationMs: 0,
		};

		logger.info(`Remote storage change: ${source} (${filePaths.length} file(s))`);

		const newSessionIds = new Set<string>();
		const allNewMessages: Array<AgentMessage> = [];
		// Business logic: this iteration walks every relevant item so incremental ingest and checkpoint safety reflects the complete source set instead of a partial snapshot.


		for (const filePath of filePaths)
		{
			try
			{
				const raw = JSON.parse(readFileSync(filePath, "utf-8")) as Array<unknown>;
				if (raw.length === 0)
				{
					continue;
				}

				const messages = raw.map((row) => AgentMessage.deserialize(row));
				const newCount = this.messageDB.addMessages(messages);

				if (newCount > 0)
				{
					newSessionIds.add(messages[0].sessionId);
					allNewMessages.push(...messages);
					result.newSessionsLoaded++;
					result.messagesAdded += newCount;
				}
			}
			catch
			{
				// Truncated or malformed file - skip silently. File sync may still be writing;
				// the next change event will retry.
			}
		}

		logger.info(
			`${source} storage: scanned=${result.filesScanned}, ` +
			`new sessions=${result.newSessionsLoaded}, messages added=${result.messagesAdded}`
		);
		// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting incremental ingest and checkpoint safety from partial or invalid state.


		// AI topic summarization for new sessions (if enabled).
		if (this.topicSummarizer && newSessionIds.size > 0)
		{
			// Business logic: this iteration walks every relevant item so incremental ingest and checkpoint safety reflects the complete source set instead of a partial snapshot.

			for (const sessionId of newSessionIds)
			{
				try
				{
					// Readiness gate: skip sessions that are too new and have too few user messages.
					const allMsgs = this.messageDB.getBySessionId(sessionId);
					const firstDateTimeIso = allMsgs[0]?.dateTime.toISO() ?? "";
					const userCount = allMsgs.filter(m => m.role === "user").length;
					if (!isReadyForSummarization(firstDateTimeIso, userCount))
					{
						logger.debug(`${sessionId}: not yet ready for summarization`);
						continue;
					}

					const entry = await this.topicSummarizer.summarizeSession(sessionId);
					if (entry)
					{
						this.topicStore.upsert(entry);
						this.topicStore.save();
						result.topicsSummarized++;
					}
				}
				catch (err)
				{
					logger.warn(`Topic error for ${sessionId}: ${(err as Error).message}`);
				}
			}
			logger.info(`Topics: summarized ${result.topicsSummarized}/${newSessionIds.size} sessions`);
		}		// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting incremental ingest and checkpoint safety from partial or invalid state.


		// Summary embedding cache pass (before vector embedding).
		if (this.summaryEmbeddingCache && this.embeddingService && newSessionIds.size > 0)
		{
			try
			{
				const newTopicEntries = this.topicStore.getAll().filter(e => newSessionIds.has(e.sessionId));
				await this.summaryEmbeddingCache.embedNewSummaries(
					newTopicEntries,
					this.embeddingService,
					0
				);
			}
			catch (err)
			{
				logger.warn(`Summary cache error: ${(err as Error).message}`);
			}
		}		// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting incremental ingest and checkpoint safety from partial or invalid state.


		// Vector embedding for new messages (if enabled).
		if (this.vectorPipeline && allNewMessages.length > 0)
		{
			try
			{
				const vectorStats = await this.vectorPipeline.processMessages(allNewMessages);
				result.embeddingsCreated = vectorStats.embeddingsCreated;
				logger.info(
					`Qdrant: embedded ${vectorStats.embeddingsCreated} chunks from ${allNewMessages.length} messages`
				);
			}
			catch (err)
			{
				logger.warn(`Vector error: ${(err as Error).message}`);
			}
		}

		result.durationMs = Date.now() - startMs;

		if (result.messagesAdded > 0)
		{
			logger.info(
				`Done in ${result.durationMs}ms - topics=${result.topicsSummarized}, embeddings=${result.embeddingsCreated}`
			);
		}

		return result;
	}
}
