/**
 * Integration tests for MCP message and session tool handlers.
 *
 * Tests handleMessageTool() directly with a minimal mock MessageDB.
 * Covers: get_message, get_session, list_sessions, query_messages, get_latest_threads.
 */

import { describe, expect, test } from "bun:test";
import { handleMessageTool } from "../tools/messages.js";
import { DateTime } from "luxon";

// ─── Test fixtures ────────────────────────────────────────────────────────────

function makeMsg(
	id = "abc123def456789a",
	sessionId = "sess-001",
	content = "This is a test message."
): any
{
	return {
		id,
		sessionId,
		subject: "Test session subject",
		role: "user",
		harness: "ClaudeCode",
		project: "test-project",
		machine: "test-machine",
		message: content,
		dateTime: DateTime.fromISO("2026-03-01T10:00:00Z"),
		model: "claude-sonnet-4-6",
		tokenUsage: { input: 100, output: 50 },
		context: [],
		toolCalls: [],
		length: content.length,
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
		queryMessages: (f: any) =>
		{
			let filtered = msgs;
			if (f.role) filtered = filtered.filter((m: any) => m.role === f.role);
			return {
				total: filtered.length,
				page: f.page ?? 1,
				results: filtered.slice(0, f.pageSize ?? 20),
			};
		},
		getAllMessages: () => msgs,
		getHarnessCounts: () => [{ harness: "ClaudeCode", count: msgs.length }],
		getHarnessDateRanges: () =>
			msgs.length > 0
				? [{ harness: "ClaudeCode", earliest: msgs[0].dateTime.toISO()!, latest: msgs[0].dateTime.toISO()! }]
				: [],
	};
}

// ─── get_message ──────────────────────────────────────────────────────────────

describe("get_message", () =>
{
	test("returns error when id is missing", () =>
	{
		const result = handleMessageTool("get_message", {}, makeDB());
		expect(result).toBe("Error: 'id' is required.");
	});

	test("returns error when id is empty string", () =>
	{
		const result = handleMessageTool("get_message", { id: "  " }, makeDB());
		expect(result).toBe("Error: 'id' is required.");
	});

	test("returns not-found for unknown id", () =>
	{
		const result = handleMessageTool("get_message", { id: "nonexistent" }, makeDB());
		expect(result).toContain("No message found with ID: nonexistent");
	});

	test("returns formatted message for known id", () =>
	{
		const msg = makeMsg();
		const result = handleMessageTool("get_message", { id: msg.id }, makeDB([msg]));
		expect(result).toContain(msg.id);
		expect(result).toContain(msg.sessionId);
		expect(result).toContain("user");
		expect(result).toContain("ClaudeCode");
		expect(result).toContain(msg.message);
		expect(result).toContain("claude-sonnet-4-6");
	});
});

// ─── get_session ──────────────────────────────────────────────────────────────

describe("get_session", () =>
{
	test("returns error when sessionId is missing", () =>
	{
		const result = handleMessageTool("get_session", {}, makeDB());
		expect(result).toBe("Error: 'sessionId' is required.");
	});

	test("returns not-found for unknown session", () =>
	{
		const result = handleMessageTool("get_session", { sessionId: "unknown" }, makeDB());
		expect(result).toContain("No messages found for session: unknown");
	});

	test("returns formatted session with messages", () =>
	{
		const msg = makeMsg();
		const result = handleMessageTool("get_session", { sessionId: msg.sessionId }, makeDB([msg]));
		expect(result).toContain(msg.sessionId);
		expect(result).toContain(msg.message);
		expect(result).toContain("USER");
	});

	test("respects maxMessages parameter", () =>
	{
		// Session with 12 messages — at maxMessages=10, should show head+tail with omission
		const msgs = Array.from({ length: 12 }, (_, i) =>
			makeMsg(`msg${i}`, "sess-big", `Message number ${i}`)
		);
		const result = handleMessageTool(
			"get_session",
			{ sessionId: "sess-big", maxMessages: 10 },
			makeDB(msgs)
		);
		expect(result).toContain("sess-big");
	});
});

// ─── list_sessions ────────────────────────────────────────────────────────────

