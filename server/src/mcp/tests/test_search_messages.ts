import { beforeAll, describe, expect, test } from "bun:test";
import { handleSearchTool } from "../tools/search.js";
import { initSearchIndex } from "../../search/searchEngine.js";
import { buildMockDB, loadMessagesFixture } from "./loadFixtures.js";
import { ScopeStore } from "../../settings/ScopeStore.js";
import type { ScopeEntry } from "../../models/ScopeEntry.js";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let db: Awaited<ReturnType<typeof buildMockDB>>;
let scopeStore: ScopeStore;

function buildScopeStore(scopes: ScopeEntry[]): ScopeStore
{
	const tmpDir = mkdtempSync(join(tmpdir(), "cc-scope-msg-"));
	const settingsDir = join(tmpDir, ".settings");
	mkdirSync(settingsDir, { recursive: true });
	writeFileSync(join(settingsDir, "scopes.json"), JSON.stringify(scopes), "utf-8");
	const store = new ScopeStore(tmpDir);
	store.load();
	return store;
}

beforeAll(async () =>
{
	const messages = await loadMessagesFixture();
	initSearchIndex(messages);
	db = await buildMockDB();
	scopeStore = buildScopeStore([
		{
			id: "scope-axon",
			name: "AxonScope",
			emoji: "🎯",
			color: "#FF0000",
			projectIds: [
				{ harness: "ClaudeCode", project: "AXON" },
			],
		},
		{
			id: "scope-nexus",
			name: "NexusAll",
			emoji: "🌐",
			color: "#0000FF",
			projectIds: [
				{ harness: "VSCode", project: "NexusPlatform" },
				{ harness: "Cursor", project: "NexusEvo" },
			],
		},
		{
			id: "scope-empty",
			name: "EmptyScope",
			emoji: "📭",
			color: "#00FF00",
			projectIds: [],
		},
	]);
});

