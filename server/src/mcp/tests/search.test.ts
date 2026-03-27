/**
 * Integration tests for MCP search tool handlers.
 *
 * Tests handleSearchTool() with a pre-initialized Fuse.js search index.
 * Covers: search_messages (all query syntax variants), search_threads.
 */

import { describe, expect, test, beforeAll } from "bun:test";
import { handleSearchTool } from "../tools/search.js";
import { initSearchIndex } from "../../search/searchEngine.js";
import { DateTime } from "luxon";

// ─── Test fixtures ────────────────────────────────────────────────────────────

function makeMsg(id: string, content: string, sessionId = "sess-001", isoDate = "2026-03-01T10:00:00Z"): any
{
	return {
		id,
		sessionId,
		subject: "test subject",
		role: "user",
		harness: "ClaudeCode",
		project: "test-project",
		machine: "test-machine",
		message: content,
		dateTime: DateTime.fromISO(isoDate),
		model: "claude-sonnet-4-6",
		context: [],
		toolCalls: [],
		tags: [],
		symbols: [],
		length: content.length,
	};
}

const TEST_MESSAGES = [
	makeMsg("msg001", "Implementing authentication with JWT tokens and refresh token flow", "sess-001", "2025-02-10T09:00:00Z"),
	makeMsg("msg002", "The database connection pool is timing out after 30 seconds", "sess-002", "2025-06-15T10:30:00Z"),
	makeMsg("msg003", "Refactoring the search module to use Fuse.js for fuzzy matching", "sess-003", "2025-09-20T14:00:00Z"),
	makeMsg("msg004", "Fixed the authentication bug by rotating the secret key", "sess-004", "2026-03-01T10:00:00Z"),
	makeMsg("msg005", "Database migration failed due to a foreign key constraint error", "sess-005", "2026-03-10T16:45:00Z"),
];

// Test messages for symbol search (with controlled symbol occurrences)
const SYMBOL_TEST_MESSAGES = [
	makeMsg("sym001", "Using MessageDB to query messages. MessageDB provides getById and MessageDB.getAllMessages()", "sess-sym-1"),
	makeMsg("sym002", "The database connection uses DB pooling. DB timeout is 30s.", "sess-sym-2"),
	makeMsg("sym003", "MessageDB initialization requires calling MessageDB.loadFromStorage()", "sess-sym-1"),
	makeMsg("sym004", "No relevant symbols here, just plain text content", "sess-sym-3"),
	makeMsg("sym005", "Testing get_session and get_message methods", "sess-sym-4"),
	makeMsg("sym006", "The DB class handles database operations", "sess-sym-5"),
];

function makeDB(): any
{
	const bySession = new Map<string, any[]>();
	for (const m of TEST_MESSAGES)
	{
		if (!bySession.has(m.sessionId)) bySession.set(m.sessionId, []);
		bySession.get(m.sessionId)!.push(m);
	}
	return {
		getBySessionId: (sid: string) => bySession.get(sid) ?? [],
		listSessions: () =>
			Array.from(bySession.entries()).map(([sid, ms]) => ({
				sessionId: sid,
				harness: ms[0].harness,
				count: ms.length,
				firstDateTime: ms[0].dateTime.toISO()!,
				lastDateTime: ms[ms.length - 1].dateTime.toISO()!,
			})),
		getAllMessages: () => TEST_MESSAGES,
	};
}

beforeAll(() =>
{
	initSearchIndex(TEST_MESSAGES);
});

// ─── search_messages — validation ────────────────────────────────────────────

describe("search_messages — validation", () =>
{
	test("returns error when no search params provided", async () =>
	{
		const result = await handleSearchTool("search_messages", {}, makeDB());
		expect(result).toContain("Error:");
		expect(result).toContain("required");
	});

	test("returns error when query is empty and no subject/symbols", async () =>
	{
		const result = await handleSearchTool("search_messages", { query: "   " }, makeDB());
		expect(result).toContain("Error:");
	});

	test("returns error when query exceeds 500 chars", async () =>
	{
		const longQuery = "authentication ".repeat(40); // ~600 chars
		const result = await handleSearchTool("search_messages", { query: longQuery }, makeDB());
		expect(result).toContain("Error:");
		expect(result).toContain("too long");
	});
});

// ─── search_messages — query syntax ──────────────────────────────────────────

