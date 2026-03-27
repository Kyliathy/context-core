/**
 * MCP prompt definitions and handlers.
 *
 * Prompts are pre-built conversation starters that inject relevant context
 * from ContextCore's conversation archive. Each prompt fetches fresh data
 * from MessageDB at invocation time, not at registration time.
 *
 * Prompts:
 * - explore_history   — "What has been discussed about {topic}?"
 * - summarize_session — "Summarize this conversation"
 * - find_decisions    — "What design decisions were made about {component}?"
 * - debug_history     — "What debugging has been done for {issue}?"
 */

import type { IMessageStore } from "../../db/IMessageStore.js";
import type { TopicStore } from "../../settings/TopicStore.js";
import { parseSearchQuery } from "../../search/queryParser.js";
import { executeSearch } from "../../search/searchEngine.js";
import { aggregateToThreads } from "../../search/threadAggregator.js";
import { formatSession, excerpt, resolveSubject } from "../formatters.js";

// ─── Prompt definitions (for ListPrompts) ────────────────────────────────────

export const PROMPT_DEFINITIONS = [
	{
		name: "explore_history",
		description:
			"Search the AI conversation archive for discussions about a topic. " +
			"Returns matching conversation threads as structured context for the LLM to analyze.",
		arguments: [
			{
				name: "topic",
				description:
					"The topic, keyword, or phrase to search for in conversation history. " +
					"Supports query syntax: space for OR, + for AND, quotes for exact phrase " +
					"(e.g., 'auth + middleware', '\"error handling\"').",
				required: true,
			},
		],
	},
	{
		name: "summarize_session",
		description:
			"Retrieve a full conversation session and present it for summarization. " +
			"Returns the session transcript with metadata, ready for the LLM to summarize.",
		arguments: [
			{
				name: "sessionId",
				description: "The session identifier to retrieve and summarize.",
				required: true,
			},
		],
	},
	{
		name: "find_decisions",
		description:
			"Search for design and architecture decisions made about a specific component or topic. " +
			"Returns relevant conversation excerpts where decisions were discussed.",
		arguments: [
			{
				name: "component",
				description:
					"The component, module, or topic to find decisions about. " +
					"Supports query syntax: space for OR, + for AND, quotes for exact phrase.",
				required: true,
			},
		],
	},
	{
		name: "debug_history",
		description:
			"Search for debugging sessions related to a specific issue or error. " +
			"Returns a chronological view of debugging conversations to understand what was tried.",
		arguments: [
			{
				name: "issue",
				description:
					"The issue, error, or bug to search debugging history for. " +
					"Supports query syntax: space for OR, + for AND, quotes for exact phrase.",
				required: true,
			},
		],
	},
];

// ─── Prompt result types ──────────────────────────────────────────────────────

interface PromptMessage
{
	role: "user" | "assistant";
	content: { type: "text"; text: string };
}

export interface PromptResult
{
	description?: string;
	messages: PromptMessage[];
}

// ─── Prompt handler ───────────────────────────────────────────────────────────

/**
 * Handles a prompts/get request.
 * Fetches fresh data from MessageDB and returns structured prompt messages.
 */
