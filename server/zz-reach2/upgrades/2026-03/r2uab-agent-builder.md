# r2uab – AgentBuilder

**Date**: 2026-03-17
**Status**: Planning
**Scope**: New AgentBuilder app mode — index and serve files from `dataSources` entries with `purpose: "AgentBuilder"`

---

## 1. Motivation

CXC's `cc.json` now supports a `dataSources` block per machine, allowing us to register external directories (like `zz-reach2` repos) as indexed knowledge bases. The AgentBuilder feature reads these data sources at startup, indexes their files, and serves the file listing (with content) through a new API endpoint. This enables AI agents to request project-specific architectural context on demand.

---

## 2. Config Shape (already in cc.json)

Each machine in `cc.json` can have a `dataSources` block alongside `harnesses`:

```json
{
  "machine": "Kyliathy3",
  "harnesses": { ... },
  "dataSources": {
    "zz-reach2": [
      {
        "path": "D:\\Codez\\Nexus\\Reach2\\context-core\\server\\zz-reach2",
        "agentPath": "D:\\Codez\\Nexus\\Reach2\\context-core\\.github\\agents",
        "name": "Context Core Server",
        "type": "Reach2 Architectural Repo",
        "purpose": "AgentBuilder"
      },
      {
        "path": "D:\\Codez\\Nexus\\Reach2\\context-core\\visualizer\\zz-reach2",
        "agentPath": "D:\\Codez\\Nexus\\Reach2\\context-core\\.github\\agents",
        "name": "Context Core Front",
        "type": "Reach2 Architectural Repo",
        "purpose": "AgentBuilder"
      }
    ]
  }
}
```

**Fields:**
| Field       | Type   | Description |
|-------------|--------|-------------|
| `path`      | string | Root directory to index |
| `agentPath` | string | (Optional) Path to agent definition files (`.agent.md`) — indexed alongside `path` |
| `name`      | string | Human-readable label for this data source (used as filter key) |
| `type`      | string | Categorization tag (informational) |
| `purpose`   | string | Must be `"AgentBuilder"` to be included |

---

## 3. Implementation Plan

### 3.1 Type Definitions — `src/types.ts`

Add the `DataSource` type and extend `MachineConfig`:

```typescript
/** A data source entry from cc.json dataSources. */
export type DataSourceEntry = {
  path: string;
  agentPath?: string;
  name: string;
  type: string;
  purpose: string;
};

/** Data sources keyed by category name (e.g. "zz-reach2"). */
export type DataSources = Record<string, DataSourceEntry[]>;

/** Machine-specific config — extend with optional dataSources. */
export type MachineConfig = {
  machine: string;
  harnesses: Harnesses;
  dataSources?: DataSources;
};
```

### 3.2 New Class — `src/agentBuilder/AgentBuilder.ts`

The `AgentBuilder` class is responsible for:
1. Reading `dataSources` from the current machine config
2. Filtering entries where `purpose === "AgentBuilder"`
3. Recursively indexing all files under each entry's `path` (and `agentPath` if present)
4. Serving the indexed file list on demand

```typescript
// src/agentBuilder/AgentBuilder.ts

interface IndexedFile {
  /** Relative path from the data source root */
  relativePath: string;
  /** Absolute path on disk */
  absolutePath: string;
  /** File size in bytes */
  size: number;
  /** Last modified timestamp (ISO) */
  lastModified: string;
  /** Data source name this file belongs to */
  sourceName: string;
  /** Data source type (informational) */
  sourceType: string;
  /** "content" or "agent" — whether from path or agentPath */
  origin: "content" | "agent";
  /** First 1000 characters of the file content */
  excerpt: string;
}

interface PrepareResponse {
  /** Total file count */
  totalFiles: number;
  /** Data sources included */
  sources: {
    name: string;
    type: string;
    path: string;
    agentPath?: string;
    fileCount: number;
  }[];
  /** Flat list of all indexed files */
  files: IndexedFile[];
}

class AgentBuilder {
  private indexedFiles: IndexedFile[] = [];
  private sources: DataSourceEntry[] = [];

  constructor(machineConfig: MachineConfig) {
    // Extract all AgentBuilder-purpose entries from dataSources
    this.sources = this.extractAgentBuilderSources(machineConfig);
  }

  /**
   * Scan all AgentBuilder data source directories and build the file index.
   * Called once at startup.
   */
  async index(): Promise<void> { ... }

  /**
   * Return the indexed file listing, optionally filtered by source name.
   */
  prepare(filterName?: string): PrepareResponse { ... }
}
```

