# R2QUC — Qdrant Upgrade Cleanup: Remove Migration Code

**Date**: 2026-03-21
**Status**: Planned
**Scope**: Remove destructive legacy-to-V2 schema migration from QdrantService. Simplify `ensureCollection()` to create-if-missing only. Clean up related architecture docs.
**Prerequisite**: All collections have already been migrated to V2 named-vector schema (R2BQ completed 2026-03-21).

---

## Context

The R2BQ upgrade added dual named vectors (`chunk` + `summary`) to Qdrant collections. The migration strategy chose a destructive approach: detect legacy single-vector collections → delete → recreate with V2 schema → re-index everything from scratch.

This was a mistake. It forced re-embedding of all chunks via OpenAI, wasting both money and time. The correct approach would have been to add the `summary` named vector to existing collections via Qdrant's `PUT /collections/{name}/vectors` API, preserving existing chunk embeddings.

Now that all collections are V2, the migration code serves no purpose and should be removed to prevent accidental collection destruction in the future.

---

## What To Remove

### 1. `QdrantService.detectSchemaVersion()` — DELETE

**File**: `src/vector/QdrantService.ts` (lines 157–183)

This method inspects collection vector config to distinguish `"legacy"`, `"v2"`, and `"missing"`. With all collections on V2 and no legacy collections possible going forward, this is dead code.

Also remove the `SchemaVersion` type export (line 75).

### 2. Legacy branch in `QdrantService.ensureCollection()` — SIMPLIFY

**File**: `src/vector/QdrantService.ts` (lines 192–229)

Current logic:
```
detectSchemaVersion()
  → "v2"     → no-op
  → "legacy" → DELETE collection → CREATE V2  ← REMOVE THIS
  → "missing" → CREATE V2
```

New logic:
```
try getCollection()
  → exists  → no-op (trust that it's V2)
  → throws  → CREATE V2 (chunk + summary named vectors)
```

The simplified `ensureCollection()` should:
- Try `getCollection()` to check existence
- If it exists, return immediately (no schema inspection)
- If it throws (missing), create with V2 schema
- Remove all `detectSchemaVersion()` calls

### 3. Architecture doc sections — UPDATE

**File**: `zz-reach2/architecture/search/archi-qdrant.md`

Remove or replace:
- **Section 4.4 (Schema Migration)** — replace the flowchart and table with a simple note: "Collections are always created with V2 named-vector schema. No migration logic exists."
- **Section 8.1** — remove the migration flowchart (the red "Delete legacy" node)
- **Section 14, row "Schema migration"** in the Error Isolation table — replace with "Collection missing → create fresh with V2 schema"
- **Section 18.5 (Destructive schema migration)** — delete entirely or replace with a note explaining why destructive migration was removed

---

## What To Keep

| Component | Why |
|---|---|
| `updateVectors()` in QdrantService | Used by the enhance-in-place path for summary vector backfill |
| `setPayload()` in QdrantService | Used by the enhance-in-place path for V2 payload updates |
| Enhance-in-place path in VectorPipeline | Handles `alreadyIndexed && forceReindex` without re-embedding |
| `forceSessionIds` logic in VectorPipeline + ContextCore | Drives summary backfill for sessions that gained summaries after initial indexing |
| `SummaryEmbeddingCache` (all of it) | Pre-computes and caches summary vectors, tracks sync state |
| `getIndexedMessageIds()` in QdrantService | Resume/dedup baseline — still needed |
| `forceFullEmbed` diagnostic counter | Visibility into first-time vs backfill embedding |
| Diagnostic log after baseline load | Shows force session overlap per harness |

---

## Verified: Live Ingestion Already Works

The IncrementalPipeline (`src/watcher/IncrementalPipeline.ts`, lines 188–267) already follows the correct three-step chain:

```
Step 4:  TopicSummarizer.summarizeSession()     → aiSummary in TopicStore
Step 4b: SummaryEmbeddingCache.embedNewSummaries() → summary vector cached
Step 5:  VectorPipeline.processMessages(newMsgs)   → indexes with cached summary vector
```

For new sessions ingested live, all messages are new (not in `indexedMessageIds`), so they go through the full embed path which reads the SummaryEmbeddingCache and attaches the summary vector. No `forceSessionIds` needed — the ordering guarantees the cache is populated before indexing.

**Edge case (not a blocker):** If a session was indexed at startup WITHOUT a summary (summarizer was disabled), and later a live ingest triggers summarization for that session, the old messages' Qdrant points won't get the summary vector backfilled until the next startup (when `unsyncedSessionIds` drives `forceSessionIds`). This is acceptable — startup backfill covers it.

---

## Implementation Plan

### T1. Simplify `ensureCollection()` — REMOVE migration logic

{{SIMPLE}}

- [ ] Remove `detectSchemaVersion()` method from `QdrantService.ts`
- [ ] Remove `SchemaVersion` type export
- [ ] Simplify `ensureCollection()` to: try `getCollection()` → exists? no-op. Throws? Create V2.
- [ ] Remove all log lines about "legacy" or "migrating"

### T2. Update architecture docs

{{SIMPLE}}

- [ ] Update `archi-qdrant.md` sections 4.4, 8.1, 14, and 18.5 as described above
- [ ] Update `r2bq-better-qdrant.md` Migration Strategy section with a note that destructive migration was removed post-completion

### T3. Verify no other code references migration

{{SIMPLE}}

- [ ] Grep for `detectSchemaVersion`, `SchemaVersion`, `"legacy"` in `src/` to confirm no remaining references
- [ ] Grep for `deleteCollection` in `src/` to confirm it's only used in migration (and remove if so)
