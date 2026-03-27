/**
 * MCP response formatters.
 * Converts internal models into LLM-friendly text strings.
 *
 * Strategy:
 * - Single messages: full content + key metadata
 * - Sessions >30 msgs: first 5 + last 5 with an omission notice
 * - Search results >20: top 20 by score, total count noted
 * - Excerpts: first 300 chars for search hits
 */

import type { AgentMessage } from "../models/AgentMessage.js";
import type { AgentThread } from "../models/AgentThread.js";
import type { TopicEntry } from "../models/TopicEntry.js";
import type { TopicStore } from "../settings/TopicStore.js";
import type { SearchResult } from "../search/searchEngine.js";

/**
 * Result type for symbol-based search with occurrence counting.
 */
export type SymbolSearchResult = {
	message: AgentMessage;
	occurrenceCount: number;
	score: number;
};

const EXCERPT_CHARS = 300;
const MAX_SEARCH_RESULTS = 20;
const SESSION_HEAD_TAIL = 5;

/**
 * Priority: customTopic → aiSummary → original subject.
 */
export function resolveSubject(sessionId: string, originalSubject: string, topicStore?: TopicStore): string
{
	if (!topicStore) return originalSubject;
	const entry = topicStore.getBySessionId(sessionId);
	if (!entry) return originalSubject;
	if (entry.customTopic) return entry.customTopic;
	if (entry.aiSummary) return entry.aiSummary;
	return originalSubject;
}

/**
 * Truncates text to maxChars, appending "…" when trimmed.
 */
export function excerpt(text: string, maxChars = EXCERPT_CHARS): string
{
	if (text.length <= maxChars) return text;
	return text.slice(0, maxChars).trimEnd() + "…";
}

/**
 * Formats a single AgentMessage as readable text for LLM consumption.
 */
export function formatMessage(msg: AgentMessage, topicStore?: TopicStore): string
{
	const subject = resolveSubject(msg.sessionId, msg.subject, topicStore);
	const dt = msg.dateTime.toISO() ?? "unknown";
	const model = msg.model ? ` | model: ${msg.model}` : "";
	const tokens = msg.tokenUsage
		? ` | tokens: in=${msg.tokenUsage.input ?? "?"} out=${msg.tokenUsage.output ?? "?"}`
		: "";

	const lines: string[] = [
		`ID: ${msg.id}`,
		`Session: ${msg.sessionId}`,
		`Subject: ${subject}`,
		`Role: ${msg.role}${model}`,
		`Harness: ${msg.harness} | Project: ${msg.project} | Machine: ${msg.machine}`,
		`DateTime: ${dt}${tokens}`,
	];

	if (msg.context.length > 0)
	{
		lines.push(`Context files: ${msg.context.join(", ")}`);
	}

	if (msg.toolCalls.length > 0)
	{
		const names = msg.toolCalls.map((t) => t.name).join(", ");
		lines.push(`Tool calls: ${names}`);
	}

	lines.push("", msg.message);

	return lines.join("\n");
}

/**
 * Formats all messages in a session.
 * For sessions >30 messages, shows first N + last N with an omission notice.
 */
export function formatSession(
	messages: AgentMessage[],
	topicStore?: TopicStore,
	maxMessages = 30
): string
{
	if (messages.length === 0)
	{
		return "No messages found in this session.";
	}

	const firstMsg = messages[0];
	const subject = resolveSubject(firstMsg.sessionId, firstMsg.subject, topicStore);
	const totalChars = messages.reduce((s, m) => s + m.length, 0);
	const head: AgentMessage[] = [];
	const tail: AgentMessage[] = [];
	let omitted = 0;

	if (messages.length <= maxMessages)
	{
		head.push(...messages);
	} else
	{
		head.push(...messages.slice(0, SESSION_HEAD_TAIL));
		tail.push(...messages.slice(-SESSION_HEAD_TAIL));
		omitted = messages.length - SESSION_HEAD_TAIL * 2;
	}

	const lines: string[] = [
		`=== Session: ${firstMsg.sessionId} ===`,
		`Subject: ${subject}`,
		`Harness: ${firstMsg.harness} | Project: ${firstMsg.project}`,
		`Messages: ${messages.length} | Total chars: ${totalChars.toLocaleString()}`,
		"",
	];

	const renderMessages = (msgs: AgentMessage[]) =>
	{
		for (const msg of msgs)
		{
			const dt = msg.dateTime.toISO()?.slice(0, 16) ?? "?";
			const model = msg.model ? ` [${msg.model}]` : "";
			lines.push(`--- [${dt}] ${msg.role.toUpperCase()}${model} ---`);
			lines.push(msg.message);
			lines.push("");
		}
	};

	renderMessages(head);

	if (omitted > 0)
	{
		lines.push(`... [${omitted} messages omitted] ...`);
		lines.push("");
		renderMessages(tail);
	}

	return lines.join("\n");
}

