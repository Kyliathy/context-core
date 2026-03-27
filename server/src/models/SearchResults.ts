/**
 * SearchResults – Encapsulates combined search results from Fuse.js + Qdrant.
 * Provides metadata about which search engines contributed to results.
 */

import type { AgentMessage } from "./AgentMessage.js";
import { AgentMessageFound, type SerializedAgentMessageFound } from "./AgentMessageFound.js";
import type { IMessageStore } from "../db/IMessageStore.js";
import type { QdrantPointPayload } from "../vector/QdrantService.js";
import { countTermHits, parseSearchQuery } from "../search/queryParser.js";

/** Search engine indicator. */
export type SearchEngine = "fuse" | "qdrant" | "hybrid";

/** Data structure for SearchResults. */
export type SearchResultsData = {
	/** Ranked search results. */
	results: AgentMessageFound[];
	/** Original query string. */
	query: string;
	/** Which search engines contributed results. */
	engine: SearchEngine;
	/** Number of results from Fuse.js before merge. */
	totalFuseResults: number;
	/** Number of results from Qdrant before merge. */
	totalQdrantResults: number;
};

/** Serialized search results for API response. */
export type SerializedSearchResults = {
	results: SerializedAgentMessageFound[];
	query: string;
	engine: SearchEngine;
	totalFuseResults: number;
	totalQdrantResults: number;
};

/**
 * Container for hybrid search results with metadata.
 * Handles deduplication and score merging from multiple search engines.
 */
export class SearchResults
{
	results: AgentMessageFound[];
	query: string;
	engine: SearchEngine;
	totalFuseResults: number;
	totalQdrantResults: number;

	/**
	 * Creates a SearchResults instance.
	 * @param data - Search results data.
	 */
	constructor(data: SearchResultsData)
	{
		this.results = data.results;
		this.query = data.query;
		this.engine = data.engine;
		this.totalFuseResults = data.totalFuseResults;
		this.totalQdrantResults = data.totalQdrantResults;
	}

	/**
	 * Merges Fuse.js and Qdrant search results.
	 * Deduplicates by messageId and calculates combined weighted scores.
	 *
	 * @param fuseHits - Results from Fuse.js fuzzy search.
	 * @param qdrantHits - Results from Qdrant semantic search.
	 * @param query - Original query string.
	 * @param messageDB - MessageDB instance for resolving Qdrant hits to full messages.
	 * @returns Merged SearchResults with deduplicated and scored results.
	 */
	static merge(
		fuseHits: Array<{ score: number; message: AgentMessage; matchedTerms?: string[] }>,
		qdrantHits: Array<{ score: number; payload: QdrantPointPayload }>,
		query: string,
		messageDB: IMessageStore
	): SearchResults
	{
		const resultMap = new Map<string, AgentMessageFound>();

		// Add all Fuse.js results
		for (const hit of fuseHits)
		{
			const hits = hit.matchedTerms ? countTermHits(hit.message.message, hit.matchedTerms) : 0;
			const found = AgentMessageFound.fromAgentMessage(hit.message, {
				fuseScore: hit.score,
				hits,
			});
			resultMap.set(hit.message.id, found);
		}

		// Parse query terms once for Qdrant-only hits
		const queryTerms = parseSearchQuery(query).tokens.map((t) =>
			t.type === "exact" ? `"${t.phrase}"` : t.term
		);

		// Add/merge Qdrant results — max-score dedup (R2BQ):
		// When a messageId appears multiple times (cross-chunk or cross-channel),
		// the highest score wins. This fixes the pre-existing last-write-wins bug.
		for (const hit of qdrantHits)
		{
			const messageId = hit.payload.messageId;
			const message = messageDB.getById(messageId);

			if (!message)
			{
				// Stale index: Qdrant references a message that no longer exists
				console.warn(`[SearchResults] Qdrant point references missing message: ${messageId}`);
				continue;
			}

			const existing = resultMap.get(messageId);

			if (existing)
			{
				// Max-score: only upgrade if this hit has a higher Qdrant score
				const bestQdrantScore = Math.max(hit.score, existing.qdrantScore ?? 0);
				const updated = AgentMessageFound.fromAgentMessage(message, {
					fuseScore: existing.fuseScore ?? undefined,
					qdrantScore: bestQdrantScore,
					hits: existing.hits,
				});
				resultMap.set(messageId, updated);
			} else
			{
				// Message only found via Qdrant
				const found = AgentMessageFound.fromAgentMessage(message, {
					qdrantScore: hit.score,
					hits: countTermHits(message.message, queryTerms),
				});
				resultMap.set(messageId, found);
			}
		}

		// Convert map to array and sort by combined score (descending)
		const results = Array.from(resultMap.values()).sort((a, b) => b.combinedScore - a.combinedScore);

		// Determine which engines contributed
		const totalFuseResults = fuseHits.length;
		const totalQdrantResults = qdrantHits.length;
		let engine: SearchEngine;

		if (totalFuseResults > 0 && totalQdrantResults > 0)
		{
			engine = "hybrid";
		} else if (totalFuseResults > 0)
		{
			engine = "fuse";
		} else if (totalQdrantResults > 0)
		{
			engine = "qdrant";
		} else
		{
			// No results from either engine
			engine = "fuse"; // Default to Fuse when nothing found
		}

		return new SearchResults({
			results,
			query,
			engine,
			totalFuseResults,
			totalQdrantResults,
		});
	}

	/**
	 * Serializes search results for API response.
	 * @returns Plain object with all fields.
	 */
	serialize(): SerializedSearchResults
	{
		return {
			results: this.results.map((r) => r.serialize()),
			query: this.query,
			engine: this.engine,
			totalFuseResults: this.totalFuseResults,
			totalQdrantResults: this.totalQdrantResults,
		};
	}
}
