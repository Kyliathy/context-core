# R2SO2 - Startup Optimization Follow-up

**Date**: 2026-06-19
**Status**: Implemented locally; live two-machine verification still pending
**Predecessor**: [`r2so-startup-optimization.md`](r2so-startup-optimization.md)
**Note**: [`r2so-startup-optimization-status.md`](r2so-startup-optimization-status.md) is historical/stale and should not be used as the implementation source of truth.

## Goal

R2SO is considered code-complete for the first startup optimization pass. R2SO2 fixes the remaining live-use failure mode: multiple machines share/sync the CXC storage tree and settings, but each machine has its own local database files because `cxc-db.sqlite`, WAL, SHM, and related DB files are ignored by the sync system.

The important correction: **the database is not shared**. The shared/synced coordination surface is the JSON storage and `.settings` metadata, especially `global-settings.json`.

The outcome:

- Harness ingest status is stored per machine.
- DB fingerprints are stored and validated per machine because DB files are local-only.
- One machine cannot make another machine see Cursor rowid regression.
- One interrupted run cannot make another machine perform recovery-full startup.
- Cursor full/recovery reads can resume from the last page that was durably persisted to storage/DB.

## Current Evidence

From `server/cc.json`:

- `storage` and `databaseFile` point into `d:\Codez\Nexus\design\CXC`, but the DB files themselves are ignored by sync.
- The machine entries are `Kyliathy3` and `SUSAN2`.
- Both machines use the same configured Cursor path string: `c:\Users\Axonn\AppData\Roaming\Cursor\User\globalStorage\state.vscdb`, but those are different local physical databases when run on different machines.
- File harness source path sets differ by machine, especially ClaudeCode and VSCode.
- `Kyliathy3` currently includes `Antigravity`, but the registry has no active reader for it.

Observed logs:

- `ClaudeCode` and `VSCode` can enter `recovery-full` because `source path config changed`, which is expected if a bookmark from one machine is read as if it belonged to the other machine.
- `Cursor` enters `recovery-full` because `rowid regressed for cursorDiskKV`, which strongly suggests a bookmark from another physical Cursor DB was applied to this machine.
- `DB fingerprint invalid: database harness count regressed for Cursor` currently resets all ingest bookmarks, which is wrong when DB files are local-only and settings are shared.
- `runInProgress` is global, so one interrupted process can push every machine into conservative recovery.

Static/code findings carried into implementation:

- `r2so-startup-optimization.md` Groups 1-19 are largely implemented.
- Group 20 live/manual verification remains incomplete.
- `bun run typecheck` passes.
- The old `cursorWorkspace.test.ts` console interception issue was fixed by asserting paging behavior directly.
- `readCursorChatsBatched()` now treats bubble rows as the authoritative bounded startup source; the legacy ItemTable fallback warning was demoted.
- OpenCode batched startup readers no longer retain a whole-result `emitted` array for callback persistence.

## Latest Retest Finding - Cursor Progress Was Saved but Ignored

Kyliathy3 was interrupted several times during Cursor full/recovery startup between `2026-06-19 02:06` and `2026-06-19 02:21`. The logs kept showing:

```text
Cursor: action=recovery-full, reason=DB fingerprint missing or invalid, scope=full
```

Backups were inspected by last-write timestamp before reading their JSON contents:

- `global-settings.json`: `2026-06-19 02:21:47`, length `2400`.
- `global-settings.json222`: `2026-06-19 02:10:47`, length `2391`.
- `global-settings.json33333`: `2026-06-19 02:15:13`, length `2400`.
- `global-settings.json44444`: `2026-06-19 02:21:55`, length `2400`.

The backups proved that the Cursor progress bookmark was being persisted. Example active state:

```text
machine=Kyliathy3
runInProgress=true
dbFingerprint=false
Cursor progress.mode=recovery-full
durableCursorDiskKVRowId=161027
targetCursorDiskKVRowId=254836
```

Root cause: `planCursor()` checked `dbFingerprintValid` before checking durable Cursor progress. During an interrupted first rebuild there is no completed DB fingerprint yet, so the missing/invalid fingerprint branch always won and forced `recovery-full` from rowid `0`, even though `progress.durableCursorDiskKVRowId` was available.

Fix: Cursor now validates bookmark basics and active-machine source identity first, then resumes from durable progress when `runInProgress=true`. The DB fingerprint recovery branch still applies when there is no usable Cursor progress. Expected restart log from the active Kyliathy3 settings after the fix:

```text
Cursor: action=resume-recovery, reason=previous Cursor ingest interrupted; resuming from durable page progress, scope=sinceCursorRowId=161027
```

