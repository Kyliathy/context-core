# R2M4 — MCP Tool Call Logging

**Date**: 2026-03-22
**Status**: Planning
**Scope**: Centralized MCP tool-call logging to console + optional file output
**Parent**: [`archi-mcp.md`](../../architecture/mcp/archi-mcp.md)

---

## 1. Goal

Every MCP tool call must clearly log:
1. **Request**: tool name + full arguments received
2. **Response summary**: number of results / chars returned + duration
3. **Full response** (when `MCP_LOGGING=true`): the complete text payload sent back

Console logging (stderr) happens always. File logging is additive when `MCP_LOGGING=true`.

---

## 2. Configuration

| Env Var       | Default | Effect                                                         |
| ------------- | ------- | -------------------------------------------------------------- |
| `MCP_LOGGING` | `false` | When `true`: enable file logging + log full response payloads  |

Already added to `.env.example` and `.env`. Will be parsed in `CCSettings.ts`.

---

## 3. File Layout

```
server/logs/                              ← gitignored
├── 2026-03-22 07:51 MCP Tool Calls.json  ← core session log (one per server run)
└── mcp-tool-calls/
    └── 2026-03-22/                        ← date directory (created on demand)
        ├── 07:51:03 Tool- search_messages.json
        ├── 07:51:04 Tool- get_session.json
        └── ...
```

### 3.1 Core Session Log

- **Path**: `server/logs/YYYY-MM-DD HH:mm MCP Tool Calls.json`
- **Created once** at MCP startup. Filename frozen for the lifetime of the process.
- **Content**: JSON array of log entries, one per tool call. Written incrementally (append to array).
- Each entry:
  ```json
  {
    "timestamp": "2026-03-22T07:51:03.412Z",
    "tool": "search_messages",
    "durationMs": 42,
    "request": { "query": "auth middleware", "maxResults": 10 },
    "responseChars": 2847,
    "resultCount": 8
  }
  ```
- When `MCP_LOGGING=false`, this file is **not written**.

### 3.2 Per-Call Detail Logs

- **Path**: `server/logs/mcp-tool-calls/YYYY-MM-DD/HH:mm:ss Tool- <toolName>.json`
- **Created per tool call** (only when `MCP_LOGGING=true`).
- Directory `server/logs/mcp-tool-calls/YYYY-MM-DD/` created with `mkdirSync({ recursive: true })` on first write of the day.
- **Content**: Full request + full response payload:
  ```json
  {
    "timestamp": "2026-03-22T07:51:03.412Z",
    "tool": "search_messages",
    "durationMs": 42,
    "request": { "query": "auth middleware", "maxResults": 10 },
    "responseChars": 2847,
    "resultCount": 8,
    "response": "<full text payload>"
  }
  ```
- If multiple calls hit the same tool in the same second, append a counter: `07:51:03 Tool- search_messages (2).json`

---

## 4. Architecture — Centralized Logger

### 4.1 New Module: `src/mcp/mcpLogger.ts`

A single module that:
1. **Initializes** at MCP startup (freezes the session log filename)
2. **Exposes one function** for tool-call logging that writes to both console and file (if enabled)
3. Reads `MCP_LOGGING` from `CCSettings` (or directly from `process.env` to stay lightweight)

```typescript
// Public API
export function initMcpLogger(): void;                     // call once at startup
export function logToolCall(entry: McpToolLogEntry): void;  // call per tool invocation
```

### 4.2 `McpToolLogEntry` Shape

```typescript
interface McpToolLogEntry {
  tool: string;
  durationMs: number;
  request: Record<string, unknown>;   // the raw arguments
  responseText: string;               // full response text (only written to file when MCP_LOGGING)
  resultCount?: number;               // parsed from response when available
  isError?: boolean;
}
```

### 4.3 Console Output (always)

Replaces the current `[MCP/Tool]` line in `registry.ts` with richer info:

```
[MCP/Tool] search_messages ← {query:"auth middleware", maxResults:10}
[MCP/Tool] search_messages → 42ms | 8 results | 2847 chars
```

Two lines: one on entry (request), one on exit (response). The entry line already exists as `logMcpRequest("tools/call", name)` — we'll enrich it.

### 4.4 File Output (when `MCP_LOGGING=true`)

The `logToolCall` function:
1. Appends entry (without `response` field) to the core session log JSON
2. Writes a per-call detail file (with full `response` field) into the date directory

### 4.5 Session Log Write Strategy

To avoid broken JSON from crashes, write the session log as **newline-delimited JSON (NDJSON)** rather than a JSON array. Each line is a self-contained JSON object. The `.json` extension stays (readers can parse line-by-line).

