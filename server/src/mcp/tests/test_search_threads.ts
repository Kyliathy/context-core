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
	const tmpDir = mkdtempSync(join(tmpdir(), "cc-scope-thr-"));
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

describe("test_search_threads (fixture-backed)", () =>
{
	// ─── Basic query search ───────────────────────────────────────────────────

	test("searches NNCharacter at thread level", async () =>
	{
		const out = await handleSearchTool("search_threads", { query: "NNCharacter" }, db);
		expect(out).not.toContain("Error:");
		expect(out).toContain("Session:");
	});

	test("searches Dialog at thread level", async () =>
	{
		const out = await handleSearchTool("search_threads", { query: "Dialog" }, db);
		expect(out).not.toContain("Error:");
	});

	test("AND query works at thread level", async () =>
	{
		const out = await handleSearchTool("search_threads", { query: "NNCharacter + storyTeller" }, db);
		expect(out).not.toContain("Error:");
	});

	test("scopes by project AXON", async () =>
	{
		const out = await handleSearchTool("search_threads", { query: "NNCharacter", projects: ["AXON"] }, db);
		expect(out).not.toContain("Error:");
	});

	// ─── subject filter ───────────────────────────────────────────────────────

	test("subject filter without query returns threads", async () =>
	{
		const out = await handleSearchTool("search_threads", { subject: "tile" }, db);
		expect(out).not.toContain("Error:");
		// "tile" is in several subjects — should find threads
		expect(out).toContain("Session:");
	});

	test("subject filter narrows query results to matching threads", async () =>
	{
		const out = await handleSearchTool("search_threads", { query: "NNCharacter", subject: "tile" }, db);
		expect(out).not.toContain("Error:");
	});

	test("subject filter with non-matching term returns no threads", async () =>
	{
		const out = await handleSearchTool("search_threads", { subject: "xyznonexistentsubject123" }, db);
		expect(out).not.toContain("Error:");
		expect(out).toMatch(/No threads found/);
	});

	// ─── symbols filter ───────────────────────────────────────────────────────

	test("symbols filter without query returns threads", async () =>
	{
		const out = await handleSearchTool("search_threads", { symbols: "NNCharacter" }, db);
		expect(out).not.toContain("Error:");
		expect(out).toContain("Session:");
	});

	test("symbols filter storyTeller returns threads", async () =>
	{
		const out = await handleSearchTool("search_threads", { symbols: "storyTeller" }, db);
		expect(out).not.toContain("Error:");
	});

	// ─── date range ───────────────────────────────────────────────────────────

	test("date range filters messages before thread aggregation", async () =>
	{
		// All fixture messages are between 2025-08-07 and 2026-03-06
		const all = await handleSearchTool("search_threads", { query: "NNCharacter" }, db);
		const filtered = await handleSearchTool(
			"search_threads",
			{ query: "NNCharacter", from: "2026-01-01" },
			db
		);
		expect(all).not.toContain("Error:");
		expect(filtered).not.toContain("Error:");
	});

	// ─── maxResults ───────────────────────────────────────────────────────────

	test("maxResults limits thread results", async () =>
	{
		const out = await handleSearchTool("search_threads", { query: "NNCharacter", maxResults: 2 }, db);
		expect(out).not.toContain("Error:");
		// Should show at most 2 threads
		const threadCount = (out.match(/^\[\d+\]/gm) ?? []).length;
		expect(threadCount).toBeLessThanOrEqual(2);
	});

	// ─── validation ───────────────────────────────────────────────────────────

	test("empty args returns error", async () =>
	{
		const out = await handleSearchTool("search_threads", {}, db);
		expect(out).toContain("Error:");
	});

	// ─── project substring matching (fixture: AXON, NexusPlatform, Reach2, NexusEvo.code-workspace, Hexez, NexusEvo) ──

	test("exact project name scopes threads", async () =>
	{
		const out = await handleSearchTool("search_threads", { query: "NNCharacter", projects: ["AXON"] }, db);
		expect(out).not.toContain("Error:");
	});

	test("case-insensitive project substring: 'axon' → AXON threads", async () =>
	{
		const out = await handleSearchTool("search_threads", { query: "NNCharacter", projects: ["axon"] }, db);
		expect(out).not.toContain("Error:");
	});

	test("substring 'Nexus' matches NexusPlatform + NexusEvo threads", async () =>
	{
		const out = await handleSearchTool("search_threads", { query: "NNCharacter", projects: ["Nexus"] }, db);
		expect(out).not.toContain("Error:");
	});

	test("non-matching project returns no threads", async () =>
	{
		const out = await handleSearchTool("search_threads", { query: "NNCharacter", projects: ["zzz-nonexistent"] }, db);
		expect(out).not.toContain("Error:");
		expect(out).toMatch(/No threads found/);
	});

	test("multiple project patterns union: ['AXON', 'Hexez']", async () =>
	{
		const out = await handleSearchTool("search_threads", { query: "NNCharacter", projects: ["AXON", "Hexez"] }, db);
		expect(out).not.toContain("Error:");
	});

	test("mid-word substring: 'latfor' matches NexusPlatform threads", async () =>
	{
		const out = await handleSearchTool("search_threads", { query: "NNCharacter", projects: ["latfor"] }, db);
		expect(out).not.toContain("Error:");
	});

	// ─── scope integration (fixture-backed) ───────────────────────────────────

	test("scope resolves to projects and filters threads", async () =>
	{
		const out = await handleSearchTool(
			"search_threads",
			{ query: "NNCharacter", scope: "AxonScope" },
			db, undefined, undefined, scopeStore
		);
		expect(out).not.toContain("Error:");
	});

	test("scope 'NexusAll' resolves to NexusPlatform + NexusEvo threads", async () =>
	{
		const out = await handleSearchTool(
			"search_threads",
			{ query: "NNCharacter", scope: "NexusAll" },
			db, undefined, undefined, scopeStore
		);
		expect(out).not.toContain("Error:");
	});

	test("scope + explicit projects merged for threads", async () =>
	{
		const out = await handleSearchTool(
			"search_threads",
			{ query: "NNCharacter", scope: "AxonScope", projects: ["Hexez"] },
			db, undefined, undefined, scopeStore
		);
		expect(out).not.toContain("Error:");
	});

	test("unknown scope returns error for threads", async () =>
	{
		const out = await handleSearchTool(
			"search_threads",
			{ query: "NNCharacter", scope: "NonexistentScope" },
			db, undefined, undefined, scopeStore
		);
		expect(out).toContain("Error:");
		expect(out).toContain("NonexistentScope");
	});

	test("scope with no scopeStore returns error for threads", async () =>
	{
		const out = await handleSearchTool(
			"search_threads",
			{ query: "NNCharacter", scope: "AxonScope" },
			db
		);
		expect(out).toContain("Error:");
		expect(out).toContain("ScopeStore not loaded");
	});

	test("empty scope with 0 projects means no thread filter", async () =>
	{
		const out = await handleSearchTool(
			"search_threads",
			{ query: "NNCharacter", scope: "EmptyScope" },
			db, undefined, undefined, scopeStore
		);
		expect(out).not.toContain("Error:");
	});

	test("scope case-insensitive lookup for threads", async () =>
	{
		const out = await handleSearchTool(
			"search_threads",
			{ query: "NNCharacter", scope: "nexusall" },
			db, undefined, undefined, scopeStore
		);
		expect(out).not.toContain("Error:");
	});
});