## Design Direction

Use a per-machine ingest object. No backwards-compatibility migration is required; it is acceptable to reset old ingest metadata and local DBs if needed.

Target shape:

```ts
type GlobalSettingsV3 = {
  schemaVersion: 3;
  ingest: {
    machines: Record<string, MachineIngestState>;
  };
};

type MachineIngestState = {
  runInProgress?: {
    runId: string;
    startedAt: string;
  } | null;
  lastSuccessfulRunAt?: string | null;
  dbFingerprint?: MachineDbFingerprint;
  harnesses: Record<string, HarnessBookmark>;
};

type MachineDbFingerprint = {
  databaseFile: string;
  messageCount: number;
  sessionCount: number;
  fileMtimeMs: number;
  fileSizeBytes: number;
  harnessCounts: Record<string, number>;
};

type CursorBookmark = HarnessBookmark & {
  mode: "rowid";
  sourceIdentity: {
    machineName: string;
    sourceKind: "cursor-state-vscdb";
    path: string;
    sizeBytes: number;
    mtimeMs: number;
  };
  rowids: {
    cursorDiskKV: number;
    ItemTable: number;
  };
  progress?: {
    mode: "full" | "recovery-full" | "rowid-delta" | "resume-full" | "resume-recovery";
    targetCursorDiskKVRowId: number;
    targetItemTableRowId: number;
    durableCursorDiskKVRowId: number;
    durableItemTableRowId: number;
    updatedAt: string;
  };
};
```

The implementation can keep this in `global-settings.json` under `ingest.machines`, or use separate synced files like `.settings/ingest/{machine}.json`. The key rule is the same either way: **harness ingest status belongs to a machine**.

{{MEDIUM}}
## Group 1 - Per-Machine Ingest State

- [X] **T1.** Replace the single global `ingest.harnesses` map with `ingest.machines[machineName].harnesses`.
- [X] **T2.** Scope `runInProgress`, `runInProgressStartedAt`, `lastSuccessfulRunAt`, and `dbFingerprint` under the active machine.
- [X] **T3.** Ensure `planStartupHarness()` reads only the active machine's harness bookmark.
- [X] **T4.** Ensure `commitHarnessBookmark()` writes only the active machine's harness bookmark.
- [X] **T5.** Ensure `resetHarnessBookmark()` defaults to the active machine only.
- [X] **T6.** Ensure `resetAllIngestBookmarks()` means active-machine reset unless a command explicitly requests global reset.
- [X] **T7.** Keep file manifests machine-named and store each manifest path only under that machine's bookmark.
- [X] **T8.** Treat unregistered harnesses such as disabled `Antigravity` as `disabled` or `unsupported`, not as recovery-full work.

{{SIMPLE}}
## Group 2 - Clean Reset Instead of Migration

- [X] **T9.** Add a clean schema reset path that discards old global ingest metadata and initializes `schemaVersion: 3` with an empty `ingest.machines` object.
- [X] **T10.** Do not implement v1/v2 backwards-compatibility migration unless a real need appears later.
- [X] **T11.** Add a clear operator note: after R2SO2 lands, old local DBs and old ingest bookmarks may be wiped/rebuilt.
- [X] **T12.** Keep existing storage JSON untouched; only local DB files and `.settings` ingest metadata are disposable.
- [X] **T13.** Ensure first startup after reset rebuilds the local DB from storage before planning harness ingest.
- [X] **T14.** Ensure each machine establishes fresh Cursor/file-harness bookmarks after its own successful startup.

{{MEDIUM}}
## Group 3 - Settings Writes in a Synced Folder

- [X] **T15.** Make settings writes atomic: write temp file, then rename into place.
- [X] **T16.** Add merge-on-save for `ingest.machines` so one machine updating its object does not erase another machine's object.
- [X] **T17.** Track last-loaded mtime or revision; if `global-settings.json` changed since load, reload and merge before saving.
- [X] **T18.** Add per-run IDs so a process only clears the `runInProgress` marker it created.
- [X] **T19.** Add tests for two `GlobalSettingsStore` instances updating different machines.
- [X] **T20.** Add tests for two `GlobalSettingsStore` instances updating different harnesses under the same machine.
- [X] **T21.** Audit startup and CLI commands for any `cc.json` writes; startup must never mutate `cc.json`.

{{MEDIUM}}
## Group 4 - Local DB Fingerprint Rules

