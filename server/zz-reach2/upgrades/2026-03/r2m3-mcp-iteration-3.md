# MCP Iteration 3 — Search Parity & Thread Search

**Date**: 2026-03-22
**Scope**: MCP search tools, Qdrant integration, new `search_thread_messages` tool, `fromDate` support for `get_latest_threads`
**Parent**: [`archi-search.md`](../../architecture/search/archi-search.md)
**References**: [`r2sr-search-review.md`](r2sr-search-review.md), [`archi-qdrant.md`](../../architecture/search/archi-qdrant.md)

---

## 1. Problem Statement

Our MCP search tools are behind the HTTP search routes. Specifically:

| Gap | MCP Current State | HTTP Route State |
| --- | --- | --- |
| **`subject` filter** | Not supported | Full support on `POST /api/messages` and `POST /api/threads` |
| **`symbols` filter** | Only in `search_by_symbol` (occurrence count) | Integrated into message & thread search as field filter |
| **Qdrant hybrid search** | Not used — Fuse.js only | Full hybrid merge (Fuse + Qdrant dual-channel with combined scoring) |
| **Score metadata** | Fuse composite only, formatted as `Score: N%` | `fuseScore`, `qdrantScore`, `combinedScore` on every result |
| **`fromDate` on get_latest_threads** | Not supported | Supported via `fromEpoch` in `getLatestThreads()` |
| **Search within thread** | Not possible | No dedicated endpoint either — new feature |

### Goal

Make MCP search tools produce the **same quality results** as the HTTP endpoints, using the same scoring, aggregation, and Qdrant integration. Add `search_thread_messages` as a new tool. Add `fromDate` to `get_latest_threads`.

---

## 2. Design Decisions

| Question | Decision | Rationale |
| --- | --- | --- |
| How to integrate Qdrant in MCP? | Optional initialization in `serve.ts`; pass `RouteContext`-like object to handlers | Same pattern as HTTP routes; Qdrant is gated on `QDRANT_URL` + `OPENAI_API_KEY` |
| Make search handlers async? | Yes — `handleSearchTool` becomes async for Qdrant embedding calls | Qdrant requires embedding via OpenAI, which is async |
| Where does `search_thread_messages` search? | Run full Fuse.js + Qdrant pipeline, then filter results to the target `sessionId` | Reuses existing search engine; cheaper than re-indexing per-session |
| Return format for scores? | Include `fuseScore`, `qdrantScore`, `combinedScore` in formatted output | LLM consumers benefit from seeing engine attribution; matches HTTP response |
| How to handle MCP without Qdrant? | Graceful fallback: Fuse-only scoring with full 0–1 range | Same as HTTP routes when Qdrant is absent |
| `search_thread_messages` query optional? | Yes — allow field-only search (symbols/subject) within a thread | Consistent with `POST /api/messages` behavior |
| Make `query` optional on `search_messages` too? | Yes — field-only search (subject/symbols) should work without a query | Matches HTTP `POST /api/messages` which supports field-only mode |

---

## 3. Tool Changes

### 3.1 `search_messages` — Add `subject`, `symbols`; Make `query` Optional

**Current signature:**
```
query (required), maxResults, projects, from, to
```

**New signature:**
```
query (optional — required if no subject/symbols), subject, symbols, maxResults, projects, from, to
```

When `query` is present: run full Fuse.js pipeline + Qdrant hybrid + field filters (same as `POST /api/messages`).
When `query` is absent but `subject`/`symbols` present: field-only search using `messagesToResults()` with relevance scoring.

**Output changes**: Include `fuseScore`, `qdrantScore`, `combinedScore` per result (when Qdrant is active). When Qdrant is absent, show only the Fuse score.

### 3.2 `search_threads` — Add `subject`, `symbols`; Make `query` Optional

**Current signature:**
```
query (required), projects, from, to
```

