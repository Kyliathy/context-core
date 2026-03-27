/**
 * Search engine core with cached Fuse.js index.
 * Executes parsed queries against the indexed message corpus.
 */

import Fuse from "fuse.js";
import type { AgentMessage } from "../models/AgentMessage.js";
import type { ParsedQuery, SearchToken, ScoringConfig } from "./queryParser.js";
import { matchesExact, computeCompositeScore, DEFAULT_SCORING } from "./queryParser.js";
import { CCSettings } from "../settings/CCSettings.js";

export type SearchResult = {
	message: AgentMessage;
	score: number; // composite score (higher = better match)
	rawFuseScore: number; // original Fuse.js score (0=best, 1=worst) for hybrid merge
	matchedTerms: string[]; // which query terms matched
};

type SearchRecord = {
	id: string;
	message: string;
	subject: string;
	symbols: Array<string>;
	tags: Array<string>;
	context: Array<string>;
};

// Module-level cache for Fuse.js index
let fuseIndex: Fuse<SearchRecord> | null = null;
let indexedRecords: SearchRecord[] = [];
let indexedRecordById = new Map<string, SearchRecord>();
let resolveMessageById: ((id: string) => AgentMessage | null) | null = null;

/**
 * Initializes the Fuse.js index. Call once at server startup.
 * @param messages - All messages to index.
 * @param resolver - Optional lazy message resolver by id.
 */
export function initSearchIndex(
	messages: AgentMessage[],
	resolver?: (id: string) => AgentMessage | null
): void
{
	const settings = CCSettings.getInstance();
	const records: SearchRecord[] = messages.map((message) => ({
		id: message.id,
		message: message.message,
		subject: message.subject,
		symbols: message.symbols,
		tags: message.tags,
		context: message.context,
	}));

	fuseIndex = new Fuse(records, {
		includeScore: true,
		threshold: settings.FUSE_THRESHOLD,
		minMatchCharLength: 3,
		keys: [
			{ name: "message", weight: 3 },
			{ name: "subject", weight: 2 },
			{ name: "symbols", weight: 2 },
			{ name: "tags", weight: 2 },
			{ name: "context", weight: 1 },
		],
	});

	indexedRecords = records;
	indexedRecordById = new Map(records.map((record) => [record.id, record]));

	if (resolver)
	{
		resolveMessageById = resolver;
	}
	else
	{
		const messageById = new Map(messages.map((message) => [message.id, message]));
		resolveMessageById = (id: string) => messageById.get(id) ?? null;
	}

	console.log(`[SearchEngine] Indexed ${messages.length} messages`);
}

/**
 * Executes a fuzzy search using the cached Fuse.js index.
 * @param term - Term to search for.
 * @returns Array of matching message ids with scores.
 */
function executeFuzzySearch(term: string): Array<{ id: string; score: number }>
{
	if (!fuseIndex)
	{
		throw new Error("Search index not initialized. Call initSearchIndex() first.");
	}

	const results = fuseIndex.search(term);
	return results.map((result) => ({
		id: result.item.id,
		score: result.score ?? 0,
	}));
}

/**
 * Executes an exact phrase search.
 * @param phrase - Exact phrase to match (case-insensitive).
 * @param records - Search records to filter.
 * @returns Array of matching message ids with score 0 (perfect match).
 */
function executeExactSearch(
	phrase: string,
	records: SearchRecord[]
): Array<{ id: string; score: number }>
{
	return records
		.filter((record) => matchesExact(record.message, phrase))
		.map((record) => ({
			id: record.id,
			score: 0, // exact match = perfect score
		}));
}

function resolveById(id: string): AgentMessage | null
{
	if (!resolveMessageById)
	{
		throw new Error("Search resolver not initialized. Call initSearchIndex() first.");
	}
	return resolveMessageById(id);
}

/**
 * Executes an OR query: union of all token matches.
 * @param tokens - Query tokens to search for.
 * @param scoringConfig - Scoring configuration.
 * @returns Merged and deduplicated results with composite scores.
 */
