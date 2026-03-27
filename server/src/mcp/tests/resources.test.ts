/**
 * Integration tests for MCP resource handlers and topic tool handlers.
 *
 * Tests readResource() and handleTopicTool() with minimal mock objects.
 * Covers: cxc://stats, cxc://projects, cxc://harnesses, cxc://projects/{name}/sessions,
 *         get_topics, get_topic, set_topic.
 */

import { describe, expect, test } from "bun:test";
import { readResource } from "../resources/index.js";
import { handleTopicTool } from "../tools/topics.js";
import { DateTime } from "luxon";

// ─── Test fixtures ────────────────────────────────────────────────────────────

function makeMsg(id: string, sessionId: string, project = "test-project"): any
{
	return {
		id,
		sessionId,
		subject: "Test subject",
		role: "user",
		harness: "ClaudeCode",
		project,
		machine: "test-machine",
		message: "Content of the message.",
		dateTime: DateTime.fromISO("2026-03-01T10:00:00Z"),
		model: "claude-sonnet-4-6",
		context: [],
		toolCalls: [],
		length: 24,
	};
}

function makeDB(msgs: any[] = []): any
{
	const byId = new Map(msgs.map((m) => [m.id, m]));
	const bySession = new Map<string, any[]>();
	for (const m of msgs)
	{
		if (!bySession.has(m.sessionId)) bySession.set(m.sessionId, []);
		bySession.get(m.sessionId)!.push(m);
	}

	return {
		getById: (id: string) => byId.get(id),
		getBySessionId: (sid: string) => bySession.get(sid) ?? [],
		listSessions: () =>
			Array.from(bySession.entries()).map(([sid, ms]) => ({
				sessionId: sid,
				harness: ms[0].harness,
				count: ms.length,
				firstDateTime: ms[0].dateTime.toISO()!,
				lastDateTime: ms[ms.length - 1].dateTime.toISO()!,
			})),
		queryMessages: (f: any) => ({
			total: msgs.length,
			page: 1,
			results: msgs.slice(0, f.pageSize ?? 20),
		}),
		getAllMessages: () => msgs,
		getHarnessCounts: () =>
			msgs.length > 0 ? [{ harness: "ClaudeCode", count: msgs.length }] : [],
		getHarnessDateRanges: () =>
			msgs.length > 0
				? [
					{
						harness: "ClaudeCode",
						earliest: "2026-03-01T10:00:00.000Z",
						latest: "2026-03-01T10:00:00.000Z",
					},
				]
				: [],
	};
}

function makeTopicStore(
	entries: Record<string, { aiSummary?: string; customTopic?: string }> = {}
): any
{
	const map = new Map(
		Object.entries(entries).map(([sid, e]) => [
			sid,
			{ sessionId: sid, charsSent: 0, aiSummary: e.aiSummary ?? "", customTopic: e.customTopic ?? "" },
		])
	);
	return {
		getBySessionId: (sid: string) => map.get(sid),
		upsert: (entry: any) =>
		{
			map.set(entry.sessionId, entry);
		},
		save: () => { /* no-op in tests */ },
		entries: map,
	};
}

// ─── cxc://stats resource ─────────────────────────────────────────────────────

describe("cxc://stats", () =>
{
	test("returns stats text for populated DB", () =>
	{
		const msgs = [makeMsg("id1", "sess-1"), makeMsg("id2", "sess-2")];
		const result = readResource("cxc://stats", makeDB(msgs));
		expect(result).not.toBeNull();
		expect(result).toContain("Total messages");
		expect(result).toContain("Total sessions");
		expect(result).toContain("ClaudeCode");
	});

	test("returns valid stats for empty DB", () =>
	{
		const result = readResource("cxc://stats", makeDB([]));
		expect(result).not.toBeNull();
		expect(result).toContain("Total messages");
	});
});

// ─── cxc://projects resource ──────────────────────────────────────────────────

describe("cxc://projects", () =>
{
	test("lists all projects", () =>
	{
		const msgs = [
			makeMsg("id1", "sess-1", "project-alpha"),
			makeMsg("id2", "sess-2", "project-beta"),
		];
		const result = readResource("cxc://projects", makeDB(msgs));
		expect(result).not.toBeNull();
		expect(result).toContain("project-alpha");
		expect(result).toContain("project-beta");
	});

	test("returns no-projects message for empty DB", () =>
	{
		const result = readResource("cxc://projects", makeDB([]));
		expect(result).not.toBeNull();
		expect(result).toContain("No projects found");
	});
});

// ─── cxc://harnesses resource ─────────────────────────────────────────────────

describe("cxc://harnesses", () =>
{
	test("lists harnesses with counts", () =>
	{
		const msgs = [makeMsg("id1", "sess-1"), makeMsg("id2", "sess-2")];
		const result = readResource("cxc://harnesses", makeDB(msgs));
		expect(result).not.toBeNull();
		expect(result).toContain("ClaudeCode");
	});

	test("returns no-harnesses message for empty DB", () =>
	{
		const result = readResource("cxc://harnesses", makeDB([]));
		expect(result).not.toBeNull();
		expect(result).toContain("No harnesses found");
	});
});

