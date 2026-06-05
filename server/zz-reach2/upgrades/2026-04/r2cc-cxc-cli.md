# ContextCore CLI Architecture Plan (`cxccli`)

**Date**: 2026-04-09  
**Status**: Completed (all checklist groups implemented)  
**Target**: `server/src/cxccli.ts` + `server/package.json` script alias

---

## 1. Goal

Create a CLI that manages harness path config in `cc.json` with emphasis on VS Code readability.

The CLI must:
- List harness paths with stable row numbers.
- Show computed project name per row.
- Resolve VS Code hash paths through `workspace.json` and show real workspace disk location.
- Support `add`, `edit`, and `delete` operations.
- Color code harnesses consistently.
- Behave as a `cc.json` editor: mutation commands persist changes to disk.

---

## 2. Command Surface

Planned script:

```json
{
  "scripts": {
    "cxccli": "bun run src/cxccli.ts"
  }
}
```

Planned commands:
- `cxccli list` (read-only)
- `cxccli add` (writes `cc.json`)
- `cxccli edit <row>` (writes `cc.json`)
- `cxccli delete <row>` (writes `cc.json`)

Planned shared flags:
- `--machine <name>`
- `--json` (for `list`)
- `--yes` (skip confirmations)

Framework contract:
- Use `commander` for command tree, parsing, validation, and help output.
- Use `@clack/prompts` for interactive selection/confirmation/text input flows.
- Keep business logic (config parsing, row flattening, mutation internals) framework-agnostic.

---

## 3. Output Contract (`list`)

Each configured path is one numbered row.

Columns:
- `#`
- `Harness`
- `Configured Path`
- `Computed Project`
- `Workspace Location` (VS Code only)
- `Exists`

Color map:
- `ClaudeCode`: green
- `Cursor`: blue
- `VSCode`: cyan
- `Kiro`: yellow
- `OpenCode`: magenta
- `Codex`: red
- unknown: gray

---

## 4. Computed Project Rules

- `VSCode`:
  - Read `<workspaceStorageHashDir>/workspace.json`
  - Use `workspace` or `folder`
  - Decode file URI to local path
  - Compute via `deriveProjectName("VSCode", decodedPath)`
  - Fallback to `deriveProjectName("VSCode", configuredPath)`
- Other harnesses (phase 1):
  - `deriveProjectName(harnessName, configuredPath)`

VS Code row metadata to retain:
- `workspaceUri`
- `workspacePath`
- `workspaceMetaStatus` (`ok | missing | malformed`)

---

## 5. Reuse Rules From `archi-setup.md`

`cxccli` should reuse setup patterns instead of creating parallel logic.

Patterns to preserve:
- Sequential interactive flow with independent harness scanners.
- Per-harness scanner contract (candidate paths -> evidence check -> candidate rows).
- Platform-specific path resolvers from setup (`get*Path(s)` functions).
- Defensive error handling (`never-crash`, warn and continue).
- Config safety conventions (`cc.json` merge behavior, preserve unknown keys, tab-indented output).
- Shared `chalk` visual language for success/warning/error and path hints.

Reuse direction:
- Extract scanner/path helper code from `src/setup.ts` into shared CLI modules.
- Import shared helpers back into `setup.ts` so there is one source of truth.

---

## 6. Mutation Safety

- Edit/delete must target one row number resolved from current list snapshot.
- Do not mutate other machines.
- Do not mutate non-path harness fields unless command explicitly needs it.
- Never target reserved key `genericProjectMappingRules` as if it were a harness row.
- All mutation commands (`add/edit/delete`) persist by default.
- Atomic write for `cc.json` (temp file + rename).
- Optional safety backup before write (for example `cc.json.bak`) if configured.

---

## 7. Execution Checklist (Chronological, Difficulty-Batched)

The checklist is strictly chronological. Difficulty tags indicate the recommended model for that batch. Tags are repeated at most every 8 tasks.

{{SIMPLE}}
- [x] Create `src/cxccli.ts` with `commander` command parsing (`list` default when no command is passed).
- [x] Add `cxccli` script in `server/package.json`.
- [x] Add CLI help text (`list`, `add`, `edit`, `delete`, flags).
- [x] Define shared row/candidate types for CLI output.
- [x] Define harness order and color-map constants.
- [x] Add standard process exit code handling for success vs validation error.