- [X] **T22.** Treat DB fingerprint as local to `ingest.machines[machineName]`.
- [X] **T23.** Never compare the active machine's DB fingerprint against another machine's stored fingerprint.
- [X] **T24.** Stop resetting all machines' ingest bookmarks when one local DB fingerprint fails.
- [X] **T25.** On local DB fingerprint failure, invalidate only the active machine's DB-dependent decisions.
- [X] **T26.** Because DB files are not synced, treat per-harness count drift as local evidence only.
- [X] **T27.** Use true local DB wipe signals for local recovery: missing DB file, invalid schema, missing `AgentMessages`, or counts below a local lower bound after storage reload.
- [X] **T28.** When local DB fingerprint is suspicious, reload/reconcile storage before invalidating Cursor bookmarks.
- [X] **T29.** Add tests where `SUSAN2` has one local DB count and `Kyliathy3` has another; neither machine should reset the other's bookmarks.
- [X] **T30.** Add tests for true local DB wipe/replacement; only that machine should rebuild.

{{MEDIUM}}
## Group 5 - Cursor Source Identity and Rowid Planning

- [X] **T31.** Include `machineName` in Cursor source identity so identical path strings on different machines are never treated as the same source.
- [X] **T32.** Validate Cursor source identity using active machine name, path, size, and mtime.
- [X] **T33.** Rowid regression should only compare live rowids against the active machine's own Cursor bookmark.
- [X] **T34.** If another machine has higher Cursor rowids, ignore them for this machine.
- [X] **T35.** If this machine's live rowid is lower than its own bookmark and source identity changed, treat it as local Cursor DB replacement.
- [X] **T36.** If this machine's live rowid is lower than its own bookmark and source identity did not change, log a high-signal local warning and choose conservative Cursor-only recovery.
- [X] **T37.** Add planner tests for the same Cursor path string across two machine names with different rowid maxima.
- [X] **T38.** Add planner tests for `source path config changed` on one machine without affecting the other machine.

{{MEDIUM}}
## Group 6 - Resumable Cursor Full/Recovery Reads

- [X] **T39.** Persist Cursor page progress after each successfully persisted batch during full/recovery reads, not only after the full reader returns.
- [X] **T40.** Store `durableCursorDiskKVRowId`, `durableItemTableRowId`, and target max rowids in the active machine's Cursor bookmark.
- [X] **T41.** On interrupted full/recovery startup, resume from `durableCursorDiskKVRowId` when source identity and target rowids still match.
- [X] **T42.** Add a distinct startup action such as `resume-full` or `resume-recovery` so logs clearly show that CXC is not starting from rowid 0.
- [X] **T43.** Do not mark the final Cursor checkpoint complete until the reader emits the final empty batch and all prior batches persisted.
- [X] **T44.** If a page persists zero new messages because the rows were already saved in DB/storage, still advance durable progress for that page after storage/DB checks succeed.
- [X] **T45.** If the process dies after DB insert but before progress commit, the next run may replay that page; dedupe must make that replay cheap and safe.
- [X] **T46.** On resume, seed Cursor parent-chain state from existing DB messages for active sessions so sessions spanning an interrupted page boundary keep stable parent IDs.
- [X] **T47.** Add a test that throws after page N, restarts, and proves the next run starts at page N+1 or safely replays only page N.
- [X] **T48.** Add a test for a session spanning the interruption boundary and verify parent IDs remain correct.
- [X] **T49.** Add a test that no resumed Cursor batch exceeds `CURSOR_INGEST_BATCH_SIZE`.

{{MEDIUM}}
## Group 7 - Cursor Reader Completeness and Memory Safety

- [X] **T50.** Decide whether ItemTable fallback is still required for current Cursor data.
- [X] **T51.** If ItemTable fallback is required, implement it in the batched Cursor reader with bounded page reads and durable progress.
- [X] **T52.** If ItemTable fallback is obsolete, remove or demote the legacy full-reader fallback warning and document why bubble rows are authoritative.
- [X] **T53.** Ensure `readCursorChatsBatched()` does not retain whole-corpus message arrays in any path.
- [X] **T54.** Verify `buildCursorSessionModelMap()` and `buildCursorSessionTimestampMap()` do not become the next large memory sink for multi-GB Cursor DBs.
- [X] **T55.** Add bounded or lazy alternatives for session model/timestamp maps if they load too much data.
- [X] **T56.** Add peak RSS logging around Cursor page reads, workspace inference, raw archive writes, and batch persistence.
- [X] **T57.** Add a forced-full large Cursor verification gate that reports max page size, emitted batch size, elapsed time, and peak RSS.

