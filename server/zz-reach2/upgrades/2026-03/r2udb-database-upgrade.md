# R2UDB – Database Upgrade: In-Memory → On-Disk SQLite

**Date**: 2026-03-15
**Status**: Complete
**Goal**: Replace the in-memory SQLite database with an on-disk SQLite file as the default storage mode, while preserving the in-memory option behind an env flag. Centralize all data access into a single abstract class with two concrete implementations.

---

## 1. Motivation

The current `MessageDB` creates a `new Database(":memory:")` and loads **every** persisted JSON session file into RAM on every startup. This:

- Consumes significant RAM (all messages × full row data in SQLite pages).
- Adds startup latency proportional to corpus size (read all JSON → parse → insert).
- Loses all data on process exit — the JSON files are the real source of truth, but the DB is rebuilt from scratch every time.

An on-disk SQLite file eliminates rebuild time on subsequent runs (only new/changed sessions need ingestion), drastically reduces RAM usage, and lets the OS page cache handle hot data transparently.

---

## 2. Configuration Changes

### 2.1 `cc.json` — new `databaseFile` field

Add a `databaseFile` key at the root level, right after `storage`:

```json
{
  "storage": "d:\\Codez\\Nexus\\design\\CXC",
  "databaseFile": "d:\\Codez\\Nexus\\design\\CXC\\cxc-db.sqlite",
  "machines": [ ... ]
}
```

- **Default value** (when absent): `{storage}/cxc-db.sqlite`
- The `ContextCoreConfig` type in `types.ts` must gain an optional `databaseFile?: string` field.
- `CCSettings` must expose `readonly databaseFile: string`, resolving the default at construction time.

### 2.2 `.env.example` — new `IN_MEMORY_DB` flag

```env
# Database Mode
# Set to true to use in-memory SQLite instead of on-disk (default: false)
IN_MEMORY_DB=false
```

When `IN_MEMORY_DB=true`, the system ignores `databaseFile` and behaves exactly as it does today (`:memory:`).

---

## 3. Database Schema (On-Disk)

The on-disk schema matches the current in-memory schema exactly, with the following additions for durability and performance:

### 3.1 Table Definition

```sql
CREATE TABLE IF NOT EXISTS AgentMessages (
  id          TEXT PRIMARY KEY,
  sessionId   TEXT NOT NULL,
  harness     TEXT NOT NULL,
  machine     TEXT NOT NULL,
  role        TEXT NOT NULL,
  model       TEXT,
  message     TEXT NOT NULL,
  subject     TEXT NOT NULL,
  context     TEXT NOT NULL,      -- JSON array
  symbols     TEXT NOT NULL,      -- JSON array
  history     TEXT NOT NULL,      -- JSON array
  tags        TEXT NOT NULL,      -- JSON array
  project     TEXT NOT NULL,
  parentId    TEXT,
  tokenUsage  TEXT,               -- JSON object or null
  toolCalls   TEXT NOT NULL,      -- JSON array
  rationale   TEXT NOT NULL,      -- JSON array
  source      TEXT NOT NULL DEFAULT '',
  dateTime    TEXT NOT NULL,
  length      INTEGER NOT NULL DEFAULT 0
);
```

### 3.2 Index Strategy

The current 7 single-column indexes are preserved. Additional **compound indexes** are added to cover the most common query patterns observed in `MessageDB.queryMessages()`, `ContextServer.ts`, and the MCP tools:

```sql
-- ═══ Existing single-column indexes (kept) ═══
CREATE INDEX IF NOT EXISTS idx_agent_sessionId ON AgentMessages(sessionId);
CREATE INDEX IF NOT EXISTS idx_agent_harness   ON AgentMessages(harness);
CREATE INDEX IF NOT EXISTS idx_agent_role      ON AgentMessages(role);
CREATE INDEX IF NOT EXISTS idx_agent_model     ON AgentMessages(model);
CREATE INDEX IF NOT EXISTS idx_agent_dateTime  ON AgentMessages(dateTime);
CREATE INDEX IF NOT EXISTS idx_agent_project   ON AgentMessages(project);
CREATE INDEX IF NOT EXISTS idx_agent_subject   ON AgentMessages(subject);

-- ═══ New compound indexes for on-disk performance ═══

-- Covers: listSessions() GROUP BY sessionId + MAX(dateTime) ordering
-- Covers: getBySessionId() WHERE sessionId = ? ORDER BY dateTime ASC
CREATE INDEX IF NOT EXISTS idx_agent_session_dt
  ON AgentMessages(sessionId, dateTime);

-- Covers: queryMessages() with harness + dateTime range filters (most common combo)
CREATE INDEX IF NOT EXISTS idx_agent_harness_dt
  ON AgentMessages(harness, dateTime);

-- Covers: queryMessages() with project + dateTime range filters
CREATE INDEX IF NOT EXISTS idx_agent_project_dt
  ON AgentMessages(project, dateTime);

-- Covers: queryMessages() with role + dateTime (e.g. "all user messages this week")
CREATE INDEX IF NOT EXISTS idx_agent_role_dt
  ON AgentMessages(role, dateTime);

-- Covers: getAllMessages() ORDER BY dateTime DESC (full scan fallback, at least ordered)
-- Note: idx_agent_dateTime already covers this; no extra index needed.

-- Covers: machine-scoped queries (cross-machine search)
CREATE INDEX IF NOT EXISTS idx_agent_machine
  ON AgentMessages(machine);
```

**Why these compounds?**
`queryMessages()` builds dynamic WHERE clauses combining 1–3 filter columns with dateTime range predicates and an `ORDER BY dateTime DESC`. Without compounds, SQLite must scan the full table and sort in a temp B-tree. A `(filter_col, dateTime)` compound lets SQLite seek + range-scan in index order, avoiding both the full scan and the sort.

### 3.3 Pragmas for On-Disk Mode

```sql
PRAGMA journal_mode = WAL;         -- concurrent readers + one writer
PRAGMA synchronous = NORMAL;       -- safe with WAL; faster than FULL
PRAGMA cache_size = -64000;        -- 64 MB page cache
PRAGMA busy_timeout = 5000;        -- wait up to 5s on lock contention
PRAGMA foreign_keys = OFF;         -- no FK constraints in this schema
```

These are set once at connection open, only for the on-disk implementation.

---

## 4. Architecture: Abstract Storage Class

### 4.1 Class Hierarchy

```
IMessageStore (interface — the public contract)
  ├── InMemoryMessageStore (current behavior, Database(":memory:"))
  └── DiskMessageStore     (on-disk SQLite file, WAL mode)
```

Both implementations share the same `bun:sqlite` `Database` API. The difference is:
- **Constructor**: `:memory:` vs file path.
- **Pragmas**: Disk sets WAL/cache; memory does not.
- **loadFromStorage()**: Disk checks which sessions are already in the DB and only inserts new ones. Memory always loads everything.

### 4.2 Interface Definition

```typescript
export interface IMessageStore {
  close(): void;
  addMessages(messages: AgentMessage[]): number;
  loadFromStorage(storagePath: string): number;
  getById(id: string): AgentMessage | null;
  getBySessionId(sessionId: string): AgentMessage[];
  listSessions(): SessionSummary[];
  getAllMessages(): AgentMessage[];
  getHarnessCounts(): Array<{ harness: string; count: number }>;
  getHarnessDateRanges(): Array<{ harness: string; earliest: string; latest: string; count: number }>;
  queryMessages(filters: MessageQueryFilters): MessageQueryResult;
}
```

### 4.3 Factory Function

