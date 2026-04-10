/**
 * IncrementalPipeline – re-ingests a single harness path and pushes new sessions
 * through the full downstream stack: StorageWriter → MessageDB → TopicSummarizer → VectorPipeline.
 *
 * Called by FileWatcher after a debounced file-change event.
 */

import { relative } from "path";
import { readFileSync } from "fs";
import chalk from "chalk";
import { AgentMessage } from "../models/AgentMessage.js";
import type { IMessageStore } from "../db/IMessageStore.js";
import type { StorageWriter } from "../storage/StorageWriter.js";
import type { HarnessConfig } from "../types.js";
import { readHarnessChats } from "../harness/index.js";
import { getCursorRowIdCheckpoint, readCursorChatsIncremental } from "../harness/cursor.js";
import { deriveProjectName } from "../utils/pathHelpers.js";
import type { TopicSummarizer } from "../analysis/TopicSummarizer.js";
import { isReadyForSummarization } from "../analysis/TopicSummarizer.js";
import type { GlobalSettingsStore } from "../settings/GlobalSettingsStore.js";
import type { TopicStore } from "../settings/TopicStore.js";
import type { EmbeddingService } from "../vector/EmbeddingService.js";
import type { SummaryEmbeddingCache } from "../vector/SummaryEmbeddingCache.js";
import type { VectorPipeline } from "../vector/VectorPipeline.js";

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
 * Groups normalized messages by "sessionId::project" key.
 * Mirrors the grouping logic in ContextCore.ts.
 */