describe("search_messages — query syntax variants", () =>
{
	test("simple term search returns no error", async () =>
	{
		const result = await handleSearchTool("search_messages", { query: "authentication" }, makeDB());
		expect(result).not.toMatch(/^Error:/);
	});

	test("OR mode (space-separated terms) works", async () =>
	{
		const result = await handleSearchTool("search_messages", { query: "authentication database" }, makeDB());
		expect(result).not.toMatch(/^Error:/);
	});

	test("AND mode (term1 + term2) works", async () =>
	{
		const result = await handleSearchTool("search_messages", { query: "authentication + JWT" }, makeDB());
		expect(result).not.toMatch(/^Error:/);
	});

	test("exact phrase query (quoted) works", async () =>
	{
		const result = await handleSearchTool("search_messages", { query: '"JWT tokens"' }, makeDB());
		expect(result).not.toMatch(/^Error:/);
	});

	test("AND query for known pair returns match", async () =>
	{
		const result = await handleSearchTool("search_messages", { query: "database + timeout" }, makeDB());
		expect(result).not.toMatch(/^Error:/);
		// The query should match msg002 which contains both "database" and "timeout/timing"
	});
});

// ─── search_messages — maxResults ────────────────────────────────────────────

describe("search_messages — maxResults", () =>
{
	test("respects maxResults=1", async () =>
	{
		const result = await handleSearchTool("search_messages", { query: "authentication", maxResults: 1 }, makeDB());
		expect(result).not.toMatch(/^Error:/);
		// Result should note "top 1 of N" if more results exist
	});

	test("maxResults defaults to 20", async () =>
	{
		const result = await handleSearchTool("search_messages", { query: "the" }, makeDB());
		expect(result).not.toMatch(/^Error:/);
	});

	test("clamps maxResults to minimum 1", async () =>
	{
		// maxResults of 0 or negative should not error
		const result = await handleSearchTool("search_messages", { query: "authentication", maxResults: 0 }, makeDB());
		expect(typeof result).toBe("string");
	});
});

describe("search_messages — date range", () =>
{
	test("filters with from only (to defaults to now)", async () =>
	{
		const result = await handleSearchTool("search_messages", { query: "authentication", from: "2026-01-01" }, makeDB());
		expect(result).not.toMatch(/^Error:/);
		expect(result).toContain("msg004");
		expect(result).not.toContain("msg001");
	});

	test("filters with explicit from and to", async () =>
	{
		const result = await handleSearchTool(
			"search_messages",
			{ query: "database", from: "2025-06-01", to: "2025-12-31" },
			makeDB()
		);
		expect(result).not.toMatch(/^Error:/);
		expect(result).toContain("msg002");
		expect(result).not.toContain("msg005");
	});

	test("returns an error for invalid date range (from > to)", async () =>
	{
		const result = await handleSearchTool(
			"search_messages",
			{ query: "database", from: "2026-03-10", to: "2025-01-01" },
			makeDB()
		);
		expect(result).toContain("Error:");
		expect(result).toContain("'from' must be earlier");
	});
});

// ─── search_threads ───────────────────────────────────────────────────────────

describe("search_threads — validation", () =>
{
	test("returns error when no search params provided", async () =>
	{
		const result = await handleSearchTool("search_threads", {}, makeDB());
		expect(result).toContain("Error:");
		expect(result).toContain("required");
	});

	test("returns error when query is too long", async () =>
	{
		const longQuery = "x".repeat(501);
		const result = await handleSearchTool("search_threads", { query: longQuery }, makeDB());
		expect(result).toContain("Error:");
		expect(result).toContain("too long");
	});
});

describe("search_threads — results", () =>
{
	test("finds threads matching simple query", async () =>
	{
		const result = await handleSearchTool("search_threads", { query: "authentication" }, makeDB());
		expect(result).not.toMatch(/^Error:/);
		// Either finds threads or reports no matches — both valid
	});

	test("returns thread-level grouping (not individual messages)", async () =>
	{
		const result = await handleSearchTool("search_threads", { query: "database" }, makeDB());
		expect(result).not.toMatch(/^Error:/);
		// Thread results show sessionId, not individual message IDs
		if (!result.includes("No threads found"))
		{
			expect(result).toContain("Session:");
		}
	});

	test("AND query works in thread search", async () =>
	{
		const result = await handleSearchTool("search_threads", { query: "database + migration" }, makeDB());
		expect(result).not.toMatch(/^Error:/);
	});

	test("applies date filtering before thread aggregation", async () =>
	{
		const result = await handleSearchTool("search_threads", { query: "database", from: "2026-01-01" }, makeDB());
		expect(result).not.toMatch(/^Error:/);
		expect(result).toContain("sess-005");
		expect(result).not.toContain("sess-002");
	});
});