```typescript
export function createMessageStore(settings: CCSettings): IMessageStore {
  const useInMemory = (process.env.IN_MEMORY_DB ?? "false").trim().toLowerCase() === "true";
  if (useInMemory) {
    return new InMemoryMessageStore();
  }
  return new DiskMessageStore(settings.databaseFile);
}
```

### 4.4 Incremental Load Optimization (Disk Only)

On-disk `loadFromStorage()` can skip files whose sessions are already in the DB:

1. Query `SELECT DISTINCT sessionId FROM AgentMessages` into a `Set<string>`.
2. For each JSON file, peek at the first message's `sessionId`.
3. If already in the set, skip the file entirely.
4. If new, parse and insert all messages from that file.

This reduces startup from O(all messages) to O(new messages only).

---

## 5. Consumer Migration Map

All 16 files that import `MessageDB` must be updated to import `IMessageStore` instead. The concrete class name is only referenced in the two factory sites:

| File | Current Usage | Change Required |
|------|--------------|-----------------|
| `ContextCore.ts` | `new MessageDB()` | Use `createMessageStore(settings)` |
| `mcp/serve.ts` | `new MessageDB()` | Use `createMessageStore(settings)` |
| `ContextServer.ts` | `MessageDB` type param | Change to `IMessageStore` |
| `IncrementalPipeline.ts` | `MessageDB` type param | Change to `IMessageStore` |
| `TopicSummarizer.ts` | `MessageDB` type param | Change to `IMessageStore` |
| `SearchResults.ts` | `MessageDB` type param | Change to `IMessageStore` |
| `mcp/MCPServer.ts` | `MessageDB` type param | Change to `IMessageStore` |
| `mcp/registry.ts` | `MessageDB` type param | Change to `IMessageStore` |
| `mcp/transports/sse.ts` | `MessageDB` type param | Change to `IMessageStore` |
| `mcp/tools/messages.ts` | `MessageDB` type param | Change to `IMessageStore` |
| `mcp/tools/search.ts` | `MessageDB` type param | Change to `IMessageStore` |
| `mcp/prompts/index.ts` | `MessageDB` type param | Change to `IMessageStore` |
| `mcp/resources/index.ts` | `MessageDB` type param | Change to `IMessageStore` |
| `search/threadAggregator.ts` | `MessageDB` type param | Change to `IMessageStore` |
| `ContextMaster.ts` | `new MessageDB()` | Use `createMessageStore(settings)` |

---

## 6. Task Plan

### Group 1 — Configuration & Types

{{SIMPLE}}

- [x] **T1.** Add `databaseFile?: string` to the `ContextCoreConfig` type in `src/types.ts`.
- [x] **T2.** In `CCSettings`, add `readonly databaseFile: string` property. In the constructor, resolve it: if `config.databaseFile` exists use it, otherwise default to `join(this.storage, "cxc-db.sqlite")`. Also add `readonly IN_MEMORY_DB: boolean` parsed from `process.env.IN_MEMORY_DB` (default `false`).
- [x] **T3.** Add `IN_MEMORY_DB=false` with a comment block to `.env.example`, in a new "Database Mode" section near the top (before the Qdrant section).
- [x] **T4.** Add `"databaseFile": "d:\\Codez\\Nexus\\design\\CXC\\cxc-db.sqlite"` to both machine blocks in `cc.json` (right after `"storage"`). Note: `databaseFile` is root-level, not per-machine.

### Group 2 — Interface Extraction & Base Implementation

{{MEDIUM}}

