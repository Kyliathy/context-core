/**
 * VectorPipeline – Orchestrates the full embedding pipeline.
 * Chunks messages → generates embeddings → upserts to Qdrant with named vectors.
 */

import type { AgentMessage } from "../models/AgentMessage.js";
import type { TopicEntry } from "../models/TopicEntry.js";
import type { TopicStore } from "../settings/TopicStore.js";
import { chunkMessage } from "./Chunker.js";
import type { EmbeddingService } from "./EmbeddingService.js";
import { QdrantService, type QdrantPoint } from "./QdrantService.js";
import type { SummaryEmbeddingCache } from "./SummaryEmbeddingCache.js";

/**
 * Resolves the summary text for vector embedding from a TopicStore entry.
 * Returns customTopic if set, falls back to aiSummary, then empty string.
 */
export function resolveSummaryText(topicEntry: TopicEntry | undefined): string
{
	return topicEntry?.customTopic || topicEntry?.aiSummary || "";
}

/** Statistics from vector pipeline execution. */
export type VectorPipelineStats = {
	/** Number of messages processed. */
	messagesProcessed: number;
	/** Number of chunks generated from messages. */
	chunksGenerated: number;
	/** Number of embeddings created. */
	embeddingsCreated: number;
	/** Number of messages skipped (already indexed). */
	skipped: number;
	/** Number of messages enhanced in-place (summary vector + payload, no re-embedding). */
	messagesEnhanced: number;
	/** Number of messages in force sessions that required full embedding (not in Qdrant index). */
	forceFullEmbed: number;
	/** Number of errors encountered. */
	errors: number;
	/** Names of collections created. */
	collectionsCreated: string[];
	/** Total wall-clock time in milliseconds. */
	durationMs: number;
	/** Number of points that received a summary vector from cache. */
	summaryVectorsAttached: number;
	/** Number of summary cache lookups that returned a hit. */
	summaryCacheHits: number;
	/** Number of summary cache lookups that missed (no cached embedding). */
	summaryCacheMisses: number;
	/** Number of points whose payload includes aiSummary. */
	payloadWithAiSummary: number;
	/** Number of points whose payload includes customTopic. */
	payloadWithCustomTopic: number;
};

/**
 * Orchestrates the vector embedding pipeline.
 * Groups messages by harness, chunks, embeds, and upserts to per-harness Qdrant collections.
 * Attaches V2 payload fields and optional summary vectors from SummaryEmbeddingCache.
 */
export class VectorPipeline
{
	private readonly embeddingService: EmbeddingService;
	private readonly qdrantService: QdrantService;
	private readonly topicStore: TopicStore | null;
	private readonly summaryEmbeddingCache: SummaryEmbeddingCache | null;
	private readonly batchSize: number;
	private readonly batchDelayMs: number;

	/**
	 * Creates a vector pipeline instance.
	 * @param embeddingService - Service for generating OpenAI embeddings.
	 * @param qdrantService - Service for Qdrant operations.
	 * @param topicStore - Read-only TopicStore for V2 payload enrichment (null = skip enrichment).
	 * @param summaryEmbeddingCache - Pre-computed summary embeddings (null = chunk-only vectors).
	 * @param batchSize - Number of messages to process per batch (default 50).
	 * @param batchDelayMs - Delay between batches for rate limiting (default 200ms).
	 */
	constructor(
		embeddingService: EmbeddingService,
		qdrantService: QdrantService,
		topicStore: TopicStore | null,
		summaryEmbeddingCache: SummaryEmbeddingCache | null,
		batchSize = 50,
		batchDelayMs = 200
	)
	{
		this.embeddingService = embeddingService;
		this.qdrantService = qdrantService;
		this.topicStore = topicStore;
		this.summaryEmbeddingCache = summaryEmbeddingCache;
		this.batchSize = batchSize;
		this.batchDelayMs = batchDelayMs;
	}

