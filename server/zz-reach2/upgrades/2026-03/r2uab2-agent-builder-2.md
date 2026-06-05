# r2uab2 – AgentBuilder Phase 2: List, Get & JSON Persistence

**Date**: 2026-03-17
**Status**: Planning
**Scope**: New `/agent-builder/list` and `/agent-builder/get-agent` endpoints; persist agent JSON alongside `.agent.md` for round-trip editing
**Depends on**: [r2uab – AgentBuilder](r2uab-agent-builder.md)

---

## 1. Problem

The current `/agent-builder/create` endpoint generates an `.agent.md` file from a JSON payload but **does not persist the JSON itself**. This means the client has no way to retrieve the structured agent definition back for editing — it would have to reverse-parse the frontmatter and markdown body, which is fragile and lossy (e.g. tool comments, knowledge path formatting).

Additionally, there is no way for a client to:
- **List** all agents in the system (only the full `/prepare` file listing exists, which mixes agents with all content files)
- **Retrieve** a specific agent's definition as structured JSON

---

## 2. Changes Overview

| #   | Change                                                        | Where                   |
| --- | ------------------------------------------------------------- | ----------------------- |
| 1   | Save `.agent.json` alongside `.agent.md` on create            | `AgentBuilder.create()` |
| 2   | New `list()` method — returns all agents with metadata        | `AgentBuilder`          |
| 3   | New `getAgent()` method — returns the JSON for a single agent | `AgentBuilder`          |
| 4   | New `GET /api/agent-builder/list` endpoint                    | `ContextServer.ts`      |
| 5   | New `GET /api/agent-builder/get-agent?path=...` endpoint      | `ContextServer.ts`      |

---

## 3. JSON Persistence — `.agent.json`

### 3.1 Rationale

Every `/create` call already receives a complete structured payload. We save it verbatim as `{agentName}.agent.json` in the same `agentPath` directory, right next to the `.agent.md` file. This gives us:

- **Lossless round-trip**: client sends JSON → server saves JSON + MD → client retrieves JSON → edits → re-saves
- **No parsing needed**: the JSON is the source of truth for the structured form; the MD is the runtime artifact consumed by VS Code / Copilot
- **Simple file pairing**: `my-agent.agent.md` + `my-agent.agent.json` — same stem, different extension

### 3.2 JSON File Shape

The `.agent.json` contains the exact `CreateAgentInput` payload (same as the request body), preserving all fields:

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

### 3.3 Implementation — `AgentBuilder.create()` Changes

After writing the `.agent.md` file and before adding to the in-memory index, also write the JSON:

```typescript
// In create(), after writeFileSync for .agent.md:
const jsonFileName = `${agentName}.agent.json`;
const jsonAbsPath = join(source.agentPath, jsonFileName);
const jsonPayload: CreateAgentInput = {
  projectName,
  agentName,
  description,
  "argument-hint": argumentHint,
  tools: tools ?? [],
  agentKnowledge,
};
writeFileSync(jsonAbsPath, JSON.stringify(jsonPayload, null, 2), "utf8");
```

The `.agent.json` file is **also** added to the in-memory index (origin `"agent"`, same as the `.agent.md`). This means it shows up in `/prepare` alongside the MD file — but more importantly, the `list()` method can find it.

### 3.4 Pre-existing Agents

Agents created before this change (e.g. `cxc-ui-worker.agent.md`) won't have a `.agent.json`. The `getAgent()` method must handle this gracefully — see §5.3.

---

## 4. Agent List — `GET /api/agent-builder/list`

### 4.1 Purpose

Returns a summary of every agent in the system. The client uses this to populate an agent management screen where users can browse, select, and edit agents.

### 4.2 Implementation — `AgentBuilder.list()`

New method that scans the in-memory index for `.agent.md` files with `origin: "agent"`, then enriches each with parsed metadata:

```typescript
interface AgentListEntry {
  /** Agent name (filename stem, e.g. "cxc-ui-worker") */
  name: string;
  /** Absolute path to the .agent.md file */
  path: string;
  /** Description extracted from frontmatter */
  description: string;
  /** Argument hint extracted from frontmatter */
  hint: string;
  /** First 1000 characters of the .agent.md content */
  excerpt: string;
}

interface AgentListResponse {
  /** Number of agents found */
  totalAgents: number;
  /** List of agent entries */
  agents: AgentListEntry[];
}
```

