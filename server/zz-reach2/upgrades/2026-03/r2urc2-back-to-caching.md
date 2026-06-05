# R2URC2 — Back to Caching: Re-wire ResponseCache After Endpoint Consolidation

**Date**: 2026-03-23
**Status**: In Progress
**Scope**: Re-integrate the orphaned `ResponseCache` into the current search endpoints, then improve cache filenames for readability
**Prerequisite**: [`r2urc-response-caching.md`](r2urc-response-caching.md), [`r2srf-search-review-fixes.md`](r2srf-search-review-fixes.md)

---

## 1. What Happened

The `ResponseCache` module (`src/cache/ResponseCache.ts`) was originally built and wired into `GET /api/search` inside `searchRoutes.ts`. It worked correctly: queries were hashed, results were cached to `{storage}/zzzcache/queries/YYYY-MM-DD/`, and repeated queries within the same day returned cached responses.

During the **endpoint consolidation** ([`r2srf-search-review-fixes.md`](r2srf-search-review-fixes.md)), the legacy `GET /api/search` and `GET /api/search/threads` were removed and search was unified into `POST /api/messages` and `POST /api/threads`. The `searchRoutes.ts` file was deleted entirely. The `ResponseCache` module was left intact but **orphaned** — no code imported or called `withCache()` anymore.

The `archi-search.md` doc even acknowledged this at section 7: *"The cache previously wrapped only the legacy `GET /api/search` endpoint, which has been removed. The `ResponseCache` infrastructure remains available but is not currently wired to any endpoint."*

Despite `DISABLE_SEARCH_CACHE=false` being set in `.env`, no cache files were ever created because `withCache()` was never called.

### Root Cause Chain

```
searchRoutes.ts (had withCache import) → DELETED during r2srf consolidation
                                        ↓
messageRoutes.ts (new POST /api/messages) → never got withCache wiring
threadRoutes.ts  (new POST /api/threads)  → never got withCache wiring
                                        ↓
ResponseCache.ts → orphaned, fully functional but called by nothing
```

---

## 2. Additional Challenge: Multi-Param Cache Keys

The old `GET /api/search?q=storyteller` had a single query param. The new POST endpoints accept a richer body:

| Param | Affects results? | Affects cache key? |
|-------|------------------|--------------------|
| `searchTerms` | Yes | Yes — primary key |
| `symbols` | Yes | Yes |
| `subject` | Yes | Yes |
| `fromDate` | Yes | Yes |
| `projects` | Yes | Yes |
| `limit` (threads only) | Yes | Yes |

A search for `"storyteller"` with `fromDate=2026-03-01` must produce a **different cache file** than the same search without a date filter. Similarly, thread searches with `limit=10` vs `limit=50` are distinct.

### Cache Key Strategy

`buildSearchCacheKey()` builds a deterministic composite string:

```
msg|storyteller|sym:AgentMessage|sub:auth|from:2026-03-01|proj:ClaudeCode::AXON,Cursor::AXON
thr|storyteller|from:2026-03-01|lim:50
```

This composite is **hashed** (SHA-256, 12 hex chars) for the lookup. But the **filename prefix** should remain human-readable. The current approach sanitizes the entire composite key into the prefix, which is cluttered. The improved approach structures the prefix as:

```
{endpoint}-{sanitized-searchTerms}--from-{date}--lim-{N}--{hash}.json
```

Examples:
- `msg-storyteller--a1b2c3d4e5f6.json` — simple message search
- `msg-storyteller--from-2026-03-01--a1b2c3d4e5f6.json` — with date filter
- `thr-storyteller--from-2026-03-01--lim-50--b2c3d4e5f6a7.json` — thread search with limit
- `thr-field-agentmessage-auth--c3d4e5f6a7b8.json` — field-only thread search

The **hash** still covers ALL params (symbols, subject, projects, etc.) so different filter combinations get unique files even if the readable prefix looks similar.

---

## 3. Tasks

### Phase 1 — Re-wire Cache into Current Endpoints (DONE)

{{SIMPLE}}