/**
 * Formats a list of search results for LLM consumption.
 * Limits to MAX_SEARCH_RESULTS, includes score and excerpt.
 */
export function formatSearchResults(results: SearchResult[], query: string, topicStore?: TopicStore): string
{
	if (results.length === 0)
	{
		return `No results found for query: "${query}"`;
	}

	const shown = results.slice(0, MAX_SEARCH_RESULTS);
	const total = results.length;
	const lines: string[] = [
		`Search results for: "${query}"`,
		`Showing ${shown.length} of ${total} result${total !== 1 ? "s" : ""}.`,
		"",
	];

	shown.forEach((result, idx) =>
	{
		const msg = result.message;
		const subject = resolveSubject(msg.sessionId, msg.subject, topicStore);
		const dt = msg.dateTime.toISO()?.slice(0, 16) ?? "?";
		const terms = result.matchedTerms.length > 0 ? ` | matched: ${result.matchedTerms.join(", ")}` : "";

		// Detect hybrid scoring: AgentMessageFound carries qdrantScore when Qdrant was active
		const msgAny = msg as any;
		let scoreLabel: string;
		if (typeof msgAny.combinedScore === "number" && "qdrantScore" in msgAny)
		{
			const combined = (msgAny.combinedScore * 100).toFixed(0);
			const q = typeof msgAny.qdrantScore === "number"
				? `Q:${(msgAny.qdrantScore * 100).toFixed(0)}%`
				: "Q:—";
			const f = typeof msgAny.fuseScore === "number"
				? `F:${((1 - msgAny.fuseScore) * 100).toFixed(0)}%`
				: "F:—";
			scoreLabel = `${combined}% (${q} | ${f})`;
		}
		else
		{
			scoreLabel = `${(result.score * 100).toFixed(0)}%`;
		}

		lines.push(`[${idx + 1}] Score: ${scoreLabel}${terms}`);
		lines.push(`ID: ${msg.id} | Session: ${msg.sessionId}`);
		lines.push(`Subject: ${subject}`);
		lines.push(`Role: ${msg.role} | Harness: ${msg.harness} | Project: ${msg.project} | ${dt}`);
		lines.push(`Excerpt: ${excerpt(msg.message)}`);
		lines.push("");
	});

	if (total > MAX_SEARCH_RESULTS)
	{
		lines.push(`(${total - MAX_SEARCH_RESULTS} more results not shown — refine your query for better focus)`);
	}

	return lines.join("\n");
}

/**
 * Formats symbol search results for LLM consumption.
 * Shows occurrence count and score for each result.
 */
export function formatSymbolSearchResults(
	results: SymbolSearchResult[],
	symbol: string,
	topicStore?: TopicStore
): string
{
	if (results.length === 0)
	{
		return `No results found for symbol: "${symbol}"`;
	}

	const shown = results.slice(0, MAX_SEARCH_RESULTS);
	const total = results.length;
	const lines: string[] = [
		`Symbol search results for: "${symbol}"`,
		`Showing ${shown.length} of ${total} result${total !== 1 ? "s" : ""}.`,
		"",
	];

	shown.forEach((result, idx) =>
	{
		const msg = result.message;
		const subject = resolveSubject(msg.sessionId, msg.subject, topicStore);
		const dt = msg.dateTime.toISO()?.slice(0, 16) ?? "?";
		const score = (result.score * 100).toFixed(0);

		lines.push(`[${idx + 1}] Occurrences: ${result.occurrenceCount} | Score: ${score}% | DateTime: ${dt}`);
		lines.push(`ID: ${msg.id} | Session: ${msg.sessionId}`);
		lines.push(`Subject: ${subject}`);
		lines.push(`Role: ${msg.role} | Harness: ${msg.harness} | Project: ${msg.project}`);
		lines.push(`Excerpt: ${excerpt(msg.message)}`);
		lines.push("");
	});

	if (total > MAX_SEARCH_RESULTS)
	{
		lines.push(`(${total - MAX_SEARCH_RESULTS} more results not shown — use maxResults parameter to see more)`);
	}

	return lines.join("\n");
}