{{MEDIUM}}
- [x] Implement `loadCcConfig()` for `server/cc.json` with typed parsing and friendly errors.
- [x] Implement machine selection (`--machine`, else hostname match, else interactive pick via `@clack/prompts`).
- [x] Flatten machine harnesses into deterministic numbered rows (`harness + path` sorted).
- [x] Ignore reserved config keys during row flatten (`genericProjectMappingRules`).
- [x] Add path existence checks and include status in row data.
- [x] Implement tab-indented write helper that preserves non-target JSON branches.

{{HARD}}
- [x] Extract VS Code workspace metadata resolver into shared CLI code (`workspace.json`, `workspace|folder`, URI decode).
- [x] Match existing harness decode behavior exactly (including Windows drive URI handling).
- [x] Add explicit resolver status (`ok | missing | malformed`) for transparent fallback behavior.
- [x] Implement project compute path for VS Code (workspace path first, configured path fallback).
- [x] Add fixture-based tests for malformed/missing `workspace.json` and valid URI decoding.
- [x] Confirm computed project parity with current `src/harness/vscode.ts` behavior.

{{MEDIUM}}
- [x] Implement `list` table renderer with the agreed columns and width rules.
- [x] Apply harness colors consistently in `list` output.
- [x] Implement `--json` output that mirrors table row semantics.
- [x] Wire `cxccli list` end-to-end with machine selection and computed project resolution.

{{HARD}}
- [x] Implement row-number to config-index resolver for mutation commands.
- [x] Implement `edit <row>` flow (`@clack/prompts` text prompt for new path, default current path, warn on non-existing path).
- [x] Implement `delete <row>` flow with `@clack/prompts` confirmation (`--yes` bypass).
- [x] Remove empty harness block only with explicit `@clack/prompts` confirmation in interactive mode.
- [x] Add atomic save path for all mutations with rollback-safe error handling.
- [x] Add optional backup strategy for `cc.json` before mutation writes.
- [x] Add tests for edit/delete across multiple machines and mixed harness blocks.
- [x] Add guard tests ensuring reserved keys are never edited/deleted as harness rows.

{{MEDIUM}}
- [x] Extract reusable discovery helpers from `setup.ts` (platform path getters + evidence scanners).
- [x] Update `setup.ts` to consume those shared helpers without changing setup behavior.
- [x] Implement `add` scan sources: ClaudeCode, Cursor, VSCode, Kiro, OpenCode, Codex.
- [x] Build colorized candidate table with row numbers and minimal evidence details.
- [x] Implement add candidate selection with `@clack/prompts` multi-select (single/comma/range parser fallback for non-TTY).
- [x] Deduplicate selected candidates against existing config paths before write.
- [x] Persist additions and print a post-write summary using the same list renderer.

{{HARD}}
- [x] Define extension contract for future harness scanners (`getCandidates`, `scan`, `describe`).
- [x] Add integration test for `add` with mocked filesystem and multi-harness candidate merge.
- [x] Add integration test for VS Code hash path that resolves through `workspace.json` to readable project.
- [x] Add a short "how to add a new harness scanner" section aligned with setup architecture contract.

{{SIMPLE}}
- [x] Update `/zz-reach2/architecture/cli/archi-cli.md` examples with final command samples and sample output table.
- [x] Run `bun run typecheck` and fix any typing regressions.
- [x] Run manual smoke pass: `list`, `add`, `edit`, `delete` on a temp copy of `cc.json`.
- [x] Record deferred backlog item: deep Cursor/Kiro rule-aware project preview in CLI list.

---

## 8. Acceptance Criteria

- `bun run cxccli list` prints numbered rows for all harness paths on the selected machine.
- VS Code rows include decoded workspace path and friendly computed project.
- `edit` and `delete` safely mutate only the targeted row and persist to `cc.json`.
- `add` scans disk, presents colorized candidates, deduplicates, and persists to `cc.json`.
- Shared discovery logic is reused between setup and cxccli to avoid drift.

---

## 9. Implementation Note (2026-04-09)

- CLI command/flag parsing and help UX is standardized on `commander`.
- Interactive selection/prompt UX is standardized on `@clack/prompts`.
- Existing business logic (config parsing, row flattening, mutations) remains framework-agnostic.

## 10. Deferred Backlog

- Deep Cursor/Kiro rule-aware project preview in `cxccli list` (currently phase-1 path-based projection for non-VSCode harnesses).
