# r2ca-codex-agents - OpenAI Codex (VS Code) Agent File Generation

**Date:** 2026-04-09  
**Status:** Implemented for baseline Codex support (batches 1–6) and Phase B multi-agent Codex collections (batches 7–11 + docs), with manual UI smoke still pending  
**Scope:** AgentBuilder server + visualizer support for OpenAI Codex instruction files, plus planned multi-agent/directory targeting extension

---

## 1) Goal

Add a third output platform to AgentBuilder so users can generate files Codex discovers in VS Code using OpenAI `AGENTS.md` conventions.

Current platforms:

- `github` -> `.agent.md` + `.agent.json`
- `claude` -> `.md` + `.json` under `.claude/agents`

New platform:

- `codex` -> `AGENTS.md` + `AGENTS.json`

---

## 2) Inputs Used

Architecture context:

- [archi-context-core-level0.md](../../architecture/archi-context-core-level0.md)
- [archi-agent-builder.md](../../architecture/agents/archi-agent-builder.md)
- [archi-agent-builder-ui.md](../../../../visualizer/zz-reach2/architecture/agents/archi-agent-builder-ui.md)

OpenAI source:

- https://developers.openai.com/codex/guides/agents-md

---

## 3) Key Constraints from OpenAI AGENTS.md

- Codex discovers `AGENTS.md` / `AGENTS.override.md` by directory hierarchy and precedence.
- Instructions are merged from root to cwd and capped by byte limit (`project_doc_max_bytes`, default 32 KiB).
- Custom filenames are not auto-discovered unless explicitly configured as fallbacks.

Implementation consequence:

- The Codex target in AgentBuilder must output recognized AGENTS filenames.

---

## 4) Chronological Task Plan (Difficulty-batched)

### Batch 01
{{SIMPLE}}
- [x] T01 Confirm baseline branch state and capture current behavior for `github` + `claude` create/list/get-agent flows.
- [x] T02 Snapshot current type contracts in `server/src/types.ts`, `server/src/agentBuilder/AgentBuilder.ts`, and `visualizer/src/types.ts`.
- [x] T03 Add `codexAgentPath?: string` to `DataSourceEntry` server type definitions.
- [x] T04 Extend platform unions from `"github" | "claude"` to `"github" | "claude" | "codex"` in shared server and visualizer types.
- [x] T05 Update route validation in `POST /api/agent-builder/create` to accept `platform: "codex"`.
- [x] T06 Add Codex filename constants (`AGENTS.md`, `AGENTS.override.md`, `AGENTS.json`) in AgentBuilder.
- [x] T07 Add a short in-file comment block documenting why Codex output must use AGENTS filenames.

### Batch 02
{{MEDIUM}}
- [x] T08 Implement `resolveCodexAgentPath(source)` with precedence: `source.codexAgentPath`, then inferred repo root from `agentPath` (`.github/agents`), then fallback `source.path`.
- [x] T09 Implement `isCodexAgentsMdPath(path)` and `isCodexOverrideMdPath(path)` helpers.
- [x] T10 Extend `toAgentJsonPath()` to map Codex paths (`AGENTS.md -> AGENTS.json`, `AGENTS.override.md -> AGENTS.override.json`).
- [x] T11 Extend `getAgentNameFromPath()` so Codex artifacts map to stable agent names (for list display and edit round-trip).
- [x] T12 Implement `buildCodexAgentContent(input)` that renders description, argument-hint intent, tools, and knowledge entries.
- [x] T13 Add Codex create branch in `create()` that writes `AGENTS.md` + companion JSON to resolved Codex target directory.
- [x] T14 Add generated-file marker (for ownership detection) into Codex output content.
- [x] T15 Ensure create response path and in-memory index updates stay consistent for Codex writes.

### Batch 03
{{HARD}}
- [x] T16 Extend startup indexing (`index()`) to include Codex agent directories without duplicating files already seen.
- [x] T17 Extend incremental refresh (`refreshAgentEntriesFromDisk()`) to include Codex AGENTS files and preserve dedup guarantees.
- [x] T18 Update list filtering so `list()` includes Codex AGENTS artifacts as agent entries.
- [x] T19 Update `getAgent()` path validation to accept Codex AGENTS file patterns while preserving traversal safety.
- [x] T20 Update JSON-first parsing in `getAgent()` to infer/return `platform: "codex"` for Codex files.
- [x] T21 Extend markdown reconstruction fallback to return valid Codex `AgentDefinition` when companion JSON is absent.
- [x] T22 Implement unmanaged-file overwrite safety: backup existing non-CXC `AGENTS.md` before write.

