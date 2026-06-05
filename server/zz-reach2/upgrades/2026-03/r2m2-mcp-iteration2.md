# R2M2 — MCP Iteration 2: Comprehensive Tool Testing

**Date**: 2026-03-21
**Status**: In Progress (Group A/B + Group 0 + Group 1 + Group 2 + Group 3 + Group 4 + Group 5 + Group 6 executed)
**Scope**: Thorough integration tests for every MCP tool, using real-data JSON fixtures
**Parent**: [`archi-mcp.md`](../../architecture/mcp/archi-mcp.md)
**Architecture**: [`archi-context-core-level0.md`](../../architecture/archi-context-core-level0.md), [`archi-search.md`](../../architecture/search/archi-search.md)

---

## Plan Startup Data / Current Status

### MCP Tools Inventory (Actually Implemented)

The MCP server registers **11 tools** across 3 handler modules:

| Module              | Tool                 | Status        |
| ------------------- | -------------------- | ------------- |
| `tools/messages.ts` | `get_message`        | ✅ Implemented |
| `tools/messages.ts` | `get_session`        | ✅ Implemented |
| `tools/messages.ts` | `list_sessions`      | ✅ Implemented |
| `tools/messages.ts` | `query_messages`     | ✅ Implemented |
| `tools/messages.ts` | `get_latest_threads` | ✅ Implemented |
| `tools/search.ts`   | `search_messages`    | ✅ Implemented |
| `tools/search.ts`   | `search_threads`     | ✅ Implemented |
| `tools/search.ts`   | `search_by_symbol`   | ✅ Implemented |
| `tools/topics.ts`   | `get_topics`         | ✅ Implemented |
| `tools/topics.ts`   | `get_topic`          | ✅ Implemented |
| `tools/topics.ts`   | `set_topic`          | ✅ Implemented |

Additionally, 5 **resources** and 4 **prompts** are registered.

### Tools NOT Yet Implemented (Documented in `archi-mcp.md` §4.4 only)

The following "Advanced Analysis Tools" exist **only in the architecture doc** — they have no code:

- `get_conversation_summary` — not implemented
- `get_project_overview` — not implemented
- `find_related_conversations` — not implemented
- `get_developer_timeline` — not implemented

These will **not** be tested in this iteration. They remain future work.

### How `search_by_symbol` Works

`search_by_symbol` does **NOT** use the `symbols` array on messages (that field is indeed empty in both sample JSONs). Instead, it performs a **brute-force word-boundary regex search** over every message's `.message` content:

1. Takes a `symbol` string (e.g., `"HexGridView"`)
2. Escapes regex special characters
3. Builds `\bHexGridView\b` regex with optional case-insensitive flag
4. Iterates over **all messages** from `db.getAllMessages()`
5. Counts matches per message → `occurrenceCount`
6. Filters to messages with count > 0
7. Sorts descending by occurrence count
8. Normalizes scores: `score = count / maxCount`

Word-boundary matching means `DB` won't match inside `MessageDB` — only standalone `DB` tokens.

### How `find_related_conversations` Works

It **doesn't exist yet**. The architecture doc describes it at §4.4 as accepting `{ sessionId }` or `{ query }` and returning "sessions with overlapping subjects/symbols." No code has been written for it.

### Available Test Data

**`latest_threads.json`** — 100 threads with:
- Projects: AXON, context-core, context-master, MISC, NexusPlatform, server, rac, NexusEvo.code-workspace, AXON.code-workspace
- Harnesses: ClaudeCode, Codex, Cursor, OpenCode, VSCode
- Session IDs, subjects, message counts, dates, first messages

**`messages_character.json`** — 271 messages (search results for "character") with:
- Projects: AXON, context-master, Hexez, IDA, IndReact, MISC, NexusEvo, NexusPlatform, Susan, zEVO, AXON.code-workspace
- Harnesses: ClaudeCode, Cursor, Kiro, VSCode
- Roles: user, assistant
- 75 have non-empty `context`, 47 have `toolCalls`
- Keyword frequencies in message body: Character (140 msgs), NNCharacter (19), Karl (14), HexGridView (14), SessionManager (10), Tile (49), Dialog (28), Evgeniy (2)

### Existing Tests

3 test files exist (`messages.test.ts`, `search.test.ts`, `resources.test.ts`) using synthetic fixtures with `bun:test`. The new tests will be **separate files** with real fixture data, using a custom `CXCTestBase` class for dual console+disk logging.

---

## Implementation Plan

### Group A — MCP Tool Description Enrichment (Query Syntax & Date Range)

The MCP tools that accept a `query` parameter must clearly document the **advanced query syntax** in both the tool `description` and the `query` parameter description. LLMs process each tool independently — they may never have seen another tool's description. The `+` (AND) operator is especially important for narrowing results.