	/**
	 * Processes messages through the full embedding pipeline.
	 * @param messages - Array of messages to process.
	 * @param forceSessionIds - Sessions whose messages must be re-upserted even if already indexed.
	 *   Use this to backfill summary vectors for sessions that gained a summary after initial indexing.
	 * @returns Pipeline execution statistics.
	 */
	async processMessages(messages: AgentMessage[], forceSessionIds?: Set<string>): Promise<VectorPipelineStats>
	{
		const startMs = Date.now();

		const stats: VectorPipelineStats = {
			messagesProcessed: 0,
			chunksGenerated: 0,
			embeddingsCreated: 0,
			messagesEnhanced: 0,
			forceFullEmbed: 0,
			skipped: 0,
			errors: 0,
			collectionsCreated: [],
			durationMs: 0,
			summaryVectorsAttached: 0,
			summaryCacheHits: 0,
			summaryCacheMisses: 0,
			payloadWithAiSummary: 0,
			payloadWithCustomTopic: 0,
		};

		// Group messages by harness
		const messagesByHarness = new Map<string, AgentMessage[]>();
		for (const message of messages)
		{
			const harness = message.harness || "UNKNOWN";
			if (!messagesByHarness.has(harness))
			{
				messagesByHarness.set(harness, []);
			}
			messagesByHarness.get(harness)!.push(message);
		}

		// Process each harness separately
		for (const [harness, harnessMessages] of messagesByHarness)
		{
			try
			{
				// Ensure collection exists (migrates legacy → V2 named vectors if needed)
				await this.qdrantService.ensureCollection(harness);
				const collectionName = this.qdrantService.getCollectionName(harness);
				if (!stats.collectionsCreated.includes(collectionName))
				{
					stats.collectionsCreated.push(collectionName);
				}

				// Preload all already-indexed message IDs once per harness.
				// This allows restart/resume behavior without expensive per-message Qdrant checks.
				const indexedMessageIds = await this.qdrantService.getIndexedMessageIds(harness);
				console.log(
					`[VectorPipeline] ${harness}: resume baseline loaded (${indexedMessageIds.size} indexed message IDs).`
				);

				// Diagnostic: show force session overlap for this harness
				if (forceSessionIds && forceSessionIds.size > 0)
				{
					const userMsgs = harnessMessages.filter(m => m.role === "user");
					const forceUserMsgs = userMsgs.filter(m => forceSessionIds.has(m.sessionId));
					const forceAndIndexed = forceUserMsgs.filter(m => indexedMessageIds.has(m.id));
					console.log(
						`[VectorPipeline] ${harness}: force backfill diagnostic — ` +
						`${userMsgs.length} user msgs total, ` +
						`${forceUserMsgs.length} in force sessions, ` +
						`${forceAndIndexed.length} already indexed (→enhance), ` +
						`${forceUserMsgs.length - forceAndIndexed.length} not indexed (→full embed)`
					);
				}

				// Process in batches
				const batchCount = Math.ceil(harnessMessages.length / this.batchSize);
				for (let batchNum = 0; batchNum < batchCount; batchNum++)
				{
					const batchStart = batchNum * this.batchSize;
					const batch = harnessMessages.slice(batchStart, batchStart + this.batchSize);

					const batchStats = await this.processMessageBatch(batch, harness, indexedMessageIds, forceSessionIds);

					// Merge batch stats
					stats.messagesProcessed += batchStats.messagesProcessed;
					stats.chunksGenerated += batchStats.chunksGenerated;
					stats.embeddingsCreated += batchStats.embeddingsCreated;
					stats.messagesEnhanced += batchStats.messagesEnhanced;
					stats.forceFullEmbed += batchStats.forceFullEmbed;
					stats.skipped += batchStats.skipped;
					stats.errors += batchStats.errors;
					stats.summaryVectorsAttached += batchStats.summaryVectorsAttached;
					stats.summaryCacheHits += batchStats.summaryCacheHits;
					stats.summaryCacheMisses += batchStats.summaryCacheMisses;
					stats.payloadWithAiSummary += batchStats.payloadWithAiSummary;
					stats.payloadWithCustomTopic += batchStats.payloadWithCustomTopic;

					// Log progress
					console.log(
						`[VectorPipeline] ${harness}: Batch ${batchNum + 1}/${batchCount} - ` +
						`processed=${batchStats.messagesProcessed}, enhanced=${batchStats.messagesEnhanced}, ` +
						`forceEmbed=${batchStats.forceFullEmbed}, chunks=${batchStats.chunksGenerated}, ` +
						`skipped=${batchStats.skipped}, errors=${batchStats.errors}`
					);

					// Rate limiting: wait between batches
					if (batchNum < batchCount - 1)
					{
						await this.sleep(this.batchDelayMs);
					}
				}
			} catch (error)
			{
				// Harness-level error: log and continue with other harnesses
				console.warn(`[VectorPipeline] Failed to process harness "${harness}": ${(error as Error).message}`);
				stats.errors += 1;
			}
		}

		stats.durationMs = Date.now() - startMs;

		// Log summary-vector stats at end of pipeline
		if (stats.summaryCacheHits > 0 || stats.summaryCacheMisses > 0)
		{
			console.log(
				`[VectorPipeline] Summary vectors: attached=${stats.summaryVectorsAttached}, ` +
				`cacheHits=${stats.summaryCacheHits}, cacheMisses=${stats.summaryCacheMisses}, ` +
				`payloadAiSummary=${stats.payloadWithAiSummary}, payloadCustomTopic=${stats.payloadWithCustomTopic}`
			);
		}

		// Persist sync state — records which sessions' summary vectors have been applied to Qdrant.
		// This closes the gap where embeddings are cached but Qdrant was skipped or unavailable.
		if (stats.summaryVectorsAttached > 0)
		{
			this.summaryEmbeddingCache?.saveSynced();
		}

		return stats;
	}