### Batch 04
{{MEDIUM}}
- [x] T23 Add Codex option to AgentBuilder UI platform selector: `OpenAI Codex (VS Code)`.
- [x] T24 Extend localStorage platform selection logic to persist and restore Codex alongside existing platforms.
- [x] T25 Ensure multi-platform create submits Codex payloads through existing per-platform create loop.
- [x] T26 Ensure edit mode hydration supports Codex in `initialValues.platform` and save path.
- [x] T27 Update user-facing helper text/tooltips to mention Codex output file as `AGENTS.md`.
- [x] T28 Verify `fetchAgentBuilderCreate` and typed request/response contracts compile with Codex enum.
- [x] T29 Verify agent-list cards and edit-entry flow work for Codex-created agents.
- [ ] T30 Run a manual UI smoke flow for create -> list -> edit -> save with Codex selected.

### Batch 05
{{HARD}}
- [x] T31 Add or extend server tests for `create(platform="codex")` writing `AGENTS.md` + `AGENTS.json`.
- [x] T32 Add tests for route validation acceptance/rejection matrix (`github`, `claude`, `codex`, invalid values).
- [x] T33 Add tests for `list()` inclusion of Codex AGENTS entries.
- [x] T34 Add tests for `getAgent()` JSON-first and markdown-fallback behavior on Codex files.
- [x] T35 Add tests for unmanaged `AGENTS.md` backup creation before overwrite.
- [x] T36 Add overlap-path dedup test where Codex path intersects indexed content path.
- [x] T37 Run full relevant server test suites and fix regressions.
- [x] T38 Run visualizer type-check/build validation after platform enum expansion.

### Batch 06
{{SIMPLE}}
- [x] T39 Update `archi-agent-builder.md` with Codex platform outputs, path rules, and API contract updates.
- [x] T40 Update `archi-agent-builder-ui.md` with Codex UI selector behavior and edit/create flows.
- [x] T41 Update `archi-context-core-level0.md` module inventory and capability summary for Codex support.
- [x] T42 Add a `cc.json` configuration snippet documenting optional `codexAgentPath` usage.
- [x] T43 Add release notes section summarizing backward compatibility and migration impact.
- [x] T44 Execute acceptance checklist and record pass/fail for each criterion.

---

## 5) Acceptance Checklist

- [x] AC01 UI shows Codex as a third platform option. **PASS**
- [x] AC02 Codex create writes `AGENTS.md` + companion JSON in resolved target directory. **PASS**
- [x] AC03 `/api/agent-builder/list` includes Codex entries. **PASS**
- [x] AC04 `/api/agent-builder/get-agent` can load Codex entries from JSON and markdown fallback. **PASS**
- [x] AC05 Existing GitHub and Claude behavior remains unchanged. **PASS**
- [x] AC06 Unmanaged AGENTS overwrite creates backup before replacement. **PASS**
- [x] AC07 Generated Codex file naming is compatible with OpenAI `agents-md` discovery behavior. **PASS**

---

## 6) Suggested Execution Order

Execute tasks strictly by task id (`T01` -> `T44`) and do not skip model switches between batches.

---

## 7) cc.json Snippet (Codex Paths)

```json
{
  "machine": "DEVBOX1",
  "harnesses": { "...": { "paths": [] } },
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
        "codexAgentPaths": [
          "D:\\Codez\\Nexus\\Reach2\\context-core\\server\\zz-reach2",
          "D:\\Codez\\Nexus\\Reach2\\context-core\\visualizer\\zz-reach2"
        ],
        "codexAgentPath": "D:\\Codez\\Nexus\\Reach2\\context-core\\visualizer\\zz-reach2",
        "name": "Context Core Front",
        "type": "Reach2 Architectural Repo",
        "purpose": "AgentBuilder"
      }
    ]
  }
}
```

Default Codex path resolution:

1. Explicit selected `codexDirectory` from request payload.
2. `codexAgentPaths[]` entries (ordered).
3. `codexAgentPath` (legacy single-path fallback).
4. Inferred repo root from `agentPath` when it matches `.github/agents` (two levels up).
5. Fallback to `path`.

---

## 8) Release Notes

### Added

- Codex platform support in AgentBuilder (`platform: "codex"`).
- Codex output generation: `AGENTS.md` + `AGENTS.json`.
- Codex collection model (`AGENTS.json` v2 with `agents[]`) and marker-based multi-entry `AGENTS.md`.
- Codex AGENTS indexing, listing, retrieval, and markdown fallback reconstruction.
- Codex overwrite safety for unmanaged `AGENTS.md` via timestamped backups.
- Atomic safe-write strategy (temp file + rename) for Codex collection updates.
- UI platform selector includes `OpenAI Codex (VS Code)`.
- UI Codex directory selector + per-source directory persistence in localStorage.
- New server tests for Codex create/list/get/backup and route platform validation.