{{SIMPLE}}
## Group 8 - OpenCode and Test Cleanup

- [X] **T58.** Remove the `emitted` whole-result accumulation from OpenCode batched startup readers when the caller uses callback persistence.
- [X] **T59.** Keep a compatibility wrapper only if tests or legacy callers still explicitly need accumulated OpenCode messages.
- [X] **T60.** Fix `cursorWorkspace.test.ts` so it captures logger output or asserts paging behavior directly instead of intercepting `console.log`.
- [X] **T61.** Add tests for `runInProgress` scoped to machine A while machine B starts normally.
- [X] **T62.** Add tests for machine A interrupting Cursor full/recovery while machine B keeps its existing Cursor skip/delta bookmark.
- [X] **T63.** Run `bun run typecheck`.
- [X] **T64.** Run the focused ingest/settings/harness/watcher tests.
- [X] **T65.** Run the full `bun test` script after focused tests are green.

{{MEDIUM}}
## Group 9 - Operator Tools and Live Verification

- [X] **T66.** Update `bun run cxccli ingest-status` to show per-machine ingest state and mark the active machine clearly.
- [X] **T67.** Add `bun run cxccli ingest-status --all-machines`.
- [X] **T68.** Add `bun run cxccli reset-ingest --machine <name> --harness Cursor`.
- [X] **T69.** Require `--global` for any command that clears every machine's ingest state.
- [X] **T70.** Add Cursor progress output: live max rowids, durable progress rowids, final checkpoint rowids, source identity, and resume target.
- [ ] **T71.** On `SUSAN2`, wipe/reset old ingest metadata, start CXC, let startup complete, and capture `ingest-status --json`.
- [ ] **T72.** On `Kyliathy3`, wipe/reset old ingest metadata, start CXC, let startup complete, and capture `ingest-status --json`.
- [ ] **T73.** Restart `SUSAN2` after `Kyliathy3` completed; Cursor must skip or delta, not recovery-full due to rowid regression.
- [ ] **T74.** Restart `Kyliathy3` after `SUSAN2` completed; Cursor must skip or delta, not recovery-full due to rowid regression.
- [ ] **T75.** Run both machines at the same time against synced storage and confirm settings writes do not erase the other machine's ingest state.
- [ ] **T76.** Interrupt Cursor full/recovery after at least one persisted page, restart the same machine, and confirm resume starts after the durable rowid or safely replays only the last uncommitted page.
- [ ] **T77.** Confirm file harnesses no longer recovery-full because a different machine has a different ClaudeCode or VSCode path set.
- [ ] **T78.** Confirm local DB fingerprint warnings no longer reset every machine's bookmarks.

{{SIMPLE}}
## Group 10 - Post-Retest Cursor Resume Regression

- [X] **T79.** Inspect `global-settings.json*` backup timestamps before reading backup contents.
- [X] **T80.** Confirm interrupted Kyliathy3 runs were persisting Cursor `progress` in the active machine bookmark.
- [X] **T81.** Identify the planner ordering bug where `DB fingerprint missing or invalid` won before the Cursor resume-progress branch.
- [X] **T82.** Move Cursor resume planning ahead of the DB fingerprint recovery branch while still validating active-machine bookmark basics and source identity.
- [X] **T83.** Add a planner regression where `runInProgress=true`, `dbFingerprintValid=false`, and Cursor durable progress produces `resume-recovery`.
- [X] **T84.** Update the coordinator resume regression so the second run resumes even when the DB fingerprint is not yet valid.
- [X] **T85.** Re-run focused startup planner/coordinator tests, `bun run typecheck`, and the full `bun run test` suite.
- [ ] **T86.** Live-retake Kyliathy3 from the current interrupted settings state and confirm the next Cursor plan logs `action=resume-recovery` with `scope=sinceCursorRowId=161027` instead of `recovery-full`.

## Acceptance Criteria

- Harness ingest status is stored per machine.
- DB fingerprint state is stored and validated per machine because DB files are local-only.
- One machine cannot cause another machine's Cursor bookmark to regress.
- One machine cannot reset another machine's ingest state because of local DB/source mismatch.
- Settings writes are atomic and merge-safe in the synced `.settings` folder.
- Cursor full/recovery reads are resumable from the last persisted page.
- Interrupted Cursor startup never discards already persisted page progress.
- Missing DB fingerprint on an interrupted first rebuild does not suppress a valid Cursor resume-progress bookmark.
- Cursor steady-state restart performs no full source read on either `SUSAN2` or `Kyliathy3`.
- File harnesses do not recovery-full because another machine has different configured paths.
