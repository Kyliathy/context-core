# R2BQ - Better Qdrant Payload + Dual 3K Vectors

**Date**: 2026-03-21
**Status**: Planned
**Scope**: Enrich Qdrant metadata (`symbols`, `dateTime`, `subject`, optional `aiSummary`/`customTopic`) and add a second 3072d vector channel for summary search quality.

---

## Goal

Upgrade Qdrant indexing so each point stores richer, queryable metadata and supports two semantic channels:

1. `chunk` vector from chunk text (existing behavior, renamed as explicit channel).
2. `summary` vector from session-level summary text when available (`customTopic` or `aiSummary`).

This should improve semantic recall for intent-level queries while preserving current hybrid Fuse + Qdrant behavior.

---

## Success Criteria

- New Qdrant payload includes:
  - `symbols: string[]`
  - `dateTime: string` (ISO)
  - `subject: string` (stored message subject, not only resolved subject at API time)
  - `aiSummary?: string` (when present in `TopicStore`)
  - `customTopic?: string` (when present in `TopicStore`)
- Qdrant collections support two dense vector names (`chunk`, `summary`) with 3072 dimensions each.
- Both `GET /api/search` and `POST /api/search` query both vector channels and merge results without regressions.
- Duplicate Qdrant hits for same `messageId` use best score (max), never last-write-wins. This fixes a pre-existing bug in `SearchResults.merge()` where a later lower-scoring Qdrant chunk silently overwrites a higher-scoring one.
- If summary text is unavailable, indexing and search still work (chunk-only fallback).
- Summary embedding failure for one message never blocks chunk indexing for that message or any subsequent message.

---

## Key Decision

### Can we store double 3K vectors in the same collection?

Yes, this is feasible with Qdrant named vectors and the current `@qdrant/js-client-rest` client.

- Collection vectors can be configured as a named map (not only anonymous single vector).
- Search accepts named vectors via `vector_name` parameter.
- Upsert supports vector structs that include named vectors.

### Primary path

Use one collection per harness (`CXC_{HOST}_{Harness}`) with two named vectors:

- `chunk`: `text-embedding-3-large` (3072)
- `summary`: `text-embedding-3-large` (3072)

### Fallback path (only if primary is blocked at runtime)

Create mirror summary collection per harness:

- `CXC_{HOST}_{Harness}_S`

This fallback is only used if named-vector migration fails in real environment.

---

## Current Baseline (Observed)

- Payload today stores 7 fields only:
  - `messageId`, `sessionId`, `chunkIndex`, `chunkText`, `harness`, `project`, `contentKind`
- Vector today is a single anonymous 3072d embedding from chunk text.
- Startup order in `ContextCore.ts` currently runs vector indexing before AI summarization, meaning freshly generated summaries are **not** available for Qdrant payload enrichment on first run.
- `IncrementalPipeline.ingest()` already runs summarization before vector embedding (correct order).
- `aiSummary`/`customTopic` live in `TopicStore` by `sessionId`, not in `AgentMessage`.
- **Pre-existing dedup bug**: `SearchResults.merge()` uses last-write-wins when multiple Qdrant hits share the same `messageId` (e.g., two chunks of the same message). A later chunk with a lower score silently overwrites a higher-scoring earlier chunk.
- `hasMessagePoints()` and `getIndexedMessageIds()` query by payload fields, not by vector structure — these are unaffected by the migration to named vectors.

---

## Target Design

### Payload V2

```ts
type QdrantPointPayloadV2 = {
  messageId: string;
  sessionId: string;
  chunkIndex: number;
  chunkText: string;
  harness: string;
  project: string;
  contentKind: string;
  symbols: string[];
  dateTime: string;      // ISO
  subject: string;       // message.subject
  aiSummary?: string;    // TopicStore entry, if available
  customTopic?: string;  // TopicStore entry, if available
};
```

### Summary Embedding Cache

Summary embeddings are **pre-computed in a separate pass** and persisted to disk as a JSON file:

```
{storage}/.settings/summary-embeddings.json
```

```json
{
  "sessionId-abc123": [0.0123, -0.0456, ...],
  "sessionId-def456": [0.0789, -0.0012, ...]
}
```

