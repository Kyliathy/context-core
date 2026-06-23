# R2BS - Better Symbols (Clean Rebuild + Per-Message Storage)

**Date**: 2026-03-21  
**Status**: Planned  
**Scope**: Populate `AgentMessage.symbols` for every message using SubjectGenerator-style heuristics, remove the top-10 cap for stored symbols, and rebuild from scratch after cache/storage wipe.

---

## Goal

Today, `AgentMessage.symbols` is effectively unused (`[]`), while symbol extraction only feeds the session `subject` string.  
This upgrade makes `symbols` a first-class per-message field:

1. Extract symbols from each message text.
2. Store all detected symbols (not capped to 10) in `AgentMessage.symbols`.
3. Wipe processed cache/storage as needed and re-run ingestion.
4. Rebuild the DB so search/indexing immediately uses the new symbols.

---

## Success Criteria

- Every persisted message has `symbols` populated from its own `message` text (empty only when no symbols are detected).
- Stored symbols are **not limited to 10**.
- Freshly rebuilt storage corpus reflects populated symbols.
- Database rows reflect rebuilt symbol arrays after clean reload.
- `/api/search` symbol-weighted matching improves measurably on symbol-only queries.

---

## Design Decisions

- `subject` generation remains capped/formatted for readability; this plan targets `message.symbols` only.
- Stored symbol lists are per-message and deduplicated within each message.
- Extraction logic is centralized in analysis utilities (single source of truth), then reused by:
  - write-time ingestion
  - tests
- Rollout uses clean wipe + full ingestion rebuild; no in-place migration of legacy session JSON is required.

---

## Implementation Plan

### Group 1 - Symbol Contract & Utility Surface

{{MEDIUM}}

- [ ] **T1.** Define the symbol contract in code comments/docs: what counts as a symbol (identifier-like tokens, contextual declarations, member-access parts), what does not.
- [ ] **T2.** In `src/analysis/SubjectGenerator.ts`, expose a reusable public API for per-message extraction (e.g., `extractMessageSymbols(text: string): string[]`).
- [ ] **T3.** Ensure the per-message API returns **all** extracted symbols (no slot-filling and no top-10 truncation).
- [ ] **T4.** Preserve deterministic output ordering (stable frequency sort + lexical tie-break) so repeated runs produce identical arrays.
- [ ] **T5.** Keep `generateSubject()` behavior compatible with existing subject formatting while internally reusing shared symbol extraction helpers where possible.

### Group 2 - Populate Symbols During Normal Ingestion

{{MEDIUM}}

- [ ] **T6.** Add symbol hydration in the main ingest path before serialization (centralized location, not duplicated across harnesses).
- [ ] **T7.** Update `StorageWriter.writeSession()` or equivalent pre-write stage to set `message.symbols = extractMessageSymbols(message.message)` for each message.
- [ ] **T8.** Ensure role handling is explicit (`user`/`assistant`/`tool`/`system`) and safe for empty or whitespace-only `message.message`.
- [ ] **T9.** Confirm symbol hydration also applies to incremental watcher writes (`IncrementalPipeline` path) so live updates match cold-start ingestion.
- [ ] **T10.** Add logging counters for symbol hydration (`messagesWithSymbols`, `totalSymbolsExtracted`) in pipeline summaries.

### Group 3 - Clean Rebuild Flow

{{SIMPLE}}

- [ ] **T11.** Document exact wipe targets for rebuild (`{storage}/{machine}/...` processed outputs and DB file), while preserving `-RAW` and `.settings` unless explicitly requested otherwise.
- [ ] **T12.** Add/verify one canonical rebuild command sequence (`bun run start` or equivalent) that performs full harness ingestion and writes fresh session JSON.
- [ ] **T13.** Add startup logging callouts for rebuild mode (messages written, sessions written, symbols populated).
- [ ] **T14.** Verify idempotence after rebuild: second run with unchanged sources should produce no semantic drift in symbol arrays.

### Group 4 - DB Rebuild Validation

{{MEDIUM}}

- [ ] **T15.** Validate disk DB mode after wipe/rebuild: loaded rows include populated `symbols`.
- [ ] **T16.** Validate in-memory DB mode path similarly.
- [ ] **T17.** Confirm no migration/upsert code path is required when running clean rebuild only.
- [ ] **T18.** Add a short operator note: if symbols heuristics change again, prefer wipe+rebuild over in-place mutation.

### Group 5 - Search, API, and MCP Verification

{{MEDIUM}}

- [ ] **T19.** Verify `searchEngine` index input now receives populated `message.symbols` for newly rebuilt messages.
- [ ] **T20.** Add/extend tests in `src/mcp/tests/search.test.ts` for symbol-only queries now matching via populated `symbols`.
- [ ] **T21.** Validate thread/message endpoints serialize updated symbol arrays correctly (`AgentMessage.serialize()` path).
- [ ] **T22.** Verify MCP search tools (`search_messages`, `search_threads`) reflect improved symbol recall.
- [ ] **T23.** Benchmark startup/index-time delta with populated symbols and document any impact.

### Group 6 - Documentation & Rollout

{{SIMPLE}}

- [ ] **T24.** Update architecture docs that currently claim `symbols` is always `[]`:
- [ ] **T25.** `zz-reach2/architecture/archi-context-core-level0.md`
- [ ] **T26.** `zz-reach2/architecture/harness/archi-harness.md`
- [ ] **T27.** Add an operational runbook section: exact command sequence for clean wipe + rebuild rollout in production/dev.
- [ ] **T28.** Include lightweight rollback instructions (restore previous DB/storage snapshot if needed).
- [ ] **T29.** Mark this plan as completed only after clean rebuild + DB reload + search verification all pass.

---

## Execution Order (Recommended)

1. Group 1 (contract/utilities)  
2. Group 2 (live ingestion population)  
3. Group 3 (clean rebuild flow)  
4. Group 4 (DB rebuild validation)  
5. Group 5 (search/API verification)  
6. Group 6 (docs + runbook)

---

## Risks & Mitigations

- **Risk: stale DB rows after partial refresh**
  - Mitigation: only support clean wipe + rebuild for this rollout (no partial in-place migration path).
- **Risk: storage size growth**
  - Mitigation: per-message symbol deduplication and deterministic extraction (no placeholder padding in `symbols` arrays).
- **Risk: noisy symbols from prose**
  - Mitigation: maintain contextual weighting and add regression tests for precision-sensitive symbol queries.
- **Risk: long-running full rebuild on large corpora**
  - Mitigation: explicit operator runbook, progress logging, and optional harness-by-harness execution if needed.

---

## Acceptance Checklist

- [ ] New messages written by pipeline have non-empty `symbols` when symbol-bearing text exists.
- [ ] Clean rebuilt storage contains populated symbols.
- [ ] DB reflects rebuilt symbols without duplicate rows.
- [ ] `/api/search` returns improved results for identifier-driven queries.
- [ ] Architecture docs no longer describe `symbols` as always empty.