Additionally, the 4 prompts that internally pass their argument through `parseSearchQuery()` → `executeSearch()` should document that the argument supports query syntax, so the LLM knows it can pass `"auth + middleware"` as a topic.

#### Current State — What's Good

- `search_messages` tool description **already explicitly lists** all 4 modes: fuzzy, exact phrase, OR, AND
- `search_messages` query param **already gives concrete examples** including `'JWT + refresh'`

#### Current State — What's Missing

1. **`search_threads` query param is too terse** — says only `"Search query. Same syntax as search_messages."` with no examples. An LLM has no guarantee it saw `search_messages` first. Should repeat the example list.

2. **Prompt argument descriptions don't mention query syntax at all**. All 3 search-using prompts feed their argument through `parseSearchQuery()`, so the `+` operator works — but the descriptions don't say so:
   - `explore_history.topic`: `"The topic, keyword, or phrase to search for"` — no mention of `+` or OR
   - `find_decisions.component`: `"The component, module, or topic to find decisions about"` — no mention
   - `debug_history.issue`: `"The issue, error, or bug to search debugging history for"` — no mention

3. **No cross-reference resource for query syntax.** A `cxc://query-syntax` resource would let an LLM read the syntax once and apply it across all tools. (Optional but valuable.)

#### Tasks

{{SIMPLE}}

- [x] **TA.1** In `src/mcp/tools/search.ts`, update the `search_threads` tool definition:
  - Change the `query` param description to repeat the full syntax + examples, identical to `search_messages`:
    `"Search query. Supports: simple terms (fuzzy), \"exact phrases\" (quoted), OR mode (space-separated: 'auth token'), AND mode (plus-separated: 'JWT + refresh'). The + operator is useful for narrowing results to messages that match ALL specified terms."`

- [x] **TA.2** In `src/mcp/prompts/index.ts`, update 3 prompt argument descriptions:
  - `explore_history.topic` → append: `" Supports query syntax: space for OR, + for AND, quotes for exact phrase (e.g., 'auth + middleware', '\"error handling\"')."`
  - `find_decisions.component` → append: `" Supports query syntax: space for OR, + for AND, quotes for exact phrase."`
  - `debug_history.issue` → append: `" Supports query syntax: space for OR, + for AND, quotes for exact phrase."`

- [x] **TA.3** (Optional) In `src/mcp/resources/index.ts`, add a `cxc://query-syntax` resource that returns a concise text block documenting the query syntax reference (all 4 modes with examples). Register it in `RESOURCE_DEFINITIONS`.

---

### Group B — Date Range Filtering for Search Tools

`search_messages` and `search_threads` currently have **no date range parameters**. This is a significant gap — the ability to scope searches to a time window ("what was discussed about X last week?") is essential.

#### Current State

- `query_messages` **already has** `from` and `to` (ISO datetime strings, inclusive) and they work correctly via SQL `WHERE dateTime >= ? AND dateTime <= ?`
- `executeSearch()` returns `SearchResult[]` where each result contains the full `AgentMessage` (which has `.dateTime`)
- **Date filtering can be applied as a post-filter** on search results, identical to how `projects` filtering already works: filter the `SearchResult[]` array after `executeSearch()` returns
- When only `from` is specified, `to` should default to the current datetime (`new Date().toISOString()`). When only `to` is specified, no lower bound is applied. This matches intuitive behavior: "from March 1st" means "from March 1st until now."

#### Tasks

{{SIMPLE}}

- [x] **TB.1** In `src/mcp/tools/search.ts`, add `from` and `to` properties to the `search_messages` inputSchema:
  ```
  from: { type: "string", description: "Filter results from this ISO datetime (inclusive). When omitted, no lower bound. Example: '2026-03-01'." }
  to:   { type: "string", description: "Filter results until this ISO datetime (inclusive). Defaults to now when 'from' is specified but 'to' is omitted. Example: '2026-03-15'." }
  ```

- [x] **TB.2** In `src/mcp/tools/search.ts`, add `from` and `to` properties to the `search_threads` inputSchema (same descriptions).

- [x] **TB.3** In `handleSearchTool()` for `search_messages`, add date filtering logic after project filtering:
  ```ts
  const from = typeof args.from === "string" ? args.from.trim() : undefined;
  const to = typeof args.to === "string" ? args.to.trim() : (from ? new Date().toISOString() : undefined);
  if (from) results = results.filter(r => r.message.dateTime.toISO()! >= from);
  if (to) results = results.filter(r => r.message.dateTime.toISO()! <= to);
  ```

- [x] **TB.4** In `handleSearchTool()` for `search_threads`, add identical date filtering on `messageResults` before aggregation.