Keyed by **`sessionId`** (not `messageId`) because summaries come from `TopicStore` which is per-session. One 3072d embedding per session, reused across all that session's message points.

**Lifecycle:**

1. After AI summarization completes, a **summary embedding pass** iterates all sessions with non-empty summary text (`customTopic || aiSummary`).
2. Sessions already present in the cache (with unchanged summary text) are skipped.
3. New/changed summaries are embedded via `EmbeddingService.embed()` and written to the cache file.
4. The main `VectorPipeline` reads from the cache — **zero OpenAI calls for summaries during chunk indexing**.
5. When a topic changes via `POST /api/topics`, the session's cache entry is invalidated (deleted). Re-embedding happens on the next pipeline run or immediately if targeted reindex is implemented.

**Benefits:**

- **Decoupled from chunk pipeline** — summary embedding failures, retries, and rate limits don't interfere with chunk indexing.
- **Persistent across restarts** — only new/changed summaries need embedding on startup.
- **Resumable** — if the process crashes mid-embedding, cached sessions survive.
- **Cheap invalidation** — delete one key per changed topic.

### Summary text source

- `summaryTextForVector = customTopic || aiSummary || ""`
- If empty: skip `summary` vector for that message's points and do not cache.
- Metadata payload still stores whichever `aiSummary`/`customTopic` fields are available (independent of whether an embedding was produced).
- All chunks of the same message share the same summary vector (looked up once from cache by `sessionId`, attached to every point).

### Search strategy

1. Embed query once (3072d).
2. Search `chunk` vector channel across all harness collections.
3. Search `summary` vector channel across all harness collections.
4. Merge chunk + summary Qdrant hits by `messageId` using **max score** (not last-write-wins).
5. Merge combined Qdrant hits with Fuse hits via existing 75/25 formula.

Both `GET /api/search` and `POST /api/search` follow this flow. The `POST` variant applies its `projects` filter after the per-channel merge but before the Fuse merge, same as today.

---

## Migration Strategy

Existing collections are single-vector. Named-vector schema requires migration.

Plan:

1. Detect schema mismatch in `ensureCollection()` via a `detectSchemaVersion()` helper.
2. Recreate harness collection to target schema (destructive to that collection only).
3. Re-index from MessageDB via existing pipeline.

Notes:

- This is safe because index data is fully derivable from the storage corpus.
- If `SKIP_STARTUP_UPDATING_QDRANT=true`, do not attempt schema migration or reindex.
- `hasMessagePoints()` and `getIndexedMessageIds()` are payload-based queries and continue to work unchanged with named-vector collections.
- If the system crashes mid-migration (after delete, before recreate), the next startup's `ensureCollection()` creates the collection fresh with V2 schema. No manual intervention needed.

---

## Implementation Plan

### Phase 1 — Types, Contracts & Config Decisions

{{SIMPLE}}

- [x] **T1.** Extend `QdrantPointPayload` in `src/vector/QdrantService.ts` with `symbols: string[]`, `dateTime: string`, `subject: string`, optional `aiSummary?: string`, `customTopic?: string`. Add a `// Payload V2 — R2BQ` doc comment marking the version boundary.
- [x] **T2.** Add backward-tolerant read typing: V2 fields must be optional on deserialized payloads so stale points from pre-migration collections don't crash search result mapping. Define `QdrantPointPayloadV2` as the write type and keep `QdrantPointPayload` as the lenient read type with all new fields optional.
- [x] **T3.** Define summary text resolver as a pure function in `VectorPipeline.ts`: `resolveSummaryText(topicEntry: TopicEntry | undefined): string` returning `customTopic || aiSummary || ""`.
- [x] **T4.** Define `SKIP_AI_SUMMARIZATION=true` behavior: skip the summarization pass entirely but use whatever `TopicStore` already contains for payload enrichment and summary embedding. No blocking, no new API calls.

### Phase 2 — Summary Embedding Cache: Build & Generate

{{MEDIUM}}

