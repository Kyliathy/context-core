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
  const tmpDir = mkdtempSync(join(tmpdir(), "cc-scope-test-"));
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
      id: "scope-1",
      name: "TestScope",
      emoji: "🔍",
      color: "#FF0000",
      projectIds: [
        { harness: "ClaudeCode", project: "AXON" },
        { harness: "VSCode", project: "zz-axon" },
      ],
    },
    {
      id: "scope-2",
      name: "EmptyScope",
      emoji: "📭",
      color: "#00FF00",
      projectIds: [],
    },
  ]);
});

describe("scope resolution in search tools", () =>
{
  test("scope resolves to its project names and filters results", async () =>
  {
    const out = await handleSearchTool(
      "search_messages",
      { query: "NNCharacter", scope: "TestScope" },
      db, undefined, undefined, scopeStore
    );
    // TestScope includes "AXON" which matches fixture data
    expect(out).not.toContain("Error:");
    expect(out).toContain("Search results for");
  });

  test("scope resolution is case-insensitive", async () =>
  {
    const out = await handleSearchTool(
      "search_messages",
      { query: "NNCharacter", scope: "testscope" },
      db, undefined, undefined, scopeStore
    );
    expect(out).not.toContain("Error:");
  });

  test("unknown scope returns error with available names", async () =>
  {
    const out = await handleSearchTool(
      "search_messages",
      { query: "NNCharacter", scope: "nonexistent" },
      db, undefined, undefined, scopeStore
    );
    expect(out).toContain("Error:");
    expect(out).toContain("nonexistent");
    expect(out).toContain("TestScope");
  });

  test("empty scope string is ignored", async () =>
  {
    const out = await handleSearchTool(
      "search_messages",
      { query: "NNCharacter", scope: "" },
      db, undefined, undefined, scopeStore
    );
    expect(out).not.toContain("Error:");
    expect(out).toContain("Search results for");
  });

  test("scope without scopeStore returns error", async () =>
  {
    const out = await handleSearchTool(
      "search_messages",
      { query: "NNCharacter", scope: "TestScope" },
      db, undefined, undefined, undefined
    );
    expect(out).toContain("Error:");
    expect(out).toContain("ScopeStore not loaded");
  });

  test("scope + explicit projects are merged", async () =>
  {
    // TestScope has AXON, plus explicit "nexus" — both should apply
    const out = await handleSearchTool(
      "search_messages",
      { query: "NNCharacter", scope: "TestScope", projects: ["nexus"] },
      db, undefined, undefined, scopeStore
    );
    // Should still find AXON results (from scope)
    expect(out).not.toContain("Error:");
  });

  test("scope works with search_threads", async () =>
  {
    const out = await handleSearchTool(
      "search_threads",
      { query: "NNCharacter", scope: "TestScope" },
      db, undefined, undefined, scopeStore
    );
    expect(out).not.toContain("Error:");
  });

  test("empty scope with 0 projects means no filter from scope", async () =>
  {
    const out = await handleSearchTool(
      "search_messages",
      { query: "NNCharacter", scope: "EmptyScope" },
      db, undefined, undefined, scopeStore
    );
    // EmptyScope has 0 projects, so no project filter → all results returned
    expect(out).not.toContain("Error:");
    expect(out).toContain("Search results for");
  });
});