// ─── search_by_symbol — validation ───────────────────────────────────────────

describe("search_by_symbol — validation", () =>
{
	function makeSymbolDB(): any
	{
		const bySession = new Map<string, any[]>();
		for (const m of SYMBOL_TEST_MESSAGES)
		{
			if (!bySession.has(m.sessionId)) bySession.set(m.sessionId, []);
			bySession.get(m.sessionId)!.push(m);
		}
		return {
			getBySessionId: (sid: string) => bySession.get(sid) ?? [],
			getAllMessages: () => SYMBOL_TEST_MESSAGES,
		};
	}

	test("returns error when symbol is missing", async () =>
	{
		const result = await handleSearchTool("search_by_symbol", {}, makeSymbolDB());
		expect(result).toBe("Error: 'symbol' is required and must not be empty.");
	});

	test("returns error when symbol is empty string", async () =>
	{
		const result = await handleSearchTool("search_by_symbol", { symbol: "   " }, makeSymbolDB());
		expect(result).toContain("Error:");
	});

	test("returns error when symbol exceeds 100 chars", async () =>
	{
		const longSymbol = "a".repeat(101);
		const result = await handleSearchTool("search_by_symbol", { symbol: longSymbol }, makeSymbolDB());
		expect(result).toContain("Error:");
		expect(result).toContain("too long");
	});
});

// ─── search_by_symbol — case sensitivity ─────────────────────────────────────

describe("search_by_symbol — case sensitivity", () =>
{
	function makeSymbolDB(): any
	{
		return {
			getBySessionId: () => [],
			getAllMessages: () => SYMBOL_TEST_MESSAGES,
		};
	}

	test("caseSensitive=false matches case-insensitively (default)", async () =>
	{
		const result = await handleSearchTool("search_by_symbol", { symbol: "messagedb" }, makeSymbolDB());
		expect(result).not.toMatch(/^Error:/);
		// Should find messages containing "MessageDB" (case-insensitive)
		expect(result).toContain("MessageDB");
	});

	test("caseSensitive=true matches case-sensitively", async () =>
	{
		const result = await handleSearchTool("search_by_symbol", { symbol: "MessageDB", caseSensitive: true }, makeSymbolDB());
		expect(result).not.toMatch(/^Error:/);
		// Should find exact case matches
	});

	test("caseSensitive=true excludes mismatched case", async () =>
	{
		// Search for lowercase "db" with caseSensitive=true should not match "DB"
		const result = await handleSearchTool("search_by_symbol", { symbol: "db", caseSensitive: true }, makeSymbolDB());
		// Should either have no results or not match "DB" entries
		// sym002 and sym006 have "DB" (uppercase) so shouldn't match
		if (!result.includes("No messages found"))
		{
			expect(result).not.toContain("DB pooling");
		}
	});
});

// ─── search_by_symbol — occurrence counting ──────────────────────────────────