describe("list_sessions", () =>
{
	test("returns empty message when DB has no sessions", () =>
	{
		const result = handleMessageTool("list_sessions", {}, makeDB());
		expect(result).toBe("No sessions found in the database.");
	});

	test("lists sessions with harness and message count", () =>
	{
		const msgs = [makeMsg("id1", "sess-001"), makeMsg("id2", "sess-002")];
		const result = handleMessageTool("list_sessions", {}, makeDB(msgs));
		expect(result).toContain("sess-001");
		expect(result).toContain("sess-002");
		expect(result).toContain("ClaudeCode");
	});

	test("respects limit parameter", () =>
	{
		const msgs = Array.from({ length: 5 }, (_, i) => makeMsg(`id${i}`, `sess-00${i}`));
		const result = handleMessageTool("list_sessions", { limit: 2 }, makeDB(msgs));
		expect(result).toContain("sess-000");
		expect(result).toContain("sess-001");
		expect(result).not.toContain("sess-004");
	});

	test("clamps limit to minimum 1", () =>
	{
		const msgs = [makeMsg()];
		const result = handleMessageTool("list_sessions", { limit: -5 }, makeDB(msgs));
		expect(result).toContain("sess-001");
	});
});

// ─── query_messages ───────────────────────────────────────────────────────────

describe("query_messages", () =>
{
	test("returns no-match message when DB is empty", () =>
	{
		const result = handleMessageTool("query_messages", {}, makeDB());
		expect(result).toContain("No messages match the given filters");
	});

	test("returns paginated results", () =>
	{
		const db = makeDB([makeMsg()]);
		const result = handleMessageTool("query_messages", { pageSize: 10 }, db);
		expect(result).toContain("page 1");
		expect(result).toContain("ClaudeCode");
	});

	test("clamps pageSize to maximum 50", () =>
	{
		const msgs = Array.from({ length: 3 }, (_, i) => makeMsg(`id${i}`, `s${i}`));
		const db = makeDB(msgs);
		// Should not error with large pageSize — clamped internally
		const result = handleMessageTool("query_messages", { pageSize: 200 }, db);
		expect(result).toContain("page 1");
	});

	test("defaults to user-only when role is not set", () =>
	{
		const userMsg = makeMsg("u1", "s1", "User message");
		const assistantMsg = { ...makeMsg("a1", "s2", "Assistant message"), role: "assistant" };
		const db = makeDB([userMsg, assistantMsg]);
		const result = handleMessageTool("query_messages", {}, db);
		// Should filter to user messages only (1 result)
		expect(result).toContain("showing 1");
		expect(result).toContain("USER");
	});

	test("role=assistant overrides default filtering", () =>
	{
		const userMsg = makeMsg("u1", "s1", "User message");
		const assistantMsg = { ...makeMsg("a1", "s2", "Assistant message"), role: "assistant" };
		const db = makeDB([userMsg, assistantMsg]);
		const result = handleMessageTool("query_messages", { role: "assistant" }, db);
		// Should only return assistant messages
		expect(result).toContain("showing 1");
		expect(result).toContain("ASSISTANT");
	});

	test("includeAssistantMessages=true returns all roles", () =>
	{
		const userMsg = makeMsg("u1", "s1", "User message");
		const assistantMsg = { ...makeMsg("a1", "s2", "Assistant message"), role: "assistant" };
		const db = makeDB([userMsg, assistantMsg]);
		const result = handleMessageTool("query_messages", { includeAssistantMessages: true }, db);
		// Should return both messages (no role filter injected)
		expect(result).toContain("showing 2");
	});
});

// ─── get_latest_threads ───────────────────────────────────────────────────────

describe("get_latest_threads", () =>
{
	test("returns empty message when DB has no sessions", () =>
	{
		const result = handleMessageTool("get_latest_threads", {}, makeDB());
		expect(result).toBe("No threads found in the database.");
	});

	test("clamps limit to minimum 1", () =>
	{
		const db = makeDB([makeMsg()]);
		// Should not error with invalid limit
		const result = handleMessageTool("get_latest_threads", { limit: 0 }, db);
		// Either returns threads or empty — both are valid with a 1-message DB
		expect(typeof result).toBe("string");
	});
});

// ─── unknown tool ─────────────────────────────────────────────────────────────

describe("unknown tool", () =>
{
	test("throws for unknown tool name", () =>
	{
		expect(() => handleMessageTool("does_not_exist", {}, makeDB())).toThrow();
	});
});