- [x] **TB.5** Add date-range tests to search tool tests (implemented in existing `src/mcp/tests/search.test.ts`):
  1. Query with `from: "2025-06-01"` — assert all results have datetime >= that date
  2. Query with `from: "2025-06-01", to: "2025-12-31"` — assert results are within range
  3. Query with only `from` — confirm `to` defaults to now (all results should be >= from)

- [x] **TB.6** Add date-range tests to search tool tests (implemented in existing `src/mcp/tests/search.test.ts`):
  1. Search threads with `from: "2025-06-01"` — assert all matching threads fall in range

---

### Group 0 — Test Infrastructure

{{MEDIUM}}

- [x] **T0.1** Create `CXCTestBase.ts` in `src/mcp/tests/`. This is a base class with:
  - Constructor accepts a `testName: string`
  - `log(message: string)` method that writes to both `console.log` and a file `src/mcp/tests/{testName}.log`
  - Before creating the log file, check if `{testName}.log` already exists. If so, rename it to `{testName}_1.log`. If `_1` exists, try `_2`, etc. Loop until a free suffix is found, rename, then create the new file.
  - `logSection(title: string)` for visual separators
  - `assertEqual(label, actual, expected)` — logs pass/fail
  - `assertContains(label, haystack, needle)` — logs pass/fail
  - `assertGreaterThan(label, actual, minimum)` — logs pass/fail
  - `done()` — flushes and closes the log file, prints summary (X passed, Y failed)
  - All assertions should auto-increment a pass/fail counter

- [x] **T0.2** Create a `loadFixtures.ts` helper in `src/mcp/tests/` that:
  - Reads `latest_threads.json` and `messages_character.json` from disk (via `Bun.file`)
  - Builds a mock `IMessageStore` from the messages_character data (implementing `getById`, `getBySessionId`, `listSessions`, `queryMessages`, `getAllMessages`, `getHarnessCounts`, `getHarnessDateRanges`)
  - Builds a mock `TopicStore` (using thread subjects as AI summaries)
  - Exports: `loadMessagesFixture()`, `loadThreadsFixture()`, `buildMockDB()`, `buildMockTopicStore()`
  - The Agent writing this should **grep the JSON files** to configure the mock to yield relevant, matching data for known IDs, session IDs, projects, and harnesses present in the fixtures.

- [x] **T0.3** Create a `runAllTests.ts` entry script in `src/mcp/tests/` that imports and runs all test files in sequence, printing a final summary. Should be runnable via `bun run src/mcp/tests/runAllTests.ts`.

### Group 1 — Message Tool Tests

{{MEDIUM}}

- [x] **T1.1** Create `test_get_message.ts`. Tests (at least 3, the Agent should grep `messages_character.json` to pick real IDs):
  1. Retrieve a known message by ID (e.g., `e0b59bb3e42d5a20`) — assert output contains the session ID, role, harness
  2. Retrieve a different known message (e.g., `f577b4be7212ae28`) — assert output contains project name
  3. Retrieve with nonexistent ID `"zzznonexistent"` — assert error text
  4. Retrieve with empty ID — assert error text

- [x] **T1.2** Create `test_get_session.ts`. Tests (grep for session IDs with multiple messages):
  1. Retrieve a session with known ID (e.g., `d080dede-4ebc-4be5-846e-29306034da05`) — assert multiple messages returned
  2. Retrieve session with `maxMessages: 2` — assert truncation behavior
  3. Retrieve nonexistent session — assert appropriate error
  4. Retrieve session with default maxMessages — assert output format

- [x] **T1.3** Create `test_list_sessions.ts`. Tests:
  1. List with default limit — assert sessions returned, format includes harness and message count
  2. List with `limit: 3` — assert at most 3 sessions
  3. List with `limit: 1` — assert exactly 1 session

- [x] **T1.4** Create `test_query_messages.ts`. Tests (at least 2 per argument combo):
  1. Query with `role: "user"` — assert all results are user messages
  2. Query with `role: "assistant"` — assert all results are assistant messages
  3. Query with `harness: "Cursor"` — assert results from Cursor
  4. Query with `project: "AXON"` — assert results from AXON project
  5. Query with `page: 1, pageSize: 5` — assert at most 5 results
  6. Query with `page: 2, pageSize: 5` — assert second page

- [x] **T1.5** Create `test_get_latest_threads.ts`. Tests (use `latest_threads.json` data):
  1. Get latest with default limit — assert threads returned with expected fields
  2. Get latest with `limit: 5` — assert at most 5 threads
  3. Get latest with `limit: 1` — assert exactly 1 thread

### Group 2 — Search Tool Tests

{{MEDIUM}}