### Changed

- `DataSourceEntry` now supports optional `codexAgentPath`.
- `DataSourceEntry` now supports optional `codexAgentPaths`.
- Codex path inference now derives from `agentPath` when it points to `.github/agents`.
- Codex list/get/edit now work per logical entry (`path + codexEntryId`) instead of one card per file.
- Agent path validation now supports GitHub, Claude, and Codex path families.

### Backward Compatibility

- GitHub and Claude flows remain supported without configuration changes.
- Existing `.agent.md` and `.claude/agents/*.md` content remains readable/editable.
- Existing single-entry Codex JSON payloads are auto-adapted to v2 in memory.
- `codexAgentPath` remains optional; `codexAgentPaths` is additive.

---

## 9) Phase B Goal (Multi-Agent Codex Collections)

Support storing and editing multiple logical Codex agents in the same `AGENTS.md`/`AGENTS.json` pair, while listing/editing them as separate cards in the UI.

Planned outcomes:

- Codex JSON companion evolves from single-agent payload to an `agents[]` structure.
- Agent list/edit works per Codex agent entry (not one card per file).
- Codex output directory selection supports multiple configured directories via `codexAgentPaths`.
- UI source selector for Codex is renamed from "project" semantics to directory semantics.

### 9.1 Baseline Limitations (Before Phase B)

- Single-entry overwrite risk: saving one Codex agent replaced the full `AGENTS.md` content and could drop sibling entries.
- List ambiguity: one AGENTS file produced one card, even when it semantically contained multiple agents.
- Edit ambiguity: `get-agent` accepted only `path`, so one specific Codex entry could not be targeted.
- Directory ambiguity: only one `codexAgentPath` could be configured; no explicit per-save directory targeting existed.

### 9.2 Compatibility Matrix

| Flow | Before Phase B | After Phase B |
| --- | --- | --- |
| GitHub create/list/get/edit | Supported | Unchanged |
| Claude create/list/get/edit | Supported | Unchanged |
| Codex create | Single logical agent per AGENTS file write | Upsert one logical entry into AGENTS collection |
| Codex list | One card per AGENTS file | One card per Codex entry |
| Codex get-agent | `path` only | `path + codexEntryId` (required when file has multiple entries) |
| Codex config targets | `codexAgentPath` only | `codexAgentPaths[]` + legacy `codexAgentPath` |

---

## 10) Phase B Chronological Task Plan (Difficulty-batched)

### Batch 07
{{SIMPLE}}
- [x] T45 Document current single-entry Codex limitations in create/list/get/edit flows with concrete examples.
- [x] T46 Define `AGENTS.json` v2 schema for Codex with `agents[]` and stable per-entry identifier.
- [x] T47 Define deterministic markdown section format for multiple Codex agents in one `AGENTS.md`.
- [x] T48 Define legacy migration strategy: single-agent JSON payload -> `agents[]` payload.
- [x] T49 Introduce config target model decision: keep `codexAgentPath` backward-compatible while adding `codexAgentPaths?: string[]`.
- [x] T50 Define API contract change for retrieving one Codex entry (e.g. `path + codexEntryId`).
- [x] T51 Define UI terminology update: rename Codex-facing "project" selection to "directory".
- [x] T52 Add compatibility matrix covering GitHub/Claude unchanged behavior versus new Codex behavior.

### Batch 08
{{MEDIUM}}
- [x] T53 Implement Codex v2 JSON types and runtime validation helpers in server models.
- [x] T54 Implement legacy adapter that reads existing single-agent `AGENTS.json` into v2 in-memory structure.
- [x] T55 Implement Codex markdown multi-entry renderer from `agents[]` with stable section ordering.
- [x] T56 Implement Codex markdown parser fallback that can reconstruct one entry by `codexEntryId` when JSON companion is absent.
- [x] T57 Implement stable Codex entry ID generation/normalization and collision handling.
- [x] T58 Refactor `create(platform=\"codex\")` to upsert a single entry into existing Codex collection instead of replacing all entries.
- [x] T59 Preserve unmanaged-file backup behavior while avoiding repeated backups on CXC-managed subsequent updates.
- [x] T60 Add safe write strategy for Codex collection updates (temp file + replace) to reduce partial-write risk.

