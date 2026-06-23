# R2UBS2 - Better Search: Symbol & Subject Targeting

**Date**: 2026-03-21
**Status**: Planned
**Scope**: Add `symbols` and `subject` search parameters to POST search endpoints for field-targeted search alongside the existing full-text pipeline.
**Parent**: [`archi-search.md`](../../architecture/search/archi-search.md)

---

## Background

### Route Overlap

Three route files handle search-related work, with significant overlap:

| Route File         | Endpoints                                                    | Primary Consumer     |
| ------------------ | ------------------------------------------------------------ | -------------------- |
| `searchRoutes.ts`  | `GET/POST /api/search`, `GET/POST /api/search/threads`       | Legacy / GET cached  |
| `messageRoutes.ts` | `GET/POST /api/messages`, `GET /api/messages/:id`            | Visualizer (primary) |
| `threadRoutes.ts`  | `POST /api/threads`, `GET /api/threads/latest`               | Visualizer (primary) |

`POST /api/messages` (with `searchTerms`) duplicates `POST /api/search` — both run Fuse.js + Qdrant hybrid search. `POST /api/threads` duplicates `POST /api/search/threads` — both run Fuse + `aggregateToThreads()`. The messageRoutes/threadRoutes variants are strict **supersets**: they add `fromDate` and `projects` filtering plus browse fallback.

The body field names differ: messageRoutes/threadRoutes use `searchTerms`, searchRoutes use `query`.

**Decision for this upgrade**: Target the **4 POST endpoints** used by the visualizer and the search POST variants:
1. `POST /api/messages` (messageRoutes) — primary
2. `POST /api/threads` (threadRoutes) — primary
3. `POST /api/search` (searchRoutes) — consistency
4. `POST /api/search/threads` (searchRoutes) — consistency

GET endpoints are legacy/cached and remain unchanged.

---

## Goal

Add two new optional POST body parameters: `symbols` and `subject`. These work as **independent search dimensions** alongside the existing full-text `searchTerms`/`query`.

### Parameter Semantics

| `searchTerms` | `symbols`   | `subject`      | Behavior                                                  |
| ------------- | ----------- | -------------- | --------------------------------------------------------- |
| empty         | empty       | empty          | Return all / paginated browse (existing behavior)         |
| `"foo"`       | empty       | empty          | Full-text Fuse search only (existing behavior)            |
| empty         | `"extract"` | empty          | Symbol-only targeted search (NEW)                         |
| empty         | empty       | `"auth refac"` | Subject-only targeted search (NEW)                        |
| `"foo"`       | `"extract"` | empty          | Full-text intersected with symbol filter (NEW)            |
| `"foo"`       | `"extract"` | `"auth"`       | Full-text intersected with symbol AND subject filter (NEW)|
| empty         | `"extract"` | `"auth"`       | Symbol + subject intersection, no full-text (NEW)         |

### Matching Strategy

- **`symbols`** (string): Case-insensitive **substring** match. A message matches if **any** entry in its `symbols[]` array contains the search term as a substring. Example: `"extract"` matches a message with symbols `["extractMessageSymbols", "parseQuery"]`.
- **`subject`** (string): Case-insensitive **substring** match against `message.subject`. Example: `"auth refac"` matches subject `"Auth refactoring & token cleanup"`.
- **Intersection**: When multiple dimensions are active, results must satisfy **ALL** active dimensions (AND semantics).

### Scoring & Ordering

- When `searchTerms` is present: results carry Fuse scores (and Qdrant scores if hybrid). Symbol/subject filters do not alter scores — they only narrow the result set.
- When `searchTerms` is absent (symbol/subject-only): there is no relevance score. Results are ordered by **date descending** (newest first), consistent with the browse fallback behavior.

---

## Design Decisions

| Question | Decision | Rationale |
| --- | --- | --- |
| Matching type for symbols | Case-insensitive substring | Symbols are code identifiers; users often search partial names (e.g., `"extract"` for `extractMessageSymbols`). Exact match is too strict; fuzzy is unnecessary for structured identifiers. |
| Matching type for subject | Case-insensitive substring | Subjects are short phrases; substring is predictable and sufficient. Fuzzy matching on subjects would produce noisy results given how short they are. |
| Multi-dimension combination | AND (intersection) | Users providing both symbols and subject want to narrow results, not broaden them. OR would defeat the purpose of targeted filtering. |
| Where to filter | Post-Fuse, pre-aggregation | For threads: filter messages before `aggregateToThreads()` so threads only include matching messages. Consistent with how `fromDate` already works. |
| No-searchTerms starting set | `messageDB.getAllMessages()` | When full-text search is skipped, we need the complete corpus as the starting set. `getAllMessages()` already exists on the DB interface. |
| Parameter type | Single string each | Keep it simple. If multi-term search is needed later, the Fuse `searchTerms` already supports that. These are targeted field filters, not full query languages. |

---

## Implementation Plan

### Group 1 — Field Filter Utilities

{{SIMPLE}}

