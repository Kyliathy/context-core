# Search Endpoint Consolidation & Qdrant Unification

**Date**: 2026-03-21
**Scope**: Remove legacy `/api/search` endpoints, unify search through `/api/messages` and `/api/threads`, ensure Qdrant integration on all search paths
**References**: [`r2sr-search-review.md`](r2sr-search-review.md), [`archi-search.md`](../../architecture/search/archi-search.md)

---

## 1. Problem Statement

The search system has **three overlapping route files** serving six search endpoints:

| File               | Endpoints                                             | Qdrant?  | Used by          |
| ------------------ | ----------------------------------------------------- | -------- | ---------------- |
| `searchRoutes.ts`  | `GET /api/search`, `POST /api/search`                 | ✅ Yes    | Nobody (legacy)  |
| `searchRoutes.ts`  | `GET /api/search/threads`, `POST /api/search/threads` | ✅ Yes    | Nobody (legacy)  |
| `messageRoutes.ts` | `POST /api/messages`                                  | ✅ Yes    | Visualizer, MCP* |
| `threadRoutes.ts`  | `POST /api/threads`                                   | ❌ **No** | Visualizer       |

\* MCP tools call `executeSearch()` and `aggregateToThreads()` directly, not HTTP endpoints.

**Issues:**
1. `POST /api/threads` — the endpoint the front-end actually uses — **has no Qdrant integration**
2. `POST /api/messages` has hand-rolled Qdrant logic instead of using `runQdrantSearch()` with subject-aware channel routing, symbols payload filters, etc.
3. Four legacy endpoints in `searchRoutes.ts` are unused but add maintenance burden
4. `searchRoutes.ts` contains `runQdrantSearch()` and `applyTopicSubjects()` — shared utilities that other routes need

---

## 2. Target State

| File               | Endpoints kept                                                     | Qdrant? | Notes                                                    |
| ------------------ | ------------------------------------------------------------------ | ------- | -------------------------------------------------------- |
| `messageRoutes.ts` | `GET /api/messages/:id`, `GET /api/messages`, `POST /api/messages` | ✅ Yes   | Use `runQdrantSearch()` + post-merge filters             |
| `threadRoutes.ts`  | `POST /api/threads`, `GET /api/threads/latest`                     | ✅ Yes   | Add Qdrant via same pattern as `/api/search/threads` had |
| `searchRoutes.ts`  | **DELETED** (file removed)                                         | —       | Utilities moved to `routeUtils.ts`                       |

---

## 3. Execution Plan

### Group 1 — Move shared utilities out of `searchRoutes.ts`

- [x] **T1.1** Move `runQdrantSearch()` from `searchRoutes.ts` to `routeUtils.ts`. Update its imports.
- [x] **T1.2** Move `applyTopicSubjects()` from `searchRoutes.ts` to `routeUtils.ts`. Update its imports.
- [x] **T1.3** Move `parseProjectFilters()` from `searchRoutes.ts` to `routeUtils.ts` (messageRoutes has its own inline copy — remove the duplicate).

### Group 2 — Add Qdrant to `POST /api/threads`

- [x] **T2.1** Import `runQdrantSearch()` in `threadRoutes.ts`.
- [x] **T2.2** After Fuse search + field filters, call `runQdrantSearch()` when `(searchTerms || subjectTerm) && ctx.vectorServices`.
- [x] **T2.3** Convert Qdrant hits to `SearchResult[]` (resolve messageId → AgentMessage, set `rawFuseScore: 1`).
- [x] **T2.4** Union with Fuse results (dedup by message ID, skip existing).
- [x] **T2.5** Apply post-merge field filters (symbols/subject) on the unioned set.
- [x] **T2.6** Apply `fromDate` filter to Qdrant-sourced results.
- [x] **T2.7** Pass combined results to `aggregateToThreads()`.

### Group 3 — Upgrade `POST /api/messages` to use `runQdrantSearch()`

- [x] **T3.1** Replace the hand-rolled Qdrant logic in `POST /api/messages` with a call to `runQdrantSearch()`.
- [x] **T3.2** Add post-merge field filters (symbols/subject) after `SearchResults.merge()` — same pattern as the old `POST /api/search`.
- [x] **T3.3** Apply `fromDate` filter to Qdrant-sourced results (filter merged results, not just Fuse).

### Group 4 — Delete `searchRoutes.ts` and deregister

- [x] **T4.1** Remove `import * as searchRoutes` and `searchRoutes.register(app, ctx)` from `ContextServer.ts`.
- [x] **T4.2** Delete `searchRoutes.ts`.
- [x] **T4.3** Remove the 4 legacy entries from `insomnia-context-core.json`: `GET /api/search`, `POST /api/search`, `GET /api/search/threads`, `POST /api/search/threads`.

### Group 5 — Verify

- [x] **T5.1** Build passes with no errors (`npm run build`).
- [ ] **T5.2** Smoke test: `POST /api/messages` with `searchTerms` returns hybrid results.
- [ ] **T5.3** Smoke test: `POST /api/threads` with `searchTerms` returns Qdrant-enhanced threads.
- [ ] **T5.4** Smoke test: `GET /api/threads/latest` still works.
- [ ] **T5.5** Confirm `GET /api/search` returns 404 (endpoint removed).

---

## 4. Risk Assessment

| Risk                                      | Impact                                                                                        | Mitigation                      |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------- |
| MCP tools break                           | None — they call `executeSearch()` directly, not HTTP                                         | Verified in code review         |
| Visualizer breaks                         | None — it uses `/api/messages` and `/api/threads` (POST)                                      | Verified in `search.ts`         |
| Response cache for GET `/api/search` lost | Acceptable — the cache was `withCache()` on the legacy GET only; POST paths were never cached | Could add caching to POST later |
| `runQdrantSearch()` import path changes   | Low — move to `routeUtils.ts`, update 2 import sites                                          | Mechanical change               |

---

## 5. Post-Consolidation Audit (follow-up)

After Groups 1-5 were executed, an audit against `r2sr-search-review.md` found **two gaps** where fixes from the old `searchRoutes.ts` were lost during consolidation:

### Gap 1 — Double-inversion bug in `messageRoutes.ts` (§7.2 / T2.5)

The `fuseHits` mapping passed `result.score` (composite, higher = better) to `SearchResults.merge()`, but `AgentMessageFound.fromAgentMessage()` interprets the score as a raw Fuse score (0 = best) and inverts it via `1 - fuseScore`. This double-inverted the score — a 0.9 composite match was treated as a 0.1 match.

**Fix**: changed `score: result.score` → `score: result.rawFuseScore` in the `fuseHits` mapping.

### Gap 2 — Missing post-merge field filters in `messageRoutes.ts` (§7.3 / T3.1-T3.2)

After `SearchResults.merge()`, Qdrant-sourced results were not filtered by `symbols` or `subject` field constraints. The old `searchRoutes.ts` had these post-merge filters, but they were lost during consolidation.

**Fix**: added post-merge filtering on `merged.results` (by `symbols` and `subject`) before `.serialize()`.

Both fixes verified with `npm run typecheck` — clean.