describe("test_search_messages (fixture-backed)", () =>
{
	// ─── Basic query search ───────────────────────────────────────────────────

	test("simple fuzzy query NNCharacter returns results", async () =>
	{
		const out = await handleSearchTool("search_messages", { query: "NNCharacter" }, db);
		expect(out).toContain("Search results for");
		expect(out).not.toContain("Error:");
	});

	test("exact phrase query NNCharacter returns results", async () =>
	{
		const out = await handleSearchTool("search_messages", { query: '"NNCharacter"' }, db);
		expect(out).toContain("Search results for");
	});

	test("OR query storyTeller Dialog works", async () =>
	{
		const out = await handleSearchTool("search_messages", { query: "storyTeller Dialog" }, db);
		expect(out).toContain("Search results for");
	});

	test("AND query NNCharacter + Dialog works", async () =>
	{
		const out = await handleSearchTool("search_messages", { query: "NNCharacter + Dialog" }, db);
		expect(out).not.toContain("Error:");
	});

	test("maxResults=3 limits output", async () =>
	{
		const out = await handleSearchTool("search_messages", { query: "NNCharacter", maxResults: 3 }, db);
		expect(out).toContain("Showing 3");
	});

	test("projects filter AXON scopes results", async () =>
	{
		const out = await handleSearchTool("search_messages", { query: "NNCharacter", projects: ["AXON"] }, db);
		expect(out).not.toContain("Error:");
	});

	// ─── subject filter ───────────────────────────────────────────────────────

	test("subject filter without query returns field-only results", async () =>
	{
		const out = await handleSearchTool("search_messages", { subject: "tile" }, db);
		expect(out).not.toContain("Error:");
		expect(out).toContain("Search results for");
	});

	test("subject filter narrows full-text search results", async () =>
	{
		const out = await handleSearchTool("search_messages", { query: "NNCharacter", subject: "tile" }, db);
		expect(out).not.toContain("Error:");
	});

	test("subject filter with non-matching term returns no-results message", async () =>
	{
		const out = await handleSearchTool("search_messages", { subject: "xyznonexistentsubject123" }, db);
		expect(out).not.toContain("Error:");
		expect(out).toMatch(/No results found/);
	});

	// ─── symbols filter ───────────────────────────────────────────────────────

	test("symbols filter without query returns field-only results", async () =>
	{
		const out = await handleSearchTool("search_messages", { symbols: "NNCharacter" }, db);
		expect(out).not.toContain("Error:");
		expect(out).toContain("Search results for");
	});

	test("symbols filter storyTeller returns results", async () =>
	{
		const out = await handleSearchTool("search_messages", { symbols: "storyTeller" }, db);
		expect(out).not.toContain("Error:");
		expect(out).toContain("Search results for");
	});

	test("symbols filter narrows full-text search", async () =>
	{
		const out = await handleSearchTool("search_messages", { query: "NNCharacter", symbols: "Dialog" }, db);
		expect(out).not.toContain("Error:");
	});

	// ─── validation ───────────────────────────────────────────────────────────

	test("empty args returns error", async () =>
	{
		const out = await handleSearchTool("search_messages", {}, db);
		expect(out).toContain("Error:");
	});

	test("only empty query string returns error", async () =>
	{
		const out = await handleSearchTool("search_messages", { query: "" }, db);
		expect(out).toContain("Error:");
	});

	// ─── role filtering (includeAssistantMessages) ────────────────────────────

	test("default search returns only human (user) messages", async () =>
	{
		const out = await handleSearchTool("search_messages", { query: "NNCharacter" }, db);
		expect(out).not.toContain("Error:");
		// Fixture has 3 assistant messages — none should appear in default results
		expect(out).not.toContain("Role: assistant");
	});

	test("includeAssistantMessages=true returns assistant messages too", async () =>
	{
		const out = await handleSearchTool(
			"search_messages",
			{ query: "NNCharacter", includeAssistantMessages: true },
			db
		);
		expect(out).not.toContain("Error:");
		// With all roles included, should see at least one assistant result
		expect(out).toContain("Role: assistant");
	});

	// ─── project substring matching (fixture: AXON, NexusPlatform, Reach2, NexusEvo.code-workspace, Hexez, NexusEvo) ──

	test("exact project name still matches", async () =>
	{
		const out = await handleSearchTool("search_messages", { query: "NNCharacter", projects: ["AXON"] }, db);
		expect(out).not.toContain("Error:");
		expect(out).toContain("Search results for");
	});

	test("case-insensitive project match: 'axon' → AXON", async () =>
	{
		const out = await handleSearchTool("search_messages", { query: "NNCharacter", projects: ["axon"] }, db);
		expect(out).not.toContain("Error:");
		expect(out).toContain("Search results for");
	});

	test("substring 'Nexus' matches NexusPlatform + NexusEvo.code-workspace + NexusEvo", async () =>
	{
		const out = await handleSearchTool("search_messages", { query: "NNCharacter", projects: ["Nexus"] }, db);
		expect(out).not.toContain("Error:");
		expect(out).toContain("Search results for");
		// Should NOT include AXON or Hexez messages
		expect(out).not.toContain("Project: AXON");
		expect(out).not.toContain("Project: Hexez");
	});

	test("substring 'Evo' matches NexusEvo.code-workspace + NexusEvo but not NexusPlatform", async () =>
	{
		const out = await handleSearchTool(
			"search_messages",
			{ query: "NNCharacter", projects: ["Evo"], includeAssistantMessages: true },
			db
		);
		expect(out).not.toContain("Error:");
		expect(out).not.toContain("Project: NexusPlatform");
		expect(out).not.toContain("Project: AXON");
	});

	test("non-matching project substring returns no results", async () =>
	{
		const out = await handleSearchTool("search_messages", { query: "NNCharacter", projects: ["zzz-nonexistent"] }, db);
		expect(out).not.toContain("Error:");
		expect(out).toMatch(/No results found/);
	});

	test("multiple project patterns union: ['AXON', 'Hexez'] matches both", async () =>
	{
		const out = await handleSearchTool("search_messages", { query: "NNCharacter", projects: ["AXON", "Hexez"] }, db);
		expect(out).not.toContain("Error:");
		expect(out).toContain("Search results for");
		expect(out).not.toContain("Project: NexusPlatform");
	});

	test("substring catches mid-word: 'latfor' → NexusPlatform", async () =>
	{
		const out = await handleSearchTool("search_messages", { query: "NNCharacter", projects: ["latfor"] }, db);
		expect(out).not.toContain("Error:");
		expect(out).not.toContain("Project: AXON");
	});

	// ─── scope integration (fixture-backed) ───────────────────────────────────

	test("scope resolves to projects and filters results", async () =>
	{
		const out = await handleSearchTool(
			"search_messages",
			{ query: "NNCharacter", scope: "AxonScope" },
			db, undefined, undefined, scopeStore
		);
		expect(out).not.toContain("Error:");
		expect(out).toContain("Search results for");
		expect(out).not.toContain("Project: NexusPlatform");
		expect(out).not.toContain("Project: Hexez");
	});

	test("scope 'NexusAll' resolves to NexusPlatform + NexusEvo (substring matches)", async () =>
	{
		const out = await handleSearchTool(
			"search_messages",
			{ query: "NNCharacter", scope: "NexusAll", includeAssistantMessages: true },
			db, undefined, undefined, scopeStore
		);
		expect(out).not.toContain("Error:");
		expect(out).not.toContain("Project: AXON");
		expect(out).not.toContain("Project: Hexez");
	});

	test("scope + explicit projects merges both sets", async () =>
	{
		// NexusAll scope has NexusPlatform + NexusEvo, plus we add AXON explicitly
		const out = await handleSearchTool(
			"search_messages",
			{ query: "NNCharacter", scope: "NexusAll", projects: ["AXON"] },
			db, undefined, undefined, scopeStore
		);
		expect(out).not.toContain("Error:");
		expect(out).toContain("Search results for");
		// Should NOT include Hexez (not in scope or projects)
		expect(out).not.toContain("Project: Hexez");
	});

	test("scope + projects where projects add new coverage", async () =>
	{
		// AxonScope has AXON, explicit projects adds Hexez
		const out = await handleSearchTool(
			"search_messages",
			{ query: "NNCharacter", scope: "AxonScope", projects: ["Hexez"] },
			db, undefined, undefined, scopeStore
		);
		expect(out).not.toContain("Error:");
		expect(out).not.toContain("Project: NexusPlatform");
	});

	test("empty scope is ignored, all projects searched", async () =>
	{
		const out = await handleSearchTool(
			"search_messages",
			{ query: "NNCharacter", scope: "" },
			db, undefined, undefined, scopeStore
		);
		expect(out).not.toContain("Error:");
		expect(out).toContain("Search results for");
	});

	test("unknown scope returns error", async () =>
	{
		const out = await handleSearchTool(
			"search_messages",
			{ query: "NNCharacter", scope: "NonexistentScope" },
			db, undefined, undefined, scopeStore
		);
		expect(out).toContain("Error:");
		expect(out).toContain("NonexistentScope");
	});

	test("scope with no scopeStore returns error", async () =>
	{
		const out = await handleSearchTool(
			"search_messages",
			{ query: "NNCharacter", scope: "AxonScope" },
			db
		);
		expect(out).toContain("Error:");
		expect(out).toContain("ScopeStore not loaded");
	});

	test("empty scope with 0 projects means no filter", async () =>
	{
		const out = await handleSearchTool(
			"search_messages",
			{ query: "NNCharacter", scope: "EmptyScope" },
			db, undefined, undefined, scopeStore
		);
		// EmptyScope has 0 projects → no filter → all results
		expect(out).not.toContain("Error:");
		expect(out).toContain("Search results for");
	});

	test("scope case-insensitive lookup", async () =>
	{
		const out = await handleSearchTool(
			"search_messages",
			{ query: "NNCharacter", scope: "axonscope" },
			db, undefined, undefined, scopeStore
		);
		expect(out).not.toContain("Error:");
		expect(out).toContain("Search results for");
	});

	// ─── combination tests: scope + project + other filters ───────────────────

	test("combo: scope with substring project overlap — deduplicates patterns", async () =>
	{
		// AxonScope resolves to "AXON", explicit projects also has "AXON" — union should dedup
		// and still return AXON results only (not duplicate them)
		const out = await handleSearchTool(
			"search_messages",
			{ query: "NNCharacter", scope: "AxonScope", projects: ["AXON"] },
			db, undefined, undefined, scopeStore
		);
		expect(out).not.toContain("Error:");
		expect(out).toContain("Search results for");
		expect(out).not.toContain("Project: NexusPlatform");
		expect(out).not.toContain("Project: Hexez");
	});

	test("combo: wide scope (4 projects) + subject filter narrows to matching subjects only", async () =>
	{
		// Custom scope covering everything except Hexez
		const wideStore = buildScopeStore([{
			id: "scope-wide",
			name: "WideScope",
			emoji: "🌍",
			color: "#AABBCC",
			projectIds: [
				{ harness: "ClaudeCode", project: "AXON" },
				{ harness: "VSCode", project: "NexusPlatform" },
				{ harness: "Cursor", project: "NexusEvo" },
				{ harness: "Kiro", project: "Reach2" },
			],
		}]);
		const out = await handleSearchTool(
			"search_messages",
			{ subject: "tile", scope: "WideScope", includeAssistantMessages: true },
			db, undefined, undefined, wideStore
		);
		expect(out).not.toContain("Error:");
		// Hexez should be excluded by scope
		expect(out).not.toContain("Project: Hexez");
	});

	test("combo: NexusAll scope + 'Hexez' project + date range", async () =>
	{
		// NexusAll → NexusPlatform + NexusEvo, plus "Hexez" — combined with date range
		const out = await handleSearchTool(
			"search_messages",
			{ query: "NNCharacter", scope: "NexusAll", projects: ["Hexez"], from: "2025-01-01", to: "2026-12-31" },
			db, undefined, undefined, scopeStore
		);
		expect(out).not.toContain("Error:");
		// AXON should be excluded (not in NexusAll or explicit projects)
		expect(out).not.toContain("Project: AXON");
	});

	test("combo: single-project scope + non-overlapping explicit project covers both", async () =>
	{
		// AxonScope = AXON only; explicit projects = ["latfor"] (substring → NexusPlatform)
		// Together they should cover AXON + NexusPlatform
		const out = await handleSearchTool(
			"search_messages",
			{ query: "NNCharacter", scope: "AxonScope", projects: ["latfor"] },
			db, undefined, undefined, scopeStore
		);
		expect(out).not.toContain("Error:");
		expect(out).toContain("Search results for");
		// Both Hexez and Reach2 and NexusEvo should be excluded
		expect(out).not.toContain("Project: Hexez");
	});

	test("combo: scope with substring projects + symbols filter + includeAssistant", async () =>
	{
		// NexusAll scope → NexusPlatform + NexusEvo (substring hits NexusEvo.code-workspace too)
		// Combined with symbols filter for "NNCharacter" and includeAssistantMessages
		const out = await handleSearchTool(
			"search_messages",
			{ symbols: "NNCharacter", scope: "NexusAll", includeAssistantMessages: true },
			db, undefined, undefined, scopeStore
		);
		expect(out).not.toContain("Error:");
		// AXON should be excluded
		expect(out).not.toContain("Project: AXON");
		expect(out).not.toContain("Project: Hexez");
	});
});
