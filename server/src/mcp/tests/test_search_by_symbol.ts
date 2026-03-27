import { beforeAll, describe, expect, test } from "bun:test";
import { handleSearchTool } from "../tools/search.js";
import { initSearchIndex } from "../../search/searchEngine.js";
import { buildMockDB, loadMessagesFixture } from "./loadFixtures.js";

let db: Awaited<ReturnType<typeof buildMockDB>>;

beforeAll(async () =>
{
	const messages = await loadMessagesFixture();
	initSearchIndex(messages);
	db = await buildMockDB();
});

describe("test_search_by_symbol (fixture-backed)", () =>
{
	test("finds NNCharacter (top symbol in fixture)", async () =>
	{
		const out = await handleSearchTool("search_by_symbol", { symbol: "NNCharacter" }, db);
		expect(out).not.toContain("Error:");
		expect(out).toContain("Occurrences:");
	});

	test("finds storyTeller", async () =>
	{
		const out = await handleSearchTool("search_by_symbol", { symbol: "storyTeller" }, db);
		expect(out).not.toContain("Error:");
		expect(out).toContain("Occurrences:");
	});

	test("finds Dialog", async () =>
	{
		const out = await handleSearchTool("search_by_symbol", { symbol: "Dialog" }, db);
		expect(out).not.toContain("Error:");
	});

	test("finds NNCharacter with maxResults=5", async () =>
	{
		const out = await handleSearchTool("search_by_symbol", { symbol: "NNCharacter", maxResults: 5 }, db);
		expect(out).toContain("Showing 5");
	});

	test("case sensitive NNCharacter matches correctly", async () =>
	{
		const out = await handleSearchTool("search_by_symbol", { symbol: "NNCharacter", caseSensitive: true }, db);
		expect(out).not.toContain("Error:");
	});

	test("case insensitive nncharacter finds NNCharacter references", async () =>
	{
		const out = await handleSearchTool("search_by_symbol", { symbol: "nncharacter", caseSensitive: false }, db);
		expect(out).not.toContain("Error:");
	});

	test("nonexistent symbol returns no results", async () =>
	{
		const out = await handleSearchTool("search_by_symbol", { symbol: "xyznonexistentsymbol" }, db);
		expect(out).toContain("No messages found containing symbol");
	});

	test("empty symbol returns error", async () =>
	{
		const out = await handleSearchTool("search_by_symbol", { symbol: "" }, db);
		expect(out).toContain("Error:");
	});

	// ─── role filtering (includeAssistantMessages) ────────────────────────────

	test("default search skips assistant messages", async () =>
	{
		const out = await handleSearchTool("search_by_symbol", { symbol: "NNCharacter" }, db);
		expect(out).not.toContain("Error:");
		// Should only contain user-role results
		expect(out).not.toContain("Role: assistant");
	});

	test("includeAssistantMessages=true includes assistant messages", async () =>
	{
		const out = await handleSearchTool(
			"search_by_symbol",
			{ symbol: "NNCharacter", includeAssistantMessages: true },
			db
		);
		expect(out).not.toContain("Error:");
		// Fixture has 3 assistant messages — at least some should mention NNCharacter
		expect(out).toContain("Role: assistant");
	});
});