- [x] **T2.1** Create `test_search_messages.ts`. Tests (grep the fixture data for terms that appear in messages):
  1. Simple fuzzy query `"Character"` — assert results returned, scores > 0
  2. Exact phrase query `"NNCharacter"` — assert results returned
  3. OR query `"Karl Evgeniy"` — assert matches from either term
  4. AND query `"Karl + Tile"` — assert matches contain both terms
  5. Query with `maxResults: 3` — assert at most 3 results
  6. Query with `projects: ["AXON"]` — assert all results from AXON project
  7. Empty query — assert error message

- [x] **T2.2** Create `test_search_threads.ts`. Tests:
  1. Search threads for `"HexGridView"` — assert thread-level results with session IDs
  2. Search threads for `"Dialog"` — assert results grouped by session
  3. Search threads with `projects: ["MISC"]` — assert scoped results
  4. Empty query — assert error message

{{MEDIUM}}

- [x] **T2.3** Create `test_search_by_symbol.ts`. Tests (grep the messages to find symbols that appear with word boundaries):
  1. Search for `"Karl"` (appears in 14 messages) — assert results found, sorted by occurrence count
  2. Search for `"Character"` (appears in 140 messages) with `maxResults: 5` — assert at most 5 results
  3. Search for `"HexGridView"` — assert results, check occurrence count > 0
  4. Search for `"SessionManager"` — assert results from messages containing it
  5. Search for `"Evgeniy"` with `caseSensitive: true` — assert case-sensitive matching
  6. Search for `"evgeniy"` with `caseSensitive: false` — assert case-insensitive matching finds results
  7. Search for `"xyznonexistentsymbol"` — assert no results message
  8. Empty symbol — assert error

### Group 3 — Topic Tool Tests

{{SIMPLE}}

- [x] **T3.1** Create `test_get_topics.ts`. Tests:
  1. Get topics with default limit — assert topic entries returned
  2. Get topics with `limit: 2` — assert at most 2 entries
  3. Get topics when store has entries — assert format includes session ID + topic text

- [x] **T3.2** Create `test_get_topic.ts`. Tests:
  1. Get topic for a known session ID — assert entry returned with AI summary
  2. Get topic for nonexistent session — assert "No topic entry" message
  3. Get topic with empty sessionId — assert error message

- [x] **T3.3** Create `test_set_topic.ts`. Tests:
  1. Set custom topic on a session — assert confirmation
  2. Clear custom topic (empty string) — assert confirmation
  3. Set topic with empty sessionId — assert error

### Group 4 — Resource Tests

{{SIMPLE}}

- [x] **T4.1** Create `test_resources.ts`. Tests:
  1. Read `cxc://stats` — assert output includes total messages and session counts
  2. Read `cxc://projects` — assert output lists known projects from the fixture data
  3. Read `cxc://harnesses` — assert output lists harness names
  4. Read `cxc://projects/AXON/sessions` — assert output lists sessions for AXON

### Group 5 — Prompt Tests

{{MEDIUM}}

- [x] **T5.1** Create `test_prompts.ts`. Tests (these require an initialized search index):
  1. `explore_history` with topic `"Character"` — assert prompt message returned with search results
  2. `summarize_session` with a known session ID — assert prompt message returned with session transcript
  3. `find_decisions` with component `"HexGridView"` — assert prompt message returned with search results
  4. `debug_history` with issue `"spinner"` — assert prompt message returned with search results

### Group 6 — Integration / Cross-Tool Tests

{{MEDIUM}}

- [x] **T6.1** Create `test_cross_tool.ts`. Tests that chain tool results:
  1. `search_messages("Dialog")` → take first result ID → `get_message(id)` — assert full message is retrievable
  2. `search_threads("Karl")` → take first session ID → `get_session(sessionId)` — assert session transcript loads
  3. `list_sessions()` → take first session → `get_topic(sessionId)` — assert topic lookup works

---

## Notes for Implementation

- Each test file inherits from `CXCTestBase` for dual console+disk logging
- Log files go to `src/mcp/tests/{testName}.log` with automatic rotation (existing logs renamed with `_N` suffix)
- The search index must be initialized with `initSearchIndex(messages)` before running search/prompt tests
- The Agent writing each test group MUST grep the fixture JSON files to pick real IDs, session IDs, project names, and keywords that exist in the data — tests should exercise real matching paths, not just error cases
- All tests should be runnable individually (e.g., `bun run src/mcp/tests/test_get_message.ts`) and collectively via `runAllTests.ts`
- ✅ Verified: `bun run src/mcp/tests/runAllTests.ts` passes (17/17 files green, including `test_prompts.ts` and `test_cross_tool.ts`)
- **The 4 "Advanced Analysis Tools" (`get_conversation_summary`, `get_project_overview`, `find_related_conversations`, `get_developer_timeline`) are NOT implemented in code.** They exist only in the architecture doc as future work. Do NOT write tests for them.