export function handlePrompt(
	name: string,
	args: Record<string, string>,
	db: IMessageStore,
	topicStore?: TopicStore
): PromptResult
{
	switch (name)
	{
		case "explore_history":
			return buildExploreHistory(args.topic ?? "", db, topicStore);
		case "summarize_session":
			return buildSummarizeSession(args.sessionId ?? "", db, topicStore);
		case "find_decisions":
			return buildFindDecisions(args.component ?? "", db, topicStore);
		case "debug_history":
			return buildDebugHistory(args.issue ?? "", db, topicStore);
		default:
			return {
				description: `Unknown prompt: ${name}`,
				messages: [{ role: "user", content: { type: "text", text: `Unknown prompt: ${name}` } }],
			};
	}
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildExploreHistory(topic: string, db: IMessageStore, topicStore?: TopicStore): PromptResult
{
	if (!topic.trim())
	{
		return {
			description: "Explore conversation history about a topic",
			messages: [{ role: "user", content: { type: "text", text: "Error: 'topic' argument is required." } }],
		};
	}

	const parsed = parseSearchQuery(topic);
	const results = executeSearch(parsed);
	const threads = aggregateToThreads(results, db, topicStore);

	if (threads.total === 0)
	{
		return {
			description: `No conversations found about "${topic}"`,
			messages: [{
				role: "user",
				content: {
					type: "text",
					text: `I searched the conversation archive for "${topic}" but found no matching discussions. ` +
						`Try a different search term or check available projects via the cxc://projects resource.`,
				},
			}],
		};
	}

	const threadSummaries = threads.results.slice(0, 10).map((t, i) =>
	{
		const from = t.firstDateTime.slice(0, 10);
		const to = t.lastDateTime.slice(0, 10);
		const dateRange = from === to ? from : `${from} → ${to}`;
		return [
			`[${i + 1}] Session: ${t.sessionId}`,
			`  Subject: ${t.subject}`,
			`  Harness: ${t.harness} | Messages: ${t.messageCount} | ${dateRange}`,
			`  Score: ${(t.bestMatchScore * 100).toFixed(0)}%`,
			`  First message: ${excerpt(t.firstMessage, 200)}`,
		].join("\n");
	}).join("\n\n");

	const text = [
		`I want to explore what has been discussed about "${topic}" in my AI conversation history.`,
		``,
		`Here are the ${Math.min(threads.total, 10)} most relevant conversation threads (out of ${threads.total} total matches):`,
		``,
		threadSummaries,
		``,
		`Based on these conversations, please:`,
		`1. Identify the key themes and topics discussed about "${topic}"`,
		`2. Highlight any important decisions, conclusions, or insights`,
		`3. Note any unresolved questions or areas that need further exploration`,
		`4. If you need more detail on a specific session, use get_session with its sessionId`,
	].join("\n");

	return {
		description: `Exploring conversation history about "${topic}" — ${threads.total} threads found`,
		messages: [{ role: "user", content: { type: "text", text } }],
	};
}

function buildSummarizeSession(sessionId: string, db: IMessageStore, topicStore?: TopicStore): PromptResult
{
	if (!sessionId.trim())
	{
		return {
			description: "Summarize a conversation session",
			messages: [{ role: "user", content: { type: "text", text: "Error: 'sessionId' argument is required." } }],
		};
	}

	const messages = db.getBySessionId(sessionId);
	if (messages.length === 0)
	{
		return {
			description: `Session not found: ${sessionId}`,
			messages: [{
				role: "user",
				content: {
					type: "text",
					text: `No messages found for session "${sessionId}". ` +
						`Use list_sessions or cxc://projects to find valid session IDs.`,
				},
			}],
		};
	}

	const transcript = formatSession(messages, topicStore, 50);
	const firstMsg = messages[0];
	const subject = resolveSubject(firstMsg.sessionId, firstMsg.subject, topicStore);

	const text = [
		`Here is a conversation transcript from session "${sessionId}":`,
		`Subject: ${subject}`,
		`Harness: ${firstMsg.harness} | Project: ${firstMsg.project}`,
		`Messages: ${messages.length}`,
		``,
		`--- TRANSCRIPT ---`,
		transcript,
		`--- END TRANSCRIPT ---`,
		``,
		`Please provide a concise summary of this conversation, including:`,
		`1. The main topic and objective of the conversation`,
		`2. Key decisions made or conclusions reached`,
		`3. Important code changes or technical details discussed`,
		`4. Any action items, open questions, or follow-ups`,
	].join("\n");

	return {
		description: `Summarizing session "${sessionId}" — ${subject}`,
		messages: [{ role: "user", content: { type: "text", text } }],
	};
}

function buildFindDecisions(component: string, db: IMessageStore, topicStore?: TopicStore): PromptResult
{
	if (!component.trim())
	{
		return {
			description: "Find design decisions about a component",
			messages: [{ role: "user", content: { type: "text", text: "Error: 'component' argument is required." } }],
		};
	}

	// Search for decision-related terms combined with the component
	const decisionResults = executeSearch(parseSearchQuery(`${component} + decision`));
	const architectureResults = executeSearch(parseSearchQuery(`${component} + architecture`));
	// Broader search for the component name itself
	const componentResults = executeSearch(parseSearchQuery(component));

	// Merge and deduplicate by message ID
	const seen = new Set<string>();
	const allResults = [...decisionResults, ...architectureResults, ...componentResults]
		.filter((r) =>
		{
			if (seen.has(r.message.id)) return false;
			seen.add(r.message.id);
			return true;
		})
		.sort((a, b) => b.score - a.score)
		.slice(0, 20);

	if (allResults.length === 0)
	{
		return {
			description: `No decisions found about "${component}"`,
			messages: [{
				role: "user",
				content: {
					type: "text",
					text: `I searched for design decisions about "${component}" but found no relevant conversations. ` +
						`Try searching with different terms or check available projects.`,
				},
			}],
		};
	}

	// Group by session for context
	const sessionMap = new Map<string, typeof allResults>();
	for (const r of allResults)
	{
		const sid = r.message.sessionId;
		if (!sessionMap.has(sid)) sessionMap.set(sid, []);
		sessionMap.get(sid)!.push(r);
	}

	const excerptBlocks = Array.from(sessionMap.entries())
		.slice(0, 8)
		.map(([sid, results]) =>
		{
			const firstMsg = results[0].message;
			const subject = resolveSubject(sid, firstMsg.subject, topicStore);
			const dt = firstMsg.dateTime.toISO()?.slice(0, 10) ?? "?";
			const excerpts = results.slice(0, 3).map((r) =>
			{
				const role = r.message.role.toUpperCase();
				return `  [${role}] ${excerpt(r.message.message, 300)}`;
			}).join("\n");

			return [
				`Session: ${sid} (${dt})`,
				`Subject: ${subject}`,
				`Harness: ${firstMsg.harness} | Project: ${firstMsg.project}`,
				excerpts,
			].join("\n");
		}).join("\n\n");

	const text = [
		`I'm looking for design decisions and architectural choices made about "${component}".`,
		``,
		`Here are relevant conversation excerpts from ${sessionMap.size} sessions (${allResults.length} matching messages):`,
		``,
		excerptBlocks,
		``,
		`Based on these conversations, please:`,
		`1. List all design decisions made about "${component}", chronologically`,
		`2. For each decision, note the rationale if discussed`,
		`3. Identify any decisions that were reversed or reconsidered`,
		`4. Highlight any open design questions that weren't resolved`,
		`5. If you need the full context of a session, use get_session with its sessionId`,
	].join("\n");

	return {
		description: `Finding design decisions about "${component}" — ${allResults.length} relevant messages in ${sessionMap.size} sessions`,
		messages: [{ role: "user", content: { type: "text", text } }],
	};
}

function buildDebugHistory(issue: string, db: IMessageStore, topicStore?: TopicStore): PromptResult
{
	if (!issue.trim())
	{
		return {
			description: "Find debugging history for an issue",
			messages: [{ role: "user", content: { type: "text", text: "Error: 'issue' argument is required." } }],
		};
	}

	// Search for the issue combined with debugging-related terms
	const debugResults = executeSearch(parseSearchQuery(`${issue} + debug`));
	const errorResults = executeSearch(parseSearchQuery(`${issue} + error`));
	const fixResults = executeSearch(parseSearchQuery(`${issue} + fix`));
	// Broader search for the issue itself
	const issueResults = executeSearch(parseSearchQuery(issue));

	// Merge and deduplicate
	const seen = new Set<string>();
	const allResults = [...debugResults, ...errorResults, ...fixResults, ...issueResults]
		.filter((r) =>
		{
			if (seen.has(r.message.id)) return false;
			seen.add(r.message.id);
			return true;
		})
		.sort((a, b) =>
		{
			// Sort chronologically for debugging narrative
			const dtA = a.message.dateTime.toMillis();
			const dtB = b.message.dateTime.toMillis();
			return dtA - dtB;
		})
		.slice(0, 30);

	if (allResults.length === 0)
	{
		return {
			description: `No debugging history found for "${issue}"`,
			messages: [{
				role: "user",
				content: {
					type: "text",
					text: `I searched for debugging history related to "${issue}" but found no relevant conversations. ` +
						`Try different search terms or broaden your query.`,
				},
			}],
		};
	}

	// Group by session, preserving chronological order
	const sessionOrder: string[] = [];
	const sessionMap = new Map<string, typeof allResults>();
	for (const r of allResults)
	{
		const sid = r.message.sessionId;
		if (!sessionMap.has(sid))
		{
			sessionMap.set(sid, []);
			sessionOrder.push(sid);
		}
		sessionMap.get(sid)!.push(r);
	}

	const sessionBlocks = sessionOrder.slice(0, 10).map((sid) =>
	{
		const results = sessionMap.get(sid)!;
		const firstMsg = results[0].message;
		const subject = resolveSubject(sid, firstMsg.subject, topicStore);
		const firstDt = results[0].message.dateTime.toISO()?.slice(0, 16) ?? "?";
		const lastDt = results[results.length - 1].message.dateTime.toISO()?.slice(0, 16) ?? "?";

		const timeline = results.slice(0, 5).map((r) =>
		{
			const dt = r.message.dateTime.toISO()?.slice(11, 16) ?? "?";
			const role = r.message.role.toUpperCase();
			return `  [${dt}] ${role}: ${excerpt(r.message.message, 250)}`;
		}).join("\n");

		return [
			`Session: ${sid}`,
			`Subject: ${subject}`,
			`Harness: ${firstMsg.harness} | Project: ${firstMsg.project}`,
			`Time: ${firstDt} → ${lastDt} | ${results.length} relevant messages`,
			timeline,
		].join("\n");
	}).join("\n\n");

	const text = [
		`I want to understand the debugging history for "${issue}".`,
		``,
		`Here are the relevant debugging sessions in chronological order (${sessionOrder.length} sessions, ${allResults.length} messages):`,
		``,
		sessionBlocks,
		``,
		`Based on these debugging sessions, please provide:`,
		`1. A chronological narrative of the debugging efforts`,
		`2. What approaches were tried and their outcomes`,
		`3. The root cause (if identified)`,
		`4. The final fix or resolution (if any)`,
		`5. Any lessons learned or patterns to watch for`,
		`6. If the issue is unresolved, suggest next debugging steps`,
	].join("\n");

	return {
		description: `Debugging history for "${issue}" — ${allResults.length} messages across ${sessionOrder.length} sessions`,
		messages: [{ role: "user", content: { type: "text", text } }],
	};
}
