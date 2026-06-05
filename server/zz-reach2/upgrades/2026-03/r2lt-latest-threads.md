# r2lt — Latest Threads: POST + fromDate Support

**Date**: 2026-03-21
**Scope**: `GET /api/threads/latest` → `POST /api/threads/latest` with `fromDate` and `limit` body params
**Files touched**: `threadRoutes.ts`, `threadAggregator.ts`

---

## Motivation

`GET /api/threads/latest` currently only accepts `limit` as a query param. We need `fromDate` support so the visualizer can apply the same date filter that search views already support. Migrating to POST keeps the interface consistent with `POST /api/messages` and `POST /api/threads`.

---

## Changes

### 1. `threadAggregator.ts` — `getLatestThreads()`

Add a `fromEpoch?: number` parameter. Apply the date filter **before** the limit slice (filter sessions by `lastDateTime >= fromEpoch`).

```typescript
export function getLatestThreads(
  db: IMessageStore,
  limit = 100,
  topicStore?: TopicStore,
  fromEpoch?: number   // ← new: Date.parse result of fromDate
): ThreadSearchResult
```

Inside the loop, after computing `lastDateTime`, skip the session if `fromEpoch` is set and `Date.parse(lastDateTime) < fromEpoch`.

### 2. `threadRoutes.ts` — Route registration

- Change `app.get("/api/threads/latest", ...)` → `app.post("/api/threads/latest", ...)`
- Read `limit` and `fromDate` from `req.body` instead of `req.query`
- Parse `fromDate` to `fromEpoch` (same pattern as the existing thread search handler)
- Pass `fromEpoch` to `getLatestThreads()`

Request body:

```json
{
  "limit": 100,
  "fromDate": "2026-01-01"
}
```

Both fields are optional (same defaults as today: `limit = 100`, no date filter).

---

## Visualizer update (follow-on)

`fetchLatestThreads()` in `visualizer/src/api/search.ts` currently uses `GET`. It must be updated to `POST` with the JSON body, and the `useSearch` hook must pass the active `fromDate` when calling it.

---

## Steps

1. Update `getLatestThreads` signature + filter logic in `threadAggregator.ts`
2. Change route to `POST`, parse body, pass `fromEpoch` in `threadRoutes.ts`
3. Update `fetchLatestThreads()` in `visualizer/src/api/search.ts` to POST with body
4. Update `useSearch.ts` to pass `fromDate` when fetching latest threads
5. Update `archi-search.md` section 8.5 to reflect POST + body params

---

## Architecture doc update (section 8.5)

Change from:

> `GET /api/threads/latest` — query param `limit`

To:

> `POST /api/threads/latest` — body: `{ limit?: number, fromDate?: string }`
