# Memory Optimization Tech Debt — ContextCore

**Date**: 2026-03-15  
**Status**: Investigated, partially optimized, major reductions deferred  
**Scope**: Startup/runtime memory behavior after migration to on-disk SQLite

---

## 1. Goal

After switching from in-memory SQLite to on-disk SQLite, `bun.exe` memory remained high (observed ~1.5 GiB steady, with startup spikes up to ~3 GiB). The goal of this investigation was to identify what was still resident and optimize obvious duplication/leaks without changing product behavior.

---

## 2. What We Investigated

We traced startup and steady-state memory through:

1. Harness ingestion + grouping (`readHarnessChats`, `groupBySession`, `StorageWriter`)
2. Database load (`DiskMessageStore.loadFromStorage`)
3. Search initialization (`initSearchIndex`)
4. Long-lived module-level state (notably in `cursor.ts`)
5. Runtime shutdown behavior (to ensure profiling artifacts flush correctly)

We also captured and analyzed Bun heap profiles via `--heap-prof-md`.

---

## 3. Key Findings

## 3.1 On-disk DB does not automatically remove all in-memory costs

Even with on-disk SQLite, large memory remained because:

- Search still builds and keeps a full in-memory Fuse corpus.
- NLP model data (winkNLP + model lexicon) is loaded and retained.
- Runtime/native allocations (outside JS heap) are substantial.

## 3.2 Heap profile evidence (critical)

From `Heap.374509312000.74520.md`:

- **Total JS heap**: ~657 MB
- **Largest type**: `string` (~612 MB)
- Heap includes clear roots for:
  - `indexedRecords`/Fuse docs in `searchEngine`
  - `PROJECT_ROOT_CACHE` / `WORKSPACE_NORMALIZE_CACHE` in `cursor.ts`
  - winkNLP model chains (`readModel`, `originalModel`, `lexicon`, `lxm.list`)

Interpretation:

- JS heap (~657 MB) explains a large part, but **not all** of process RSS (~1.5 GiB).
- Remaining memory is likely runtime/native allocator/page-cache/etc. (outside markdown heap accounting).

## 3.3 Cursor caches are real but not the main problem

`PROJECT_ROOT_CACHE` and `WORKSPACE_NORMALIZE_CACHE` are retained and measurable (~8 MB class), but they are not the dominant contributor versus Fuse + strings + NLP + runtime baseline.

## 3.4 Graceful shutdown bug blocked profiling output

`SIGINT` originally stopped only `FileWatcher`, leaving process handles open. Bun would not exit, so heap profile files were often not flushed. This was fixed.

---

## 4. Changes Implemented

## 4.1 Reduced search object retention

In `src/search/searchEngine.ts`:

- Removed per-record `source: AgentMessage` from indexed records.
- Removed duplicate retained `indexedMessages` full array.
- Switched to ID-based lazy hydration (`getById`) for result materialization.

In `src/server/ContextServer.ts` and `src/mcp/serve.ts`:

- `initSearchIndex` now receives resolver `(id) => db.getById(id)`.

## 4.2 Reduced unnecessary DB startup scanning

In `src/db/BaseMessageStore.ts`:

- `collectJsonFiles()` now skips non-session trees:
  - `*-RAW`
  - `zeCache`
  - `.settings`

This avoids parsing large irrelevant JSON during DB load.

## 4.3 Fixed graceful shutdown for profile generation

In `src/ContextCore.ts`:

- Added full shutdown flow on `SIGINT`/`SIGTERM`:
  - stop watcher
  - clear keepalive timer
  - close HTTP server connections
  - close DB
  - exit cleanly
- Added timeout fallback to avoid indefinite hangs.

Result: Bun can flush heap profile artifacts reliably on `Ctrl+C`.

---

## 5. Current State (Post-Optimization)

- Some duplication was removed and startup waste reduced.
- Biggest memory drivers remain architectural (not quick-fix leaks):
  - Full in-memory Fuse corpus
  - NLP model resident data
  - Bun/native memory overhead
- Therefore, further major RSS reduction likely requires design-level changes.

---

## 6. Future Optimization Options

## Tier A — High Impact, Higher Effort

1. **Replace/augment Fuse with SQLite FTS5**
	- Keep indexed search in SQLite, avoid full in-memory text corpus.
	- Biggest likely reduction in JS heap strings.

2. **Segmented or lazy search index**
	- Per-harness/per-project indexes loaded on demand.
	- Trades latency/complexity for lower baseline memory.

3. **Two-process architecture**
	- Isolate heavy search/NLP in worker/service process.
	- Main API process remains lighter.

## Tier B — Medium Impact, Lower Risk

1. **Bound cursor caches**
	- Apply LRU/size cap to `PROJECT_ROOT_CACHE` and `WORKSPACE_NORMALIZE_CACHE`.

2. **Configurable search text truncation at index time**
	- Index only first N chars per message for lexical search.
	- Can materially reduce strings with acceptable relevance tradeoff.

3. **Startup mode flags**
	- Disable nonessential heavy subsystems (e.g., vector init, topic summarization) for specific runs.

## Tier C — Operational Experiments

1. **Run with `bun --smol`** for memory-sensitive runs.
2. Capture side-by-side profiles:
	- baseline
	- `--smol`
	- reduced-search-index variants
3. Track both:
	- JS heap profile (`--heap-prof-md`)
	- OS process RSS over time

---

## 7. Suggested Next Step (if resumed)

If optimization work resumes, the highest-value next increment is:

1. Add an opt-in capped search indexing mode (truncate text + cap caches).
2. Measure memory and search relevance impact.
3. Use that data to decide whether full FTS5 migration is justified.

---

## 8. Closure Note

This investigation confirms the system is not primarily suffering from a small accidental leak; memory footprint is largely explained by current architecture choices and runtime behavior. Quick optimizations are mostly exhausted; major further gains require search/index design changes.