- [x] Add `buildSearchCacheKey()` to `ResponseCache.ts` — combines endpoint prefix + searchTerms + optional filters into a pipe-delimited composite key for hashing
- [x] Add `import { withCache, buildSearchCacheKey }` to `messageRoutes.ts`
- [x] Wrap `POST /api/messages` full-text search pipeline (Fuse.js + Qdrant hybrid + field filters + topic resolution) inside `withCache()`
- [x] Add `X-Cache: HIT/MISS` response header to `POST /api/messages`
- [x] Add cache HIT console log to `POST /api/messages`
- [x] Add `import { withCache, buildSearchCacheKey }` to `threadRoutes.ts`
- [x] Wrap `POST /api/threads` search pipeline (full-text AND field-only paths, Qdrant merge, thread aggregation, limit truncation) inside `withCache()`
- [x] Add `X-Cache: HIT/MISS` response header and cache HIT console log to `POST /api/threads`
- [x] Wrap `POST /api/threads/latest` (latest threads view) with `withCache()` using `thr-latest|lim:{N}|from:{date}` cache key

### Phase 2 — Readable Cache Filenames

{{SIMPLE}}

- [x] Add `buildCacheFilenamePrefix(endpoint, searchTerms, options?)` function to `ResponseCache.ts` — builds human-readable filename prefix with optional `--from-{date}` and `--lim-{N}` suffixes
- [x] Add optional `filenamePrefix?: string` parameter to `writeCachedResponse()` — when provided, uses it instead of auto-sanitizing the full composite key
- [x] Add optional `filenamePrefix?: string` parameter to `withCache()` — passes it through to `writeCachedResponse()`
- [x] Update `POST /api/messages` handler in `messageRoutes.ts` to build and pass `filenamePrefix` via `buildCacheFilenamePrefix('msg', searchTerms, { fromDate })`
- [x] Update `POST /api/threads` handler in `threadRoutes.ts` to build and pass `filenamePrefix` via `buildCacheFilenamePrefix('thr', searchTerms, { fromDate, limit })`

### Phase 3 — Verify & Test

{{SIMPLE}}

- [ ] Verify all three files transpile cleanly with Bun (`bun build --no-bundle`)
- [ ] Restart server, run a search, confirm `zzzcache/queries/YYYY-MM-DD/` directory is created with readable filenames
- [ ] Run same search again, confirm `X-Cache: HIT` header and cache HIT console log
- [ ] Run same search with different `fromDate`, confirm separate cache file created
- [ ] Run thread search with different `limit`, confirm separate cache file created

### Phase 4 — Documentation Updates

{{SIMPLE}}

- [ ] Update `archi-search.md` section 7 (Response Cache) to remove the "not currently wired" note and document the new POST endpoint caching with multi-param keys
- [ ] Update `archi-context-core-level0.md` module inventory if needed (ResponseCache entry)

---

## 4. Files Changed

| File | Change |
|------|--------|
| `src/cache/ResponseCache.ts` | Added `buildSearchCacheKey()`. Phase 2: add `buildCacheFilenamePrefix()`, optional `filenamePrefix` param on `writeCachedResponse()` and `withCache()` |
| `src/server/routes/messageRoutes.ts` | Import `withCache` + `buildSearchCacheKey`, wrap search pipeline. Phase 2: pass `filenamePrefix` |
| `src/server/routes/threadRoutes.ts` | Import `withCache` + `buildSearchCacheKey`, wrap search pipeline. Phase 2: pass `filenamePrefix` |

---

## 5. Design Decisions

| Question | Decision | Rationale |
|----------|----------|-----------|
| What to cache? | Only full-text search paths (when `searchTerms` or field filters are present) | Paginated browse and direct lookups are cheap DB queries; caching would add I/O overhead for minimal gain |
| Cache latest threads? | Yes | Same daily TTL as search; `limit` + `fromDate` form the key so different views get separate files |
| Include Qdrant results in cache? | Yes | Within a single day (cache TTL), Qdrant data is static — loaded at startup |
| Endpoint type in cache key? | Yes (`msg\|` / `thr\|`) | Same search terms on messages vs threads produce different result shapes — must not collide |
| Filename prefix structure | `{endpoint}-{terms}--from-{date}--lim-{N}` | Human-browsable on disk while hash ensures correctness |