**Indexing rules:**
- Recursively walk `path` and `agentPath` directories
- Include all files (`.md`, `.json`, `.agent.md`, etc.)
- Exclude: `.git/`, `node_modules/`, hidden dirs (`.*/` except `.github`)
- Store relative paths from the source root for portability
- Deduplicate: if the same absolute path appears in multiple entries (e.g. duplicate "Context Core Front" entries in current cc.json), index it only once
- Read the first **1000 characters** of each file during indexing and store as `excerpt` — gives consumers a preview without needing a second round-trip

### 3.3 New API Endpoint — `POST /api/agent-builder/prepare`

Register in `ContextServer.ts`:

```
POST /api/agent-builder/prepare
```

**Request body:**
```json
{
  "name": "Context Core Server"
}
```

- `name` is **optional**. When provided, only files from the data source(s) matching that name are returned.
- When omitted, all AgentBuilder files across all sources are returned.

**Response (200):**
```json
{
  "totalFiles": 29,
  "sources": [
    {
      "name": "Context Core Server",
      "type": "Reach2 Architectural Repo",
      "path": "D:\\Codez\\...\\server\\zz-reach2",
      "agentPath": "D:\\Codez\\...\\.github\\agents",
      "fileCount": 21
    }
  ],
  "files": [
    {
      "relativePath": "architecture/archi-context-core-level0.md",
      "absolutePath": "D:\\Codez\\...\\server\\zz-reach2\\architecture\\archi-context-core-level0.md",
      "size": 38420,
      "lastModified": "2026-03-16T09:21:00.000Z",
      "sourceName": "Context Core Server",
      "sourceType": "Reach2 Architectural Repo",
      "origin": "content",
      "excerpt": "# ContextCore – Architectural Review\n\n**Date**: 2026-03-07  \n**Scope**: High level architecture of ContextCore\n..."
    },
    {
      "relativePath": "cxc-ui-worker.agent.md",
      "absolutePath": "D:\\Codez\\...\\.github\\agents\\cxc-ui-worker.agent.md",
      "size": 525,
      "lastModified": "2026-03-17T08:54:00.000Z",
      "sourceName": "Context Core Server",
      "sourceType": "Reach2 Architectural Repo",
      "origin": "agent",
      "excerpt": "# CXC UI Worker Agent\n\nYou are a frontend worker agent..."
    }
  ]
}
```

### 3.4 Integration into Startup — `ContextCore.ts`

After loading the machine config and before starting the server:

```
1. const agentBuilder = new AgentBuilder(machineConfig);
2. await agentBuilder.index();
3. Pass agentBuilder to startServer() so ContextServer can register the endpoint.
```

Lightweight — no DB writes, no SQLite involvement. Pure filesystem index held in memory.

### 3.5 File Inventory (current state)

**"Context Core Server"** (`server/zz-reach2/`): ~20 markdown files
```
architecture/
  archi-context-core-level0.md
  data/archi-database.md, archi-file-watcher.md
  harness/archi-harness.md
  mcp/archi-mcp.md
  prose/archi-summarizer.md
  search/archi-qdrant.md, archi-search.md
  techDebt/td-memory-optimization.md
guides/mcp-connection-guide.md
protocol/archi-cxs.md
upgrades/2026-03/*.md (8 files)
upgrades/r2uab-agent-builder.md (this file)
```

**"Context Core Front"** (`visualizer/zz-reach2/`): ~9 markdown files
```
architecture/
  archi-context-core-visualizer.md
  ui/archi-context-core-ui.md
upgrades/*.md (7 files)
```