function groupBySession(messages: Array<AgentMessage>): Map<string, Array<AgentMessage>>
{
	const sessions = new Map<string, Array<AgentMessage>>();
	for (const message of messages)
	{
		const key = `${message.sessionId}::${message.project || "project"}`;
		if (!sessions.has(key))
		{
			sessions.set(key, []);
		}
		sessions.get(key)!.push(message);
	}
	return sessions;
}

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
		console.log(chalk.blue(`[FileWatcher] Change detected: ${harnessName} @ ${pathLabel}`));

		try
		{
			// 1. Re-read harness source — file-based harnesses skip unchanged files automatically.
			let messages: Array<AgentMessage> = [];
			if (harnessName === "Cursor")
			{
				const cursorDbPath = paths[0];
				if (!cursorDbPath)
				{
					throw new Error("Cursor incremental ingest requires a database path.");
				}

				const checkpoint = this.globalSettingsStore.getCursorCheckpoint();
				console.log(
					chalk.blue(`[Cursor][Checkpoint] Watcher start: ${formatCursorCheckpoint(checkpoint)}`)
				);
				if (checkpoint.cursorDiskKVRowId <= 0 && checkpoint.itemTableRowId <= 0)
				{
					const seededCheckpoint = getCursorRowIdCheckpoint(cursorDbPath);
					this.globalSettingsStore.setCursorState(seededCheckpoint);
					console.log(
						chalk.blue(
							`[Cursor][Checkpoint] Watcher end: ` +
							`${formatCursorCheckpoint(checkpoint)} -> ${formatCursorCheckpoint(seededCheckpoint)}`
						)
					);
				}
				else
				{
					const incremental = readCursorChatsIncremental(cursorDbPath, rawBase, checkpoint);
					this.globalSettingsStore.setCursorState(incremental.checkpoint);
					console.log(
						chalk.blue(
							`[Cursor][Checkpoint] Watcher end: ` +
							`${formatCursorCheckpoint(checkpoint)} -> ${formatCursorCheckpoint(incremental.checkpoint)}`
						)
					);
					messages = incremental.messages;
				}
			}
			else
			{
				messages = readHarnessChats(harnessName, harnessConfig, rawBase);
			}

			// Stamp machine + harness, relativize source path (same as startup pipeline).
			for (const message of messages)
			{
				message.machine = this.machineName;
				message.harness = harnessName;
				if (message.source)
				{
					message.source = relative(this.storagePath, message.source);
				}
			}

			// 2. Group by session.
			const sessions = groupBySession(messages);
			result.sessionsScanned = sessions.size;

			const newSessionIds = new Set<string>();
			const allNewMessages: Array<AgentMessage> = [];

			// 3. Process each session group.
			for (const [, sessionMessages] of sessions.entries())
			{
				if (sessionMessages.length === 0)
				{
					continue;
				}

				const first = sessionMessages[0];
				let project = first.project || deriveProjectName(harnessName, first.sessionId);

				if (harnessName === "Cursor")
				{
					const existingSession = this.messageDB.getBySessionId(first.sessionId);
					const existingProject = existingSession[0]?.project;
					if (existingProject && (!first.project || first.project === "MISC"))
					{
						project = existingProject;
						for (const message of sessionMessages)
						{
							message.project = existingProject;
						}
					}
				}

				try
				{
					// Write to storage (sets subject on messages, skips file if already exists).
					this.storageWriter.writeSession(sessionMessages, this.machineName, harnessName, project);

					// Insert into DB — INSERT OR IGNORE returns count of genuinely new rows.
					const newCount = this.messageDB.addMessages(sessionMessages);

					if (newCount > 0)
					{
						result.newSessionsFound++;
						result.messagesAdded += newCount;
						newSessionIds.add(first.sessionId);
						allNewMessages.push(...sessionMessages);

						// Force-overwrite the storage file with all current messages for this session.
						// This covers continued conversations where the source file grew but the output
						// file was skipped above (already existed from a prior run).
						const allSessionMessages = this.messageDB.getBySessionId(first.sessionId);
						this.storageWriter.writeSession(
							allSessionMessages,
							this.machineName,
							harnessName,
							project,
							true // overwrite
						);
					}
				}
				catch (err)
				{
					console.warn(
						chalk.yellow(
							`[IncrementalPipeline] Session error (${harnessName}/${first.sessionId}): ${(err as Error).message}`
						)
					);
				}
			}

			console.log(
				chalk.blue(
					`[IncrementalPipeline] ${harnessName}: scanned=${result.sessionsScanned} sessions, ` +
					`new=${result.newSessionsFound}, messages added=${result.messagesAdded}`
				)
			);

			// Three-step dependency chain (R2BQ — T25):
			//   Step 4:  TopicSummarizer       → generates aiSummary in TopicStore
			//   Step 4b: SummaryEmbeddingCache  → embeds fresh summaries into the cache
			//   Step 5:  VectorPipeline         → attaches cached summary vectors to Qdrant points
			// This ordering ensures freshly summarized sessions get both summary metadata
			// and summary vectors in their Qdrant points on the same ingestion pass.

			// 4. AI topic summarization for new sessions (if enabled).
			if (this.topicSummarizer && newSessionIds.size > 0)
			{
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
							console.log(chalk.gray(`[IncrementalPipeline] ${sessionId}: not yet ready for summarization`));
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
						console.warn(
							chalk.yellow(
								`[IncrementalPipeline] Topic error for ${sessionId}: ${(err as Error).message}`
							)
						);
					}
				}
				console.log(
					chalk.blue(
						`[IncrementalPipeline] Topics: summarized ${result.topicsSummarized}/${newSessionIds.size} sessions`
					)
				);
			}

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
					console.warn(
						chalk.yellow(`[IncrementalPipeline] Summary cache error: ${(err as Error).message}`)
					);
				}
			}

			// 5. Vector embedding for new messages (if enabled).
			if (this.vectorPipeline && allNewMessages.length > 0)
			{
				try
				{
					// VectorPipeline already skips already-indexed messages via Qdrant ID preload.
					const vectorStats = await this.vectorPipeline.processMessages(allNewMessages);
					result.embeddingsCreated = vectorStats.embeddingsCreated;
					console.log(
						chalk.blue(
							`[IncrementalPipeline] Qdrant: embedded ${vectorStats.embeddingsCreated} chunks from ${allNewMessages.length} messages`
						)
					);
				}
				catch (err)
				{
					console.warn(
						chalk.yellow(`[IncrementalPipeline] Vector error: ${(err as Error).message}`)
					);
				}
			}
		}
		catch (err)
		{
			console.warn(
				chalk.yellow(
					`[IncrementalPipeline] Harness error for ${harnessName}: ${(err as Error).message}`
				)
			);
		}

		result.durationMs = Date.now() - startMs;

		if (result.messagesAdded > 0)
		{
			console.log(
				chalk.green(
					`[IncrementalPipeline] Done in ${result.durationMs}ms — ` +
					`topics=${result.topicsSummarized}, embeddings=${result.embeddingsCreated}`
				)
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
	 * step is needed — the files are the storage artifact.
	 *
	 * @param source - Machine directory name, e.g. "SUSAN2" (used for logging only).
	 * @param filePaths - Absolute paths of the .json files that were created/modified.
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

		console.log(
			chalk.blue(`[FileWatcher] Remote storage change: ${source} (${filePaths.length} file(s))`)
		);

		const newSessionIds = new Set<string>();
		const allNewMessages: Array<AgentMessage> = [];

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
				// Truncated or malformed file — skip silently. File sync may still be writing;
				// the next change event will retry.
			}
		}

		console.log(
			chalk.blue(
				`[IncrementalPipeline] ${source} storage: scanned=${result.filesScanned}, ` +
				`new sessions=${result.newSessionsLoaded}, messages added=${result.messagesAdded}`
			)
		);

		// AI topic summarization for new sessions (if enabled).
		if (this.topicSummarizer && newSessionIds.size > 0)
		{
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
						console.log(chalk.gray(`[IncrementalPipeline] ${sessionId}: not yet ready for summarization`));
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
					console.warn(
						chalk.yellow(
							`[IncrementalPipeline] Topic error for ${sessionId}: ${(err as Error).message}`
						)
					);
				}
			}
			console.log(
				chalk.blue(
					`[IncrementalPipeline] Topics: summarized ${result.topicsSummarized}/${newSessionIds.size} sessions`
				)
			);
		}

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
				console.warn(
					chalk.yellow(`[IncrementalPipeline] Summary cache error: ${(err as Error).message}`)
				);
			}
		}

		// Vector embedding for new messages (if enabled).
		if (this.vectorPipeline && allNewMessages.length > 0)
		{
			try
			{
				const vectorStats = await this.vectorPipeline.processMessages(allNewMessages);
				result.embeddingsCreated = vectorStats.embeddingsCreated;
				console.log(
					chalk.blue(
						`[IncrementalPipeline] Qdrant: embedded ${vectorStats.embeddingsCreated} chunks ` +
						`from ${allNewMessages.length} messages`
					)
				);
			}
			catch (err)
			{
				console.warn(
					chalk.yellow(`[IncrementalPipeline] Vector error: ${(err as Error).message}`)
				);
			}
		}

		result.durationMs = Date.now() - startMs;

		if (result.messagesAdded > 0)
		{
			console.log(
				chalk.green(
					`[IncrementalPipeline] Done in ${result.durationMs}ms — ` +
					`topics=${result.topicsSummarized}, embeddings=${result.embeddingsCreated}`
				)
			);
		}

		return result;
	}
}
