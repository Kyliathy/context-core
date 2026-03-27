/**
 * MCP resource definitions and handlers.
 *
 * Resources expose structured, browsable data without requiring a search query.
 * URIs follow the cxc:// scheme:
 *
 * - cxc://stats                          — system-wide statistics
 * - cxc://projects                       — all known projects with session counts
 * - cxc://harnesses                      — all harnesses with message counts and date ranges
 * - cxc://projects/{name}/sessions       — sessions for a specific project
 */

import type { IMessageStore } from "../../db/IMessageStore.js";
import type { TopicStore } from "../../settings/TopicStore.js";
import { resolveSubject } from "../formatters.js";

export const RESOURCE_DEFINITIONS = [
	{
		uri: "cxc://stats",
		name: "System Statistics",
		description:
			"System-wide ContextCore statistics: total messages, session count, harness breakdown, and date ranges.",
		mimeType: "text/plain",
	},
	{
		uri: "cxc://projects",
		name: "Projects",
		description:
			"All known projects ingested by ContextCore, with session counts and last activity dates.",
		mimeType: "text/plain",
	},
	{
		uri: "cxc://harnesses",
		name: "Harnesses",
		description:
			"Configured harnesses (ClaudeCode, Cursor, Kiro, VSCode) with message counts and date ranges.",
		mimeType: "text/plain",
	},
	{
		uri: "cxc://query-syntax",
		name: "Search Query Syntax",
		description:
			"Reference for ContextCore search query syntax used by search tools and prompts (simple, exact phrase, OR, AND).",
		mimeType: "text/plain",
	},
];

/**
 * Resource templates that accept parameters in the URI.
 */
export const RESOURCE_TEMPLATE_DEFINITIONS = [
	{
		uriTemplate: "cxc://projects/{name}/sessions",
		name: "Project Sessions",
		description: "Session list for a specific project, with summaries and resolved topics.",
		mimeType: "text/plain",
	},
];

/**
 * Reads a resource by URI and returns its text content.
 * Returns null if the URI is not recognized.
 */
export function readResource(uri: string, db: IMessageStore, topicStore?: TopicStore): string | null
{
	if (uri === "cxc://stats")
	{
		return buildStats(db);
	}

	if (uri === "cxc://projects")
	{
		return buildProjects(db);
	}

	if (uri === "cxc://harnesses")
	{
		return buildHarnesses(db);
	}

	if (uri === "cxc://query-syntax")
	{
		return buildQuerySyntax();
	}

	// Match cxc://projects/{name}/sessions
	const projectMatch = uri.match(/^cxc:\/\/projects\/(.+)\/sessions$/);
	if (projectMatch)
	{
		const projectName = decodeURIComponent(projectMatch[1]);
		return buildProjectSessions(projectName, db, topicStore);
	}

	return null;
}

// ─── Builder functions ────────────────────────────────────────────────────────

function buildStats(db: IMessageStore): string
{
	const harnessCounts = db.getHarnessCounts();
	const dateRanges = db.getHarnessDateRanges();
	const sessions = db.listSessions();

	const totalMessages = harnessCounts.reduce((s, h) => s + h.count, 0);
	const globalEarliest = dateRanges.reduce(
		(a, b) => (a < b.earliest ? a : b.earliest),
		dateRanges[0]?.earliest ?? "N/A"
	);
	const globalLatest = dateRanges.reduce(
		(a, b) => (a > b.latest ? a : b.latest),
		dateRanges[0]?.latest ?? "N/A"
	);

	const lines: string[] = [
		"=== ContextCore System Statistics ===",
		"",
		`Total messages : ${totalMessages.toLocaleString()}`,
		`Total sessions : ${sessions.length.toLocaleString()}`,
		`Date range     : ${globalEarliest.slice(0, 10)} → ${globalLatest.slice(0, 10)}`,
		"",
		"Breakdown by harness:",
	];

	for (const h of harnessCounts)
	{
		const range = dateRanges.find((r) => r.harness === h.harness);
		const from = range?.earliest.slice(0, 10) ?? "?";
		const to = range?.latest.slice(0, 10) ?? "?";
		lines.push(`  ${h.harness}: ${h.count.toLocaleString()} messages (${from} → ${to})`);
	}

	return lines.join("\n");
}