**Logic:**

1. Filter `this.indexedFiles` for entries where `origin === "agent"` and `relativePath` ends with `.agent.md`
2. For each matching file, extract metadata via one of two strategies:
   - **If a matching `.agent.json` exists** (same stem): read `description` and `argument-hint` from the JSON (fast, structured)
   - **Fallback (no JSON)**: parse the `.agent.md` frontmatter to extract `name`, `description`, `argument-hint` — simple line-by-line YAML parse between `---` fences (no heavy YAML library needed)
3. The `excerpt` field is already available on the `IndexedFile` — no extra read needed
4. The `name` field is the filename stem (strip `.agent.md`)
5. The `path` field is the `absolutePath` from the index

**Frontmatter parsing** (fallback for legacy agents without JSON):

```typescript
function parseFrontmatter(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return result;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "---") break;
    if (line.startsWith("#")) continue; // skip commented-out lines
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      result[key] = value;
    }
  }
  return result;
}
```

### 4.3 API Endpoint

```
GET /api/agent-builder/list
```

No request body or query params. Returns all agents across all AgentBuilder data sources.

**Response (200):**

```json
{
  "totalAgents": 2,
  "agents": [
    {
      "name": "cxc-ui-worker",
      "path": "D:\\Codez\\...\\agents\\cxc-ui-worker.agent.md",
      "description": "Work with the Context Core UI.",
      "hint": "A task to implement.",
      "excerpt": "---\nname: cxc-ui-worker\ndescription: Work with the Context Core UI.\nargument-hint: A task to implement.\n# tools: ...\n---\n\nTo get context for your task, you MUST read..."
    },
    {
      "name": "cxc-server-worker",
      "path": "D:\\Codez\\...\\agents\\cxc-server-worker.agent.md",
      "description": "Work with the Context Core server-side code.",
      "hint": "A task to implement.",
      "excerpt": "---\nname: cxc-server-worker\n..."
    }
  ]
}
```

**Error cases:**

| Condition                   | HTTP | Response                                                              |
| --------------------------- | ---- | --------------------------------------------------------------------- |
| AgentBuilder not configured | 404  | `{ error: "AgentBuilder not available (no dataSources configured)" }` |

### 4.4 Endpoint Registration — `ContextServer.ts`

```typescript
app.get("/api/agent-builder/list", (req, res) =>
{
  if (!agentBuilder) {
    res.status(404).json({ error: "AgentBuilder not available (no dataSources configured)" });
    return;
  }
  res.json(agentBuilder.list());
});
```

---

## 5. Get Agent — `GET /api/agent-builder/get-agent`

### 5.1 Purpose

Returns the full structured JSON definition of a single agent, enabling the client to populate an edit form.

### 5.2 API Endpoint

```
GET /api/agent-builder/get-agent?path=D:\Codez\...\agents\cxc-server-worker.agent.md
```

| Param  | Type   | Required | Description                                                    |
| ------ | ------ | -------- | -------------------------------------------------------------- |
| `path` | string | yes      | Absolute path to the `.agent.md` file (as returned by `/list`) |

### 5.3 Implementation — `AgentBuilder.getAgent()`

```typescript
interface AgentDefinition extends CreateAgentInput {
  /** Whether this definition was loaded from a .agent.json (true) or reconstructed from .agent.md (false) */
  fromJson: boolean;
}

interface GetAgentResponse {
  agent: AgentDefinition;
}
```

**Logic:**

1. Validate that `path` is a string, non-empty, and ends with `.agent.md`
2. Validate that the path exists in the in-memory index (prevents arbitrary file reads — security boundary)
3. Derive the JSON path: replace `.agent.md` → `.agent.json` in the filename
4. **If `.agent.json` exists on disk**: read and parse it, set `fromJson: true` — this is the happy path
5. **If no JSON file exists** (legacy agent): reconstruct `CreateAgentInput` from the `.agent.md` by:
   - Parsing frontmatter for `name` → `agentName`, `description`, `argument-hint`
   - Parsing the `tools:` line (handle both active `tools: [...]` and commented `# tools: [...]` — commented means empty array)
   - Scanning the body for markdown links to build `agentKnowledge[]` (each `- [text](path)` line below the knowledge header)
   - Setting `projectName` from the `sourceName` of the matching index entry
   - Setting `fromJson: false` to signal this is a best-effort reconstruction
