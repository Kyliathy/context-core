# R2M6 â€” MCP Iteration 5: Scope-Aware Search & Substring Project Matching

**Date**: 2026-03-26
**Status**: Done
**Scope**: Add `scope` argument to MCP search tools; change project matching from exact-equality to substring (SQL LIKE `%project%` semantics)
**Parent**: [archi-mcp.md](../../architecture/mcp/archi-mcp.md)
**Predecessor**: [r2m5-mcp-iteration-4.md](r2m5-mcp-iteration-4.md)
**Related**: [archi-search.md](../../architecture/search/archi-search.md)

---

## 1. Problem

### 1.1 No Scope Support in MCP

The visualizer already has **scopes** â€” named groupings of projects stored in `.settings/scopes.json` via `ScopeStore`. A scope like "Reach2" might contain `{ harness: "ClaudeCode", project: "zz-reach2" }`, `{ harness: "VSCode", project: "zz-reach2" }`, `{ harness: "Cursor", project: "reach2-web" }`, etc.

But the MCP tools don't know about scopes. An LLM that wants to search within a scope has to know the individual project names and pass them all in `projects: [...]`. This defeats the purpose of scopes â€” they exist precisely to avoid enumerating projects every time.

### 1.2 Project Matching Is Exact-Equality

Current project filtering in `extractProjectFilter()` builds a `Set<string>` and uses `projectFilter.has(r.message.project)` â€” **exact match only**. If the LLM says `projects: ["reach2"]`, it will NOT match messages from project `"zz-reach2"` or `"reach2-web"`. The LLM has to know the precise project name, which is fragile and defeats natural-language interaction.

---

## 2. Design

### 2.1 New `scope` Argument on Search Tools

Add an optional `scope` string parameter to `search_messages` and `search_threads` (the two tools that already accept `projects`).

```typescript
scope: {
    type: "string",
    description:
        "Name of a saved scope to search within. A scope groups multiple projects together. " +
        "When provided, the scope is resolved to its constituent projects, which are merged " +
        "with any explicitly provided 'projects' list. " +
        "Use the cxc://projects resource to see available projects and scopes."
}
```

**Resolution flow:**

1. MCP handler receives `scope: "Reach2"`.
2. Look up the scope by name (case-insensitive) in `ScopeStore`.
3. Extract `projectIds[].project` from the matched `ScopeEntry`.
4. Merge these project names into whatever `projects` array was also provided (union, not replace).
5. Proceed with the normal project filter logic (now using substring matching per Â§2.2).

**Edge cases:**
- Scope not found â†’ return error: `"Error: Scope '{name}' not found. Available scopes: ..."`
- Both `scope` and `projects` provided â†’ merge (union of both sets).
- Scope has 0 projects â†’ effectively no filter from scope (only `projects` array applies, if any).

### 2.2 Substring Project Matching (LIKE `%project%`)

Change project filtering from exact-equality to **case-insensitive substring matching**. When the MCP handler passes `"reach2"`, it should match any project whose name contains `"reach2"` â€” including `"zz-reach2"`, `"reach2-web"`, `"Reach2"`, etc.

**Where this changes:**

| Layer                            | Current                                     | New                                         |
| -------------------------------- | ------------------------------------------- | ------------------------------------------- |
| **MCP `extractProjectFilter()`** | Returns `Set<string>`                       | Returns `string[]` (patterns)               |
| **MCP search handlers**          | `projectFilter.has(msg.project)`            | `matchesAnyProject(msg.project, patterns)`  |
| **`hybridMerge()` â†’ Qdrant**     | `ProjectFilter[]` with exact `.project`     | `ProjectFilter[]` with `%pattern%` matching |
| **`runQdrantSearch()`**          | `qdrantProjectNames.has(h.payload.project)` | Substring match against Qdrant hits         |

**New helper function:**

