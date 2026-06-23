# Rename Plan: `zeSettings` → `.settings` & `HarnessConfig.path` → `HarnessConfig.paths`

**Date**: 2026-03-22
**Status**: Inventory complete — ready for execution
**Scope**: Two orthogonal rename operations; execute one at a time, verify between.

---

## Search Strategy (MANDATORY)

Before marking either rename done, run these grep sweeps to confirm zero survivors:

```bash
# zeSettings survivors
grep -r "zeSettings" src/ README.md zz-reach2/

# HarnessConfig.path survivors (careful: .path in ProjectMappingRule is intentional — see §2)
grep -rn "config\.path\b\|harnessConfig\.path\b\|HarnessConfig.*path\b" src/
grep -rn '"path"' src/types.ts src/setup.ts src/harness/index.ts src/watcher/
```

Use grep profusely throughout the execution steps. Do not rely on IDE search alone — string-replace misses are easy to introduce when multiple `.path` semantics coexist.

---

## Rename 1: `zeSettings` → `.settings`

### What changes

The on-disk directory `{storage}/zeSettings/` is renamed to `{storage}/.settings/`. The leading dot makes it a hidden/system folder and avoids the awkward `ze` prefix. All code that constructs or references this path must be updated.

### ⚠️ Migration note

If a user has an existing `zeSettings/` directory on disk, the server will silently create a new `.settings/` directory and the old one will be orphaned. Add a **one-time migration step** in startup: if `{storage}/zeSettings/` exists and `{storage}/.settings/` does not, rename it. This ensures data continuity for existing users.

### Source files — runtime path construction (critical)

| File | Line | Current | Change to |
|------|------|---------|-----------|
| `src/settings/TopicStore.ts` | 12 | `private readonly zeSettingsDir` | `private readonly settingsDir` |
| `src/settings/TopicStore.ts` | 22 | `join(storagePath, "zeSettings")` | `join(storagePath, ".settings")` |
| `src/settings/TopicStore.ts` | 23 | `join(this.zeSettingsDir, ...)` | `join(this.settingsDir, ...)` |
| `src/settings/TopicStore.ts` | 26 | comment `// Ensure zeSettings directory exists` | `// Ensure .settings directory exists` |
| `src/settings/TopicStore.ts` | 27 | `existsSync(this.zeSettingsDir)` | `existsSync(this.settingsDir)` |
| `src/settings/TopicStore.ts` | 29 | `mkdirSync(this.zeSettingsDir, ...)` | `mkdirSync(this.settingsDir, ...)` |
| `src/settings/ScopeStore.ts` | 12 | `private readonly zeSettingsDir` | `private readonly settingsDir` |
| `src/settings/ScopeStore.ts` | 22 | `join(storagePath, "zeSettings")` | `join(storagePath, ".settings")` |
| `src/settings/ScopeStore.ts` | 23 | `join(this.zeSettingsDir, ...)` | `join(this.settingsDir, ...)` |
| `src/settings/ScopeStore.ts` | 26 | `existsSync(this.zeSettingsDir)` | `existsSync(this.settingsDir)` |
| `src/settings/ScopeStore.ts` | 28 | `mkdirSync(this.zeSettingsDir, ...)` | `mkdirSync(this.settingsDir, ...)` |
| `src/vector/SummaryEmbeddingCache.ts` | 64 | `join(storagePath, "zeSettings", "summary-embeddings.json")` | `join(storagePath, ".settings", "summary-embeddings.json")` |
| `src/vector/SummaryEmbeddingCache.ts` | 65 | `join(storagePath, "zeSettings", "summary-vectors-synced.json")` | `join(storagePath, ".settings", "summary-vectors-synced.json")` |
| `src/agentBuilder/AgentBuilder.ts` | 907 | `join(storagePath, "zeSettings", "agent-templates")` | `join(storagePath, ".settings", "agent-templates")` |
| `src/agentBuilder/AgentBuilder.ts` | 934 | `join(storagePath, "zeSettings", "agent-templates")` | `join(storagePath, ".settings", "agent-templates")` |

### Source files — comments only

| File | Line | Change |
|------|------|--------|
| `src/settings/TopicStore.ts` | 3 | `zeSettings/topics.json` → `.settings/topics.json` |
| `src/settings/ScopeStore.ts` | 3 | `zeSettings/scopes.json` → `.settings/scopes.json` |
| `src/models/TopicEntry.ts` | 3 | `zeSettings/topics.json` → `.settings/topics.json` |
| `src/models/ScopeEntry.ts` | 3 | `zeSettings/scopes.json` → `.settings/scopes.json` |
| `src/vector/SummaryEmbeddingCache.ts` | 4 | `zeSettings/summary-embeddings.json` → `.settings/summary-embeddings.json` |
| `src/agentBuilder/AgentBuilder.ts` | 901 | `{storagePath}/zeSettings/agent-templates/` → `{storagePath}/.settings/agent-templates/` |
| `src/agentBuilder/AgentBuilder.ts` | 928 | same |