- [ ] **T1.** Create `filterBySymbols(messages: AgentMessage[], term: string): AgentMessage[]` — case-insensitive substring match against each message's `symbols[]` array. Returns messages where at least one symbol contains the term.
- [ ] **T2.** Create `filterBySubject(messages: AgentMessage[], term: string): AgentMessage[]` — case-insensitive substring match against `message.subject`. Returns messages where subject contains the term.
- [ ] **T3.** Create overloads or parallel functions that accept `SearchResult[]` (from Fuse pipeline) instead of `AgentMessage[]`, preserving scores. The filter unwraps `.message` for matching and returns the full `SearchResult`.
- [ ] **T4.** Place these in a new `src/search/fieldFilters.ts` module (keeps searchEngine focused on Fuse).

### Group 2 — `POST /api/messages` Enhancement

{{MEDIUM}}

- [ ] **T5.** Accept `symbols` (string, optional) and `subject` (string, optional) in the POST body. Trim whitespace, treat empty string as absent.
- [ ] **T6.** Modify the "no searchTerms" branch: if `symbols` or `subject` is non-empty, do NOT fall through to `queryMessages()` browse mode. Instead, load all messages via `messageDB.getAllMessages()`, apply symbol/subject filters, then apply existing `fromDate` and `projects` filters. Order by date descending.
- [ ] **T7.** Modify the "has searchTerms" branch: after Fuse+Qdrant search and `fromDate` filtering, apply symbol/subject filters on the `SearchResult[]` before merging. Scores from Fuse/Qdrant are preserved; the filters only narrow the set.
- [ ] **T8.** Ensure the `resolveSubject()` call happens AFTER subject filtering (filter against the raw subject from the message, not the topic-resolved one, to stay consistent with indexed data). Document this decision inline.

### Group 3 — `POST /api/threads` Enhancement

{{MEDIUM}}

- [ ] **T9.** Accept `symbols` and `subject` in the POST body. Same trim/empty handling as messages.
- [ ] **T10.** Modify the "no searchTerms" branch: if symbols/subject are non-empty, load all messages, apply filters, then aggregate to threads. Currently this branch returns `{ total: 0 }` — it should now produce results when targeted filters are active.
- [ ] **T11.** Modify the "has searchTerms" branch: apply symbol/subject filters on Fuse results before `aggregateToThreads()`, consistent with how `fromDate` is applied pre-aggregation.

### Group 4 — `POST /api/search` and `POST /api/search/threads` Enhancement

{{SIMPLE}}

- [ ] **T12.** Accept `symbols` and `subject` in `POST /api/search` body alongside existing `query` and `projects`.
- [ ] **T13.** Apply the same pipeline logic: when `query` is empty but symbols/subject present, load all messages and filter. When `query` is present, post-filter Fuse results.
- [ ] **T14.** Accept `symbols` and `subject` in `POST /api/search/threads`. Apply pre-aggregation filtering.

### Group 5 — Architecture & Documentation

{{SIMPLE}}

- [ ] **T15.** Update `archi-search.md` Section 8 (API Endpoints) with the new parameters for all 4 POST endpoints.
- [ ] **T16.** Update the "Module Inventory" table if `fieldFilters.ts` is added.
- [ ] **T17.** Update the pipeline diagram in Section 2.1 to show the symbol/subject filter step.

---

## Execution Order

1. Group 1 (field filter utilities) — foundation
2. Group 2 (POST /api/messages) — primary endpoint, most complex
3. Group 3 (POST /api/threads) — mirrors Group 2 logic
4. Group 4 (POST /api/search variants) — consistency, simpler
5. Group 5 (docs) — after implementation settles

---

## Risks & Mitigations

- **Risk: Performance on symbol/subject-only search (no searchTerms)**
  - Loading all messages via `getAllMessages()` is O(n) but the corpus is already fully in memory (Fuse index is built from it at startup). The substring filter is fast.
  - Mitigation: if performance is an issue, build a secondary Fuse index keyed on symbols/subject only.

- **Risk: Subject resolved by topicStore differs from stored subject**
  - `resolveSubject()` can replace a message's subject with a topic-store entry. If we filter on the raw `message.subject`, we match against ingestion-time data. If we filter on resolved subject, we match against display-time data.
  - Decision: Filter on **raw** subject (pre-resolve). This is consistent, deterministic, and doesn't depend on topicStore state. Users searching by subject will see the resolved subject in results but the filter operates on the canonical value.

- **Risk: Empty symbols array on older messages**
  - Messages ingested before R2BS (Better Symbols) have `symbols: []`. Symbol-only search will not match those messages. This is acceptable — the user is aware of the rebuild lifecycle.

---

## Acceptance Checklist

- [ ] `POST /api/messages` with `symbols` only returns messages matching by symbol substring.
- [ ] `POST /api/messages` with `subject` only returns messages matching by subject substring.
- [ ] `POST /api/messages` with `searchTerms` + `symbols` returns intersection of Fuse results and symbol matches.
- [ ] `POST /api/threads` with `symbols`/`subject` returns threads aggregated from matching messages only.
- [ ] `POST /api/search` and `POST /api/search/threads` accept and honor the new parameters.
- [ ] All parameters are optional; omitting them preserves existing behavior exactly.
- [ ] Architecture doc updated with new parameters and pipeline changes.