**New signature:**
```
query (optional — required if no subject/symbols), subject, symbols, maxResults, projects, from, to
```

Same Qdrant integration as message search, but results are aggregated via `aggregateToThreads()`.

### 3.3 `search_thread_messages` — NEW

Search within a specific thread's messages.

**Signature:**
```
sessionId (required), query (optional), subject (optional), symbols (optional), maxResults (default 20)
```

**Flow:**
1. If `query` present: run `executeSearch()` on the full index, filter to `sessionId`
2. If field-only: get session messages via `db.getBySessionId()`, apply field filters
3. When Qdrant enabled: run hybrid merge, filter to `sessionId`
4. Return scored results (same format as `search_messages` but scoped to one thread)

**Rationale:** This allows an LLM to "drill into" a thread found via `search_threads`, finding the specific messages that are most relevant within that conversation.

### 3.4 `get_latest_threads` — Add `fromDate`

**Current signature:**
```
limit
```

**New signature:**
```
limit, fromDate (ISO date string)
```

Pass `fromEpoch` to `getLatestThreads()`, which already supports it.

---

## 4. Qdrant Integration in MCP

### 4.1 Initialization in `serve.ts`

Currently `serve.ts` initializes only `MessageDB`, `TopicStore`, and Fuse.js. Need to optionally initialize:
- `EmbeddingService` (OpenAI embeddings)
- `QdrantService` (vector search client)

Gated on `QDRANT_URL` and `OPENAI_API_KEY` environment variables, same as the HTTP server.

```typescript
// In serve.ts, after loading messages:
let vectorServices: RouteContext["vectorServices"] | undefined;

if (settings.QDRANT_URL && settings.OPENAI_API_KEY) {
    const embeddingService = new EmbeddingService(settings.OPENAI_API_KEY);
    const qdrantService = new QdrantService(settings.QDRANT_URL);
    vectorServices = { embeddingService, qdrantService };
    console.error(`[MCP] Qdrant enabled: ${settings.QDRANT_URL}`);
}
```

### 4.2 Handler Signature Change

`handleSearchTool` becomes async and accepts a `RouteContext`-like context:

```typescript
export type MCPSearchContext = {
    db: IMessageStore;
    topicStore?: TopicStore;
    vectorServices?: RouteContext["vectorServices"];
};

export async function handleSearchTool(
    toolName: string,
    args: Record<string, unknown>,
    ctx: MCPSearchContext
): Promise<string>
```

### 4.3 Search Pipeline in MCP (mirroring messageRoutes.ts)

For `search_messages` with `query`:
1. `parseSearchQuery(query)` → `executeSearch(parsed)`
2. Apply `fromDate`, `projects`, `symbols`, `subject` filters on Fuse results
3. If Qdrant enabled: `runQdrantSearch(query, subjectTerm, symbolsTerm, count, projectFilters, ctx)`
4. `SearchResults.merge(fuseHits, qdrantHits, query, db)` — produces `AgentMessageFound[]` with hybrid scores
5. Post-merge field filters (symbols/subject safety net)
6. Format results with `combinedScore`, `fuseScore`, `qdrantScore`

For `search_threads` with `query`:
1. Same pipeline up through step 5
2. `aggregateToThreads()` on the merged result set

### 4.4 Registry & Dispatch Change

`registry.ts` CallTool handler must `await` the search handler since it becomes async. Currently:
```typescript
text = handleSearchTool(name, safeArgs, db, topicStore);
```
Changes to:
```typescript
text = await handleSearchTool(name, safeArgs, ctx);
```

---

## 5. Formatter Changes

### 5.1 Enhanced Score Display

Current format:
```
[1] Score: 85% | matched: auth, token
```

New format (when Qdrant active):
```
[1] Score: 85% (fuse: 72% | qdrant: 91%) | matched: auth, token
```

New format (Fuse-only):
```
[1] Score: 85% | matched: auth, token
```