// ─── cxc://query-syntax resource ─────────────────────────────────────────────

describe("cxc://query-syntax", () =>
{
	test("returns syntax guidance including + AND operator", () =>
	{
		const result = readResource("cxc://query-syntax", makeDB([]));
		expect(result).not.toBeNull();
		expect(result).toContain("AND mode");
		expect(result).toContain("JWT + refresh");
	});
});

// ─── cxc://projects/{name}/sessions resource ──────────────────────────────────

describe("cxc://projects/{name}/sessions", () =>
{
	test("returns sessions for known project", () =>
	{
		const msgs = [makeMsg("id1", "sess-1", "my-project"), makeMsg("id2", "sess-2", "my-project")];
		const result = readResource("cxc://projects/my-project/sessions", makeDB(msgs));
		expect(result).not.toBeNull();
		expect(result).toContain("my-project");
		expect(result).toContain("sess-1");
	});

	test("returns not-found message for unknown project", () =>
	{
		const result = readResource("cxc://projects/no-such-project/sessions", makeDB([]));
		expect(result).not.toBeNull();
		expect(result).toContain("No sessions found");
	});

	test("handles URL-encoded project names", () =>
	{
		const msgs = [makeMsg("id1", "sess-1", "my project")];
		const result = readResource("cxc://projects/my%20project/sessions", makeDB(msgs));
		expect(result).not.toBeNull();
		// Should decode %20 → space and find the project
		expect(result).toContain("my project");
	});
});

// ─── unknown URI ──────────────────────────────────────────────────────────────

describe("unknown resource URI", () =>
{
	test("returns null for unrecognized URI", () =>
	{
		const result = readResource("cxc://invalid/uri", makeDB());
		expect(result).toBeNull();
	});

	test("returns null for wrong scheme", () =>
	{
		const result = readResource("http://something", makeDB());
		expect(result).toBeNull();
	});
});

// ─── get_topic ────────────────────────────────────────────────────────────────

describe("get_topic", () =>
{
	test("returns error when sessionId is missing", () =>
	{
		const result = handleTopicTool("get_topic", {}, makeTopicStore());
		expect(result).toContain("Error:");
	});

	test("returns not-found for unknown session", () =>
	{
		const result = handleTopicTool("get_topic", { sessionId: "unknown" }, makeTopicStore());
		expect(result).toContain("No topic entry found");
	});

	test("returns entry with both AI summary and custom topic", () =>
	{
		const ts = makeTopicStore({
			"sess-1": { aiSummary: "AI generated summary", customTopic: "Custom label" },
		});
		const result = handleTopicTool("get_topic", { sessionId: "sess-1" }, ts);
		expect(result).toContain("Custom label");
		expect(result).toContain("AI generated summary");
	});

	test("returns entry with only AI summary", () =>
	{
		const ts = makeTopicStore({ "sess-1": { aiSummary: "Only an AI summary" } });
		const result = handleTopicTool("get_topic", { sessionId: "sess-1" }, ts);
		expect(result).toContain("AI summary");
	});
});

// ─── set_topic ────────────────────────────────────────────────────────────────

describe("set_topic", () =>
{
	test("sets a custom topic on existing session", () =>
	{
		const ts = makeTopicStore({ "sess-1": { aiSummary: "Old summary" } });
		const result = handleTopicTool(
			"set_topic",
			{ sessionId: "sess-1", customTopic: "New topic label" },
			ts
		);
		expect(result).toContain("New topic label");
	});

	test("clears a custom topic when empty string passed", () =>
	{
		const ts = makeTopicStore({ "sess-1": { customTopic: "Old topic" } });
		const result = handleTopicTool("set_topic", { sessionId: "sess-1", customTopic: "" }, ts);
		expect(result).toContain("cleared");
	});

	test("creates a new entry for unknown session", () =>
	{
		const ts = makeTopicStore();
		const result = handleTopicTool(
			"set_topic",
			{ sessionId: "brand-new-session", customTopic: "First topic" },
			ts
		);
		expect(result).toContain("First topic");
	});

	test("returns error when sessionId is missing", () =>
	{
		const ts = makeTopicStore();
		const result = handleTopicTool("set_topic", { customTopic: "Topic" }, ts);
		expect(result).toContain("Error:");
	});
});

// ─── get_topics ───────────────────────────────────────────────────────────────

describe("get_topics", () =>
{
	test("returns no-topics message when store is empty", () =>
	{
		const ts = makeTopicStore();
		const result = handleTopicTool("get_topics", {}, ts);
		expect(result).toContain("No topic entries");
	});

	test("lists topic entries", () =>
	{
		const ts = makeTopicStore({
			"sess-1": { customTopic: "Topic one" },
			"sess-2": { aiSummary: "AI summary two" },
		});
		const result = handleTopicTool("get_topics", {}, ts);
		expect(result).toContain("sess-1");
		expect(result).toContain("Topic one");
	});
});
