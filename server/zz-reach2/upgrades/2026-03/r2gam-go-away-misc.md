# R2GAM – Go Away MISC

**Date**: 2026-03-21  
**Scope**: Eliminate blind MISC project assignments in Cursor and Kiro harnesses  
**Status**: In Progress (Phases 1–3 complete; Phase 4 new; Phases 5–6 pending)  
**Modules**: `src/harness/cursor.ts`, `src/harness/kiro.ts`, `src/harness/index.ts`, `src/ContextCore.ts`

---

## 1. Problem Statement

Both the Cursor and Kiro harnesses fall back to `project = "MISC"` when their rule cascades fail to match.  This loses project provenance and pollutes the storage tree with an opaque catch-all bucket.

The root cause is the same in both harnesses — `workspacePathToProject()` (Cursor) and `resolveKiroProjectFromPaths()` (Kiro) return `MISC` when:

1. **No workspace path is found** at all for the session (zero candidates survive the inference pipeline).
2. **A workspace path exists but no rule matches** — neither `projectMappingRules` nor `genericProjectMappingRules` contain an entry whose `path` substring appears in the candidate.

When (2) occurs the system already *has* a useful workspace path (e.g. `D:\Codez\SomeNewProject\src\app.ts`) but discards it because the user never configured a matching rule.

### 1.1 Remaining Problem: Bad Workspace Path Derivation

Even with the Phase 2 auto-derived fallback, the Cursor harness still produces **bad project names** from garbage workspace paths.  The current `inferCursorWorkspaceBySession()` collects path hints exclusively from bubble text and scattered `cursorDiskKV` rows.  This produces noise paths extracted from code snippets rather than actual workspace context:

```
session 6198bcf1... → derived "Lands" from /gfx/Lands
session a4d0be81... → derived "factory" from /source/ndk/factory
session bc93f6f0... → derived "nclass" from \r\nclass
session a69816f8... → derived "tprivate" from \r\n\tprivate
session 5219353d... → derived "r" from t:\r\n\r\n\r
session e75007bc... → derived "untitled" from /**
```

The auto-derived fallback works correctly — the problem is **upstream**: the workspace path being fed to it is wrong.

---

## 2. Investigation: What Data Is Available for MISC Sessions?

### 2.1 Cursor — Current Sources (Already Used)

When MISC is assigned in the bubble pipeline, the system already computed a **best workspace path** via `chooseBestWorkspacePath()`.  That path went into `workspacePathToProject()` and fell through both rule passes.

| Data                                       | Source                                                                                                                 | Available?                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Best workspace path** (directory)        | `chooseBestWorkspacePath(sessionCounter)` → normalized root                                                            | **Yes** — this is the input to `workspacePathToProject()`                 |
| **All workspace path candidates + counts** | `sessionHintCounts` map (path → frequency per session)                                                                 | **Yes** — the full scored set exists in `inferCursorWorkspaceBySession()` |
| **Bubble context paths**                   | `CursorBubbleRecord.context[]` — file paths extracted from message text, `parsed.context`, `codeBlocks`, `toolResults` | **Yes** — aggregated in `bubbleContextBySession`                          |
| **composerData workspace hints**           | Keys collected from `collectWorkspaceHints()` on all `cursorDiskKV` rows                                               | **Yes** — fed into `sessionHintCounts`                                    |
| **Session ID**                             | From the `bubbleId:{sessionId}:*` key structure                                                                        | **Yes**                                                                   |
| **Model**                                  | From `sessionModelMap` or `pickModel()`                                                                                | **Yes**                                                                   |

### 2.2 Cursor — Newly Discovered Sources (NOT Yet Used)

Deep exploration of `state.vscdb` (2026-03-21) revealed **three untapped data sources** that contain authoritative workspace information, far more reliable than mining bubble text.

**Database structure**: Two tables — `ItemTable` (690 rows) and `cursorDiskKV` (46,876 rows).  
**Key prefix breakdown** in `cursorDiskKV`:

| Prefix                      | Count  | Used by Harness?     |
| --------------------------- | ------ | -------------------- |
| `bubbleId`                  | 25,774 | Yes                  |
| `agentKv`                   | 8,500  | No                   |
| `checkpointId`              | 5,250  | No                   |
| `codeBlockDiff`             | 3,620  | No                   |
| `messageRequestContext`     | 1,209  | **No ← NEW**         |
| `codeBlockPartialInline...` | 1,088  | No                   |
| `composerData`              | 574    | Partial (model only) |
| `composer.content.*`        | misc   | No                   |