```typescript
/**
 * Tests whether a message's project name matches any of the given patterns.
 * Each pattern is treated as a case-insensitive substring (SQL LIKE %pattern%).
 */
function matchesAnyProject(project: string, patterns: string[]): boolean
{
    if (patterns.length === 0) return true; // no filter = match all
    const lower = project.toLowerCase();
    return patterns.some(p => lower.includes(p.toLowerCase()));
}
```

This is intentionally **not regex/glob** â€” just `.toLowerCase().includes()`. The mental model for the LLM is "search in reach2" and it should just work. The `%project%` convention mentioned in the SQL LIKE analogy is purely conceptual for the user; the implementation is simple substring matching.

### 2.3 Scope Resolution in `runQdrantSearch()`

The Qdrant search path (`runQdrantSearch` in `routeUtils.ts`) also filters by project. Currently:

```typescript
const qdrantProjectNames = new Set(projectFilters.map(p => p.project));
qdrantHits = qdrantHits.filter(h => qdrantProjectNames.has(h.payload.project));
```

This needs the same substring-matching treatment. The change should use the same `matchesAnyProject()` helper (or an equivalent) to filter Qdrant hits.

---

## 3. Task List

### Group A â€” Plumbing & simple helpers (signatures, types, wiring)

{{SIMPLE}}

- [x] **A1.** In `src/mcp/tools/search.ts`: add the `matchesAnyProject(project, patterns)` helper function (case-insensitive `.includes()` substring matching, returns `true` when patterns is empty). Export it.
- [x] **A2.** In `src/mcp/tools/search.ts`: change `extractProjectFilter()` return type from `Set<string>` to `string[]`. Update body: replace `new Set(...)` with a plain filtered/trimmed array.
- [x] **A3.** In `src/mcp/MCPServer.ts`: add optional `scopeStore?: ScopeStore` parameter to the constructor. Store it as a private field. Pass it to `registerAll()`.
- [x] **A4.** In `src/mcp/registry.ts`: add `scopeStore?: ScopeStore` param to `registerAll()` and `registerTools()`. Forward it to `handleSearchTool()` calls.
- [x] **A5.** In `src/mcp/tools/search.ts`: add `scopeStore?: ScopeStore` param to `handleSearchTool()` signature. Import `ScopeStore` type.
- [x] **A6.** In `src/mcp/serve.ts`: instantiate `ScopeStore`, call `.load()`, pass it to `MCPServer` constructor (same pattern as `TopicStore`).

### Group B â€” Core logic changes (project matching, scope resolution, tool defs)

{{MEDIUM}}

- [x] **B1.** In `src/mcp/tools/search.ts`: replace all `projectFilter.has(r.message.project)` calls in `search_messages` handler (both full-text and field-only paths) with `matchesAnyProject(r.message.project, projectPatterns)`. Update the guard from `.size > 0` to `.length > 0`.
- [x] **B2.** In `src/mcp/tools/search.ts`: same replacement in `search_threads` handler â€” both full-text and field-only paths.
- [x] **B3.** In `src/mcp/tools/search.ts`: update `hybridMerge()` â€” its `projectFilter` param changes from `Set<string>` to `string[]`; update the `ProjectFilter[]` conversion to pass patterns instead of exact names.
- [x] **B4.** In `src/server/routeUtils.ts` â†’ `runQdrantSearch()`: replace the `qdrantProjectNames.has()` filter with substring matching (import or inline `matchesAnyProject`).
- [x] **B5.** In `src/mcp/tools/search.ts`: add the `resolveProjectPatterns(args, scopeStore)` function â€” looks up scope by name (case-insensitive) in `ScopeStore.list()`, extracts `.projectIds[].project`, merges with explicit `projects` array, returns `string[]` or `{ error }`.
- [x] **B6.** In `src/mcp/tools/search.ts`: wire `resolveProjectPatterns()` into `search_messages` handler â€” call it early, return error string if it fails, otherwise use the returned `string[]` as project patterns.
- [x] **B7.** In `src/mcp/tools/search.ts`: wire `resolveProjectPatterns()` into `search_threads` handler â€” same pattern as B6.

{{MEDIUM}}