### 5.2 New Formatter for Thread-Scoped Messages

`formatThreadSearchResults()` — same as `formatSearchResults()` but with a thread context header:

```
Search within thread: <sessionId>
Subject: <resolved subject>
Showing N of M results.

[1] Score: 85% | matched: auth
ID: abc123 | Role: assistant | 2026-03-21T10:30
Excerpt: ...
```

---

## 6. Test Plan

All tests use the upgraded fixtures:
- `messages_storyteller_nncharacter.json` — 23 messages across 22 sessions, dates 2025-08-07 to 2026-03-06, 3357 distinct symbols
- `threads_storyteller_nncharacter.json` — 100 thread results matching storyteller/nncharacter search
- `threads_latest.json` — 100 latest threads, dates 2026-03-13 to 2026-03-22

### 6.1 Test: `search_messages` with `subject`

**Fixture**: `messages_storyteller_nncharacter.json`
- Search with `subject` containing a known subject substring from the fixture
- Verify results are filtered to messages matching that subject
- Verify score is present and > 0

### 6.2 Test: `search_messages` with `symbols`

**Fixture**: `messages_storyteller_nncharacter.json`
- Search with `symbols: "HexGrid"` (known to exist in fixture)
- Verify all returned messages contain "HexGrid" in their symbols array
- Verify score is present

### 6.3 Test: `search_messages` field-only (no query)

**Fixture**: `messages_storyteller_nncharacter.json`
- Search with only `symbols: "IndraAPIService"` (no query)
- Verify results returned without error
- Verify results have differentiated scores (not all identical)

### 6.4 Test: `search_threads` with `subject`

**Fixture**: `messages_storyteller_nncharacter.json`
- Thread search with `subject` matching a known subject pattern
- Verify returned threads have matching subjects

### 6.5 Test: `search_thread_messages` basic

**Fixture**: `messages_storyteller_nncharacter.json`
- Pick a session ID from the fixture that has multiple messages
- Search within that session with a `query`
- Verify all results belong to the target session

### 6.6 Test: `search_thread_messages` field-only

**Fixture**: `messages_storyteller_nncharacter.json`
- Pick a session ID, search with `symbols` only (no query)
- Verify results scoped to session and filtered by symbol

### 6.7 Test: `get_latest_threads` with `fromDate`

**Fixture**: `threads_latest.json` (dates 2026-03-13 to 2026-03-22)
- Call with `fromDate: "2026-03-20"` — should return ~38 threads (4+24+10 from 3/20, 3/21, 3/22)
- Call with `fromDate: "2026-03-22"` — should return ~4 threads
- Call without `fromDate` — should return all threads (up to limit)
- Verify the filtered count is less than the unfiltered count

### 6.8 Test: `search_threads` with `from`/`to` date range

**Fixture**: `messages_storyteller_nncharacter.json`
- Search threads with date range that excludes older messages
- Verify thread count is reduced

---

## 7. Implementation Task List

### Group 1 — `get_latest_threads` `fromDate` Support

{{SIMPLE}}

- [x] **T1.1** In `messages.ts`, add `fromDate` property to `get_latest_threads` input schema: `{ type: "string", description: "Only include threads with activity on or after this ISO date (e.g., '2026-03-15'). When omitted, no date filter." }`
- [x] **T1.2** In `handleMessageTool` `get_latest_threads` case, parse `fromDate` from args, compute `fromEpoch = Date.parse(fromDate + 'T00:00:00.000Z')`, pass to `getLatestThreads(db, limit, topicStore, fromEpoch)`.
- [x] **T1.3** Add test in `test_get_latest_threads.ts` using `threads_latest.json`: call with `fromDate: "2026-03-20"`, verify count < unfiltered count. Call with `fromDate: "2026-03-22"`, verify ≤4 threads.

### Group 2 — Add `subject` and `symbols` to `search_messages` and `search_threads`

{{MEDIUM}}

