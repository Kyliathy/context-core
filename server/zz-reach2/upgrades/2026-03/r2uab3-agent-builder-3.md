# Agent Builder Phase 3 — Multi-Platform Agent Creation

**Date**: 2026-03-20
**Scope**: Add `platform` field to `CreateAgentInput`; implement Claude-specific agent file generation alongside the existing GitHub Copilot format.
**Files touched (backend)**: `AgentBuilder.ts`, `types.ts` (server), `ContextServer.ts`
**Files touched (UI — handled separately)**: `AgentBasket.tsx`, `api/search.ts`, `types.ts` (visualizer)

---

## 1. Background

The AgentBuilder currently creates two files per agent:

| File | Purpose |
|---|---|
| `{agentPath}/{agentName}.agent.md` | Runtime artifact consumed by GitHub Copilot / VS Code |
| `{agentPath}/{agentName}.agent.json` | Structured source-of-truth for lossless round-trip editing |

We now need to support a second platform: **Claude Code**. Claude Code sub-agents live in `.claude/agents/` at the project root as plain `.md` files with a different frontmatter schema.

---

## 2. Target File Formats

### 2.1 GitHub Copilot (existing — unchanged)

```markdown
---
name: my-agent
description: What this agent does.
argument-hint: A task to implement.
tools: ['read', 'edit', 'search']
---

To get context for your task, you MUST read the following files:

- [path/to/file.md](path/to/file.md)
```

### 2.2 Claude Code (new)

```markdown
---
name: my-agent
description: What this agent does and when to invoke it.
---

To get context for your task, you MUST read the following files:

- [path/to/file.md](path/to/file.md)
```