- [x] **T5.** Create `src/db/IMessageStore.ts`. Define the `IMessageStore` interface containing all public method signatures currently on `MessageDB` (see §4.2). Also re-export the existing types `MessageQueryFilters`, `MessageQueryResult`, `SessionSummary` from this file so consumers have a single import point.
- [x] **T6.** Rename `MessageDB` class to `InMemoryMessageStore`. Make it `implements IMessageStore`. Keep it in `src/db/MessageDB.ts` (rename the file to `src/db/InMemoryMessageStore.ts`). Ensure all internal logic is unchanged — this is a pure rename + interface conformance.
- [x] **T7.** Extract the shared private helpers (`insertMessage`, `mapRowToMessage`, `collectJsonFiles`, schema creation SQL, index creation SQL) into a `src/db/BaseMessageStore.ts` abstract class that implements `IMessageStore`. Both `InMemoryMessageStore` and `DiskMessageStore` will extend this. The abstract class holds the `protected db: Database` field and all shared query methods.
- [x] **T8.** Create `src/db/DiskMessageStore.ts` extending `BaseMessageStore`. Constructor takes a file path, opens `new Database(filePath)`, runs the WAL/cache pragmas (§3.3), then calls the shared schema + index creation. The `loadFromStorage()` override implements the incremental skip logic (§4.4).

### Group 3 — Factory & Wiring

{{MEDIUM}}

- [x] **T9.** Create a `createMessageStore()` factory function in `src/db/IMessageStore.ts` (or a separate `src/db/factory.ts`). It reads `CCSettings.IN_MEMORY_DB` and returns the appropriate implementation.
- [x] **T10.** Update `ContextCore.ts`: replace `new MessageDB()` with `createMessageStore(settings)`. Change the local variable type to `IMessageStore`.
- [x] **T11.** Update `mcp/serve.ts`: replace `new MessageDB()` with `createMessageStore(settings)`. Change the local variable type to `IMessageStore`.
- [x] **T12.** Update `ContextMaster.ts`: replace `new MessageDB()` with `createMessageStore(settings)`. Change the local variable type to `IMessageStore`.

### Group 4 — Consumer Type Migration (batch 1)

{{SIMPLE}}

- [x] **T13.** Update `server/ContextServer.ts`: change `MessageDB` import to `IMessageStore`, update parameter type in `startServer()`.
- [x] **T14.** Update `watcher/IncrementalPipeline.ts`: change `MessageDB` import to `IMessageStore`, update constructor parameter type.
- [x] **T15.** Update `analysis/TopicSummarizer.ts`: change `MessageDB` import to `IMessageStore`, update constructor parameter type.
- [x] **T16.** Update `models/SearchResults.ts`: change `MessageDB` import to `IMessageStore`, update `merge()` parameter type.
- [x] **T17.** Update `search/threadAggregator.ts`: change `MessageDB` import to `IMessageStore`, update function parameter types.
- [x] **T18.** Update `mcp/MCPServer.ts`: change `MessageDB` import to `IMessageStore`, update constructor parameter type.
- [x] **T19.** Update `mcp/registry.ts`: change `MessageDB` import to `IMessageStore`, update `registerAll()` and sub-function parameter types.
- [x] **T20.** Update `mcp/transports/sse.ts`: change `MessageDB` import to `IMessageStore`, update `mountMcpSse()` parameter type.

### Group 5 — Consumer Type Migration (batch 2)

{{SIMPLE}}

- [x] **T21.** Update `mcp/tools/messages.ts`: change `MessageDB` import to `IMessageStore`, update handler parameter types.
- [x] **T22.** Update `mcp/tools/search.ts`: change `MessageDB` import to `IMessageStore`, update handler parameter types.
- [x] **T23.** Update `mcp/prompts/index.ts`: change `MessageDB` import to `IMessageStore`, update handler parameter types.
- [x] **T24.** Update `mcp/resources/index.ts`: change `MessageDB` import to `IMessageStore`, update handler parameter types.

### Group 6 — Disk-Specific Optimizations

{{HARD}}