6. Return the `GetAgentResponse`

**Frontmatter + body parser** (only used for legacy fallback):

```typescript
function reconstructAgentInput(
  content: string, 
  sourceName: string
): CreateAgentInput {
  const fm = parseFrontmatter(content);
  
  // Parse tools from frontmatter (handles both active and commented lines)
  let tools: string[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "---" && tools.length === 0) continue;
    // Match: tools: ['a', 'b'] or # tools: ['a', 'b']
    const toolMatch = trimmed.match(/^#?\s*tools:\s*\[(.+)\]/);
    if (toolMatch) {
      tools = toolMatch[1].split(",").map(t => t.trim().replace(/['"]/g, "")).filter(Boolean);
      break;
    }
    if (trimmed === "---") break; // end of frontmatter
  }

  // Parse knowledge links from body
  const agentKnowledge: string[] = [];
  let pastFrontmatter = false;
  let frontmatterCount = 0;
  for (const line of lines) {
    if (line.trim() === "---") { frontmatterCount++; if (frontmatterCount >= 2) pastFrontmatter = true; continue; }
    if (!pastFrontmatter) continue;
    const linkMatch = line.match(/\[.*?\]\((.+?)\)/);
    if (linkMatch) agentKnowledge.push(linkMatch[1]);
  }

  return {
    projectName: sourceName,
    agentName: fm["name"] ?? "",
    description: fm["description"] ?? "",
    "argument-hint": fm["argument-hint"] ?? "",
    tools,
    agentKnowledge,
  };
}
```

### 5.4 Response (200)

**From JSON (new agents):**
```json
{
  "agent": {
    "projectName": "Context Core Server",
    "agentName": "cxc-server-worker",
    "description": "Work with the Context Core server-side code.",
    "argument-hint": "A task to implement.",
    "tools": ["read", "edit", "search", "todo"],
    "agentKnowledge": [
      "server/zz-reach2/architecture/archi-context-core-level0.md",
      "server/zz-reach2/architecture/mcp/archi-mcp.md"
    ],
    "fromJson": true
  }
}
```

**Reconstructed from MD (legacy agents):**
```json
{
  "agent": {
    "projectName": "Context Core Server",
    "agentName": "cxc-ui-worker",
    "description": "Work with the Context Core UI.",
    "argument-hint": "A task to implement.",
    "tools": [],
    "agentKnowledge": [
      "../../visualizer/zz-reach2/architecture/archi-context-core-visualizer.md",
      "../../visualizer/zz-reach2/architecture/ui/archi-context-core-ui.md"
    ],
    "fromJson": false
  }
}
```

### 5.5 Error Cases

| Condition                     | HTTP | Response                                                              |
| ----------------------------- | ---- | --------------------------------------------------------------------- |
| AgentBuilder not configured   | 404  | `{ error: "AgentBuilder not available (no dataSources configured)" }` |
| `path` query param missing    | 400  | `{ error: "path query parameter is required" }`                       |
| `path` not found in index     | 404  | `{ error: "Agent not found in index: ..." }`                          |
| File cannot be read from disk | 500  | `{ error: "Failed to read agent file: ..." }`                         |

### 5.6 Security Note

The path is validated against the in-memory index before any disk read. This prevents path traversal — only files that were indexed from legitimate `agentPath` directories can be retrieved.

### 5.7 Endpoint Registration — `ContextServer.ts`

```typescript
app.get("/api/agent-builder/get-agent", (req, res) =>
{
  if (!agentBuilder) {
    res.status(404).json({ error: "AgentBuilder not available (no dataSources configured)" });
    return;
  }

  const agentPath = typeof req.query.path === "string" ? req.query.path.trim() : "";
  if (!agentPath) {
    res.status(400).json({ error: "path query parameter is required" });
    return;
  }

  try {
    res.json(agentBuilder.getAgent(agentPath));
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500;
    res.status(status).json({ error: (error as Error).message });
  }
});
```