**Agent files** (`.github/agents/`): 1 file
```
cxc-ui-worker.agent.md
```

---

## 4. Execution Checklist

- [x] **Step 1**: Add `DataSourceEntry` and `DataSources` types to `src/types.ts`; extend `MachineConfig` with optional `dataSources`
- [x] **Step 2**: Create `src/agentBuilder/AgentBuilder.ts` with `index()` and `prepare()` methods
- [x] **Step 3**: Register `POST /api/agent-builder/prepare` in `ContextServer.ts`
- [x] **Step 4**: Wire `AgentBuilder` into `ContextCore.ts` startup sequence
- [x] **Step 5**: Add `POST /api/agent-builder/create` endpoint + `AgentBuilder.create()` method
- [ ] **Step 6**: Test — start server, call both endpoints

---

## 5. Agent Create Endpoint — `POST /api/agent-builder/create`

### 5.1 Purpose

Creates a new `.agent.md` file in the `agentPath` of the data source matching the given `projectName`. The generated file follows the same frontmatter + body format as existing agent files (e.g. `cxc-ui-worker.agent.md`).

### 5.2 Request Body

```json
{
  "projectName": "Context Core Server",
  "agentName": "cxc-server-worker",
  "description": "Work with the Context Core server-side code.",
  "argument-hint": "A task to implement.",
  "tools": ["read", "edit", "search", "todo"],
  "agentKnowledge": [
    "server/zz-reach2/architecture/archi-context-core-level0.md",
    "server/zz-reach2/architecture/mcp/archi-mcp.md"
  ]
}
```

| Field            | Type       | Required | Description |
|------------------|------------|----------|-------------|
| `projectName`    | string     | yes      | Must match a data source `name` with `purpose: "AgentBuilder"` that has an `agentPath` |
| `agentName`      | string     | yes      | Slug for the agent (used as filename stem, e.g. `my-agent` → `my-agent.agent.md`) |
| `description`    | string     | yes      | One-line description of what the agent does |
| `argument-hint`  | string     | yes      | Hint shown to the user for what argument to pass |
| `tools`          | string[]   | no       | List of tool names the agent is allowed to use. Omit for all tools |
| `agentKnowledge` | string[]   | yes      | File paths the agent must read for context (written as instructions in the body) |

### 5.3 Generated File Format

Output file: `{agentPath}/{agentName}.agent.md`

```markdown
---
name: {agentName}
description: {description}
argument-hint: {argument-hint}
tools: [{tools joined as quoted strings}]
---

To get context for your task, you MUST read the following files:

{for each path in agentKnowledge}
- [{path}]({path})
{end}
```

If `tools` is empty or omitted, the `tools:` line is commented out (matching the style of `cxc-ui-worker.agent.md`).

### 5.4 Error Cases

| Condition | HTTP | Response |
|-----------|------|----------|
| `projectName` not found in AgentBuilder sources | 404 | `{ error: "No AgentBuilder source found for project ..." }` |
| Matched source has no `agentPath` | 400 | `{ error: "Data source '...' has no agentPath configured" }` |
| `agentName` or `description` missing/empty | 400 | `{ error: "..." }` |
| File already exists at target path | 409 | `{ error: "Agent file already exists: ..." }` |

### 5.5 Success Response (201)

```json
{
  "created": true,
  "path": "D:\\Codez\\...\\agents\\cxc-server-worker.agent.md",
  "agentName": "cxc-server-worker"
}
```

After creation, the new file is **immediately added to the in-memory index** so a subsequent `/prepare` call reflects it without a server restart.

---

## 6. Future Extensions (not in this iteration)

- **File content retrieval**: A `POST /api/agent-builder/read` endpoint that returns the actual file contents for selected files (by relative path), so agents can load specific docs on demand
- **Watch for changes**: Hook into `FileWatcher` to re-index when files in data source paths change
- **Per-file metadata**: Parse frontmatter from `.md` files to extract title, date, status, etc.
