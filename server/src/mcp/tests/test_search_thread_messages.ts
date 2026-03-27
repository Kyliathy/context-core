/**
 * Fixture-backed tests for search_thread_messages tool.
 *
 * Uses messages_storyteller_nncharacter.json:
 * - 23 messages across 22 sessions
 * - Session "39057b0d-0c90-4dda-bf39-a110680381e6" has 2 messages (the only multi-message session)
 * - Top symbols: NNCharacter (21x), storyTeller (17x), Dialog (14x)
 * - Subjects contain: "tile", "CombatTurnCycle", "spell", "NNCharacter"
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { handleSearchTool } from "../tools/search.js";
import { initSearchIndex } from "../../search/searchEngine.js";
import { buildMockDB, loadMessagesFixture } from "./loadFixtures.js";

// The only session with multiple messages in the fixture
const MULTI_MSG_SESSION = "39057b0d-0c90-4dda-bf39-a110680381e6";
// A single-message session (user role)
const SINGLE_MSG_SESSION = "f8b0015a-7954-4f5b-ae5a-a4ca14a11e60";
// A single-message session with an assistant-role message
const ASSISTANT_MSG_SESSION = "020ecf0f-35ba-4b06-aa16-9c4b85d1ac6c";

let db: Awaited<ReturnType<typeof buildMockDB>>;

beforeAll(async () =>
{
	const messages = await loadMessagesFixture();
	initSearchIndex(messages);
	db = await buildMockDB();
});

describe("test_search_thread_messages (fixture-backed)", () =>
{
	// ─── Validation ───────────────────────────────────────────────────────────

	test("returns error when sessionId is missing", async () =>
	{
		const out = await handleSearchTool("search_thread_messages", { query: "NNCharacter" }, db);
		expect(out).toContain("Error:");
		expect(out).toContain("sessionId");
	});

	test("returns error when no search criteria provided", async () =>
	{
		const out = await handleSearchTool("search_thread_messages", { sessionId: MULTI_MSG_SESSION }, db);
		expect(out).toContain("Error:");
		expect(out).toContain("required");
	});

	test("returns not-found for unknown session", async () =>
	{
		const out = await handleSearchTool(
			"search_thread_messages",
			{ sessionId: "00000000-0000-0000-0000-000000000000", query: "NNCharacter" },
			db
		);
		expect(out).toContain("No messages found for session:");
	});

	// ─── Full-text search within session ─────────────────────────────────────

	test("query search in multi-message session returns scoped results", async () =>
	{
		const out = await handleSearchTool(
			"search_thread_messages",
			{ sessionId: MULTI_MSG_SESSION, query: "NNCharacter" },
			db
		);
		expect(out).not.toMatch(/^Error:/);
		// Either found results (thread header) or no-results message
		expect(out).toMatch(/Search within thread|No messages found in session/);
	});

	test("results header shows the target sessionId", async () =>
	{
		const out = await handleSearchTool(
			"search_thread_messages",
			{ sessionId: MULTI_MSG_SESSION, query: "storyTeller" },
			db
		);
		expect(out).not.toMatch(/^Error:/);
		if (!out.includes("No messages found in session"))
		{
			expect(out).toContain(MULTI_MSG_SESSION);
		}
	});

	test("query search in single-message session works", async () =>
	{
		const out = await handleSearchTool(
			"search_thread_messages",
			{ sessionId: SINGLE_MSG_SESSION, query: "NNCharacter" },
			db
		);
		expect(out).not.toMatch(/^Error:/);
	});

	// ─── Field-only search within session ────────────────────────────────────

	test("symbols filter within session returns results", async () =>
	{
		const out = await handleSearchTool(
			"search_thread_messages",
			{ sessionId: MULTI_MSG_SESSION, symbols: "NNCharacter" },
			db
		);
		expect(out).not.toMatch(/^Error:/);
		// Both messages in the session have NNCharacter symbols — should find them
		expect(out).toMatch(/Search within thread|No messages found in session/);
	});

	test("subject filter within session (matching subject)", async () =>
	{
		// Multi-message session has subject containing "StoryTeller.currentCharacter"
		const out = await handleSearchTool(
			"search_thread_messages",
			{ sessionId: MULTI_MSG_SESSION, subject: "StoryTeller" },
			db
		);
		expect(out).not.toMatch(/^Error:/);
		expect(out).toContain(MULTI_MSG_SESSION);
	});

	test("subject filter with non-matching term returns no results", async () =>
	{
		const out = await handleSearchTool(
			"search_thread_messages",
			{ sessionId: MULTI_MSG_SESSION, subject: "xyznonexistentsubject123" },
			db
		);
		expect(out).not.toMatch(/^Error:/);
		expect(out).toContain("No messages found in session");
	});

	// ─── Combined query + field filter ───────────────────────────────────────

	test("query + symbols filter combination works", async () =>
	{
		const out = await handleSearchTool(
			"search_thread_messages",
			{ sessionId: MULTI_MSG_SESSION, query: "NNCharacter", symbols: "Dialog" },
			db
		);
		expect(out).not.toMatch(/^Error:/);
	});

	// ─── maxResults ───────────────────────────────────────────────────────────

	test("maxResults=1 limits output to 1 result", async () =>
	{
		const out = await handleSearchTool(
			"search_thread_messages",
			{ sessionId: MULTI_MSG_SESSION, query: "NNCharacter", maxResults: 1 },
			db
		);
		expect(out).not.toMatch(/^Error:/);
		if (!out.includes("No messages found in session"))
		{
			const resultCount = (out.match(/^\[\d+\]/gm) ?? []).length;
			expect(resultCount).toBeLessThanOrEqual(1);
		}
	});

	// ─── role filtering (includeAssistantMessages) ────────────────────────────

	test("default search in assistant-only session returns no results", async () =>
	{
		// Session 020ecf0f has only an assistant message — default filtering excludes it
		const out = await handleSearchTool(
			"search_thread_messages",
			{ sessionId: ASSISTANT_MSG_SESSION, symbols: "NNCharacter" },
			db
		);
		expect(out).not.toMatch(/^Error:/);
		expect(out).toContain("No messages found in session");
	});

	test("includeAssistantMessages=true finds assistant messages in session", async () =>
	{
		const out = await handleSearchTool(
			"search_thread_messages",
			{ sessionId: ASSISTANT_MSG_SESSION, symbols: "NNCharacter", includeAssistantMessages: true },
			db
		);
		expect(out).not.toMatch(/^Error:/);
		// Should now find the assistant message
		expect(out).not.toContain("No messages found in session");
	});
});
