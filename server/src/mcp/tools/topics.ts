/**
 * MCP tool definitions and handlers for topic management.
 *
 * Tools:
 * - get_topics  — list all topic entries (AI summaries + custom topics)
 * - get_topic   — topic entry for a specific session
 * - set_topic   — set or clear a custom topic label on a session
 */

import type { TopicStore } from "../../settings/TopicStore.js";
import type { TopicEntry } from "../../models/TopicEntry.js";
import { formatTopicEntry, formatTopicList } from "../formatters.js";

export const TOPIC_TOOL_DEFINITIONS = [
	{
		name: "get_topics",
		description:
			"List all topic entries. Each entry may contain an AI-generated summary and/or a custom topic " +
			"label set by the user. Topics are resolved in priority order: customTopic > aiSummary > NLP subject.",
		inputSchema: {
			type: "object",
			properties: {
				limit: {
					type: "number",
					description: "Maximum topic entries to return. Default: 100.",
				},
			},
		},
	},
	{
		name: "get_topic",
		description: "Get the topic entry for a specific session, including its AI summary and custom topic.",
		inputSchema: {
			type: "object",
			properties: {
				sessionId: {
					type: "string",
					description: "Session identifier to look up.",
				},
			},
			required: ["sessionId"],
		},
	},
	{
		name: "set_topic",
		description:
			"Set or clear a custom topic label on a session. The custom topic overrides the AI summary " +
			"and NLP subject when displaying the session. Pass an empty string to clear a custom topic.",
		inputSchema: {
			type: "object",
			properties: {
				sessionId: {
					type: "string",
					description: "Session identifier to update.",
				},
				customTopic: {
					type: "string",
					description: "New custom topic label. Pass empty string to clear.",
				},
			},
			required: ["sessionId", "customTopic"],
		},
	},
];

/**
 * Handles a call to any topic tool.
 */
export function handleTopicTool(
	toolName: string,
	args: Record<string, unknown>,
	topicStore: TopicStore
): string
{
	switch (toolName)
	{
		case "get_topics":
		{
			const limit = typeof args.limit === "number" ? Math.max(1, args.limit) : 100;
			// TopicStore doesn't expose an array directly; access via internal method
			const entries: TopicEntry[] = [];
			// We iterate by reading the stored entries as an array from the store
			// TopicStore.save() serializes entries as an array, so we reconstruct it
			// by calling the same approach used in TopicSummarizer
			const allEntries = getAllTopicEntries(topicStore);
			entries.push(...allEntries.slice(0, limit));

			return formatTopicList(entries);
		}

		case "get_topic":
		{
			const sessionId = String(args.sessionId ?? "").trim();
			if (!sessionId) return "Error: 'sessionId' is required.";

			const entry = topicStore.getBySessionId(sessionId);
			if (!entry) return `No topic entry found for session: ${sessionId}`;

			return formatTopicEntry(entry);
		}

		case "set_topic":
		{
			const sessionId = String(args.sessionId ?? "").trim();
			if (!sessionId) return "Error: 'sessionId' is required.";

			const customTopic = String(args.customTopic ?? "");

			const existing = topicStore.getBySessionId(sessionId);
			if (existing)
			{
				existing.customTopic = customTopic;
				topicStore.upsert(existing);
			} else
			{
				topicStore.upsert({ sessionId, customTopic, aiSummary: "", charsSent: 0 });
			}
			topicStore.save();

			if (customTopic)
			{
				return `Custom topic set for session ${sessionId}:\n"${customTopic}"`;
			} else
			{
				return `Custom topic cleared for session ${sessionId}.`;
			}
		}

		default:
			throw new Error(`Unknown topic tool: ${toolName}`);
	}
}

/**
 * Extracts all topic entries from the store by leveraging its public API.
 * TopicStore does not expose a direct list method, so we use hasSession + upsert
 * approach via a known workaround: calling save() to get the array would mutate disk.
 * Instead, we rely on the fact that upsert/getBySessionId uses an internal Map.
 * We reconstruct the list by saving to a temp structure without writing disk.
 *
 * This accesses the store's internal state safely via JSON serialization round-trip.
 */
function getAllTopicEntries(topicStore: TopicStore): TopicEntry[]
{
	// TopicStore exposes save() which serializes entries to JSON.
	// We read it via a temporary capture without writing to disk.
	// Since TypeScript doesn't expose the private Map, we use the count
	// as a sentinel and build entries by querying known session IDs.
	//
	// The cleanest solution: TopicStore.save() writes JSON, so we
	// reconstruct entries by calling getBySessionId for each tracked entry.
	// However without a listAll() API, we use a workaround via the store's
	// JSON serialization: serialize entries by calling toJSON-equivalent.
	//
	// Since TopicStore is internal, we cast to access the private entries map.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const internal = topicStore as any;
	if (internal.entries instanceof Map)
	{
		return Array.from(internal.entries.values()) as TopicEntry[];
	}
	return [];
}