#### Source A: `messageRequestContext:{sessionId}:{bubbleId}` → `projectLayouts` (BEST)

Each `messageRequestContext` entry is a JSON object containing a `projectLayouts` array.  Each layout entry contains:

- **`rootPath`**: The workspace folder name as displayed by Cursor (e.g. `"AXON"`, `"NexusPlatform"`)
- **`listDirV2Result.directoryTreeRoot.absPath`**: The **full absolute workspace path** (e.g. `"d:\Codez\Nexus\AXON"`)

This is the **definitive workspace-to-session mapping** that Cursor itself uses.  Multi-root workspaces produce multiple `projectLayouts` entries with all their roots listed.

**Verified on problem sessions:**

| Session                                   | projectLayouts `absPath`                      | Correct Project?      |
| ----------------------------------------- | --------------------------------------------- | --------------------- |
| `6198bcf1...` "Create Textures class"     | `d:\Codez\Nexus\AXON` (+ 3 more roots)        | **AXON** ✓            |
| `a4d0be81...` "Debugging random number"   | `d:\Codez\Nexus\Evo\NexusPlatform` (+ 5 more) | **NexusEvo** ✓        |
| `e7427259...` "Implement search function" | `d:\Codez\zEVO\karla-game-meta`               | **karla-game-meta** ✓ |

**Coverage**: 77 of 574 sessions (13%).  Appears to be a newer Cursor feature — older sessions lack `projectLayouts`.  Available for sessions with `messageRequestContext` entries (230 of 574), but only ~33% of those have the `projectLayouts` field.

#### Source B: `composerData:{sessionId}` → `originalFileStates` + `allAttachedFileCodeChunksUris` (GOOD)

Each `composerData` entry is a JSON object containing:

- **`originalFileStates`**: Object whose keys are full `file:///` URIs of files Cursor saved snapshots for (e.g. `file:///d%3A/Codez/Nexus/Evo/NexusDK/source/ndk/factory/TileMaker.hx`)
- **`allAttachedFileCodeChunksUris`**: Array of `file:///` URIs the user attached as context

These URIs encode the **actual files the user worked on** in that session, from which the workspace root can be extracted with high confidence.

**Verified on ALL 9 problem sessions:**

| Session                                   | File URIs point to                          | Should be             |
| ----------------------------------------- | ------------------------------------------- | --------------------- |
| `6198bcf1...` "Create Textures class"     | `d:\Codez\Nexus\AXON\src\...` (3 files)     | **AXON** ✓            |
| `a4d0be81...` "Debugging random number"   | `d:\Codez\Nexus\Evo\NexusDK\...` (7 files)  | **NexusEvo** ✓        |
| `d84b7c96...` "Check tileData reuse"      | `Evo\NexusDK` (2), `Evo\NexusPlatform` (1)  | **NexusEvo** ✓        |
| `bc93f6f0...` "Rename Maker classes"      | `Evo\NexusDK` (31), `Evo\NexusPlatform` (2) | **NexusEvo** ✓        |
| `a69816f8...` "Fixing visited status"     | `Evo\NexusDK` (2), `Evo\Kromyre` (1)        | **NexusEvo** ✓        |
| `4c2b2822...` "Handle incomplete routes"  | `Evo\NexusDK` (6 files)                     | **NexusEvo** ✓        |
| `5219353d...` "Fixing SFO in MapWarden"   | `Evo\NexusDK` (8), `Evo\NexusPlatform` (1)  | **NexusEvo** ✓        |
| `e75007bc...` "Remove route from origin"  | `Evo\NexusDK` (1), `Evo\Kromyre` (1)        | **NexusEvo** ✓        |
| `e7427259...` "Implement search function" | `d:\Codez\zEVO\karla-game-meta` (1)         | **karla-game-meta** ✓ |

**Coverage**: 251 of 574 sessions have `originalFileStates`; 228 have `allAttachedFileCodeChunksUris`.

#### Source C: Bubble text heuristics (CURRENT — Weakest)

This is what the harness does today.  It mines scattered path-like tokens from bubble `text`, `context`, `codeBlocks`, and `toolResults`.  The paths are often snippets of code containing `\r\n`, relative paths, or URL fragments — not real workspace paths.

### 2.3 Recommended Workspace Inference Priority