- [x] **B8.** In `src/mcp/tools/search.ts` â†’ `SEARCH_TOOL_DEFINITIONS`: add the `scope` property to `search_messages` inputSchema (type string, description about scope resolution).
- [x] **B9.** In `src/mcp/tools/search.ts` â†’ `SEARCH_TOOL_DEFINITIONS`: add the `scope` property to `search_threads` inputSchema (same as B8).
- [x] **B10.** In `src/mcp/tools/search.ts` â†’ `SEARCH_TOOL_DEFINITIONS`: update `projects` description on both `search_messages` and `search_threads` to mention substring matching behavior ("names are matched as case-insensitive substrings").

### Group C â€” Tests

{{MEDIUM}}

- [x] **C1.** Create `src/mcp/tests/test_project_matching.ts`: unit tests for `matchesAnyProject()` â€” exact match, substring match (`"reach2"` â†’ `"zz-reach2"`, `"reach2-web"`), case-insensitive (`"axon"` â†’ `"AXON"`), mid-word (`"xon"` â†’ `"AXON"`), empty patterns matches all.
- [x] **C2.** In same file or new `test_scope_resolution.ts`: unit tests for `resolveProjectPatterns()` â€” scope resolves to project names; scope + projects merged (union); unknown scope returns error with available names; empty scope string ignored; `scopeStore` undefined â†’ graceful error.
- [x] **C3.** Add integration tests to existing `test_search_messages.ts`: call `search_messages` with `projects: ["reach2"]` against fixture data containing `"zz-reach2"` project â€” verify substring matching returns results.
- [x] **C4.** Add integration tests to existing `test_search_threads.ts`: same substring-matching verification at thread level.
- [x] **C5.** Run full test suite (`bun run test`) â€” verify all existing tests still pass (backward compatibility: exact project names match as substrings of themselves).

### Group D â€” Documentation

{{SIMPLE}}

- [x] **D1.** In `archi-mcp.md` Â§4.2 Search Tools table: add `scope` to the Input column for `search_messages` and `search_threads`.
- [x] **D2.** In `archi-mcp.md` below Â§4.2 table: update the `projects` filter description to document substring matching behavior and add a sentence about scope resolution.
- [x] **D3.** In `archi-search.md` (if it references MCP project filtering): note the change from exact to substring matching.

---

## 4. Files Changed

| File                                     | What Changes                                                                                                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/mcp/tools/search.ts`                | Add `scope` arg to tool defs; change `extractProjectFilter()` â†’ `string[]`; add `resolveProjectPatterns()`; add `matchesAnyProject()`; replace all `.has()` with substring matching; accept `scopeStore` param |
| `src/mcp/registry.ts`                    | Thread `scopeStore` through `registerAll()` â†’ `registerTools()` â†’ `handleSearchTool()`                                                                                                                         |
| `src/mcp/MCPServer.ts`                   | Accept `scopeStore` in constructor; pass to `registerAll()`                                                                                                                                                    |
| `src/mcp/serve.ts`                       | Instantiate + load `ScopeStore`; pass to `MCPServer`                                                                                                                                                           |
| `src/server/routeUtils.ts`               | Change `runQdrantSearch()` project filter from `.has()` to substring matching                                                                                                                                  |
| `src/mcp/tests/test_project_matching.ts` | New: unit tests for `matchesAnyProject()`                                                                                                                                                                      |
| `src/mcp/tests/test_scope_resolution.ts` | New: unit tests for `resolveProjectPatterns()`                                                                                                                                                                 |

---

## 5. Non-Goals

- **HTTP API routes**: The REST endpoints (`/api/messages`, `/api/threads`) already have their own project filtering via `parseProjectFilters()`. This upgrade targets MCP tools only. HTTP routes can adopt substring matching separately if desired.
- **Wildcard/glob syntax**: No `*` or `?` patterns. Just simple substring matching. The LLM doesn't need regex â€” it needs "reach2" to match "zz-reach2".
- **Scope CRUD via MCP**: Scopes are managed through the visualizer UI and REST API. The MCP server is read-only for scopes â€” it just resolves them during search.