### Documentation files (zz-reach2)

All 10 markdown files below contain `zeSettings` and must be updated:

| File | Notes |
|------|-------|
| `zz-reach2/architecture/archi-context-core-level0.md` | Multiple refs in §1, §2.2 module inventory, §4.3 storage layout, §15 execution env |
| `zz-reach2/architecture/prose/archi-summarizer.md` | References topics.json path |
| `zz-reach2/architecture/data/archi-file-watcher.md` | References settings dir |
| `zz-reach2/architecture/search/archi-qdrant.md` | References summary-embeddings path |
| `zz-reach2/architecture/techDebt/td-memory-optimization.md` | References settings path |
| `zz-reach2/upgrades/2026-03/r2ubt-better-topics.md` | References topics.json path |
| `zz-reach2/upgrades/2026-03/r2us-scopes.md` | References scopes.json path |
| `zz-reach2/upgrades/2026-03/r2uat-agent-templates.md` | References agent-templates path |
| `zz-reach2/upgrades/2026-03/r2bq-better-qdrant.md` | References summary-embeddings path |
| `zz-reach2/upgrades/2026-03/r2bs-better-symbols.md` | References settings dir |

### README.md

| File | Line | Change |
|------|------|--------|
| `README.md` | 36 | `{storage}/zeSettings/topics.json` → `{storage}/.settings/topics.json` |

### Verification grep after execution

```bash
grep -r "zeSettings" . --include="*.ts" --include="*.md" --include="*.json"
# Expected: zero results
```

---

## Rename 2: `HarnessConfig.path` → `HarnessConfig.paths`

### What changes

The `path` field on `HarnessConfig` was always `string | string[]` and is now exclusively arrays in `cc.json`. Rename it to `paths` so the type matches the shape. This is a **type-level + runtime** change.

### ⚠️ Scope boundary — DO NOT rename these

These `.path` properties are **different fields** on different types and must remain unchanged:

| Type | Field | Why |
|------|-------|-----|
| `ProjectMappingRule` | `.path` | A substring matcher, not a file path array |
| `GenericProjectMappingRule` | `.path` | Same |
| `DataSourceEntry` | `.path` | Single path string, not a harness config |
| `ScopeEntry` etc. | `.path` | Route/scope path, unrelated |

The rename only targets `HarnessConfig.path`.

### Type definition

| File | Line | Change |
|------|------|--------|
| `src/types.ts` | 8 | `path: string \| string[]` → `paths: string[]` (also tighten type: cc.json is always array now) |

### Runtime accesses of `HarnessConfig.path` / `config.path`

| File | Lines | Change |
|------|-------|--------|
| `src/harness/index.ts` | 15, 18 | Comment: `path(s)` → `paths`; `config.path` → `config.paths` (both occurrences); also simplify: `Array.isArray(config.paths) ? config.paths : [config.paths]` → just `config.paths` once type is `string[]` |
| `src/watcher/FileWatcher.ts` | 114–116 | `Array.isArray(harnessConfig.path) ? harnessConfig.path : [harnessConfig.path]` → `harnessConfig.paths` |
| `src/watcher/IncrementalPipeline.ts` | 105–107 | `Array.isArray(harnessConfig.path) ? harnessConfig.path[0] : harnessConfig.path` → `harnessConfig.paths[0]` |

### setup.ts — harness config object construction

| File | Lines | Change |
|------|-------|--------|
| `src/setup.ts` | 592 | `{ path: claudePaths }` → `{ paths: claudePaths }` |
| `src/setup.ts` | 595 | `{ path: cursorPath }` → `{ paths: [cursorPath] }` (wrap scalar to match `string[]`) |
| `src/setup.ts` | 598 | `{ path: vscodePaths }` → `{ paths: vscodePaths }` |
| `src/setup.ts` | 602 | `{ path: kiro.paths }` → `{ paths: kiro.paths }` |
| `src/setup.ts` | 608 | `{ path: [openCodePath] }` → `{ paths: [openCodePath] }` |

### Verification grep after execution

```bash
# Should find ONLY ProjectMappingRule/GenericProjectMappingRule/DataSourceEntry .path — not HarnessConfig
grep -n "config\.path\|harnessConfig\.path" src/harness/index.ts src/watcher/FileWatcher.ts src/watcher/IncrementalPipeline.ts
# Expected: zero results

# Check type definition is updated
grep -n "path:" src/types.ts
# Expected: only ProjectMappingRule.path, GenericProjectMappingRule.path, DataSourceEntry.path remain
```

---

## Execution Order

1. **Rename 1 first** (`zeSettings` → `.settings`) — isolated to string literals and comments, lower regression risk
2. Run `bun run test` + manual smoke test of topics/scopes/agent-templates endpoints
3. **Rename 2** (`path` → `paths`) — touches type system, requires TypeScript compilation check
4. Run `bun run build` (or `bun run typecheck`) to confirm zero type errors
5. Run full test suite
6. **Final grep sweeps** (see verification commands above)