- [x] **T2.1** In `search.ts`, update `search_messages` inputSchema: add `subject` (`{ type: "string", description: "Filter results to messages whose subject contains this term (case-insensitive substring match)." }`) and `symbols` (`{ type: "string", description: "Filter results to messages that reference this code symbol (case-insensitive substring match against the symbols array)." }`). Make `query` no longer required — instead validate that at least one of `query`, `subject`, `symbols` is present.
- [x] **T2.2** Same for `search_threads`: add `subject`, `symbols`, `maxResults` to inputSchema. Make `query` optional with same validation.
- [x] **T2.3** In `handleSearchTool` `search_messages` case, extract `symbolsTerm` and `subjectTerm` from args. When `query` is present: after executing search, apply `filterResultsBySymbols()` and `filterResultsBySubject()` from `fieldFilters.ts`. When `query` is absent: use field-only path with `filterMessagesBySymbols()`, `filterMessagesBySubject()`, and `messagesToResults()`.
- [x] **T2.4** In `handleSearchTool` `search_threads` case, same field filter logic. Field-only path: get all messages → filter by symbols/subject → `messagesToResults()` → `aggregateToThreads()`.
- [x] **T2.5** Add tests: `search_messages` with `symbols: "HexGrid"` returns results; `search_messages` with `subject` returns filtered results; `search_threads` with `subject` returns threads; field-only `search_messages` with `symbols: "IndraAPIService"` (no query) returns results.

### Group 3 — `search_thread_messages` New Tool

{{MEDIUM}}

- [x] **T3.1** Add `search_thread_messages` to `SEARCH_TOOL_DEFINITIONS` with schema: `sessionId` (required), `query` (optional), `subject` (optional), `symbols` (optional), `maxResults` (default 20).
- [x] **T3.2** Implement handler in `handleSearchTool`: validate `sessionId`; verify session exists via `db.getBySessionId()`. When `query` present: run `executeSearch()`, filter results to `sessionId`, apply field filters. When field-only: filter session messages by symbols/subject, wrap with `messagesToResults()`.
- [x] **T3.3** Add formatter `formatThreadSearchResults()` in `formatters.ts` — same as `formatSearchResults()` but with a thread header (sessionId, subject, message count).
- [x] **T3.4** Add tests: search within a known session with query; search within session field-only; verify results scoped to session.

### Group 4 — Qdrant Integration for MCP

{{HARD}}

- [x] **T4.1** In `serve.ts`, after Fuse.js init, optionally initialize `EmbeddingService` and `QdrantService` when `QDRANT_URL` and `OPENAI_API_KEY` are set. Build a `RouteContext`-compatible object.
- [x] **T4.2** Defined `VectorServices` type in `MCPServer.ts`; `handleSearchTool` accepts optional `vectorServices` parameter.
- [x] **T4.3** Changed `handleSearchTool` signature to async (`Promise<string>`). Updated `registry.ts` to `await` the call and pass `vectorServices`.
- [x] **T4.4** In `search_messages` with `query`: added `hybridMerge()` helper that calls `runQdrantSearch()` + `SearchResults.merge()` with post-merge safety net filters. Converts `AgentMessageFound[]` back to `SearchResult[]` for formatters.
- [x] **T4.5** In `search_threads` with `query`: same `hybridMerge()` call before `aggregateToThreads()`.
- [x] **T4.6** In `search_thread_messages`: same `hybridMerge()` with re-filter to target `sessionId`.
- [x] **T4.7** Updated `MCPServer.ts` constructor to accept optional `VectorServices` and forward to `registerAll()`.

### Group 5 — Enhanced Score Formatting

{{SIMPLE}}

