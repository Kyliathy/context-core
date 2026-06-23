# R2M5 — MCP Iteration 4: Human-Only Message Filtering

**Date**: 2026-03-22
**Status**: Planned
**Scope**: Filter MCP tool responses to return only human (user) messages by default, with opt-in for assistant messages
**Parent**: [archi-mcp.md](../../architecture/mcp/archi-mcp.md)
**Predecessor**: [r2m3-mcp-iteration-3.md](r2m3-mcp-iteration-3.md)

---

## Problem

Assistant messages are **fat**. A single assistant response can be thousands of characters — code blocks, explanations, tool call results, reasoning. When an LLM calls our MCP search tools, it gets back a wall of assistant-generated text that:

1. **Blows up context windows** — 20 search results × phat assistant messages = context budget gone
2. **Is mostly noise** — the LLM doesn't need to read what *another* LLM wrote; it needs to know what the *human* asked/decided
3. **Drowns signal** — the human's terse "fix the auth bug in middleware.ts" is far more useful than the assistant's 2000-char response implementing it

Currently, **zero filtering by role** happens anywhere in the MCP pipeline. Every search tool, every message retrieval tool returns all roles indiscriminately.

---

## Role Inventory (from harness JSONs)

Grepped one JSON per harness directory under `d:\Codez\Nexus\design\CXC\Kyliathy3\`:

| Harness      | Roles Found                    |
| ------------ | ------------------------------ |
| **ClaudeCode** | `"user"`, `"assistant"`      |
| **Codex**      | `"user"`, `"assistant"`      |
| **Cursor**     | `"user"`, `"assistant"`      |
| **Kiro**       | `"user"`, `"assistant"`, `"tool"` |
| **OpenCode**   | `"user"`, `"assistant"`      |
| **VSCode**     | `"user"`, `"assistant"`      |

**Unique roles across all harnesses**: `user`, `assistant`, `tool`

- `user` = human messages (the signal we want)
- `assistant` = AI/LLM responses (the fat we filter)
- `tool` = tool call results, Kiro only (also fat, also filtered)

**Human role** = `"user"` in all harnesses. No harness uses `"human"` as a role value.

---

## Design

### Default Behavior Change

All **search/message-listing** tools will filter to `role === "user"` by default. This means:
- `search_messages` → only human messages in results
- `search_thread_messages` → only human messages within the thread
- `search_by_symbol` → only human messages with symbol occurrences
- `query_messages` → only human messages (unless `role` param explicitly set to `"assistant"`)

### Exemptions (Thread-Level Tools)

These tools show **full conversations** (the human-AI duet) and are **NOT filtered**:
- `get_session` — full chronological transcript, both sides needed for context
- `search_threads` — thread-level metadata, not individual messages
- `list_sessions` — session summaries, no message content
- `get_latest_threads` — thread metadata only

### The `includeAssistantMessages` Parameter

Added to **every message-interacting tool** (both filtered and unfiltered):

```typescript
includeAssistantMessages: {
    type: "boolean",
    description:
        "Include assistant/AI responses in results. Default: false. " +
        "Only set to true when performing deep research into what the AI suggested or implemented."
}
```

**Where it applies:**

| Tool                       | Default  | Effect when `true`                                    |
| -------------------------- | -------- | ----------------------------------------------------- |
| `search_messages`          | `false`  | Include assistant messages in search results           |
| `search_thread_messages`   | `false`  | Include assistant messages within thread results       |
| `search_by_symbol`         | `false`  | Count symbol occurrences in assistant messages too     |
| `query_messages`           | `false`  | Include assistant messages (overrides `role` default)  |
| `get_message`              | `true`   | When `false`, returns error if message is non-human    |
| `get_session`              | `true`   | When `false`, filters session to human messages only   |

Note: `get_message` and `get_session` default to `true` because they are targeted retrievals (you asked for a specific thing). Search tools default to `false` because you're discovering content and don't want the fat.

### Implementation: Where Filtering Happens

Filtering goes at the **handler level** (not in DB queries, not in formatters) — each tool handler applies `role === "user"` filtering after fetching data but before formatting. This keeps the DB layer clean and the change localized.

```
DB query → [all roles] → handler filters by role → formatter → response
```

For search tools, filtering happens **after** scoring/ranking but **before** slicing to `maxResults`. This preserves correct result counts in the "(Showing top N of M results)" footer.

### Edge Case: `query_messages` + explicit `role`

`query_messages` already has a `role` parameter. Interaction rules:
- `role` omitted + `includeAssistantMessages` omitted → filter to `user` only
- `role: "assistant"` → returns assistant messages (explicit override)
- `role: "user"` + `includeAssistantMessages: true` → `role` wins, returns `user` only
- `role` omitted + `includeAssistantMessages: true` → returns all roles

---

## Tasks

### Group 1 — Tool Definition Updates (inputSchema)

{{SIMPLE}}

- [x] **1.1** Add `includeAssistantMessages` property to `search_messages` inputSchema in `tools/search.ts` — type `boolean`, description says "Default: false. Only set to true when performing deep research into what the AI suggested or implemented."
- [x] **1.2** Add `includeAssistantMessages` property to `search_thread_messages` inputSchema in `tools/search.ts` — same description as 1.1
- [x] **1.3** Add `includeAssistantMessages` property to `search_by_symbol` inputSchema in `tools/search.ts` — same description as 1.1
- [x] **1.4** Add `includeAssistantMessages` property to `query_messages` inputSchema in `tools/messages.ts` — same description as 1.1
- [x] **1.5** Add `includeAssistantMessages` property to `get_message` inputSchema in `tools/messages.ts` — description: "Default: true. Set to false to reject non-human messages."
- [x] **1.6** Add `includeAssistantMessages` property to `get_session` inputSchema in `tools/messages.ts` — description: "Default: true. Set to false to show only human messages in the transcript."
- [x] **1.7** Update `search_messages` tool description to mention that results are filtered to human messages by default
- [x] **1.8** Update `search_by_symbol` tool description to mention human-only default filtering

### Group 2 — Handler Filtering Logic (Search Tools)

{{MEDIUM}}

- [x] **2.1** In `handleSearchTool` → `search_messages` (full-text path): after scoring and field filtering but before `slice(0, maxResults)`, add role filter: `results = results.filter(r => r.message.role === "user")` unless `includeAssistantMessages` is truthy
- [x] **2.2** In `handleSearchTool` → `search_messages` (field-only path): after `filterMessagesBySubject`/`filterMessagesBySymbols` but before sorting, add: `messages = messages.filter(m => m.role === "user")` unless `includeAssistantMessages` is truthy
- [x] **2.3** In `handleSearchTool` → `search_thread_messages` (query path): after session filtering but before `slice(0, maxResults)`, add role filter unless `includeAssistantMessages`
- [x] **2.4** In `handleSearchTool` → `search_thread_messages` (field-only path): after field filtering, add role filter unless `includeAssistantMessages`
- [x] **2.5** In `handleSearchTool` → `search_by_symbol`: inside the `for (const message of allMessages)` loop, skip messages where `message.role !== "user"` unless `includeAssistantMessages`
- [x] **2.6** Extract the `includeAssistantMessages` arg parsing into a shared helper at the top of each handler case (simple: `const includeAssistant = args.includeAssistantMessages === true`)

### Group 3 — Handler Filtering Logic (Message Tools)

{{MEDIUM}}

- [x] **3.1** In `handleMessageTool` → `query_messages`: when `role` is not explicitly set AND `includeAssistantMessages` is not `true`, inject `role: "user"` into the DB query filter
- [x] **3.2** In `handleMessageTool` → `get_message`: when `includeAssistantMessages` is explicitly `false`, check `msg.role` after retrieval — if not `"user"`, return an informative message like "Message {id} is an assistant message. Pass includeAssistantMessages: true to retrieve it."
- [x] **3.3** In `handleMessageTool` → `get_session`: when `includeAssistantMessages` is explicitly `false`, filter the `messages` array to `role === "user"` before passing to `formatSession()`
- [x] **3.4** Update `search_thread_messages` and `search_threads` description strings to mention that `search_thread_messages` now returns human-only by default

### Group 4 — Test Updates

{{HARD}}

- [x] **4.1** In `test_search_messages.ts`: add test case verifying that search results contain only `role === "user"` messages by default (fixture has both user and assistant messages)
- [x] **4.2** In `test_search_messages.ts`: add test case verifying that `includeAssistantMessages: true` returns assistant messages too
- [x] **4.3** In `test_search_thread_messages.ts`: add test case for human-only default filtering
- [x] **4.4** In `test_search_thread_messages.ts`: add test case for `includeAssistantMessages: true` override
- [x] **4.5** In `test_search_by_symbol.ts`: add test case confirming symbol search skips assistant messages by default
- [x] **4.6** In `test_search_by_symbol.ts`: add test case for `includeAssistantMessages: true` including assistant messages
- [x] **4.7** In `test_get_message.ts`: add test case for `includeAssistantMessages: false` rejecting an assistant message
- [x] **4.8** In `test_get_session.ts`: add test case for `includeAssistantMessages: false` filtering a session to human-only

{{HARD}}

- [x] **4.9** In `messages.test.ts` or new test: verify `query_messages` without explicit `role` returns only human messages
- [x] **4.10** In `messages.test.ts`: verify `query_messages` with `role: "assistant"` still works (explicit override)
- [x] **4.11** In `messages.test.ts`: verify `query_messages` with `includeAssistantMessages: true` returns all roles
- [x] **4.12** Verify fixture file `messages_storyteller_nncharacter.json` has both `user` and `assistant` role messages (prerequisite for above tests). If not, add fixture entries with both roles.
- [x] **4.13** Run full test suite (`bun run test`) and verify all 185 tests pass

### Group 5 — Architecture Documentation Update

{{SIMPLE}}

- [x] **5.1** Update `archi-mcp.md` §4.1 table: add `includeAssistantMessages` to `get_message` and `get_session` input columns
- [x] **5.2** Update `archi-mcp.md` §4.2 table: add `includeAssistantMessages` to all four search tools' input columns and add note about human-only default
- [x] **5.3** Update `archi-mcp.md` §4.1 `query_messages` input column to mention `includeAssistantMessages` and the interaction with the existing `role` parameter
- [x] **5.4** Add a new subsection §4.5 "Message Role Filtering" to `archi-mcp.md` documenting: role inventory, default filtering behavior, per-tool defaults, and the `includeAssistantMessages` parameter
- [x] **5.5** Update `archi-mcp.md` §7 "Response Formatting Strategy" to note that search results now show only human messages by default
- [x] **5.6** Update the tool count if it changes (currently "12 tools" — count stays at 12, but parameter count changes)

---

## Files Modified

| File | Changes |
| ---- | ------- |
| `src/mcp/tools/search.ts` | Add `includeAssistantMessages` to 3 tool schemas + filtering in 3 handlers |
| `src/mcp/tools/messages.ts` | Add `includeAssistantMessages` to 3 tool schemas + filtering in 3 handlers |
| `src/mcp/tests/test_search_messages.ts` | 2 new tests (human-only default + opt-in) |
| `src/mcp/tests/test_search_thread_messages.ts` | 2 new tests |
| `src/mcp/tests/test_search_by_symbol.ts` | 2 new tests |
| `src/mcp/tests/test_get_message.ts` | 1 new test |
| `src/mcp/tests/test_get_session.ts` | 1 new test |
| `src/mcp/tests/messages.test.ts` | 3 new tests for query_messages role behavior |
| `zz-reach2/architecture/mcp/archi-mcp.md` | New §4.5, updated §4.1, §4.2, §7 |

**Files NOT modified**: `formatters.ts` (formatting stays the same, just receives fewer messages), `registry.ts` (dispatch unchanged), `MCPServer.ts` (no changes needed), DB layer (filtering happens at handler level).

---

## Risks & Mitigations

| Risk | Mitigation |
| ---- | ---------- |
| Fuse.js indexes all roles — filtering after search means wasted Fuse work | Acceptable: Fuse scoring is fast, and we need scores for ranking even if we then filter. Re-indexing Fuse for user-only would lose the ability to opt-in via `includeAssistantMessages`. |
| `search_threads` uses message-level search internally | Thread aggregation happens *after* message search. Since `search_threads` is exempt, its internal `executeSearch()` call should NOT apply role filtering — only the message-level tools filter. |
| Fixture data may not have both roles | Task 4.12 explicitly checks this before tests run. |
| `query_messages` role interaction complexity | Clear precedence rules defined above. `role` param takes priority when explicitly set. |