function buildProjects(db: IMessageStore): string
{
	// Aggregate sessions by project
	const sessions = db.listSessions();
	// Get project data from queryMessages distinct projects
	const projectMap = new Map<string, { count: number; lastDateTime: string; harnesses: Set<string> }>();

	for (const session of sessions)
	{
		const msgs = db.getBySessionId(session.sessionId);
		if (msgs.length === 0) continue;

		const project = msgs[0].project || "MISC";
		const existing = projectMap.get(project);
		const dt = session.lastDateTime;

		if (existing)
		{
			existing.count += session.count;
			if (dt > existing.lastDateTime) existing.lastDateTime = dt;
			existing.harnesses.add(session.harness);
		} else
		{
			projectMap.set(project, {
				count: session.count,
				lastDateTime: dt,
				harnesses: new Set([session.harness]),
			});
		}
	}

	const sorted = Array.from(projectMap.entries()).sort((a, b) =>
		b[1].lastDateTime.localeCompare(a[1].lastDateTime)
	);

	if (sorted.length === 0) return "No projects found.";

	const lines: string[] = [
		`=== Projects (${sorted.length}) ===`,
		"Note: Use cxc://projects/{name}/sessions to list sessions for a project.",
		"",
	];

	sorted.forEach(([name, data]) =>
	{
		const harnesses = Array.from(data.harnesses).join(", ");
		const lastActivity = data.lastDateTime.slice(0, 10);
		lines.push(`${name}`);
		lines.push(`  Messages: ${data.count} | Last activity: ${lastActivity} | Harnesses: ${harnesses}`);
		lines.push(`  URI: cxc://projects/${encodeURIComponent(name)}/sessions`);
		lines.push("");
	});

	return lines.join("\n");
}

function buildHarnesses(db: IMessageStore): string
{
	const harnessCounts = db.getHarnessCounts();
	const dateRanges = db.getHarnessDateRanges();

	if (harnessCounts.length === 0) return "No harnesses found.";

	const lines: string[] = ["=== Harnesses ===", ""];

	for (const h of harnessCounts)
	{
		const range = dateRanges.find((r) => r.harness === h.harness);
		const from = range?.earliest.slice(0, 10) ?? "?";
		const to = range?.latest.slice(0, 10) ?? "?";
		lines.push(`${h.harness}`);
		lines.push(`  Messages: ${h.count.toLocaleString()} | Date range: ${from} → ${to}`);
		lines.push("");
	}

	return lines.join("\n");
}

function buildQuerySyntax(): string
{
	return [
		"=== ContextCore Search Query Syntax ===",
		"",
		"Use this syntax with:",
		"- search_messages.query",
		"- search_threads.query",
		"- prompts that search history (explore_history, find_decisions, debug_history)",
		"",
		"1) Simple term (fuzzy)",
		"   Example: authentication",
		"",
		"2) Exact phrase (quoted)",
		"   Example: \"error handling\"",
		"",
		"3) OR mode (space-separated terms)",
		"   Example: auth token",
		"   Meaning: match messages containing either term",
		"",
		"4) AND mode (plus-separated terms)",
		"   Example: JWT + refresh",
		"   Meaning: match messages containing all terms",
		"",
		"Tip: Start broad with OR mode, then narrow with + AND mode.",
	].join("\n");
}

function buildProjectSessions(
	projectName: string,
	db: IMessageStore,
	topicStore?: TopicStore
): string
{
	const allSessions = db.listSessions();

	// Filter to sessions that belong to this project
	const projectSessions = allSessions.filter((s) =>
	{
		const msgs = db.getBySessionId(s.sessionId);
		return msgs.length > 0 && msgs[0].project === projectName;
	});

	if (projectSessions.length === 0)
	{
		return `No sessions found for project: "${projectName}".\n\nHint: Use cxc://projects to see all known project names.`;
	}

	const lines: string[] = [
		`=== Sessions for project: ${projectName} (${projectSessions.length}) ===`,
		"",
	];

	projectSessions.forEach((session, idx) =>
	{
		const msgs = db.getBySessionId(session.sessionId);
		const firstMsg = msgs[0];
		const subject = resolveSubject(session.sessionId, firstMsg?.subject ?? "", topicStore);
		const from = session.firstDateTime.slice(0, 10);
		const to = session.lastDateTime.slice(0, 10);
		const dateRange = from === to ? from : `${from} → ${to}`;

		lines.push(`[${idx + 1}] ${session.sessionId}`);
		lines.push(`  Harness: ${session.harness} | Messages: ${session.count} | ${dateRange}`);
		if (subject) lines.push(`  Subject: ${subject}`);
		lines.push("");
	});

	return lines.join("\n");
}