- [x] **T25.** In `DiskMessageStore.loadFromStorage()`, implement the incremental session detection: query existing sessionIds from the DB, then skip JSON files whose first message's sessionId is already present. Log counts of skipped vs loaded files.
- [x] **T26.** In `DiskMessageStore`, wrap `addMessages()` in an explicit transaction (`BEGIN`/`COMMIT`) for batch insert performance. The in-memory version can keep the current per-row approach (transactions have negligible benefit in-memory).
- [x] **T27.** Add a `getMessageCount(): number` method to `IMessageStore` (simple `SELECT COUNT(*) FROM AgentMessages`). Use this in `ContextCore.ts` startup logging instead of the return value from `loadFromStorage()`, so the log accurately reflects the total DB size for both modes.
- [x] **T28.** Add compound indexes (`session_dt`, `harness_dt`, `project_dt`, `role_dt`, `machine`) to the schema creation in `BaseMessageStore` (§3.2). These benefit on-disk performance significantly; they're harmless (just slightly more memory) for in-memory mode.

### Group 7 — Integration Testing & Validation

{{HARD}}

- [x] **T29.** Manually test: start with `IN_MEMORY_DB=true`, verify identical behavior to current baseline (full JSON load, all endpoints work).
- [x] **T30.** Manually test: start with `IN_MEMORY_DB=false` (default), verify the SQLite file is created at `databaseFile` path, all endpoints return correct data, and the file persists across restarts.
- [x] **T31.** Verify incremental load: after first run with disk mode, restart the process. Confirm that `loadFromStorage()` skips already-loaded sessions and only processes new ones. Check startup time improvement.
- [x] **T32.** Verify `IncrementalPipeline` (FileWatcher) works correctly with `DiskMessageStore`: live file changes should still be detected, ingested, and queryable via the API.
- [x] **T33.** Verify MCP tools work correctly with both storage modes: `search_messages`, `get_session`, `list_sessions`, `get_latest_threads`.
- [x] **T34.** Performance smoke test: compare startup time and RAM usage between in-memory and disk modes on the full corpus. Document the results.

### Group 8 — Cleanup & Documentation

{{SIMPLE}}

- [x] **T35.** Remove the old `src/db/MessageDB.ts` file (now replaced by `InMemoryMessageStore.ts` + `BaseMessageStore.ts` + `DiskMessageStore.ts`).
- [x] **T36.** Update `archi-context-core-level0.md` §12.1 (In-Memory DB Scalability) to mark the risk as addressed, similar to how §12.6 was updated for file-based caching.
- [x] **T37.** Add a brief note to `archi-context-core-level0.md` §2.2 Module Inventory for the new files: `IMessageStore.ts`, `BaseMessageStore.ts`, `DiskMessageStore.ts`, `InMemoryMessageStore.ts`.
- [x] **T38.** Update the startup log in `ContextCore.ts` to indicate which storage mode is active: `[Pipeline] Database mode: disk (cxc-db.sqlite)` or `[Pipeline] Database mode: in-memory`.

---

## 7. Risk Notes

1. **WAL file growth**: WAL mode creates `cxc-db.sqlite-wal` and `cxc-db.sqlite-shm` sidecar files. These are auto-checkpointed by SQLite. If the process crashes mid-write, WAL replay on next open recovers automatically.

2. **Concurrent access**: Only one ContextCore process should write to the DB file at a time. The `busy_timeout` pragma handles brief lock contention (e.g., FileWatcher ingesting while API reads), but running two full instances against the same file is unsupported.

3. **Migration path**: There is no data migration needed. On first run in disk mode, `loadFromStorage()` will populate the SQLite file from the existing JSON session files — the same path as in-memory mode, just persisted. Subsequent runs benefit from incremental loading.

4. **Fuse.js search index**: The Fuse.js in-memory search index (`searchEngine.ts`) is independent of the database mode. It will still be built from `getAllMessages()` at startup. Optimizing this (e.g., replacing with SQLite FTS5) is a separate future task.

5. **File size estimate**: Based on ~20 columns × ~4KB average per message, a corpus of 50,000 messages would produce a ~200 MB SQLite file. This is well within SQLite's capabilities.