---

## 6. File Layout After Changes

```
{agentPath}/
├── cxc-ui-worker.agent.md        ← legacy (no JSON companion)
├── cxc-server-worker.agent.md    ← generated by /create
└── cxc-server-worker.agent.json  ← NEW: saved by /create alongside the MD
```

---

## 7. Summary of `AgentBuilder` Method Changes

| Method           | Status               | Description                                                                                       |
| ---------------- | -------------------- | ------------------------------------------------------------------------------------------------- |
| `index()`        | Existing, no changes | Indexes all files including `.agent.json` files                                                   |
| `prepare()`      | Existing, no changes | Returns full file listing (no change in behavior)                                                 |
| `create()`       | **Modified**         | Now also writes `.agent.json` + adds it to index                                                  |
| `list()`         | **New**              | Returns all `.agent.md` agents with name, path, description, hint, excerpt                        |
| `getAgent(path)` | **New**              | Returns structured JSON for a single agent (from `.agent.json` or reconstructed from `.agent.md`) |

Helper additions:
| Function                                     | Scope          | Description                                                                       |
| -------------------------------------------- | -------------- | --------------------------------------------------------------------------------- |
| `parseFrontmatter(content)`                  | Private/module | Extracts key-value pairs from `---` fenced YAML frontmatter                       |
| `reconstructAgentInput(content, sourceName)` | Private/module | Rebuilds `CreateAgentInput` from `.agent.md` content (fallback for legacy agents) |

---

## 8. Execution Checklist

Tasks are grouped by difficulty and sorted chronologically within each group.

### Group A — Interfaces & Type Scaffolding

{{SIMPLE}}

- [x] Add `AgentListEntry` and `AgentListResponse` interfaces to `AgentBuilder.ts` (§4.2)
- [x] Add `AgentDefinition` interface (extends `CreateAgentInput` with `fromJson: boolean`) to `AgentBuilder.ts` (§5.3)
- [x] Add `GetAgentResponse` interface (`{ agent: AgentDefinition }`) to `AgentBuilder.ts` (§5.3)

### Group B — Simple Helpers & Wiring

{{SIMPLE}}

- [x] Implement `parseFrontmatter(content)` module-level helper function in `AgentBuilder.ts` (§4.2)
- [x] Modify `create()` to write `.agent.json` alongside `.agent.md` using `writeFileSync` (§3.3)
- [x] Modify `create()` to add the `.agent.json` file to the in-memory index after writing (§3.3)
- [x] Register `GET /api/agent-builder/list` endpoint in `ContextServer.ts` — guard with `agentBuilder` null check, delegate to `agentBuilder.list()` (§4.4)
- [x] Register `GET /api/agent-builder/get-agent` endpoint in `ContextServer.ts` — validate `path` query param, delegate to `agentBuilder.getAgent()`, map thrown errors to HTTP status codes (§5.7)

### Group C — Core Logic

{{MEDIUM}}

- [x] Implement `list()` method on `AgentBuilder` — filter index for `.agent.md` with `origin: "agent"`, resolve metadata from companion JSON or frontmatter fallback, return `AgentListResponse` (§4.2)
- [x] Implement `reconstructAgentInput(content, sourceName)` helper — parse frontmatter, tools line (active and commented), body knowledge links, return `CreateAgentInput` (§5.3)
- [x] Implement `getAgent(path)` method on `AgentBuilder` — validate path against index, try `.agent.json` first, fall back to `reconstructAgentInput`, return `GetAgentResponse` with `fromJson` flag (§5.3)

### Group D — Validation

{{SIMPLE}}

- [ ] Test: start server, call `GET /api/agent-builder/list`, verify response shape matches §4.3
- [ ] Test: call `GET /api/agent-builder/get-agent?path=...` for legacy agent (`cxc-ui-worker`), verify `fromJson: false` and reconstructed fields
- [ ] Test: call `POST /api/agent-builder/create` for a new agent, verify both `.agent.md` and `.agent.json` are written to disk
- [ ] Test: call `GET /api/agent-builder/get-agent?path=...` for the newly created agent, verify `fromJson: true` and fields match the create payload