Layer the data sources, use the first one that yields a result:

1. **`projectLayouts` absPath** from `messageRequestContext` — definitive workspace root, no derivation needed
2. **File URI extraction** from `composerData.originalFileStates` + `allAttachedFileCodeChunksUris` — real file paths, workspace root extractable
3. **Bubble text heuristics** (current approach) — last resort, noisy

### 2.4 Kiro

When MISC is assigned, `resolveKiroProjectFromPaths()` received the full candidate set but no rule matched.

| Data                                       | Source                                                                               | Available?             |
| ------------------------------------------ | ------------------------------------------------------------------------------------ | ---------------------- |
| **Storage path** (Kiro workspace hash dir) | `storagePath` argument — e.g. `.../kiro.kiroagent/1582a63a37f5cbc148e58da75716b816/` | **Yes**                |
| **Chat file path**                         | `parsedFile.filePath`                                                                | **Yes**                |
| **staticDirectoryView**                    | First chat entry's `context[0].staticDirectoryView` — multi-line directory tree dump | **Yes** (when present) |
| **Path candidates from message text**      | `extractPathCandidates(text)` across all chat entries                                | **Yes**                |
| **Context paths**                          | `extractKiroContextPaths()` — filtered file references from message text             | **Yes**                |
| **Full project candidate set**             | The `projectCandidates` Set before it enters `resolveKiroProjectFromPaths()`         | **Yes**                |

---

## 3. Tasks

### Phase 1 — Diagnostic: Log MISC Sessions with Their Evidence ✅

**Goal**: After each harness ingestion, emit console warnings listing every session that resolved to MISC, along with the best workspace path or candidate paths that were available.

{{SIMPLE}}

- [x] **T1. Cursor — add `miscSessionPaths` field to `CursorWorkspaceInference` type**
- [x] **T2. Cursor — track MISC in `inferCursorWorkspaceBySession()`**
- [x] **T3. Cursor — also track sessions with zero candidates**
- [x] **T4. Cursor — emit warning block in `readCursorChats()`**

{{SIMPLE}}

- [x] **T5. Kiro — collect MISC session diagnostics in `readKiroChats()`**
- [x] **T6. Kiro — emit warning block after file loop**
- [x] **T7. Smoke test**

---

### Phase 2 — Automatic Best-Effort Project Derivation ✅

**Goal**: When MISC would be returned but a workspace path IS available, derive a project name from the last directory segment instead.

{{MEDIUM}}

- [x] **T8. Cursor — add last-segment fallback in `workspacePathToProject()`**
- [x] **T9. Kiro — add last-segment fallback in `resolveKiroProjectFromPaths()`**
- [x] **T10. Update diagnostic logging to distinguish "auto-derived" vs "true MISC"**
- [x] **T11. Regression test**

---

### Phase 3 — Interactive Rule Suggestion ✅

**Goal**: Print paste-ready `cc.json` snippets when MISC or auto-derived sessions exist.

{{MEDIUM}}

- [x] **T12. Generate paste-ready `cc.json` snippet in warning output**
- [x] **T13. Deduplicate suggested rules**

---

### Phase 4 — Cursor: Better Workspace Inference from Untapped DB Sources (NEW)

**Goal**: Replace the noisy bubble-text workspace heuristic with authoritative data from `messageRequestContext.projectLayouts` and `composerData.originalFileStates`/`allAttachedFileCodeChunksUris`.  This fixes the root cause of bad auto-derived names like `"Lands"`, `"nclass"`, `"tprivate"`, `"r"`.

{{SIMPLE}}

- [x] **T14. Add type `CursorProjectLayout`** — Define a type `{ rootPath: string; absPath: string }` to model entries extracted from `messageRequestContext` projectLayouts.
- [x] **T15. Add function `extractProjectLayoutsForSession()`** — Query `cursorDiskKV` for `messageRequestContext:{sessionId}:%`, parse each row's JSON, extract `projectLayouts[*].listDirV2Result.directoryTreeRoot.absPath` and `rootPath`.  Return `Array<CursorProjectLayout>`.
- [x] **T16. Add function `extractComposerFileUris()`** — Query `cursorDiskKV` for `composerData:{sessionId}`, parse the JSON, collect all URI keys from `originalFileStates` and all entries from `allAttachedFileCodeChunksUris`.  Decode `file:///` URIs to local paths.  Return `Array<string>`.
- [x] **T17. Add function `deriveWorkspaceRootFromFileUris()`** — Given an array of absolute file paths, find the longest common directory prefix.  If the prefix is too short (e.g. just a drive root), fall back to grouping files by directory and returning the most frequent directory root.  Return `string | null`.