- [x] **T5.** Create `SummaryEmbeddingCache` module in `src/vector/SummaryEmbeddingCache.ts`: reads/writes `{storage}/.settings/summary-embeddings.json` as a `Map<sessionId, number[]>`. Methods: `load()`, `save()`, `get(sessionId): number[] | undefined`, `set(sessionId, vector)`, `delete(sessionId)`, `has(sessionId)`.
- [x] **T6.** Implement the **summary embedding pass** as a method on `SummaryEmbeddingCache` (or a standalone function): iterate all `TopicStore` entries, skip sessions already cached with unchanged summary text, embed new/changed summaries via `EmbeddingService.embed()`, and persist to disk. Include rate limiting consistent with `EMBEDDING_BATCH_DELAY_MS`.
- [x] **T7.** Handle summary embedding failures per-session: if `embed()` throws for one session's summary, log a warning and continue with the next session. Never abort the pass.
- [x] **T8.** Add pipeline stats counters for the embedding pass: `summariesEmbedded`, `summariesSkipped` (already cached), `summariesFailed`. Log a summary line at the end of the pass.

> **GATE — Stop and verify.** Run the summary embedding pass standalone against the current `TopicStore`. Confirm that `summary-embeddings.json` is generated, contains the expected session IDs, and each value is a 3072-length float array. Only proceed to Phase 3 once this file is validated.

### Phase 3 — Qdrant Service: Named Vectors & Schema Migration

{{HARD}}

- [x] **T9.** Update `ensureCollection()` to create collections with two named vectors: `chunk` (3072d, Cosine) and `summary` (3072d, Cosine) instead of a single anonymous vector. Collection naming stays `CXC_{HOST}_{Harness}`.
- [x] **T10.** Add `detectSchemaVersion()` helper in `QdrantService`: inspect an existing collection's vector config via `getCollectionInfo()` to distinguish legacy single-vector (`"legacy"`) from named-vector (`"v2"`) from missing (`"missing"`).
- [x] **T11.** Implement controlled recreate on schema mismatch: when `detectSchemaVersion()` returns `"legacy"`, delete the collection and recreate with V2 schema. Harness-scoped only — other collections are untouched. Skip entirely if `isQdrantUpdateSkipped()` returns `true`.
- [x] **T12.** Update `upsertPoints()` to accept named-vector point structure: `{ id, vector: { chunk: number[], summary?: number[] }, payload }`. When `summary` vector is absent for a point, omit it from the vector map (Qdrant allows sparse named vectors).
- [x] **T13.** Extend `search()` to accept a `vectorName` parameter (`"chunk"` | `"summary"`) and pass it as `vector_name` to the Qdrant client's search call. Default to `"chunk"` for backward compatibility.

### Phase 4 — Pipeline Wiring & Dual-Vector Attachment

{{MEDIUM}}

- [x] **T14.** Wire read-only `TopicStore` and `SummaryEmbeddingCache` access into `VectorPipeline` constructor. The pipeline calls `topicStore.getBySessionId(sessionId)` for payload fields and `summaryCache.get(sessionId)` for the pre-computed summary vector — **zero OpenAI calls** for summaries during chunk indexing.
- [x] **T15.** Update point construction in `VectorPipeline.processBatch()` to populate V2 payload fields: `symbols` from `message.symbols`, `dateTime` from `message.dateTime.toISO()`, `subject` from `message.subject`, plus `aiSummary`/`customTopic` from the resolved `TopicEntry`.
- [x] **T16.** Add pipeline stats counters: `summaryVectorsAttached`, `summaryCacheHits`, `summaryCacheMisses`, `payloadWithAiSummary`, `payloadWithCustomTopic`. Log these in the pipeline summary alongside existing `chunked`/`embedded`/`skipped` counts.

{{HARD}}

- [x] **T17.** In `VectorPipeline.processBatch()`, look up the pre-computed summary embedding from `SummaryEmbeddingCache` by `sessionId`. Attach both vectors to each upserted point: `{ chunk: chunkEmbedding, summary: summaryEmbedding }`. All chunks of the same message share the same summary vector. When no cached summary embedding exists, pass `{ chunk: chunkEmbedding }` only.
- [x] **T18.** Ensure the `upsertPoints()` call handles the mixed case where some points in a batch have `summary` vectors and others don't (different sessions in the same harness batch).