	/**
	 * Processes a batch of messages for a specific harness.
	 * Populates V2 payload fields and attaches summary vectors from cache.
	 *
	 * @param messages - Batch of messages.
	 * @param harness - Harness name.
	 * @param indexedMessageIds - Set of already-indexed message IDs (mutated: new IDs added).
	 * @returns Partial stats for this batch.
	 */
	private async processMessageBatch(
		messages: AgentMessage[],
		harness: string,
		indexedMessageIds: Set<string>,
		forceSessionIds?: Set<string>
	): Promise<Omit<VectorPipelineStats, "collectionsCreated" | "durationMs">>
	{
		const stats = {
			messagesProcessed: 0,
			chunksGenerated: 0,
			embeddingsCreated: 0,
			messagesEnhanced: 0,
			forceFullEmbed: 0,
			skipped: 0,
			errors: 0,
			summaryVectorsAttached: 0,
			summaryCacheHits: 0,
			summaryCacheMisses: 0,
			payloadWithAiSummary: 0,
			payloadWithCustomTopic: 0,
		};

		// New points (full embed path)
		const pointsToUpsert: QdrantPoint[] = [];
		// Enhance-in-place updates (no re-embedding — summary vector + V2 payload only)
		const vectorUpdates: { id: string; vector: { summary: number[] } }[] = [];
		const payloadUpdates: { pointIds: string[]; payload: Record<string, unknown> }[] = [];

		for (const message of messages)
		{
			try
			{
				// Only embed user messages — assistant/tool/system content is noise for semantic search.
				if (message.role !== "user")
				{
					stats.skipped += 1;
					continue;
				}

				// Resume/deduplication check from preloaded indexed IDs.
				const alreadyIndexed = indexedMessageIds.has(message.id);
				const forceReindex = forceSessionIds?.has(message.sessionId) ?? false;
				if (alreadyIndexed && !forceReindex)
				{
					stats.skipped += 1;
					continue;
				}

				// Look up TopicStore entry for V2 payload fields (once per message, shared across chunks).
				const topicEntry = this.topicStore?.getBySessionId(message.sessionId);

				// Look up pre-computed summary embedding from cache (once per message).
				const summaryVector = this.summaryEmbeddingCache?.get(message.sessionId);
				if (summaryVector)
				{
					stats.summaryCacheHits += 1;
				} else if (this.summaryEmbeddingCache)
				{
					stats.summaryCacheMisses += 1;
				}

				// ── Enhance-in-place path ──
				// Already indexed but needs summary vector backfill or V2 payload update.
				// Re-chunk locally (free) to derive deterministic point IDs, then
				// update existing points via updateVectors + setPayload. Zero OpenAI calls.
				if (alreadyIndexed && forceReindex)
				{
					const chunks = await chunkMessage(message.message);
					const pointIds = chunks.map((c) => QdrantService.generatePointId(message.id, c.index));

					if (pointIds.length === 0)
					{
						stats.skipped += 1;
						continue;
					}

					// Attach summary vector to existing points (preserves chunk vector)
					if (summaryVector)
					{
						for (const pointId of pointIds)
						{
							vectorUpdates.push({ id: pointId, vector: { summary: summaryVector } });
						}
						stats.summaryVectorsAttached += pointIds.length;
						this.summaryEmbeddingCache?.markSynced(message.sessionId);
					}

					// Build V2 payload fields to merge onto existing points
					const payloadUpdate: Record<string, unknown> = {
						symbols: message.symbols,
						dateTime: message.dateTime.toISO() ?? "",
						subject: message.subject,
					};
					if (topicEntry?.aiSummary)
					{
						payloadUpdate.aiSummary = topicEntry.aiSummary;
						stats.payloadWithAiSummary += pointIds.length;
					}
					if (topicEntry?.customTopic)
					{
						payloadUpdate.customTopic = topicEntry.customTopic;
						stats.payloadWithCustomTopic += pointIds.length;
					}
					payloadUpdates.push({ pointIds, payload: payloadUpdate });

					stats.messagesEnhanced += 1;
					continue;
				}

				// ── Full embed path ──
				// New message: chunk → embed → build point → upsert.
				if (forceReindex)
				{
					stats.forceFullEmbed += 1;
				}
				const chunks = await chunkMessage(message.message);
				stats.chunksGenerated += chunks.length;

				for (const chunk of chunks)
				{
					try
					{
						const chunkEmbedding = await this.embeddingService.embed(chunk.text);
						stats.embeddingsCreated += 1;

						const pointId = QdrantService.generatePointId(message.id, chunk.index);

						const payload: QdrantPoint["payload"] = {
							messageId: message.id,
							sessionId: message.sessionId,
							chunkIndex: chunk.index,
							chunkText: chunk.text,
							harness: message.harness,
							project: message.project,
							contentKind: chunk.kind,
							symbols: message.symbols,
							dateTime: message.dateTime.toISO() ?? "",
							subject: message.subject,
						};

						if (topicEntry?.aiSummary)
						{
							payload.aiSummary = topicEntry.aiSummary;
							stats.payloadWithAiSummary += 1;
						}
						if (topicEntry?.customTopic)
						{
							payload.customTopic = topicEntry.customTopic;
							stats.payloadWithCustomTopic += 1;
						}

						const point: QdrantPoint = {
							id: pointId,
							vector: summaryVector
								? { chunk: chunkEmbedding, summary: summaryVector }
								: { chunk: chunkEmbedding },
							payload,
						};

						if (summaryVector)
						{
							stats.summaryVectorsAttached += 1;
							this.summaryEmbeddingCache?.markSynced(message.sessionId);
						}

						pointsToUpsert.push(point);
					} catch (error)
					{
						console.warn(
							`[VectorPipeline] Failed to embed chunk ${chunk.index} of message ${message.id}: ${(error as Error).message}`
						);
						stats.errors += 1;
					}
				}

				stats.messagesProcessed += 1;
				indexedMessageIds.add(message.id);
			} catch (error)
			{
				console.warn(`[VectorPipeline] Failed to process message ${message.id}: ${(error as Error).message}`);
				stats.errors += 1;
			}
		}

		// Upsert new points (full embed path)
		if (pointsToUpsert.length > 0)
		{
			try
			{
				await this.qdrantService.upsertPoints(harness, pointsToUpsert);
			} catch (error)
			{
				console.warn(`[VectorPipeline] Failed to upsert points for harness "${harness}": ${(error as Error).message}`);
				stats.errors += 1;
			}
		}

		// Apply enhance-in-place updates: summary vectors (no re-embedding)
		if (vectorUpdates.length > 0)
		{
			try
			{
				await this.qdrantService.updateVectors(harness, vectorUpdates);
			} catch (error)
			{
				console.warn(`[VectorPipeline] Failed to update vectors for harness "${harness}": ${(error as Error).message}`);
				stats.errors += 1;
			}
		}

		// Apply enhance-in-place updates: V2 payload fields
		for (const update of payloadUpdates)
		{
			try
			{
				await this.qdrantService.setPayload(harness, update.pointIds, update.payload);
			} catch (error)
			{
				console.warn(`[VectorPipeline] Failed to set payload for harness "${harness}": ${(error as Error).message}`);
				stats.errors += 1;
			}
		}

		return stats;
	}

	/**
	 * Sleeps for a specified duration.
	 * @param ms - Milliseconds to sleep.
	 */
	private sleep(ms: number): Promise<void>
	{
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