function executeOrQuery(tokens: SearchToken[], scoringConfig: ScoringConfig): SearchResult[]
{
	if (tokens.length === 0)
	{
		return [];
	}

	// Map to track all matches per message ID
	const messageMatches = new Map<
		string,
		{
			scores: number[];
			matchedTerms: string[];
		}
	>();

	// Execute search for each token
	for (const token of tokens)
	{
		let hits: Array<{ id: string; score: number }>;

		if (token.type === "exact")
		{
			hits = executeExactSearch(token.phrase, indexedRecords);
		} else
		{
			hits = executeFuzzySearch(token.term);
		}

		// Merge into messageMatches
		for (const hit of hits)
		{
			const existing = messageMatches.get(hit.id);
			const termLabel = token.type === "exact" ? `"${token.phrase}"` : token.term;

			if (existing)
			{
				existing.scores.push(hit.score);
				existing.matchedTerms.push(termLabel);
			} else
			{
				messageMatches.set(hit.id, {
					scores: [hit.score],
					matchedTerms: [termLabel],
				});
			}
		}
	}

	// Compute composite scores
	const results: SearchResult[] = [];
	for (const [messageId, match] of messageMatches.entries())
	{
		const message = resolveById(messageId);
		if (!message)
		{
			continue;
		}

		const avgFuseScore = match.scores.reduce((sum, s) => sum + s, 0) / match.scores.length;
		const compositeScore = computeCompositeScore(
			avgFuseScore,
			match.matchedTerms.length,
			tokens.length,
			scoringConfig
		);

		results.push({
			message,
			score: compositeScore,
			rawFuseScore: avgFuseScore,
			matchedTerms: match.matchedTerms,
		});
	}

	// Sort by composite score descending (higher = better)
	results.sort((a, b) => b.score - a.score);

	return results;
}

/**
 * Executes an AND query: sequential filtering through terms.
 * @param tokens - Query tokens (all must match).
 * @param scoringConfig - Scoring configuration.
 * @returns Intersection of matches with composite scores.
 */
function executeAndQuery(tokens: SearchToken[], scoringConfig: ScoringConfig): SearchResult[]
{
	if (tokens.length === 0)
	{
		return [];
	}

	// Start with first token
	const firstToken = tokens[0];
	let candidates: Array<{ id: string; messageText: string; score: number }>;

	if (firstToken.type === "exact")
	{
		candidates = executeExactSearch(firstToken.phrase, indexedRecords)
			.map((hit) =>
			{
				const record = indexedRecordById.get(hit.id);
				if (!record)
				{
					return null;
				}
				return { id: hit.id, messageText: record.message, score: hit.score };
			})
			.filter((candidate): candidate is { id: string; messageText: string; score: number } => Boolean(candidate));
	} else
	{
		candidates = executeFuzzySearch(firstToken.term)
			.map((hit) =>
			{
				const record = indexedRecordById.get(hit.id);
				if (!record)
				{
					return null;
				}
				return { id: hit.id, messageText: record.message, score: hit.score };
			})
			.filter((candidate): candidate is { id: string; messageText: string; score: number } => Boolean(candidate));
	}

	// Filter through remaining tokens sequentially
	for (let i = 1; i < tokens.length; i++)
	{
		const token = tokens[i];
		const filteredCandidates: Array<{ id: string; messageText: string; score: number }> = [];

		for (const candidate of candidates)
		{
			let matches = false;

			if (token.type === "exact")
			{
				matches = matchesExact(candidate.messageText, token.phrase);
			} else
			{
				// Check if fuzzy term matches (use a simple contains check for AND filtering)
				// This is a simplification; could use Fuse.js on the candidate set
				matches = candidate.messageText.toLowerCase().includes(token.term.toLowerCase());
			}

			if (matches)
			{
				filteredCandidates.push(candidate);
			}
		}

		candidates = filteredCandidates;

		// Early exit if no candidates remain
		if (candidates.length === 0)
		{
			return [];
		}
	}

	// Build results with composite scores
	const results: SearchResult[] = [];
	const matchedTerms = tokens.map((t) => (t.type === "exact" ? `"${t.phrase}"` : t.term));
	for (const candidate of candidates)
	{
		const message = resolveById(candidate.id);
		if (!message)
		{
			continue;
		}

		const avgFuseScore = candidate.score;
		const compositeScore = computeCompositeScore(avgFuseScore, tokens.length, tokens.length, scoringConfig);

		results.push({
			message,
			score: compositeScore,
			rawFuseScore: avgFuseScore,
			matchedTerms,
		});
	}

	// Sort by composite score descending
	results.sort((a, b) => b.score - a.score);

	return results;
}

/**
 * Executes a parsed query against the cached index.
 * @param query - Parsed query with mode and tokens.
 * @param scoringConfig - Optional scoring configuration.
 * @returns Search results sorted by relevance.
 */
export function executeSearch(query: ParsedQuery, scoringConfig: ScoringConfig = DEFAULT_SCORING): SearchResult[]
{
	if (!fuseIndex)
	{
		throw new Error("Search index not initialized. Call initSearchIndex() first.");
	}

	if (query.tokens.length === 0)
	{
		return [];
	}

	if (query.mode === "and")
	{
		return executeAndQuery(query.tokens, scoringConfig);
	} else
	{
		return executeOrQuery(query.tokens, scoringConfig);
	}
}