{{SIMPLE}}

- [x] **T18. Add function `buildComposerWorkspaceMap()`** — Iterate all `composerData:*` keys.  For each session, call `extractComposerFileUris()`, then `deriveWorkspaceRootFromFileUris()`.  Return `Map<string, string>` (sessionId → workspace root path).  Log progress every N sessions.
- [x] **T19. Add function `buildProjectLayoutWorkspaceMap()`** — Iterate all `messageRequestContext:*` keys, grouped by session.  For each session, call `extractProjectLayoutsForSession()`.  Pick the first layout's `absPath`.  Return `Map<string, string>` (sessionId → workspace root path).  Log progress.
- [x] **T20. Integrate new sources into `inferCursorWorkspaceBySession()`** — At the start, call `buildProjectLayoutWorkspaceMap()` and `buildComposerWorkspaceMap()`.  When resolving each session, check in order: (1) projectLayout map, (2) composerData file URI map, (3) existing bubble heuristics.  Use the first non-null result as `workspacePath`.
- [x] **T21. Log coverage stats** — After workspace inference, log how many sessions were resolved by each source: `[Cursor] Workspace source: projectLayouts=X, composerFileUris=Y, bubbleHeuristics=Z, unresolved=W`.

{{MEDIUM}}

- [x] **T22. Handle multi-root workspaces** — When `projectLayouts` returns multiple roots (e.g. NexusEvo workspace has NexusPlatform, NexusDK, Kromyre, etc.), the correct workspace root is the parent that contains all of them.  Detect this case and resolve to the common parent path, then feed that to `workspacePathToProject()` for rule matching.
- [x] **T23. Handle `composerData` file URIs across subprojects** — When `originalFileStates` URIs span multiple directories under a common workspace (e.g. `Evo\NexusDK` and `Evo\NexusPlatform`), `deriveWorkspaceRootFromFileUris()` should walk up to the common parent rather than picking the most-frequent leaf.
- [x] **T24. Avoid duplicate DB reads** — The current code already reads all `cursorDiskKV` rows for bubble and metadata scanning.  Refactor to collect `composerData` and `messageRequestContext` payloads during the existing single scan rather than issuing new queries per session.
- [ ] **T25. Smoke test with known problem sessions** — Run ingest, verify the 9 reported bad sessions now resolve correctly:
  - `6198bcf1...` → **AXON** (was "Lands")
  - `a4d0be81...` → **NexusEvo** (was "factory")
  - `d84b7c96...` → **NexusEvo** (was "history")
  - `bc93f6f0...` → **NexusEvo** (was "nclass")
  - `a69816f8...` → **NexusEvo** (was "tprivate")
  - `4c2b2822...` → **NexusEvo** (was "tile")
  - `5219353d...` → **NexusEvo** (was "r")
  - `e75007bc...` → **NexusEvo** (was "untitled")
  - `e7427259...` → **karla-game-meta** (was "ask-metadata")

{{MEDIUM}}

- [ ] **T26. Full regression test** — Run full ingest across all harnesses, verify no project assignment regressions.  Compare before/after MISC counts and auto-derived counts.
- [x] **T27. Update diagnostic warnings** — The MISC/auto-derived warning blocks (from Phases 1–2) should now report the source that resolved each session (e.g. `[via projectLayouts]`, `[via composerFileUris]`, `[via bubble heuristic]`).

---

### Phase 5 — Interactive CLI: `bun run fix-misc`

**Goal**: Let the user interactively fix remaining MISC sessions by accepting or overriding auto-derived project names and patching `cc.json`.

{{HARD}}

- [ ] **T28. Design `bun run fix-misc` interactive CLI command** — Plan the UX: list MISC sessions with path evidence, let user type a project name or accept auto-derived suggestion, then patch `cc.json` with the chosen mapping rules.
- [ ] **T29. Implement `bun run fix-misc`** — Wire up the interactive flow: read current `cc.json`, load storage to find MISC sessions, present choices, merge new rules into the config, write back to `cc.json`.
- [ ] **T30. End-to-end validation** — Run `fix-misc`, apply suggested rules, re-run full ingest, confirm zero MISC sessions remain (or only genuinely untraceable ones).