Alternative: maintain an in-memory array and `writeFileSync` the whole thing on each call. Given MCP tool calls are infrequent (seconds apart), this is fine and keeps the file valid JSON at all times.

**Decision**: Use the in-memory array + writeFileSync approach. MCP tool calls are low-frequency, and valid JSON files are easier to inspect.

---

## 5. Result Count Extraction

The `resultCount` field should be extracted from the tool response text. Current formatting patterns in `formatters.ts`:

| Tool                     | Pattern in response text                                  | How to extract count        |
| ------------------------ | --------------------------------------------------------- | --------------------------- |
| `search_messages`        | `"Found N messages matching..."` or `"No messages found"` | Parse N from header         |
| `search_threads`         | `"Found N threads matching..."`                           | Parse N from header         |
| `search_thread_messages` | `"Found N messages in thread..."`                         | Parse N from header         |
| `search_by_symbol`       | `"Found N messages containing symbol..."`                 | Parse N from header         |
| `get_message`            | Single message block                                      | Count = 1 (or 0 if error)  |
| `get_session`            | `"Session ... (N messages)"`                              | Parse N from header         |
| `list_sessions`          | `"N sessions"`                                            | Parse N from header         |
| `query_messages`         | `"Page X of Y (Z total)"`                                 | Parse Z from header         |
| `get_latest_threads`     | `"N threads ..."`                                         | Parse N from header         |
| `get_topics`             | Multiple topic entries separated by `---`                 | Count separators + 1        |
| `get_topic`              | Single topic entry                                        | Count = 1                   |
| `set_topic`              | Confirmation text                                         | N/A                         |

Rather than parsing every format, a simpler approach: **have each tool handler return a structured result** that includes both the text and a count. But that's a larger refactor.

**Pragmatic approach**: Add a `parseResultCount(toolName: string, text: string): number | undefined` helper in `mcpLogger.ts` that regex-extracts the count from known header patterns. Falls back to `undefined` for tools where extraction isn't clean.

---

## 6. Integration Points

### 6.1 `CCSettings.ts`

Add `MCP_LOGGING` boolean field:
```typescript
readonly MCP_LOGGING: boolean;
// In constructor:
this.MCP_LOGGING = this.parseEnvBoolean(process.env.MCP_LOGGING, false);
```

### 6.2 `registry.ts` — Tool Call Handler (lines 77-124)

Replace the current logging with `mcpLogger` calls:

```typescript
// Before dispatch (line 82):
logToolRequest(name, safeArgs);   // console: [MCP/Tool] name ← {args}

// After dispatch (line 110), replace console.error line:
logToolCall({
  tool: name,
  durationMs: Date.now() - start,
  request: safeArgs,
  responseText: text,
});
// logToolCall handles console + file logging internally
```

### 6.3 `MCPServer.ts` — Startup

Call `initMcpLogger()` during construction, after `registerAll()`.

### 6.4 `serve.ts` — Standalone Startup

Call `initMcpLogger()` after creating the MCPServer instance.

### 6.5 `.gitignore`

Add `logs/` to `server/.gitignore` (currently only has `*.log`).

---

## 7. Implementation Steps

- [ ] **Step 1**: Add `MCP_LOGGING` to `CCSettings.ts`
- [ ] **Step 2**: Add `logs/` to `server/.gitignore`
- [ ] **Step 3**: Create `src/mcp/mcpLogger.ts` with `initMcpLogger()`, `logToolCall()`, `parseResultCount()`
- [ ] **Step 4**: Update `registry.ts` — replace current logging with mcpLogger calls
- [ ] **Step 5**: Update `MCPServer.ts` — call `initMcpLogger()` at startup
- [ ] **Step 6**: Update `serve.ts` — call `initMcpLogger()` at startup
- [ ] **Step 7**: Test manually: start MCP, invoke a few tools, verify console + file output
- [ ] **Step 8**: Update `archi-mcp.md` §13 (Diagnostic Output) to document the new logging

---

## 8. Risks & Mitigations

| Risk                                         | Mitigation                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| File writes on every tool call add latency   | `writeFileSync` is ~1ms for small JSON; MCP calls are infrequent          |
| Duplicate filenames in same second            | Counter suffix: `(2)`, `(3)`, etc.                                         |
| Logs directory grows unbounded               | Not auto-pruned — user manages. Could add cleanup later if needed          |
| `stdout` corruption from accidental logging  | All logging goes to stderr (console) or file. Never touches stdout.        |
| Session log file gets large over long runs   | One entry per tool call (small JSON). A 1000-call session ≈ 200KB — fine   |