### Phase 5 — Search: Dual-Channel Query & Ranking

{{MEDIUM}}

- [x] **T19.** In `ContextServer` search flow (both `GET /api/search` and `POST /api/search`), embed the query once and run two sequential Qdrant searches: one on the `chunk` channel, one on the `summary` channel. Collect both result arrays.
- [x] **T20.** Before passing Qdrant hits to `SearchResults.merge()`, deduplicate by `messageId` using **max score**: when the same message appears in both chunk and summary results (or from multiple chunk hits), keep the higher score.
- [x] **T21.** Fix `SearchResults.merge()` so that when a second Qdrant hit arrives for an already-seen `messageId`, it upgrades `qdrantScore` to `max(existing, new)` and recalculates `combinedScore`. This fixes the pre-existing last-write-wins bug where a lower-scoring chunk could silently downgrade a message's ranking.
- [x] **T22.** Add graceful degradation: if summary-channel search fails (collection error, timeout), log a warning and continue with chunk-only Qdrant results merged with Fuse. Never let a summary failure suppress chunk results.

### Phase 6 — Startup Ordering & Consistency

{{MEDIUM}}

- [x] **T23.** Reorder `ContextCore.ts` startup: run AI summarization pass (`TopicSummarizer`) **before** the summary embedding pass and `VectorPipeline.processMessages()`, so that freshly generated `aiSummary` entries are available for both the summary embedding cache and payload enrichment on the first full run.
- [x] **T24.** Insert the summary embedding pass between summarization and chunk indexing in `ContextCore.ts` startup: `TopicSummarizer` → `SummaryEmbeddingCache.embedNewSummaries()` → `VectorPipeline.processMessages()`.
- [x] **T25.** Verify that `IncrementalPipeline.ingest()` already follows summary-first, vector-second ordering (it does today). Extend it to also run the summary embedding pass before calling `VectorPipeline`. Add a code comment documenting this three-step dependency.
- [x] **T26.** Add a follow-up hook for `POST /api/topics` custom topic updates: when a `customTopic` changes, invalidate (delete) the session's entry in `SummaryEmbeddingCache` and persist the cache to disk. Re-embedding happens on the next pipeline run, or immediately if targeted reindex is implemented.
- [x] **T27.** Document whichever topic-update reindex strategy is implemented as the official consistency model (inline code comment + architecture doc cross-reference).

### Phase 7 — Fallback: Mirror Collection Design

{{SIMPLE}}

- [ ] **T28.** Keep a gated fallback design ready: if named-vector creation fails at runtime, route summary embeddings from the cache into separate `CXC_{HOST}_{Harness}_S` collections using the same anonymous-vector schema and V2 payload.
- [ ] **T29.** If fallback is activated, update search to query both `_S` and primary collections per harness, then merge cross-collection by `messageId` with max score before passing to `SearchResults.merge()`.
- [ ] **T30.** Preserve identical V2 payload contract between primary (named-vector) and fallback (`_S` mirror) paths so downstream code is agnostic to which path was used.

### Phase 8 — Tests & Validation

{{MEDIUM}}

- [ ] **T31.** Unit tests for `SummaryEmbeddingCache`: verify load/save round-trip, skip-if-cached behavior, invalidation on topic change, and graceful handling of corrupt/missing cache file.
- [ ] **T32.** Unit tests for payload V2 enrichment mapping: verify `symbols`, `dateTime`, `subject`, `aiSummary`, `customTopic` are correctly populated from `AgentMessage` + `TopicStore` — including edge cases (empty symbols array, null topic entry, missing aiSummary with customTopic present).
- [ ] **T33.** Unit tests for Qdrant hit dedup with max-score semantics: verify that when two chunks of the same message have scores 0.9 and 0.7, the merged result uses 0.9. Also verify chunk-vs-summary cross-channel dedup.
- [ ] **T34.** Integration test for dual-channel query merge: mock both `chunk` and `summary` Qdrant responses, verify correct merge with Fuse results and final `combinedScore` calculation.
- [ ] **T35.** Regression test for missing-summary sessions: verify that messages without `aiSummary`/`customTopic` are indexed with chunk-only vectors and are searchable via the chunk channel without errors.

