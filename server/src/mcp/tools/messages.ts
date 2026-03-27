/**
 * MCP tool definitions and handlers for message and session retrieval.
 *
 * Tools:
 * - get_message        — single message by ID
 * - get_session        — all messages in a session (head+tail truncation for long sessions)
 * - list_sessions      — session summaries sorted by recency
 * - query_messages     — filtered + paginated message listing (role, harness, model, project, date)
 * - get_latest_threads — most recent conversation threads; supports fromDate to filter by activity date
 */

import type { IMessageStore } from "../../db/IMessageStore.js";
import type { TopicStore } from "../../settings/TopicStore.js";
import { getLatestThreads } from "../../search/threadAggregator.js";
import {
	formatMessage,
	formatSession,
	formatThread,
	resolveSubject,
} from "../formatters.js";

export const MESSAGE_TOOL_DEFINITIONS = [
	{
		name: "get_message",
		description:
			"Retrieve a single AI conversation message by its unique ID. Returns the full message content plus metadata (role, model, harness, project, datetime, token usage, tool calls).",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description: "The unique message ID (16-char hex string).",
				},
				includeAssistantMessages: {
					type: "boolean",
					description:
						"Default: true. Set to false to reject non-human messages (returns an error if the requested message is from the assistant).",
				},
			},
			required: ["id"],
		},
	},
	{
		name: "get_session",
		description:
			"Retrieve all messages in a conversation session, ordered chronologically. For sessions with more than 30 messages, shows the first 5 and last 5 with an omission notice. Pass maxMessages to control the threshold.",
		inputSchema: {
			type: "object",
			properties: {
				sessionId: {
					type: "string",
					description: "The session identifier.",
				},
				maxMessages: {
					type: "number",
					description: "Maximum messages to show before truncating to head+tail. Default: 30.",
				},
				includeAssistantMessages: {
					type: "boolean",
					description:
						"Default: true. Set to false to show only human messages in the session transcript.",
				},
			},
			required: ["sessionId"],
		},
	},
	{
		name: "list_sessions",
		description:
			"List all conversation sessions sorted by most recent activity. Each entry includes: sessionId, harness, message count, date range, and resolved subject (customTopic > aiSummary > NLP subject).",
		inputSchema: {
			type: "object",
			properties: {
				limit: {
					type: "number",
					description: "Maximum number of sessions to return. Default: 50.",
				},
			},
		},
	},
	{
		name: "query_messages",
		description:
			"Query messages with optional filters and pagination. Useful for browsing messages by role (user/assistant), harness (ClaudeCode, Cursor, Kiro, VSCode), model, project, or date range. " +
			"By default returns only human (user) messages — set includeAssistantMessages: true or pass role: 'assistant' to include AI responses.",
		inputSchema: {
			type: "object",
			properties: {
				role: {
					type: "string",
					description:
						"Filter by role: 'user' or 'assistant'. When set, takes priority over includeAssistantMessages.",
					enum: ["user", "assistant"],
				},
				harness: {
					type: "string",
					description: "Filter by harness: 'ClaudeCode', 'Cursor', 'Kiro', or 'VSCode'.",
				},
				model: {
					type: "string",
					description: "Filter by model name (e.g. 'claude-opus-4-6', 'gpt-5').",
				},
				project: {
					type: "string",
					description: "Filter by project name.",
				},
				from: {
					type: "string",
					description: "Filter messages from this ISO datetime (inclusive).",
				},
				to: {
					type: "string",
					description: "Filter messages until this ISO datetime (inclusive).",
				},
				page: {
					type: "number",
					description: "Page number (1-based). Default: 1.",
				},
				pageSize: {
					type: "number",
					description: "Results per page. Default: 20, max recommended: 50.",
				},
				includeAssistantMessages: {
					type: "boolean",
					description:
						"Include assistant/AI responses in results. Default: false. " +
						"Only set to true when performing deep research into what the AI suggested or implemented. " +
						"Ignored when 'role' is explicitly set.",
				},
			},
		},
	},
	{
		name: "get_latest_threads",
		description:
			"Get the most recent conversation threads sorted by last activity. Each thread includes: sessionId, subject, harness, message count, total length, date range, and the first message text.",
		inputSchema: {
			type: "object",
			properties: {
				limit: {
					type: "number",
					description: "Maximum number of threads to return. Default: 20.",
				},
				fromDate: {
					type: "string",
					description:
						"Only include threads with activity on or after this ISO date (YYYY-MM-DD). " +
						"When omitted, no date filter is applied. Example: '2026-03-15'.",
				},
			},
		},
	},
];

/**
 * Handles a call to any message/session tool.
 * Returns { text } on success, throws on unrecognized tool name.
 */
