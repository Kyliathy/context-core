/**
 * SummaryEmbeddingCache — Persistent cache of pre-computed summary embeddings.
 * Keyed by sessionId; one 3072-dimensional vector per session.
 * Stored at {storage}/.settings/summary-embeddings.json.
 *
 * Lifecycle:
 *   1. After TopicSummarizer completes, call embedNewSummaries() once.
 *   2. Already-cached sessions are skipped (zero OpenAI calls for them).
 *   3. Cache is persisted to disk after the pass.
 *   4. VectorPipeline reads from this cache — zero OpenAI calls for summaries during chunk indexing.
 *   5. When a topic changes via POST /api/topics, delete() the session entry and save().
 *
 * Sync tracking:
 *   A second file (summary-vectors-synced.json) records which session IDs have had
 *   their summary vectors confirmed upserted to Qdrant. This closes the gap where
 *   the embedding cache is populated but Qdrant was disabled or indexing was skipped.
 *   On startup: forceSessionIds = newlyEmbeddedSessionIds ∪ getUnsyncedSessionIds().
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { TopicEntry } from "../models/TopicEntry.js";
import type { EmbeddingService } from "./EmbeddingService.js";

/** Statistics from the summary embedding pass. */
export type SummaryEmbedPassStats = {
	/** Number of sessions successfully embedded. */
	summariesEmbedded: number;
	/** Number of sessions skipped (already cached). */
	summariesSkipped: number;
	/** Number of sessions that failed to embed. */
	summariesFailed: number;
	/**
	 * Session IDs that were newly embedded this pass (not previously cached).
	 * Callers should pass this to VectorPipeline.processMessages() as forceSessionIds
	 * so that already-indexed Qdrant points for these sessions are re-upserted
	 * with updated summary vectors and enriched payload.
	 */
	newlyEmbeddedSessionIds: Set<string>;
};

/** File format: object keyed by sessionId, values are 3072-dim float arrays. */
type CacheFile = Record<string, number[]>;

/**
 * Persistent cache of pre-computed summary embeddings.
 * Each session's summary text is embedded once and stored here.
 * The VectorPipeline reads from this cache — zero OpenAI calls for summaries during chunk indexing.
 */
export class SummaryEmbeddingCache
{
	private readonly filePath: string;
	private readonly syncedFilePath: string;
	private cache: Map<string, number[]>;
	/** Session IDs whose summary vectors have been confirmed upserted to Qdrant. */
	private syncedSessionIds: Set<string>;

	/**
	 * Creates a SummaryEmbeddingCache instance.
	 * @param storagePath - Root storage directory (e.g., "d:\\Codez\\Nexus\\design\\CXC").
	 */
	constructor(storagePath: string)
	{
		this.filePath = join(storagePath, ".settings", "summary-embeddings.json");
		this.syncedFilePath = join(storagePath, ".settings", "summary-vectors-synced.json");
		this.cache = new Map();
		this.syncedSessionIds = new Set();
	}

	/**
	 * Loads the cache from disk.
	 * If the file doesn't exist or is corrupt, starts with an empty cache silently.
	 */
	load(): void
	{
		if (!existsSync(this.filePath))
		{
			this.cache = new Map();
			return;
		}

		try
		{
			const raw = readFileSync(this.filePath, "utf-8");
			const parsed = JSON.parse(raw) as CacheFile;
			this.cache = new Map(Object.entries(parsed));
			console.log(`[SummaryEmbeddingCache] Loaded ${this.cache.size} cached embeddings from disk.`);
		} catch (error)
		{
			console.warn(
				`[SummaryEmbeddingCache] Failed to load cache: ${(error as Error).message}. Starting with empty cache.`
			);
			this.cache = new Map();
		}
	}

	/**
	 * Persists the current cache to disk.
	 */
	save(): void
	{
		const fileContent: CacheFile = Object.fromEntries(this.cache);
		writeFileSync(this.filePath, JSON.stringify(fileContent), "utf-8");
	}

	/** Returns the cached embedding vector for a session, or undefined if not cached. */
	get(sessionId: string): number[] | undefined
	{
		return this.cache.get(sessionId);
	}

	/** Stores an embedding vector for a session. Does not persist to disk — call save() after. */
	set(sessionId: string, vector: number[]): void
	{
		this.cache.set(sessionId, vector);
	}

	/** Removes a session's cached embedding and sync state. Call save() + saveSynced() to persist. */
	delete(sessionId: string): void
	{
		this.cache.delete(sessionId);
		this.syncedSessionIds.delete(sessionId);
	}

	/** Returns true if a session's embedding is present in the cache. */
	has(sessionId: string): boolean
	{
		return this.cache.has(sessionId);
	}

	// --- Sync tracking: which cached embeddings have been confirmed applied to Qdrant ---

