# R2HC – OpenCode Harness

**Date**: 2026-03-19
**Status**: Planning
**Scope**: New harness reader for OpenCode Desktop chat data

---

## 1. Source Format Analysis

OpenCode stores all data in a single **SQLite database** at:
```
c:\Users\Axonn\.local\share\opencode\opencode.db
```

The DB uses [Drizzle ORM](https://orm.drizzle.team/) migrations (9 applied). It has WAL journaling with `-shm` and `-wal` companion files.

### 1.1 Database Schema (Relevant Tables)

#### `project`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | e.g. `"global"` |
| worktree | TEXT | e.g. `"/"` |
| name | TEXT | nullable |
| time_created | INTEGER | epoch ms |
| time_updated | INTEGER | epoch ms |
| sandboxes | TEXT | JSON array |

#### `session`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | e.g. `"ses_2faa00eb1ffePKR5FbzSRR9v5y"` |
| project_id | TEXT | FK → project.id |
| parent_id | TEXT | nullable, for session branching |
| slug | TEXT | human-readable, e.g. `"gentle-wizard"` |
| **directory** | TEXT | **working directory**, e.g. `"D:\\Coding\\zDUMP\\rac"` — this is our project source |
| title | TEXT | AI-generated title, e.g. `"Express server package.json creation in directory"` |
| version | TEXT | OpenCode version, e.g. `"1.2.27"` |
| time_created | INTEGER | epoch ms |
| time_updated | INTEGER | epoch ms |

#### `message`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | e.g. `"msg_d055ff166001R35dcQ97fUDAR3"` |
| session_id | TEXT | FK → session.id |
| time_created | INTEGER | epoch ms |
| time_updated | INTEGER | epoch ms |
| **data** | TEXT | JSON blob with role, model, tokens, etc. |

#### `part`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | e.g. `"prt_d055ff169001M2XNskNlxRUWwF"` |
| **message_id** | TEXT | FK → message.id |
| session_id | TEXT | FK → session.id |
| time_created | INTEGER | epoch ms |
| time_updated | INTEGER | epoch ms |
| **data** | TEXT | JSON blob — the actual content |

---

## 2. Data Model — Message & Part Relationship

OpenCode uses a **two-tier structure**: `message` holds metadata (role, model, tokens, cost), and `part` holds the actual content. Each message has 1+ parts.

### 2.1 Message `data` JSON

**User message:**
```json
{
  "role": "user",
  "time": { "created": 1773911667092 },
  "summary": { "diffs": [] },
  "agent": "build",
  "model": { "providerID": "opencode", "modelID": "big-pickle" }
}
```

**Assistant message:**
```json
{
  "role": "assistant",
  "time": { "created": 1773911667105, "completed": 1773911670381 },
  "parentID": "msg_d055ff166001R35dcQ97fUDAR3",
  "modelID": "big-pickle",
  "providerID": "opencode",
  "mode": "build",
  "agent": "build",
  "path": { "cwd": "D:\\Coding\\zDUMP\\rac", "root": "/" },
  "cost": 0,
  "tokens": {
    "total": 11476,
    "input": 78,
    "output": 64,
    "reasoning": 0,
    "cache": { "read": 510, "write": 10824 }
  },
  "finish": "tool-calls"   // or "stop" for final response
}
```

Key observations:
- `parentID` links assistant messages back to the user message that triggered them
- **Multiple assistant messages can share the same `parentID`** — this is the "duplication" pattern. Each tool call cycle creates a new assistant message. So one user prompt → N assistant messages (one per "step")
- `finish: "tool-calls"` = intermediate step (used a tool, will continue), `finish: "stop"` = final response
- Model is in `modelID` field on assistant messages, and `model.modelID` on user messages

### 2.2 Part `data` JSON — Part Types

Parts are the actual content atoms. Five types observed:

#### `text` — User prompt text OR assistant response text
```json
{ "type": "text", "text": "Hello OpenCode Desktop! ..." }
// On assistant side, may also have:
{ "type": "text", "text": "Done.", "time": { "start": ..., "end": ... } }
```

#### `reasoning` — Model thinking/rationale
```json
{
  "type": "reasoning",
  "text": "The user wants me to create a simple package.json...",
  "metadata": { "anthropic": { "signature": "..." } },
  "time": { "start": ..., "end": ... }
}
```

#### `tool` — Tool invocation with full state
```json
{
  "type": "tool",
  "callID": "call_function_x9jzb5o3n7ph_1",
  "tool": "write",      // tool name: "read", "write", "edit", etc.
  "state": {
    "status": "completed",
    "input": { "filePath": "...", "content": "..." },
    "output": "Wrote file successfully.",
    "title": "D:\\Coding\\zDUMP\\rac\\package.json",
    "metadata": { ... },
    "time": { "start": ..., "end": ... }
  }
}
```

#### `step-start` — Marks the beginning of a processing step
```json
{ "type": "step-start" }
```

#### `step-finish` — Marks end of step with token/cost summary
```json
{
  "type": "step-finish",
  "reason": "tool-calls",   // or "stop"
  "cost": 0,
  "tokens": { "total": 11476, "input": 78, "output": 64, "reasoning": 0, "cache": { "read": 510, "write": 10824 } }
}
```

### 2.3 Observed Conversation Flow

```
USER MSG (msg_1)
  └─ PART: text (user's prompt)

ASSISTANT MSG (msg_2, parentID=msg_1, finish=tool-calls)
  ├─ PART: step-start
  ├─ PART: reasoning  ← thinking
  ├─ PART: tool (read) ← tool call
  └─ PART: step-finish (reason=tool-calls)

ASSISTANT MSG (msg_3, parentID=msg_1, finish=tool-calls)  ← SAME parent!
  ├─ PART: step-start
  ├─ PART: reasoning
  ├─ PART: tool (write)
  └─ PART: step-finish (reason=tool-calls)

ASSISTANT MSG (msg_4, parentID=msg_1, finish=stop)  ← SAME parent, final step
  ├─ PART: step-start
  ├─ PART: reasoning
  ├─ PART: text  ← final response text
  └─ PART: step-finish (reason=stop)
```

**Key insight**: What looks like "duplicated messages" is actually OpenCode's **step-based architecture**. Each tool invocation cycle creates a new `message` row, all linked to the same user message via `parentID`. The conversation is NOT 1 user → 1 assistant. It's 1 user → N assistant messages (one per step).

---

## 3. Mapping to AgentMessage

### 3.1 User Messages
- **role**: `"user"`
- **message**: Concatenate all `text`-type parts for this message
- **sessionId**: `message.session_id`
- **dateTime**: `message.time_created` (epoch ms → Luxon DateTime)
- **model**: `null` (user messages have no model in CXC convention)
- **project**: Derived from `session.directory` via `deriveProjectName()`

### 3.2 Assistant Messages — Consolidation Strategy

**Problem**: OpenCode creates N messages for one logical assistant response. We need to **consolidate** all assistant messages sharing the same `parentID` into a single `AgentMessage`.

**Strategy**:
1. Group all assistant messages by `parentID`
2. Collect all parts from all messages in the group, ordered by `time_created`
3. Build one `AgentMessage` from the consolidated parts:
   - **role**: `"assistant"`
   - **message**: Join all `text`-type parts' text
   - **rationale**: Collect all `reasoning`-type parts' text
   - **toolCalls**: Collect all `tool`-type parts → map to `ToolCall { name, context, results }`
   - **model**: Take from the first assistant message's `modelID`
   - **dateTime**: Take from the first assistant message's `time_created`
   - **tokenUsage**: Sum tokens across all step-finish parts (or take from last one)
   - **sessionId**: Same as user message's

### 3.3 Tool Call Mapping

OpenCode tool part → CXC ToolCall:
```
name    ← part.data.tool (e.g. "read", "write", "edit")
context ← [part.data.state.input.filePath] (when present)
results ← [part.data.state.output] (when present)
```

### 3.4 Project Resolution

The `session.directory` field gives us the working directory (e.g. `"D:\\Coding\\zDUMP\\rac"`). Use `deriveProjectName()` from `pathHelpers.ts` to extract the last path segment as the project name.

No project mapping rules needed initially — the directory path is explicit.

### 3.5 Model Resolution

- User messages: `data.model.modelID` (e.g. `"big-pickle"`) — but we store `null` for user role per CXC convention
- Assistant messages: `data.modelID` (e.g. `"big-pickle"`)

---

## 4. Implementation Plan

### Group A — Scaffolding & Registration

{{SIMPLE}}

- [x] A1. Create `src/harness/opencode.ts` with the exported function signature `readOpenCodeChats(dbPath: string, rawBase: string): AgentMessage[]` that returns an empty array. Add standard imports: `AgentMessage`, `DateTime` from luxon, `Database` from `bun:sqlite`, `deriveProjectName` from `pathHelpers`, `generateMessageId` from `hashId`, `writeRawSourceData` from `rawCopier`.
- [x] A2. Register the harness in `src/harness/index.ts`: import `readOpenCodeChats` from `./opencode.js` and add `OpenCode: readOpenCodeChats` to the `READERS` map.
- [x] A3. Verify the project compiles (`bun build` or `bun run src/ContextCore.ts`) — the OpenCode harness will be called with the paths from `cc.json` and should return `[]` without errors.

### Group B — DB Access & Session/Message Queries

{{SIMPLE}}

- [x] B1. Implement the DB open logic: open `opencode.db` at the given `dbPath` with `{ readonly: true }`. The `dbPath` from `cc.json` points to the **directory** (e.g. `c:\Users\Axonn\.local\share\opencode\`), so append `opencode.db` to it. Wrap in try/catch — if DB doesn't exist or is locked, log a warning and return `[]`.
- [x] B2. Query all sessions: `SELECT id, project_id, directory, title, slug, time_created, time_updated FROM session`. Store results in a typed local interface `OpenCodeSession`.
- [x] B3. For each session, query all messages: `SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id = ? ORDER BY time_created`. Parse the `data` JSON blob into a typed local interface `OpenCodeMessageData` with fields: `role`, `parentID?`, `modelID?`, `model?: { modelID }`, `tokens?`, `finish?`, `path?: { cwd }`.
- [x] B4. For each session, query all parts: `SELECT id, message_id, session_id, time_created, time_updated, data FROM part WHERE session_id = ? ORDER BY time_created`. Parse the `data` JSON blob. Build a `Map<messageId, Part[]>` for fast lookup.

### Group C — Core Conversion Logic

{{MEDIUM}}

- [x] C1. Implement user message conversion: for each message where `role === "user"`, find its parts from the Map. Concatenate all `type: "text"` parts' `.text` to form the message body. Create an `AgentMessage` with: `role: "user"`, `sessionId: message.session_id`, `dateTime: DateTime.fromMillis(message.time_created)`, `message: concatenatedText`, `model: null`, `project: deriveProjectName(session.directory)`. Generate ID via `generateMessageId(sessionId, "user", timestamp, messagePrefix)`.
- [x] C2. Implement assistant message consolidation: group all assistant messages (where `role === "assistant"`) by their `parentID`. For each group, collect all parts from all messages in the group (ordered by `time_created`).
- [x] C3. From consolidated assistant parts, extract: **message text** (all `type: "text"` parts → join `.text`), **rationale** (all `type: "reasoning"` parts → collect `.text` into `string[]`), **toolCalls** (all `type: "tool"` parts → map to `ToolCall { name: part.tool, context: [part.state.input.filePath].filter(Boolean), results: [part.state.output].filter(Boolean) }`).
- [x] C4. Build the consolidated `AgentMessage` for each assistant group: `role: "assistant"`, `model: firstMessage.modelID`, `dateTime: DateTime.fromMillis(firstMessage.time_created)`, `message: joinedText`, `rationale: collectedRationale`, `toolCalls: collectedToolCalls`, `tokenUsage: { input: summedInput, output: summedOutput }` (sum from all `step-finish` parts' `tokens`). Generate ID via `generateMessageId()`.
- [x] C5. Pair each user message with its consolidated assistant response. Push them into the result array in chronological order: user first, then assistant. Handle edge case: assistant messages with no `parentID` (standalone) — emit them individually.

### Group D — Raw Archival & Edge Cases

{{MEDIUM}}

- [x] D1. Implement raw source archival using `writeRawSourceData()` from `rawCopier.ts`. For each session, build a JSON payload containing the session metadata, all its messages, and all its parts. Write to `{rawBase}/{project}/{sessionId}.json`. Skip if the file already exists (idempotent).
- [x] D2. Handle edge case: sessions with zero messages — skip entirely, do not emit any AgentMessage or write raw data.
- [x] D3. Handle edge case: assistant messages with no `text` parts (tool-only responses) — emit with `message: ""` but populated `toolCalls` array.
- [x] D4. Handle edge case: DB path normalization — the `dbPath` from `cc.json` may use backslashes or forward slashes, may or may not have a trailing separator. Normalize and append `opencode.db`. Also handle the case where `dbPath` directly points to the `.db` file (ends with `.db`).
- [x] D5. Add console logging consistent with other harnesses: log the number of sessions found, messages processed, and total AgentMessages returned. Use chalk for colored output if available (follow existing patterns in `claude.ts` or `cursor.ts`).

### Group E — Testing & Verification

{{MEDIUM}}

- [x] E1. Run the full CXC pipeline (`bun run src/ContextCore.ts`) and verify: OpenCode harness is invoked, reads the test session from the DB, and produces AgentMessages. Check the console output for correct counts (expect 2 user messages, 2 assistant messages from the test data).
- [x] E2. Verify the storage output: check that session JSON files are written under `{storage}/{machine}/OpenCode/{project}/YYYY-MM/` with correct filenames and valid AgentMessage arrays inside.
- [x] E3. Verify raw archival: check that `{storage}/{machine}-RAW/OpenCode/{project}/{sessionId}.json` exists and contains the full session data (messages + parts).
- [x] E4. Verify idempotency: run the pipeline a second time and confirm no duplicate files or messages are created (`0 new messages` on second run).

### Group F — Architecture Doc Update

{{SIMPLE}}

- [x] F1. Update `archi-context-core-level0.md` section 1 (System Overview) to mention OpenCode as a fifth IDE assistant, and add it to the Sources subgraph in the mermaid diagram.
- [x] F2. Add an OpenCode subsection to section 3.2 (Harness Ingestion Flow) describing the DB → message → part → consolidation pipeline, with a mermaid flowchart.
- [x] F3. Add OpenCode to section 8 (Model Resolution Strategies) table with: source = `message.data.modelID` on assistant messages, example = `"big-pickle"`.
- [x] F4. Update the Module Inventory table (section 2.2) with the new `opencode.ts` module entry.
- [x] F5. Update Metrics Summary (section 14): bump source file count, harness reader count, and approximate total lines of code.

### Caching Strategy

Since the data source is a live SQLite DB (similar to Cursor), we can't use file-based size/mtime caching. Follow the Cursor pattern — re-read all sessions each time, let downstream dedup (`StorageWriter` existsSync + `MessageDB` INSERT OR IGNORE) handle it.

### Edge Cases Summary

1. **Sessions with no messages**: Skip (empty session)
2. **Assistant messages with no text parts**: Tool-only; store with empty message body but populated toolCalls
3. **Multiple user messages in a session**: Each user message starts a new conversation turn — group by user message ID
4. **`time_created` is epoch milliseconds**: Convert via `DateTime.fromMillis()`
5. **DB may be locked by running OpenCode**: Open with `{ readonly: true }` to avoid conflicts; if that fails, log and return `[]`

---

## 5. Data Volumes (Current)

| Table | Rows | Notes |
|-------|------|-------|
| project | 1 | Single "global" project |
| session | 1 | One test session |
| message | 7 | 2 user + 5 assistant |
| part | 22 | Average ~3 parts per message |

Small dataset, but the structure is clean and well-understood. The harness should scale to any number of sessions.

---

## 6. Open Questions

1. **Multi-project**: Currently there's one "global" project. Does OpenCode create per-workspace projects? The `session.directory` is more reliable for project derivation anyway.
2. **Provider/model naming**: `"big-pickle"` seems like an internal codename. We'll store it as-is (like other harnesses store raw model strings).
3. **Agent modes**: Messages have an `agent` field (`"build"`). OpenCode may have other agent modes. We can ignore this for now.

---

## 7. Summary

OpenCode's SQLite schema is **clean and well-structured** — simpler than Cursor's. The key insight is the step-based message model where one user prompt produces N assistant messages (one per tool-call cycle), all linked via `parentID`. Our harness must consolidate these into single AgentMessage responses.

The implementation is straightforward: ~200-300 lines, following the Cursor harness pattern for DB-based reading and raw archival.