export function handleMessageTool(
	toolName: string,
	args: Record<string, unknown>,
	db: IMessageStore,
	topicStore?: TopicStore
): string
{
	switch (toolName)
	{
		case "get_message":
		{
			const id = String(args.id ?? "").trim();
			if (!id) return "Error: 'id' is required.";

			const msg = db.getById(id);
			if (!msg) return `No message found with ID: ${id}`;

			// When includeAssistantMessages is explicitly false, reject non-human messages
			if (args.includeAssistantMessages === false && msg.role !== "user")
			{
				return `Message ${id} is a ${msg.role} message. Pass includeAssistantMessages: true to retrieve non-human messages.`;
			}

			return formatMessage(msg, topicStore);
		}

		case "get_session":
		{
			const sessionId = String(args.sessionId ?? "").trim();
			if (!sessionId) return "Error: 'sessionId' is required.";

			let messages = db.getBySessionId(sessionId);
			if (messages.length === 0) return `No messages found for session: ${sessionId}`;

			// When includeAssistantMessages is explicitly false, show only human messages
			if (args.includeAssistantMessages === false)
			{
				messages = messages.filter((m) => m.role === "user");
				if (messages.length === 0) return `No human messages found for session: ${sessionId}`;
			}

			const maxMessages = typeof args.maxMessages === "number" ? args.maxMessages : 30;
			return formatSession(messages, topicStore, maxMessages);
		}

		case "list_sessions":
		{
			const limit = typeof args.limit === "number" ? Math.max(1, args.limit) : 50;
			const sessions = db.listSessions().slice(0, limit);

			if (sessions.length === 0) return "No sessions found in the database.";

			const lines: string[] = [
				`Sessions (showing ${sessions.length}):`,
				"",
			];

			sessions.forEach((s, idx) =>
			{
				const subject = resolveSubject(s.sessionId, "", topicStore);
				const from = s.firstDateTime.slice(0, 10);
				const to = s.lastDateTime.slice(0, 10);
				const dateRange = from === to ? from : `${from} → ${to}`;
				lines.push(`[${idx + 1}] ${s.sessionId}`);
				lines.push(`  Harness: ${s.harness} | Messages: ${s.count} | ${dateRange}`);
				if (subject)
				{
					lines.push(`  Subject: ${subject}`);
				}
				lines.push("");
			});

			return lines.join("\n");
		}

		case "query_messages":
		{
			const pageSize = typeof args.pageSize === "number" ? Math.min(args.pageSize, 50) : 20;

			// Role resolution: explicit 'role' param takes priority.
			// When role is omitted and includeAssistantMessages is not true, default to user-only.
			let roleFilter = args.role as string | undefined;
			if (!roleFilter && args.includeAssistantMessages !== true)
			{
				roleFilter = "user";
			}

			const result = db.queryMessages({
				role: roleFilter,
				harness: args.harness as string | undefined,
				model: args.model as string | undefined,
				project: args.project as string | undefined,
				from: args.from as string | undefined,
				to: args.to as string | undefined,
				page: typeof args.page === "number" ? args.page : 1,
				pageSize,
			});

			if (result.results.length === 0)
			{
				return `No messages match the given filters. Total in DB: ${result.total}`;
			}

			const lines: string[] = [
				`Messages: page ${result.page}, showing ${result.results.length} of ${result.total} total.`,
				"",
			];

			result.results.forEach((msg, idx) =>
			{
				const dt = msg.dateTime.toISO()?.slice(0, 16) ?? "?";
				const model = msg.model ? ` [${msg.model}]` : "";
				lines.push(
					`[${idx + 1}] ${msg.id} | ${msg.role.toUpperCase()}${model} | ${msg.harness}/${msg.project} | ${dt}`
				);
				lines.push(`  ${msg.message.slice(0, 120).replace(/\n/g, " ")}…`);
				lines.push("");
			});

			return lines.join("\n");
		}

		case "get_latest_threads":
		{
			const limit = typeof args.limit === "number" ? Math.max(1, args.limit) : 20;
			const rawFromDate = typeof args.fromDate === "string" ? args.fromDate.trim() : "";
			const fromEpoch = rawFromDate ? Date.parse(`${rawFromDate}T00:00:00.000Z`) : undefined;
			const result = getLatestThreads(db, limit, topicStore, fromEpoch);

			if (result.results.length === 0) return "No threads found in the database.";

			const lines: string[] = [
				`Latest threads (${result.results.length}):`,
				"",
			];

			result.results.forEach((thread, idx) =>
			{
				lines.push(`[${idx + 1}] ${formatThread(thread)}`);
				lines.push("");
			});

			return lines.join("\n");
		}

		default:
			throw new Error(`Unknown message tool: ${toolName}`);
	}
}