Key differences from GitHub format:
- **No `argument-hint`** in frontmatter (Claude doesn't use it)
- **No `tools`** in frontmatter
- **File extension**: `.md` (not `.agent.md`)
- **Output directory**: `{claudeAgentPath}/{agentName}.md`

---

## 3. Configuration — `claudeAgentPath`

Add an optional `claudeAgentPath` field to `DataSourceEntry` in `types.ts`:

```typescript
export interface DataSourceEntry {
  path: string;
  agentPath?: string;       // existing — .github/agents/
  claudeAgentPath?: string; // NEW — .claude/agents/
  name: string;
  type: string;
  purpose: string;
}
```

**Fallback derivation** when `claudeAgentPath` is absent but platform `"claude"` is requested:
- Go up two directory levels from `agentPath` (which is typically `{root}/.github/agents`), then append `.claude/agents`.
- Concretely: `dirname(dirname(agentPath)) + "/.claude/agents"`
- If `agentPath` is also absent, throw `400 – No claudeAgentPath configured`.

Example `cc.json` after change:

```json
{
  "path": "D:\\...\\server\\zz-reach2",
  "agentPath": "D:\\...\\.github\\agents",
  "claudeAgentPath": "D:\\...\\.claude\\agents",
  "name": "Context Core Server",
  "type": "Reach2 Architectural Repo",
  "purpose": "AgentBuilder"
}
```

---

## 4. Implementation Plan

> **Status**: Groups A–E implemented. Group F (UI) is handled separately.

### Group A — Type changes ✓

**A1 — `CreateAgentInput` in `AgentBuilder.ts`**

Add `platform` as a **required** field:

```typescript
export interface CreateAgentInput {
  projectName: string;
  agentName: string;
  description: string;
  "argument-hint": string;
  tools?: string[];
  agentKnowledge: string[];
  platform: "github" | "claude";   // NEW — mandatory
}
```

`AgentDefinition extends CreateAgentInput` — inherits `platform` automatically.

**A2 — `DataSourceEntry` in `types.ts`**

Add `claudeAgentPath?: string` as shown in §3.

---

### Group B — Server validation (`ContextServer.ts`) ✓

In the `POST /api/agent-builder/create` handler, add `platform` to the existing required-field check:

```
if (!projectName || !agentName || !description || !argumentHint || !platform) {
  return res.status(400).json({ error: "Missing required fields: projectName, agentName, description, argument-hint, platform" });
}
if (platform !== "github" && platform !== "claude") {
  return res.status(400).json({ error: "platform must be \"github\" or \"claude\"" });
}
```

Same validation applies to the `POST /api/agent-builder/add-template` handler (templates should also carry platform).

---

### Group C — `create()` method branching (`AgentBuilder.ts`) ✓

Replace the single write path with a branch:

```
create(input):
  validate projectName → source
  if platform === "github":
    → existing logic (writes .agent.md + .agent.json to source.agentPath)
  else if platform === "claude":
    → new logic (writes .md + .agent.json to claudeAgentPath)
```

**C1 — Resolve `claudeAgentPath`**

```typescript
function resolveClaudeAgentPath(source: DataSourceEntry): string {
  if (source.claudeAgentPath) return source.claudeAgentPath;
  if (!source.agentPath) throw Object.assign(
    new Error(`Data source "${source.name}" has no claudeAgentPath or agentPath configured`),
    { status: 400 }
  );
  // Derive: up two levels from .github/agents → project root → .claude/agents
  const projectRoot = dirname(dirname(source.agentPath));
  return join(projectRoot, ".claude", "agents");
}
```

**C2 — Claude `.md` file content builder**

```typescript
function buildClaudeAgentContent(input: CreateAgentInput): string {
  const knowledgeLines = input.agentKnowledge.length > 0
    ? [
        "To get context for your task, you MUST read the following files:",
        "",
        ...input.agentKnowledge.map((p) => `- [${p}](${p})`),
      ]
    : [];

  return [
    "---",
    `name: ${input.agentName}`,
    `description: ${input.description}`,
    "---",
    "",
    ...knowledgeLines,
    "",
  ].join("\n");
}
```

**C3 — Write files**

For `"claude"` platform:
- `mdAbsPath` = `{claudeAgentPath}/{agentName}.md`  (no `.agent.` infix)
- `jsonAbsPath` = `{claudeAgentPath}/{agentName}.agent.json`  (companion unchanged)
- Write `.md` with `buildClaudeAgentContent()`
- Write `.agent.json` with same payload as GitHub path (includes `platform: "claude"`)

**C4 — Index update**

After writing, add both files to `indexedFiles` with `origin: "agent"`. The `isAgentMdPath()` predicate currently filters on `.agent.md` — it must NOT be used to filter Claude files. The origin field is the reliable discriminator.

---

### Group D — `collectFiles()` traversal — allow `.claude` ✓

Currently, `collectFiles()` skips hidden directories except `.github`:

```typescript
if (entry.startsWith(".") && entry !== ".github") continue;
```

Change to also allow `.claude`:

```typescript
const ALLOWED_HIDDEN_DIRS = new Set([".github", ".claude"]);
if (entry.startsWith(".") && !ALLOWED_HIDDEN_DIRS.has(entry)) continue;
```

This ensures that if `agentPath` or `claudeAgentPath` lives inside a `.claude` directory, or if the data source `path` contains `.claude/agents/*.md`, those files are indexed.

---

### Group E — `list()` and `getAgent()` updates ✓

**E1 — `list()`**

Currently filters on `isAgentMdPath()` (requires `.agent.md`). Claude agents are plain `.md` files. New filter:

```typescript
function isAgentFile(f: IndexedFile): boolean {
  return f.origin === "agent" && (
    isAgentMdPath(f.absolutePath) ||       // GitHub: .agent.md
    isClaudeAgentMdPath(f.absolutePath)     // Claude: .md inside .claude/agents/
  );
}

function isClaudeAgentMdPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.includes("/.claude/agents/") && normalized.toLowerCase().endsWith(".md");
}
```

For the `AgentListEntry` enrichment, check `.agent.json` companion for both formats (the companion naming is the same).

**E2 — `getAgent()`**

Currently validates `isAgentMdPath(agentPath)`. Relax to accept either format:

```typescript
if (!agentPath || (!isAgentMdPath(agentPath) && !isClaudeAgentMdPath(agentPath))) {
  throw Object.assign(new Error("path must point to a .agent.md or Claude .md agent file"), { status: 400 });
}
```

Index lookup already uses `f.origin === "agent"` — no other change needed there.

**E3 — `getAgentNameFromPath()`**

Currently strips `.agent.md`. For Claude files (plain `.md`), strip `.md`:

```typescript
function getAgentNameFromPath(agentMdPath: string): string {
  const normalized = agentMdPath.replace(/\\/g, "/");
  const fileName = normalized.split("/").pop() ?? normalized;
  if (fileName.endsWith(".agent.md")) return fileName.slice(0, -".agent.md".length);
  if (fileName.endsWith(".md")) return fileName.slice(0, -".md".length);
  return fileName;
}
```

**E4 — `reconstructAgentInput()`**

For Claude agents loaded without a JSON companion, the reconstruction is the same as GitHub (frontmatter + knowledge links). `argument-hint` and `tools` will just be empty. Add `platform: "claude"` via the `isClaudeAgentMdPath()` check in the caller.

---

### Group F — UI changes (`AgentBasket.tsx`, `types.ts`, `api/search.ts`) — handled separately

**F1 — `AgentKnowledgeEntry` and `CreateAgentInput` mirror in `visualizer/src/types.ts`**

Add `platform: "github" | "claude"` to the mirrored `CreateAgentInput`.

**F2 — `AgentBasket.tsx` — platform selector**

Add a `platform` field to the form, rendered as a two-option selector (radio or dropdown):

| Label | Value |
|---|---|
| GitHub Copilot | `github` |
| Claude Code | `claude` |

- Default: `"github"` (backward compatible)
- In edit mode: pre-populate from `initialValues.platform`
- Include in the payload sent to `fetchAgentBuilderCreate()`

**F3 — `fetchAgentBuilderCreate()` in `api/search.ts`**

No signature change needed — the input type already flows through. Just verify the `platform` field is included in the POST body.

---

## 5. Error Cases

| Condition | HTTP | Where |
|---|---|---|
| `platform` absent or not `"github"`/`"claude"` | 400 | `ContextServer` |
| platform `"claude"` but no `claudeAgentPath` derivable | 400 | `AgentBuilder.create()` |
| platform `"claude"` but `agentPath` also absent | 400 | `AgentBuilder.create()` |

---

## 6. File Output Summary

| Platform | Agent file | Companion JSON |
|---|---|---|
| `github` | `{agentPath}/{name}.agent.md` | `{agentPath}/{name}.agent.json` |
| `claude` | `{claudeAgentPath}/{name}.md` | `{claudeAgentPath}/{name}.agent.json` |

The companion `.agent.json` is identical in structure for both platforms — it now also stores `platform` so round-trips are lossless.

---

## 7. Out of Scope

- Template (`addTemplate` / `listTemplates`) changes beyond adding `platform` to the payload — that is a separate concern.
- Deleting agents via the API.
- Syncing between platforms (creating both formats simultaneously).
