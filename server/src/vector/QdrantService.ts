/**
 * QdrantService – Qdrant client with multi-collection support.
 * Manages per-harness collections, point upsertion, search, and deduplication.
 */

import { QdrantClient } from "@qdrant/js-client-rest";
import { v5 as uuidv5 } from "uuid";
import { EMBEDDING_DIMENSIONS } from "./EmbeddingService.js";

// Payload V2 — R2BQ

/**
 * Qdrant point payload — lenient read type.
 * V2 fields are optional for backward compatibility with pre-migration points.
 */
export type QdrantPointPayload = {
	/** AgentMessage ID for resolution via MessageDB. */
	messageId: string;
	/** Session ID for grouping. */
	sessionId: string;
	/** Position of this chunk within the message's chunks (0-based). */
	chunkIndex: number;
	/** The actual text of this chunk (stored as metadata for traceability). */
	chunkText: string;
	/** Source harness name. */
	harness: string;
	/** Project label. */
	project: string;
	/** Content kind classification ("prose" | "code" | "mixed" | "unknown"). */
	contentKind: string;
	// V2 fields — optional for backward compatibility with pre-migration points
	symbols?: string[];
	dateTime?: string;
	subject?: string;
	aiSummary?: string;
	customTopic?: string;
};

/**
 * Qdrant point payload — strict write type.
 * Enforces all V2 fields on newly indexed points.
 */
export type QdrantPointPayloadV2 = {
	messageId: string;
	sessionId: string;
	chunkIndex: number;
	chunkText: string;
	harness: string;
	project: string;
	contentKind: string;
	symbols: string[];
	dateTime: string;      // ISO
	subject: string;       // message.subject
	aiSummary?: string;    // TopicStore entry, if available
	customTopic?: string;  // TopicStore entry, if available
};

/** Named vector structure for dual-channel points (chunk + optional summary). */
export type NamedVectors = {
	chunk: number[];
	summary?: number[];
};

/** Qdrant point with ID, named vectors, and payload. */
export type QdrantPoint = {
	/** UUID v5 deterministic ID (from messageId + chunkIndex). */
	id: string;
	/** Named embedding vectors: chunk (required) + summary (optional). */
	vector: NamedVectors;
	/** Point metadata. */
	payload: QdrantPointPayloadV2;
};

/** Qdrant search result. */
export type QdrantSearchResult = {
	/** Cosine similarity score (0.0-1.0, higher is better). */
	score: number;
	/** Point payload. */
	payload: QdrantPointPayload;
};

/** Collection information. */
export type CollectionInfo = {
	/** Number of points in the collection. */
	pointsCount: number;
	/** Whether the collection exists. */
	exists: boolean;
};

/** Qdrant payload filter for narrowing search results. */
export type QdrantPayloadFilter = {
	must?: Array<{ key: string; match: { text: string } | { value: string } }>;
};

/** UUID namespace for deterministic point ID generation. */
const UUID_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"; // ISO OID namespace

/**
 * Service for interacting with Qdrant vector database.
 * Supports per-harness collections and multi-collection search.
 */
export class QdrantService
{
	private readonly client: QdrantClient;
	private readonly hostname: string;

	/**
	 * Creates a Qdrant service instance.
	 * @param url - Qdrant server URL (e.g., http://localhost:6333).
	 * @param apiKey - Optional API key for authentication.
	 * @param hostname - Machine hostname for collection naming.
	 */
	constructor(url: string, apiKey: string | null, hostname: string)
	{
		this.client = new QdrantClient({
			url,
			apiKey: apiKey ?? undefined,
		});
		this.hostname = this.sanitizeHostname(hostname);
	}

	/**
	 * Sanitizes hostname for use in collection names.
	 * Replaces non-alphanumeric characters with underscores.
	 * @param hostname - Raw hostname.
	 * @returns Sanitized hostname.
	 */
	private sanitizeHostname(hostname: string): string
	{
		return hostname.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
	}

	/**
	 * Generates collection name for a harness.
	 * Format: CXC_{HOSTNAME}_{Harness}
	 * @param harness - Harness name (e.g., "Kiro", "ClaudeCode").
	 * @returns Collection name (e.g., "CXC_KYLIATHY3_Kiro").
	 */
	getCollectionName(harness: string): string
	{
		return `CXC_${this.hostname}_${harness}`;
	}