- [x] **T5.1** Update `formatSearchResults()` to detect hybrid scoring via duck-typing (`"qdrantScore" in msg`). Shows `Score: X% (Q:Y% | F:Z%)` when Qdrant was active; plain `Score: X%` otherwise. No `engine` param needed.
- [x] **T5.2** Duck-typing inline in `formatSearchResults()` handles the full score breakdown — no separate `formatHybridSearchResults()` required.
- [x] **T5.3** In `formatThread()`, already shows `score: N%` — no change needed, `bestMatchScore` will naturally reflect hybrid scoring.

### Group 6 — Test Suite

{{MEDIUM}}

Note: `loadMessagesFixture()` was updated to read `messages_storyteller_nncharacter.json` (Decision B was taken). All test files were created as `test_search_messages.ts` and `test_search_threads.ts` rather than `_v2` variants — the plan naming was aspirational.

- [x] **T6.1** `loadMessagesFixture()` reads `messages_storyteller_nncharacter.json`; `loadThreadsFixture()` reads `threads_latest.json`. Sufficient for all tests.
- [x] **T6.2** `test_search_messages.ts` (14 tests) covers subject/symbols filters, field-only, combined query+symbols, validation.
- [x] **T6.3** `test_search_threads.ts` (12 tests) covers subject/symbols filters, date range, maxResults, validation.
- [x] **T6.4** `test_search_thread_messages.ts` (11 tests) — validation, query search, field-only, combined, maxResults.
- [x] **T6.5** `test_get_latest_threads.ts` (7 tests) — fromDate filtering, limit, future/past boundary tests.

### Group 7 — Documentation Updates

{{SIMPLE}}

- [x] **T7.1** Updated header blocks in `search.ts` (added Qdrant hybrid merge, enhanced score display notes) and `messages.ts` (expanded tool descriptions, noted `fromDate` on `get_latest_threads`).
- [x] **T7.2** Added §13 "MCP Tool Parity" to `archi-search.md`: tool↔endpoint mapping table, Qdrant integration flow, score formatting modes, key differences from HTTP (plain text output, MCP-only tools). Also added MCP files to the §12 File Map.

---

## 8. Execution Priority

| Priority | Group | Effort | Dependency |
| --- | --- | --- | --- |
| 1 | Group 1 — `fromDate` on `get_latest_threads` | Simple | None |
| 2 | Group 2 — `subject`/`symbols` on search tools | Medium | None |
| 3 | Group 3 — `search_thread_messages` | Medium | None |
| 4 | Group 4 — Qdrant integration | Hard | Groups 2 & 3 (adds Qdrant on top) |
| 5 | Group 5 — Score formatting | Simple | Group 4 (needs hybrid scores) |
| 6 | Group 6 — Tests | Medium | Groups 1–5 |
| 7 | Group 7 — Docs | Simple | Groups 1–5 |

Groups 1–3 can execute in parallel. Group 4 builds on 2 & 3. Group 5 is a polish pass. Group 6 validates everything. Group 7 is documentation.

---

## 9. Files Changed

| File | Change |
| --- | --- |
| `src/mcp/tools/search.ts` | Add `subject`, `symbols` to `search_messages` & `search_threads`; add `search_thread_messages`; make handler async; integrate Qdrant pipeline |
| `src/mcp/tools/messages.ts` | Add `fromDate` to `get_latest_threads` |
| `src/mcp/formatters.ts` | Add `formatHybridSearchResults()`, `formatThreadSearchResults()` |
| `src/mcp/registry.ts` | Await search handler; pass context |
| `src/mcp/MCPServer.ts` | Accept and forward vector services |
| `src/mcp/serve.ts` | Optionally init Qdrant/Embeddings |
| `src/mcp/tests/loadFixtures.ts` | Add storyteller/latest fixture loaders |
| `src/mcp/tests/test_search_messages_v2.ts` | New test file |
| `src/mcp/tests/test_search_threads_v2.ts` | New test file |
| `src/mcp/tests/test_search_thread_messages.ts` | New test file |
| `src/mcp/tests/test_get_latest_threads.ts` | Add fromDate tests |