### Batch 09
{{HARD}}
- [x] T61 Refactor `list()` to explode one Codex file into multiple list entries (one per `agents[]` item).
- [x] T62 Extend `AgentListEntry` and related UI payloads with Codex entry identity (`codexEntryId`) to disambiguate cards.
- [x] T63 Refactor `getAgent()` and route handling to resolve one Codex entry by `path + codexEntryId`.
- [x] T64 Refactor Codex edit/save flow so updating one entry preserves sibling entries in same file.
- [x] T65 Extend index/refresh caching to maintain per-entry metadata while preserving file-level dedup behavior.
- [x] T66 Handle edge cases where codex entry IDs are missing/duplicated in legacy files with deterministic recovery.
- [x] T67 Add explicit behavior for entry rename (ID retained vs regenerated) and enforce it consistently.
- [x] T68 Verify GitHub/Claude list/get/edit paths are unaffected by Codex collection changes.

### Batch 10
{{MEDIUM}}
- [x] T69 Add `codexAgentPaths?: string[]` to `DataSourceEntry` types and config loading.
- [x] T70 Implement Codex directory resolver precedence: selected directory -> `codexAgentPaths` -> `codexAgentPath` -> inferred-from-`agentPath` -> `path`.
- [x] T71 Extend prepare payload to return available Codex directories for each source.
- [x] T72 Update create payload and route validation to require/validate selected directory when multiple Codex directories exist.
- [x] T73 Update AgentBuilder UI selector model for Codex to choose directory target explicitly.
- [x] T74 Rename/create UI labels from project-centric wording to directory-centric wording for Codex flows.
- [x] T75 Persist per-source Codex directory selection in localStorage and restore safely.
- [x] T76 Add clear server/client validation errors for invalid or unauthorized Codex target directory selections.

### Batch 11
{{HARD}}
- [x] T77 Add unit tests for Codex v2 schema validation, legacy adapter, and entry ID normalization.
- [x] T78 Add server tests for Codex multi-entry create/upsert preserving sibling entries.
- [x] T79 Add server tests for list fan-out (N Codex entries from one AGENTS file -> N list cards).
- [x] T80 Add server tests for `getAgent(path, codexEntryId)` JSON-first + markdown fallback behavior.
- [x] T81 Add route tests for directory-target validation with `codexAgentPaths`.
- [x] T82 Add regression tests for backward compatibility of legacy single-entry Codex files.
- [x] T83 Add regression tests ensuring GitHub/Claude list/get/edit/create remain unchanged.
- [x] T84 Run full server + visualizer test/type/build suites and fix regressions.

### Batch 12
{{SIMPLE}}
- [x] T85 Update `archi-agent-builder.md` with Codex multi-entry model, per-entry identity, and directory selection rules.
- [x] T86 Update `archi-agent-builder-ui.md` with Codex directory selector UX and per-entry edit semantics.
- [x] T87 Update `archi-context-core-level0.md` capability notes for Codex collection support.
- [x] T88 Update upgrade docs and `cc.json` snippets to document `codexAgentPaths` and fallback precedence.
- [x] T89 Add migration notes for existing repositories with single-entry `AGENTS.json`.
- [ ] T90 Execute manual smoke suite: create 3 Codex entries in one directory, list as separate cards, edit each independently.
- [x] T91 Re-run acceptance checklist and record pass/fail outcomes.

---

## 11) Phase B Acceptance Checklist (Executed)

- [x] AC08 Codex companion JSON supports `agents[]` and remains backward-compatible with legacy single-entry files. **PASS**
- [x] AC09 One Codex `AGENTS.md` file can represent multiple logical agents; list shows one card per logical agent. **PASS**
- [x] AC10 Editing one Codex logical agent does not overwrite or remove sibling entries in the same directory file. **PASS**
- [x] AC11 `get-agent` resolves a specific Codex logical agent by identity (not only by file path). **PASS**
- [x] AC12 Config supports multiple Codex target directories per source (`codexAgentPaths`) with deterministic fallback. **PASS**
- [x] AC13 UI allows explicit Codex directory selection and uses directory-oriented labels. **PASS**
- [x] AC14 Existing GitHub and Claude flows are unaffected. **PASS**
- [x] AC15 Existing single-entry Codex artifacts continue to load and can be migrated safely. **PASS**

---

## 12) Migration Notes (Legacy Codex Files)

- Existing single-entry `AGENTS.json` payloads are read as legacy and adapted into v2 in memory (`agents[]` with a stable generated id).
- Existing `AGENTS.md` without JSON remains readable through markdown reconstruction fallback.
- Legacy entries with missing or duplicate ids are normalized to deterministic unique slugs (for example `dup`, `dup-2`, `third-agent`).
- First save after migration rewrites both `AGENTS.md` and `AGENTS.json` in v2 collection format while preserving logical entry content.
- Non-CXC managed `AGENTS.md` files still receive one timestamped backup before first overwrite.

Outstanding:

- Manual smoke task `T90` is still open (UI-driven validation of create/list/edit across three Codex entries in one directory).