	/**
	 * Ensures a collection exists with V2 named-vector schema (chunk + summary).
	 * If the collection already exists, it is left untouched (trusted to be V2).
	 * If the collection is missing, it is created fresh with V2 schema.
	 *
	 * @param harness - Harness name.
	 */
	async ensureCollection(harness: string): Promise<void>
	{
		const collectionName = this.getCollectionName(harness);

		try
		{
			await this.client.getCollection(collectionName);
			// Collection exists — nothing to do.
		} catch
		{
			// Collection missing — create with V2 named-vector schema.
			try
			{
				await this.client.createCollection(collectionName, {
					vectors: {
						chunk: { size: EMBEDDING_DIMENSIONS, distance: "Cosine" },
						summary: { size: EMBEDDING_DIMENSIONS, distance: "Cosine" },
					},
				});
				console.log(`[QdrantService] Created collection: ${collectionName} (chunk + summary vectors)`);
			} catch (createError)
			{
				console.warn(`[QdrantService] Failed to create collection "${collectionName}": ${(createError as Error).message}`);
				throw createError;
			}
		}
	}

	/**
	 * Upserts points to a harness-specific collection.
	 * @param harness - Harness name.
	 * @param points - Array of points to upsert.
	 */
	async upsertPoints(harness: string, points: QdrantPoint[]): Promise<void>
	{
		if (points.length === 0)
		{
			return;
		}

		const collectionName = this.getCollectionName(harness);
		const batchSize = 100; // Qdrant safe batch size

		// Split into batches
		for (let i = 0; i < points.length; i += batchSize)
		{
			const batch = points.slice(i, i + batchSize);

			try
			{
				await this.client.upsert(collectionName, {
					wait: true,
					points: batch.map((p) => ({
						id: p.id,
						vector: p.vector, // NamedVectors: { chunk: number[], summary?: number[] }
						payload: p.payload,
					})),
				});
			} catch (error)
			{
				const err = error as any;
				const detail = err?.data?.status?.error || err?.response?.data || err?.cause || "";
				const sampleVector = batch[0]?.vector;
				console.warn(
					`[QdrantService] Failed to upsert batch ${i / batchSize + 1} to "${collectionName}": ${(error as Error).message}` +
					(detail ? `\n  Detail: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : "") +
					`\n  Points in batch: ${batch.length}, IDs: [${batch.slice(0, 3).map(p => p.id).join(", ")}${batch.length > 3 ? ", ..." : ""}]` +
					`\n  Vector dims: chunk=${sampleVector?.chunk?.length ?? "N/A"}, summary=${sampleVector?.summary?.length ?? "none"}`
				);
				throw error;
			}
		}
	}

	/**
	 * Searches across multiple harness collections using a named vector channel.
	 * @param harnesses - Array of harness names to search.
	 * @param queryVector - Query embedding vector (3072 dimensions).
	 * @param limit - Maximum number of results to return.
	 * @param minScore - Minimum similarity score threshold (0.0-1.0).
	 * @param vectorName - Named vector channel to search ("chunk" or "summary"). Defaults to "chunk".
	 * @param filter - Optional Qdrant payload filter to narrow results.
	 * @returns Array of search results sorted by score (descending).
	 */
	async search(
		harnesses: string[],
		queryVector: number[],
		limit: number,
		minScore: number,
		vectorName: "chunk" | "summary" = "chunk",
		filter?: QdrantPayloadFilter
	): Promise<QdrantSearchResult[]>
	{
		const allResults: QdrantSearchResult[] = [];

		for (const harness of harnesses)
		{
			const collectionName = this.getCollectionName(harness);

			try
			{
				const results = await this.client.search(collectionName, {
					vector: {
						name: vectorName,
						vector: queryVector,
					},
					limit,
					score_threshold: minScore,
					with_payload: true,
					...(filter ? { filter } : {}),
				});

				console.log(`[QdrantService] Search[${vectorName}] hits in "${collectionName}": ${results.length}`);

				// Map results to our format
				for (const result of results)
				{
					allResults.push({
						score: result.score,
						payload: result.payload as QdrantPointPayload,
					});
				}
			} catch (error)
			{
				// Skip this collection if it doesn't exist or search fails
				console.warn(`[QdrantService] Failed to search[${vectorName}] collection "${collectionName}": ${(error as Error).message}`);
			}
		}

		// Re-sort all results by score descending
		allResults.sort((a, b) => b.score - a.score);

		// Return top N results across all collections
		return allResults.slice(0, limit);
	}

	/**
	 * Checks if a message already has indexed points in Qdrant.
	 * Used for deduplication to skip already-indexed messages.
	 *
	 * @param harness - Harness name.
	 * @param messageId - AgentMessage ID to check.
	 * @returns True if the message has at least one indexed point.
	 */
	async hasMessagePoints(harness: string, messageId: string): Promise<boolean>
	{
		const collectionName = this.getCollectionName(harness);

		try
		{
			const result = await this.client.scroll(collectionName, {
				filter: {
					must: [
						{
							key: "messageId",
							match: { value: messageId },
						},
					],
				},
				limit: 1, // Only need to know if at least one point exists
			});

			return result.points.length > 0;
		} catch (error)
		{
			// If collection doesn't exist, message is definitely not indexed
			return false;
		}
	}

	/**
	 * Loads all unique indexed message IDs for a harness collection.
	 * This enables fast restart/resume without per-message existence checks.
	 *
	 * @param harness - Harness name.
	 * @returns Set of indexed message IDs for the harness collection.
	 */
	async getIndexedMessageIds(harness: string): Promise<Set<string>>
	{
		const collectionName = this.getCollectionName(harness);
		const indexedMessageIds = new Set<string>();

		try
		{
			let offset: string | number | Record<string, unknown> | undefined = undefined;

			while (true)
			{
				const result = await this.client.scroll(collectionName, {
					limit: 1000,
					offset,
					with_payload: true,
					with_vector: false,
				});

				for (const point of result.points)
				{
					const payload = point.payload as Partial<QdrantPointPayload> | null | undefined;
					const messageId = payload?.messageId;
					if (typeof messageId === "string" && messageId.length > 0)
					{
						indexedMessageIds.add(messageId);
					}
				}

				if (!result.next_page_offset)
				{
					break;
				}

				offset = result.next_page_offset;
			}

			return indexedMessageIds;
		} catch
		{
			// Collection missing/unreachable: treat as no indexed IDs.
			return indexedMessageIds;
		}
	}

	/**
	 * Gets collection information (point count, existence).
	 * @param harness - Harness name.
	 * @returns Collection info or null if unreachable.
	 */
	async getCollectionInfo(harness: string): Promise<CollectionInfo | null>
	{
		const collectionName = this.getCollectionName(harness);

		try
		{
			const info = await this.client.getCollection(collectionName);
			return {
				pointsCount: info.points_count ?? 0,
				exists: true,
			};
		} catch (error)
		{
			// Collection doesn't exist or Qdrant unreachable
			return null;
		}
	}

	/**
	 * Updates named vectors on existing points without touching other vectors.
	 * Used for summary vector backfill — adds the `summary` vector while
	 * preserving the existing `chunk` vector. Zero OpenAI calls required.
	 *
	 * @param harness - Harness name.
	 * @param points - Points with IDs and partial named vectors to update.
	 */
	async updateVectors(harness: string, points: { id: string; vector: Partial<NamedVectors> }[]): Promise<void>
	{
		if (points.length === 0)
		{
			return;
		}

		const collectionName = this.getCollectionName(harness);
		const batchSize = 100;

		for (let i = 0; i < points.length; i += batchSize)
		{
			const batch = points.slice(i, i + batchSize);

			try
			{
				await this.client.updateVectors(collectionName, {
					wait: true,
					points: batch.map((p) => ({
						id: p.id,
						vector: p.vector,
					})),
				});
			} catch (error)
			{
				console.warn(
					`[QdrantService] Failed to updateVectors batch ${i / batchSize + 1} in "${collectionName}": ${(error as Error).message}`
				);
				throw error;
			}
		}
	}

	/**
	 * Sets payload fields on existing points without touching vectors.
	 * Merges with existing payload (does not overwrite unspecified fields).
	 *
	 * @param harness - Harness name.
	 * @param pointIds - IDs of points to update.
	 * @param payload - Payload fields to set/overwrite.
	 */
	async setPayload(harness: string, pointIds: (string | number)[], payload: Record<string, unknown>): Promise<void>
	{
		if (pointIds.length === 0)
		{
			return;
		}

		const collectionName = this.getCollectionName(harness);

		try
		{
			await this.client.setPayload(collectionName, {
				payload,
				points: pointIds,
				wait: true,
			});
		} catch (error)
		{
			console.warn(
				`[QdrantService] Failed to setPayload on ${pointIds.length} points in "${collectionName}": ${(error as Error).message}`
			);
			throw error;
		}
	}

	/**
	 * Generates a deterministic point ID from messageId and chunkIndex.
	 * Uses UUID v5 (namespace + name) for reproducibility.
	 *
	 * @param messageId - AgentMessage ID.
	 * @param chunkIndex - Chunk position within the message.
	 * @returns UUID v5 string.
	 */
	static generatePointId(messageId: string, chunkIndex: number): string
	{
		return uuidv5(`${messageId}:${chunkIndex}`, UUID_NAMESPACE);
	}
}