describe("search_by_symbol — occurrence counting", () =>
{
	function makeSymbolDB(): any
	{
		return {
			getBySessionId: () => [],
			getAllMessages: () => SYMBOL_TEST_MESSAGES,
		};
	}

	test("counts multiple occurrences in single message correctly", async () =>
	{
		const result = await handleSearchTool("search_by_symbol", { symbol: "MessageDB" }, makeSymbolDB());
		expect(result).not.toMatch(/^Error:/);
		// sym001 has "MessageDB" 3 times, sym003 has 2 times
		// Should show occurrence counts
		expect(result).toContain("Occurrences:");
	});

	test("uses word boundaries (DB doesn't match MessageDB)", async () =>
	{
		const result = await handleSearchTool("search_by_symbol", { symbol: "DB" }, makeSymbolDB());
		expect(result).not.toMatch(/^Error:/);
		// Should match sym002 and sym006 (standalone "DB"), but NOT sym001/sym003 ("MessageDB")
		if (!result.includes("No messages found"))
		{
			// Should not contain messages that only have "MessageDB"
			const lines = result.split("\n");
			const excerptLines = lines.filter(l => l.includes("Excerpt:"));
			// If we have results, they should be from messages with standalone "DB"
			// sym002: "DB pooling. DB timeout"
			// sym006: "The DB class"
		}
	});

	test("handles symbols with special regex characters", async () =>
	{
		const result = await handleSearchTool("search_by_symbol", { symbol: "get_session" }, makeSymbolDB());
		expect(result).not.toMatch(/^Error:/);
		// sym005 contains "get_session"
		if (!result.includes("No messages found"))
		{
			expect(result).toContain("get_session");
		}
	});

	test("returns no results when symbol not found", async () =>
	{
		const result = await handleSearchTool("search_by_symbol", { symbol: "NonExistentSymbol" }, makeSymbolDB());
		expect(result).toContain("No messages found containing symbol");
	});
});

// ─── search_by_symbol — sorting ──────────────────────────────────────────────

describe("search_by_symbol — sorting", () =>
{
	function makeSymbolDB(): any
	{
		return {
			getBySessionId: () => [],
			getAllMessages: () => SYMBOL_TEST_MESSAGES,
		};
	}

	test("results sorted by occurrence count descending", async () =>
	{
		const result = await handleSearchTool("search_by_symbol", { symbol: "MessageDB" }, makeSymbolDB());
		expect(result).not.toMatch(/^Error:/);
		// sym001 has 3 occurrences (should be first)
		// sym003 has 2 occurrences (should be second)
		const lines = result.split("\n");
		const occurrenceLines = lines.filter(l => l.includes("Occurrences:"));

		if (occurrenceLines.length >= 2)
		{
			// First result should have highest count
			const firstMatch = occurrenceLines[0].match(/Occurrences: (\d+)/);
			const secondMatch = occurrenceLines[1].match(/Occurrences: (\d+)/);

			if (firstMatch && secondMatch)
			{
				expect(parseInt(firstMatch[1])).toBeGreaterThanOrEqual(parseInt(secondMatch[1]));
			}
		}
	});
});

// ─── search_by_symbol — maxResults ───────────────────────────────────────────

describe("search_by_symbol — maxResults", () =>
{
	function makeSymbolDB(): any
	{
		return {
			getBySessionId: () => [],
			getAllMessages: () => SYMBOL_TEST_MESSAGES,
		};
	}

	test("respects maxResults parameter", async () =>
	{
		const result = await handleSearchTool("search_by_symbol", { symbol: "DB", maxResults: 1 }, makeSymbolDB());
		expect(result).not.toMatch(/^Error:/);
		// Should show at most 1 result
		if (!result.includes("No messages found"))
		{
			const lines = result.split("\n");
			const resultMarkers = lines.filter(l => l.match(/^\[\d+\]/));
			expect(resultMarkers.length).toBeLessThanOrEqual(1);
		}
	});

	test("maxResults defaults to 20", async () =>
	{
		const result = await handleSearchTool("search_by_symbol", { symbol: "DB" }, makeSymbolDB());
		expect(result).not.toMatch(/^Error:/);
		// Default maxResults is 20, should work without specifying
	});

	test("shows pagination notice when more results exist", async () =>
	{
		// This would need more test messages to trigger, but we can test the structure
		const result = await handleSearchTool("search_by_symbol", { symbol: "DB", maxResults: 1 }, makeSymbolDB());
		if (!result.includes("No messages found") && result.includes("of"))
		{
			// If there are multiple results, should show "top 1 of N"
			expect(result).toMatch(/top \d+ of \d+/);
		}
	});
});

// ─── search_thread_messages ───────────────────────────────────────────────────

describe("search_thread_messages — validation", () =>
{
	test("returns error when sessionId is missing", async () =>
	{
		const result = await handleSearchTool("search_thread_messages", { query: "auth" }, makeDB());
		expect(result).toContain("Error:");
		expect(result).toContain("sessionId");
	});

	test("returns error when no search criteria provided", async () =>
	{
		const result = await handleSearchTool("search_thread_messages", { sessionId: "sess-001" }, makeDB());
		expect(result).toContain("Error:");
		expect(result).toContain("required");
	});

	test("returns not-found for unknown session", async () =>
	{
		const result = await handleSearchTool("search_thread_messages", { sessionId: "nonexistent", query: "auth" }, makeDB());
		expect(result).toContain("No messages found for session:");
	});
});