	/** Loads the synced session ID set from disk. Call after load(). */
	loadSynced(): void
	{
		if (!existsSync(this.syncedFilePath))
		{
			this.syncedSessionIds = new Set();
			return;
		}
		try
		{
			const raw = readFileSync(this.syncedFilePath, "utf-8");
			const parsed = JSON.parse(raw) as string[];
			this.syncedSessionIds = new Set(parsed);
			console.log(`[SummaryEmbeddingCache] Loaded ${this.syncedSessionIds.size} synced session IDs from disk.`);
		} catch
		{
			this.syncedSessionIds = new Set();
		}
	}

	/** Persists the synced session ID set to disk. Call after pipeline completes. */
	saveSynced(): void
	{
		writeFileSync(this.syncedFilePath, JSON.stringify([...this.syncedSessionIds]), "utf-8");
	}

	/** Marks a session's summary vector as confirmed applied to Qdrant. */
	markSynced(sessionId: string): void
	{
		this.syncedSessionIds.add(sessionId);
	}

	/**
	 * Returns session IDs that have cached embeddings but have NOT been confirmed
	 * applied to Qdrant. These sessions need force-reindex on next pipeline run.
	 *
	 * Covers the gap where:
	 * - Qdrant was disabled (DO_NOT_USE_QDRANT=true) when embeddings were cached
	 * - Pipeline crashed before reaching those sessions' messages
	 */
	getUnsyncedSessionIds(): Set<string>
	{
		const unsynced = new Set<string>();
		for (const sessionId of this.cache.keys())
		{
			if (!this.syncedSessionIds.has(sessionId))
			{
				unsynced.add(sessionId);
			}
		}
		return unsynced;
	}

	/**
	 * Embeds summary text for all sessions not yet cached.
	 * Sessions already present in the cache are skipped (assumed unchanged).
	 * Persists the cache to disk after the pass completes.
	 *
	 * Per-session failures are non-fatal: a warning is logged and the pass continues.
	 * Missing cache entries simply result in chunk-only vectors in the pipeline.
	 *
	 * @param topicEntries - All entries from TopicStore (call topicStore.getAll()).
	 * @param embeddingService - Service for generating OpenAI embeddings.
	 * @param batchDelayMs - Delay between embedding calls for rate limiting.
	 * @returns Statistics for the embedding pass.
	 */
	async embedNewSummaries(
		topicEntries: TopicEntry[],
		embeddingService: EmbeddingService,
		batchDelayMs: number
	): Promise<SummaryEmbedPassStats>
	{
		const stats: SummaryEmbedPassStats = {
			summariesEmbedded: 0,
			summariesSkipped: 0,
			summariesFailed: 0,
			newlyEmbeddedSessionIds: new Set<string>(),
		};

		// Filter to sessions that have non-empty summary text
		const pending = topicEntries.filter((entry) =>
		{
			const text = entry.customTopic || entry.aiSummary || "";
			return text.trim().length > 0;
		});

		const toEmbed = pending.filter((e) => !this.has(e.sessionId));
		const toSkip = pending.length - toEmbed.length;

		console.log(
			`[SummaryEmbeddingCache] Starting pass — ` +
			`toEmbed=${toEmbed.length}, alreadyCached=${toSkip} (total sessions with summaries: ${pending.length})`
		);

		for (let i = 0; i < pending.length; i++)
		{
			const entry = pending[i]!;

			// Skip sessions already in cache — assumed unchanged
			if (this.has(entry.sessionId))
			{
				stats.summariesSkipped += 1;
				continue;
			}

			const summaryText = entry.customTopic || entry.aiSummary || "";

			try
			{
				const vector = await embeddingService.embed(summaryText);
				this.set(entry.sessionId, vector);
				stats.summariesEmbedded += 1;
				stats.newlyEmbeddedSessionIds.add(entry.sessionId);

				// Progress log every 10 embeddings so the user can see activity
				if (stats.summariesEmbedded % 10 === 0)
				{
					console.log(
						`[SummaryEmbeddingCache] Progress: ${stats.summariesEmbedded}/${toEmbed.length} embedded...`
					);
				}
			} catch (error)
			{
				// Per-session failure: log warning and continue — never abort the pass
				console.warn(
					`[SummaryEmbeddingCache] Failed to embed summary for session "${entry.sessionId}": ${(error as Error).message}`
				);
				stats.summariesFailed += 1;
			}

			// Rate limiting between embedding calls
			if (i < pending.length - 1 && batchDelayMs > 0)
			{
				await new Promise<void>((resolve) => setTimeout(resolve, batchDelayMs));
			}
		}

		// Persist updated cache to disk
		this.save();

		console.log(
			`[SummaryEmbeddingCache] Pass complete — ` +
			`embedded=${stats.summariesEmbedded}, skipped=${stats.summariesSkipped}, failed=${stats.summariesFailed}`
		);

		return stats;
	}
}