/**
 * Formats search results scoped to a specific thread (session).
 * Same structure as formatSearchResults but with a thread context header.
 */
export function formatThreadSearchResults(
	results: SearchResult[],
	sessionId: string,
	sessionSubject: string,
	query: string,
	topicStore?: TopicStore
): string
{
	if (results.length === 0)
	{
		return `No results found in session ${sessionId}.`;
	}

	const shown = results.slice(0, MAX_SEARCH_RESULTS);
	const total = results.length;
	const lines: string[] = [
		`Search within thread: ${sessionId}`,
		`Subject: ${sessionSubject || "(no subject)"}`,
		`Showing ${shown.length} of ${total} result${total !== 1 ? "s" : ""}.`,
		"",
	];

	shown.forEach((result, idx) =>
	{
		const msg = result.message;
		const subject = resolveSubject(msg.sessionId, msg.subject, topicStore);
		const dt = msg.dateTime.toISO()?.slice(0, 16) ?? "?";
		const score = (result.score * 100).toFixed(0);
		const terms = result.matchedTerms.length > 0 ? ` | matched: ${result.matchedTerms.join(", ")}` : "";

		lines.push(`[${idx + 1}] Score: ${score}%${terms}`);
		lines.push(`ID: ${msg.id} | Role: ${msg.role} | ${dt}`);
		lines.push(`Subject: ${subject}`);
		lines.push(`Excerpt: ${excerpt(msg.message)}`);
		lines.push("");
	});

	if (total > MAX_SEARCH_RESULTS)
	{
		lines.push(`(${total - MAX_SEARCH_RESULTS} more results not shown — use maxResults parameter to see more)`);
	}

	return lines.join("\n");
}

/**
 * Formats a single thread summary.
 */
export function formatThread(thread: AgentThread): string
{
	const from = thread.firstDateTime.slice(0, 10);
	const to = thread.lastDateTime.slice(0, 10);
	const dateRange = from === to ? from : `${from} → ${to}`;
	const kchars = (thread.totalLength / 1000).toFixed(1);
	const score = thread.bestMatchScore < 1 ? ` | score: ${(thread.bestMatchScore * 100).toFixed(0)}%` : "";

	return [
		`Session: ${thread.sessionId}`,
		`Subject: ${thread.subject}`,
		`Harness: ${thread.harness} | Messages: ${thread.messageCount} | ${kchars}k chars`,
		`Date: ${dateRange}${score}`,
		`First message: ${excerpt(thread.firstMessage, 200)}`,
	].join("\n");
}

/**
 * Formats a list of AgentThreads.
 */
export function formatThreadList(threads: AgentThread[], label: string): string
{
	if (threads.length === 0)
	{
		return `No threads found.`;
	}

	const lines: string[] = [
		`${label} (${threads.length} thread${threads.length !== 1 ? "s" : ""})`,
		"",
	];

	threads.forEach((thread, idx) =>
	{
		lines.push(`[${idx + 1}] ${formatThread(thread)}`);
		lines.push("");
	});

	return lines.join("\n");
}

/**
 * Formats a TopicEntry as text.
 */
export function formatTopicEntry(entry: TopicEntry): string
{
	const lines: string[] = [`Session: ${entry.sessionId}`];

	if (entry.customTopic)
	{
		lines.push(`Custom topic: ${entry.customTopic}`);
	}
	if (entry.aiSummary)
	{
		lines.push(`AI summary: ${entry.aiSummary}`);
	}
	if (!entry.customTopic && !entry.aiSummary)
	{
		lines.push("(no topic set)");
	}

	return lines.join("\n");
}

/**
 * Formats a list of TopicEntries.
 */
export function formatTopicList(entries: TopicEntry[]): string
{
	if (entries.length === 0)
	{
		return "No topic entries found.";
	}

	return entries.map((e) => formatTopicEntry(e)).join("\n---\n");
}