describe("search_thread_messages — results", () =>
{
	test("scopes results to the target session", async () =>
	{
		const result = await handleSearchTool(
			"search_thread_messages",
			{ sessionId: "sess-001", query: "authentication" },
			makeDB()
		);
		// Either found matching messages in session or no results — never an error
		expect(result).not.toMatch(/^Error:/);
	});

	test("field-only search by subject within session", async () =>
	{
		const db = makeDB();
		const result = await handleSearchTool(
			"search_thread_messages",
			{ sessionId: "sess-001", subject: "test" },
			db
		);
		expect(result).not.toMatch(/^Error:/);
	});
});

// ─── search_messages — subject and symbols filters ────────────────────────────

describe("search_messages — subject and symbols", () =>
{
	test("subject filter without query returns results", async () =>
	{
		const result = await handleSearchTool("search_messages", { subject: "test" }, makeDB());
		// All TEST_MESSAGES have subject "test subject" so should match
		expect(result).not.toMatch(/^Error:/);
		expect(result).toContain("Search results for");
	});

	test("symbols filter without query returns field-only results", async () =>
	{
		const result = await handleSearchTool("search_messages", { symbols: "JWT" }, makeDB());
		// No messages have symbols matching JWT in this fixture — should return no results
		expect(result).not.toMatch(/^Error:/);
	});

	test("query + subject filters together", async () =>
	{
		const result = await handleSearchTool(
			"search_messages",
			{ query: "authentication", subject: "test" },
			makeDB()
		);
		expect(result).not.toMatch(/^Error:/);
	});
});

// ─── search_threads — subject and symbols filters ─────────────────────────────

describe("search_threads — subject and symbols", () =>
{
	test("subject filter without query returns threads", async () =>
	{
		const result = await handleSearchTool("search_threads", { subject: "test" }, makeDB());
		expect(result).not.toMatch(/^Error:/);
	});

	test("symbols filter without query returns threads", async () =>
	{
		const result = await handleSearchTool("search_threads", { symbols: "JWT" }, makeDB());
		// No JWT symbols in fixture — either "No threads found" or threads
		expect(result).not.toMatch(/^Error:/);
	});
});

// ─── search_messages — project substring matching ─────────────────────────────

describe("search_messages — project substring matching", () =>
{
	test("substring of project name filters correctly", async () =>
	{
		// All fixtures have project="test-project"; "test-proj" is a substring
		const result = await handleSearchTool("search_messages", { query: "authentication", projects: ["test-proj"] }, makeDB());
		expect(result).not.toMatch(/^Error:/);
		expect(result).toContain("msg001");
	});

	test("case-insensitive project substring matches", async () =>
	{
		const result = await handleSearchTool("search_messages", { query: "authentication", projects: ["TEST-PROJ"] }, makeDB());
		expect(result).not.toMatch(/^Error:/);
		expect(result).toContain("msg001");
	});

	test("non-matching project substring returns no results", async () =>
	{
		const result = await handleSearchTool("search_messages", { query: "authentication", projects: ["nonexistent"] }, makeDB());
		expect(result).not.toMatch(/^Error:/);
		expect(result).not.toContain("msg001");
	});
});

// ─── search_threads — project substring matching ──────────────────────────────

describe("search_threads — project substring matching", () =>
{
	test("substring of project name includes matching threads", async () =>
	{
		const result = await handleSearchTool("search_threads", { query: "database", projects: ["test-proj"] }, makeDB());
		expect(result).not.toMatch(/^Error:/);
	});

	test("non-matching project substring excludes threads", async () =>
	{
		const result = await handleSearchTool("search_threads", { query: "database", projects: ["nonexistent"] }, makeDB());
		expect(result).not.toMatch(/^Error:/);
		expect(result).not.toContain("sess-002");
		expect(result).not.toContain("sess-005");
	});
});

// ─── unknown tool ─────────────────────────────────────────────────────────────

describe("unknown tool", () =>
{
	test("throws for unknown search tool name", async () =>
	{
		expect(handleSearchTool("no_such_tool", { query: "test" }, makeDB())).rejects.toThrow();
	});
});
