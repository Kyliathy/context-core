/**
 * Thread aggregation for search results.
 * Groups individual message matches into conversation thread summaries.
 */

import type { IMessageStore } from "../db/IMessageStore.js";
import type { SearchResult } from "./searchEngine.js";
import type { AgentThread } from "../models/AgentThread.js";
import type { TopicStore } from "../settings/TopicStore.js";
import { countTermHits } from "./queryParser.js";

function resolveSubject(sessionId: string, originalSubject: string, topicStore?: TopicStore): string
{
	if (!topicStore) return originalSubject;
	const entry = topicStore.getBySessionId(sessionId);
	if (!entry) return originalSubject;
	if (entry.customTopic) return entry.customTopic;
	if (entry.aiSummary) return entry.aiSummary;
	return originalSubject;
}

export type ThreadSearchResult = {
	total: number;
	page: number;
	results: AgentThread[];
};

// ThreadAccumulator is just an alias for the building process
type ThreadAccumulator = AgentThread;

/**
 * Aggregates search results into thread summaries.
 * Groups matching messages by sessionId, computes metadata for each thread.
 * @param searchResults - Individual message search results with scores.
 * @param db - MessageDB instance for fetching full session data.
 * @returns Thread results sorted by bestMatchScore descending.
 */
export function aggregateToThreads(
	searchResults: SearchResult[],
	db: IMessageStore,
	topicStore?: TopicStore
): ThreadSearchResult
{
	if (searchResults.length === 0)
	{
		return { total: 0, page: 1, results: [] };
	}

	// Group search results by sessionId
	const sessionGroups = new Map<string, SearchResult[]>();
	for (const result of searchResults)
	{
		const sessionId = result.message.sessionId;
		const group = sessionGroups.get(sessionId);
		if (group)
		{
			group.push(result);
		} else
		{
			sessionGroups.set(sessionId, [result]);
		}
	}

	// Build thread metadata for each unique session
	const threads: ThreadAccumulator[] = [];

	for (const [sessionId, matches] of sessionGroups)
	{
		// Fetch all messages in the session for complete metadata
		const sessionMessages = db.getBySessionId(sessionId);

		if (sessionMessages.length === 0)
		{
			continue; // Skip orphaned sessions
		}

		// Compute thread metadata
		const totalLength = sessionMessages.reduce((sum, msg) => sum + msg.length, 0);
		const dateTimes = sessionMessages.map((msg) => msg.dateTime.toISO() ?? "");
		const firstDateTime = dateTimes.reduce((a, b) => (a < b ? a : b));
		const lastDateTime = dateTimes.reduce((a, b) => (a > b ? a : b));

		// Best match score from search results (not all session messages)
		const bestMatchScore = Math.max(...matches.map((m) => m.score));

		// Matching message IDs (only the ones that matched the query)
		const matchingMessageIds = matches.map((m) => m.message.id);

		// Sum hits across all matching messages
		const totalHits = matches.reduce((sum, m) =>
			sum + countTermHits(m.message.message, m.matchedTerms), 0);

		// Use first message for subject/harness (could also use most recent)
		const firstMessage = sessionMessages[0];

		threads.push({
			sessionId,
			subject: resolveSubject(sessionId, firstMessage.subject, topicStore),
			harness: firstMessage.harness,
			project: firstMessage.project,
			messageCount: sessionMessages.length,
			totalLength,
			firstDateTime,
			lastDateTime,
			firstMessage: firstMessage.message,
			matchingMessageIds,
			bestMatchScore,
			hits: totalHits,
		});
	}

	// Sort by bestMatchScore descending (higher = better match)
	threads.sort((a, b) => b.bestMatchScore - a.bestMatchScore);

	// Return all results (no pagination)
	return {
		total: threads.length,
		page: 1,
		results: threads,
	};
}

/**
 * Gets the latest conversation threads sorted by most recent activity.
 * Returns thread metadata for recent sessions without requiring a search query.
 * @param db - MessageDB instance for fetching session data.
 * @param limit - Maximum number of threads to return (default 100).
 * @param topicStore - Optional topic store for subject resolution.
 * @param fromEpoch - Optional epoch ms; threads whose lastDateTime < fromEpoch are excluded.
 * @returns Thread results sorted by lastDateTime descending.
 */
export function getLatestThreads(
	db: IMessageStore,
	limit = 100,
	topicStore?: TopicStore,
	fromEpoch?: number
): ThreadSearchResult
{
	// Get all sessions sorted by most recent activity
	const sessionSummaries = db.listSessions();

	// Build thread metadata for each session
	const threads: AgentThread[] = [];

	for (const summary of sessionSummaries)
	{
		// Fetch all messages in the session for complete metadata
		const sessionMessages = db.getBySessionId(summary.sessionId);

		if (sessionMessages.length === 0)
		{
			continue; // Skip empty sessions
		}

		// Compute total length across all messages
		const totalLength = sessionMessages.reduce((sum, msg) => sum + msg.length, 0);

		// Get first and last message
		const firstMessage = sessionMessages[0];
		const lastMessage = sessionMessages[sessionMessages.length - 1];

		// Extract timestamps
		const dateTimes = sessionMessages.map((msg) => msg.dateTime.toISO() ?? "");
		const firstDateTime = dateTimes.reduce((a, b) => (a < b ? a : b));
		const lastDateTime = dateTimes.reduce((a, b) => (a > b ? a : b));

		// Apply date filter before limit
		if (fromEpoch !== undefined && !Number.isNaN(fromEpoch))
		{
			const lastEpoch = Date.parse(lastDateTime);
			if (Number.isNaN(lastEpoch) || lastEpoch < fromEpoch) continue;
		}

		threads.push({
			sessionId: summary.sessionId,
			subject: resolveSubject(summary.sessionId, firstMessage.subject, topicStore),
			harness: summary.harness,
			project: firstMessage.project,
			messageCount: sessionMessages.length,
			totalLength,
			firstDateTime,
			lastDateTime,
			firstMessage: firstMessage.message,
			matchingMessageIds: [lastMessage.id], // For latest threads, clicking opens the most recent message
			bestMatchScore: 1.0, // Not a search result, so all threads have equal "score"
			hits: 0,
		});
	}

	// Sort by lastDateTime descending (most recent first)
	threads.sort((a, b) => {
		if (b.lastDateTime > a.lastDateTime) return 1;
		if (b.lastDateTime < a.lastDateTime) return -1;
		return 0;
	});

	// Apply limit
	const limitedThreads = threads.slice(0, limit);

	return {
		total: limitedThreads.length,
		page: 1,
		results: limitedThreads,
	};
}