{{MEDIUM}}

- [ ] **T36.** Migration validation: create a single-vector collection, run `detectSchemaVersion()` and assert `"legacy"`, trigger recreate, verify named-vector schema exists, re-index a sample message, and search both channels.
- [ ] **T37.** End-to-end startup ordering test: verify that after a fresh run, `summary-embeddings.json` contains entries for all sessions with summaries, and Qdrant points for those sessions carry both `chunk` and `summary` vectors.

### Phase 9 — Documentation

{{SIMPLE}}

- [ ] **T38.** Update [`archi-qdrant.md`](../../architecture/search/archi-qdrant.md): payload V2 schema, named-vector collection design, summary embedding cache design, dual-channel search flow, migration strategy, max-score dedup fix.
- [ ] **T39.** Update [`archi-context-core-level0.md`](../../architecture/archi-context-core-level0.md): enriched vector metadata, startup ordering change (summarization → summary embedding cache → vector indexing), new `SummaryEmbeddingCache` module in module inventory.
- [ ] **T40.** Update [`archi-summarizer.md`](../../architecture/prose/archi-summarizer.md): add cross-reference noting that AI summaries are now consumed by the summary embedding cache and propagated to Qdrant via the vector pipeline.
- [ ] **T41.** Add operator runbook notes: how to force collection recreate (`detectSchemaVersion` + delete), how to invalidate/rebuild the summary embedding cache, how to trigger full reindex, fallback `_S` activation criteria, and rollback procedure.

---

## Risks and Mitigations

- **Risk: index size increase from second 3072d vector**
  - Mitigation: monitor collection growth via Qdrant dashboard; summary vector is per-session (shared across all chunks of all messages in the session), so overhead is bounded by session count, not chunk count.
- **Risk: score noise from multiple chunk points per message**
  - Mitigation: strict per-message max-score dedupe before `SearchResults.merge()`. This also fixes the pre-existing last-write-wins bug.
- **Risk: schema migration destroys old collection state**
  - Mitigation: deterministic full reindex from storage; harness-scoped recreate only. If crash during migration, next startup recreates cleanly.
- **Risk: stale summary metadata after topic edits**
  - Mitigation: `POST /api/topics` invalidates the session's `SummaryEmbeddingCache` entry immediately (T26). Re-embedding happens on next pipeline run.
- **Risk: summary embedding cache grows large on disk**
  - Mitigation: one 3072-float array per session. At ~25 KB per entry (JSON), 1000 sessions = ~25 MB. Manageable. Can compress or switch to binary format if needed later.
- **Risk: summary embedding pass adds startup latency**
  - Mitigation: cache is persistent — only new/changed summaries need embedding. Steady-state cost is near-zero. Rate limiting via `EMBEDDING_BATCH_DELAY_MS` prevents API bursts.
- **Risk: OpenAI embed() failure for summary text blocks chunk indexing**
  - Mitigation: summary embedding runs in a **separate pass before** chunk indexing (T7/T24). Failures are per-session and never touch the chunk pipeline. Missing cache entries simply result in chunk-only vectors.

---

## Acceptance Checklist

- [ ] Qdrant payload contains `symbols`, `dateTime`, `subject` for all newly indexed points.
- [ ] `aiSummary` and `customTopic` appear in payload when present in `TopicStore`.
- [ ] Dual-vector collection schema (named `chunk` + `summary`) exists and indexes successfully.
- [ ] `summary-embeddings.json` persists across restarts and skips already-cached sessions.
- [ ] Both `GET /api/search` and `POST /api/search` use chunk + summary semantic channels with stable ranking.
- [ ] Duplicate Qdrant hits (cross-chunk and cross-channel) cannot downgrade a message's score.
- [ ] Summary embedding failure for one session does not block chunk indexing for any message.
- [ ] Startup order: summarization → summary embedding cache → vector indexing.
- [ ] Topic change via API invalidates the affected session's cached summary embedding.
- [ ] Docs updated for architecture and operations.
