/**
 * GlobalSettingsStore tests for machine-scoped ingest metadata.
 *
 * Architecture: server/zz-reach2/architecture/archi-context-core-level0.md
 * Upgrade plan: server/zz-reach2/upgrades/2026-06/r2so2-startup-optimization2.md
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GlobalSettingsStore } from "../GlobalSettingsStore.js";

/**
 * Runs a test against an isolated temporary CXC storage root.
 * @param fn - Test body that receives the storage root.
 */
function withTempStorage(fn: (dir: string) => void): void
{
	const dir = mkdtempSync(join(tmpdir(), "cc-global-settings-"));
	try
	{
		fn(dir);
	}
	finally
	{
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("GlobalSettingsStore ingest bookmarks", () =>
{
	test("loads empty settings with a v3 active-machine ingest container", () =>
	{
		withTempStorage((dir) =>
		{
			const store = new GlobalSettingsStore(dir, "SUSAN2");
			store.load();

			expect(store.getActiveMachineName()).toBe("SUSAN2");
			expect(store.getCursorCheckpoint()).toEqual({ cursorDiskKVRowId: 0, itemTableRowId: 0 });
			expect(store.getHarnessBookmark("Cursor")).toBeNull();
			expect(store.isRunInProgress()).toBe(false);
		});
	});

	test("drops old global Cursor state instead of migrating it", () =>
	{
		withTempStorage((dir) =>
		{
			const settingsDir = join(dir, ".settings");
			mkdirSync(settingsDir, { recursive: true });
			writeFileSync(
				join(settingsDir, "global-settings.json"),
				JSON.stringify({
					cursor: {
						lastQueriedAt: "2026-06-01T10:00:00.000Z",
						cursorDiskKVRowId: 42,
						itemTableRowId: 7,
					},
				}),
				"utf-8"
			);

			const store = new GlobalSettingsStore(dir, "SUSAN2");
			store.load();

			expect(store.getCursorCheckpoint()).toEqual({ cursorDiskKVRowId: 0, itemTableRowId: 0 });
			expect(store.getHarnessBookmark("Cursor")).toBeNull();
		});
	});

	test("recovers from invalid JSON and can save active-machine harness state", () =>
	{
		withTempStorage((dir) =>
		{
			const settingsDir = join(dir, ".settings");
			mkdirSync(settingsDir, { recursive: true });
			writeFileSync(join(settingsDir, "global-settings.json"), "{nope", "utf-8");

			const store = new GlobalSettingsStore(dir, "SUSAN2");
			store.load();
			store.commitHarnessBookmark("ClaudeCode", {
				mode: "file-manifest",
				parserEpoch: 1,
				sourcePathHash: "abc",
				lastSuccessfulIngestAt: "2026-06-08T00:00:00.000Z",
			});

			const reloaded = new GlobalSettingsStore(dir, "SUSAN2");
			reloaded.load();
			expect(reloaded.getHarnessBookmark("ClaudeCode")).toMatchObject({
				mode: "file-manifest",
				parserEpoch: 1,
				sourcePathHash: "abc",
			});

			const parsed = JSON.parse(readFileSync(join(settingsDir, "global-settings.json"), "utf-8")) as {
				schemaVersion?: number;
				ingest?: { machines?: Record<string, unknown> };
			};
			expect(parsed.schemaVersion).toBe(3);
			expect(parsed.ingest?.machines?.SUSAN2).toBeTruthy();
		});
	});

	test("keeps machine bookmarks isolated in the synced settings file", () =>
	{
		withTempStorage((dir) =>
		{
			const susan = new GlobalSettingsStore(dir, "SUSAN2");
			susan.load();
			susan.commitHarnessBookmark("Cursor", {
				mode: "rowid",
				parserEpoch: 1,
				rowids: { cursorDiskKV: 10, ItemTable: 1 },
			});

			const kyliathy = new GlobalSettingsStore(dir, "Kyliathy3");
			kyliathy.load();
			kyliathy.commitHarnessBookmark("Cursor", {
				mode: "rowid",
				parserEpoch: 1,
				rowids: { cursorDiskKV: 99, ItemTable: 2 },
			});

			const reloadedSusan = new GlobalSettingsStore(dir, "SUSAN2");
			reloadedSusan.load();
			const reloadedKyliathy = new GlobalSettingsStore(dir, "Kyliathy3");
			reloadedKyliathy.load();

			expect(reloadedSusan.getCursorCheckpoint()).toEqual({ cursorDiskKVRowId: 10, itemTableRowId: 1 });
			expect(reloadedKyliathy.getCursorCheckpoint()).toEqual({ cursorDiskKVRowId: 99, itemTableRowId: 2 });
		});
	});

	test("merge-on-save preserves different machines from stores loaded concurrently", () =>
	{
		withTempStorage((dir) =>
		{
			const susan = new GlobalSettingsStore(dir, "SUSAN2");
			const kyliathy = new GlobalSettingsStore(dir, "Kyliathy3");
			susan.load();
			kyliathy.load();

			susan.commitHarnessBookmark("Cursor", {
				mode: "rowid",
				rowids: { cursorDiskKV: 10, ItemTable: 1 },
			});
			kyliathy.commitHarnessBookmark("Cursor", {
				mode: "rowid",
				rowids: { cursorDiskKV: 99, ItemTable: 2 },
			});

			const reloadedSusan = new GlobalSettingsStore(dir, "SUSAN2");
			reloadedSusan.load();
			const reloadedKyliathy = new GlobalSettingsStore(dir, "Kyliathy3");
			reloadedKyliathy.load();

			expect(reloadedSusan.getCursorCheckpoint()).toEqual({ cursorDiskKVRowId: 10, itemTableRowId: 1 });
			expect(reloadedKyliathy.getCursorCheckpoint()).toEqual({ cursorDiskKVRowId: 99, itemTableRowId: 2 });
		});
	});

	test("merge-on-save preserves different harnesses for the same machine", () =>
	{
		withTempStorage((dir) =>
		{
			const first = new GlobalSettingsStore(dir, "SUSAN2");
			const second = new GlobalSettingsStore(dir, "SUSAN2");
			first.load();
			second.load();

			first.commitHarnessBookmark("Cursor", {
				mode: "rowid",
				rowids: { cursorDiskKV: 10, ItemTable: 1 },
			});
			second.commitHarnessBookmark("ClaudeCode", {
				mode: "file-manifest",
				parserEpoch: 1,
				sourcePathHash: "claude",
			});

			const reloaded = new GlobalSettingsStore(dir, "SUSAN2");
			reloaded.load();

			expect(reloaded.getHarnessBookmark("Cursor")).toMatchObject({
				rowids: { cursorDiskKV: 10, ItemTable: 1 },
			});
			expect(reloaded.getHarnessBookmark("ClaudeCode")).toMatchObject({
				sourcePathHash: "claude",
			});
		});
	});

	test("clearStaleIngestRun clears only the active machine run flag and keeps bookmarks", () =>
	{
		withTempStorage((dir) =>
		{
			const store = new GlobalSettingsStore(dir, "SUSAN2");
			store.load();
			store.beginIngestRun(new Date("2026-06-08T01:00:00.000Z"));
			store.commitHarnessBookmark("Cursor", {
				mode: "rowid",
				parserEpoch: 1,
				lastSuccessfulIngestAt: "2026-06-08T00:00:00.000Z",
				rowids: { cursorDiskKV: 42, ItemTable: 7 },
			});

			store.clearStaleIngestRun();

			const reloaded = new GlobalSettingsStore(dir, "SUSAN2");
			reloaded.load();
			expect(reloaded.isRunInProgress()).toBe(false);
			expect(reloaded.getHarnessBookmark("Cursor")).toMatchObject({
				rowids: { cursorDiskKV: 42, ItemTable: 7 },
			});
		});
	});

	test("beginIngestRun and endIngestRun persist active-machine run state and db fingerprint", () =>
	{
		withTempStorage((dir) =>
		{
			const store = new GlobalSettingsStore(dir, "SUSAN2");
			store.load();
			const runId = store.beginIngestRun(new Date("2026-06-08T01:00:00.000Z"));
			expect(store.isRunInProgress()).toBe(true);

			store.endIngestRun(
				true,
				{
					databaseFile: join(dir, "db.sqlite"),
					messageCount: 10,
					sessionCount: 2,
					fileMtimeMs: 1,
					fileSizeBytes: 2,
					harnessCounts: { Cursor: 10 },
				},
				new Date("2026-06-08T01:01:00.000Z"),
				runId
			);

			const reloaded = new GlobalSettingsStore(dir, "SUSAN2");
			reloaded.load();
			expect(reloaded.isRunInProgress()).toBe(false);
			expect(reloaded.getDbFingerprint()).toMatchObject({
				messageCount: 10,
				sessionCount: 2,
				harnessCounts: { Cursor: 10 },
			});
		});
	});

	test("db fingerprints are local to each active machine", () =>
	{
		withTempStorage((dir) =>
		{
			const susan = new GlobalSettingsStore(dir, "SUSAN2");
			susan.load();
			susan.beginIngestRun(new Date("2026-06-08T01:00:00.000Z"));
			susan.endIngestRun(true, {
				databaseFile: join(dir, "susan.sqlite"),
				messageCount: 10,
				sessionCount: 2,
				fileMtimeMs: 1,
				fileSizeBytes: 2,
				harnessCounts: { Cursor: 10 },
			});

			const kyliathy = new GlobalSettingsStore(dir, "Kyliathy3");
			kyliathy.load();
			kyliathy.beginIngestRun(new Date("2026-06-08T02:00:00.000Z"));
			kyliathy.endIngestRun(true, {
				databaseFile: join(dir, "kyliathy.sqlite"),
				messageCount: 99,
				sessionCount: 9,
				fileMtimeMs: 3,
				fileSizeBytes: 4,
				harnessCounts: { Cursor: 99 },
			});

			const reloadedSusan = new GlobalSettingsStore(dir, "SUSAN2");
			reloadedSusan.load();
			const reloadedKyliathy = new GlobalSettingsStore(dir, "Kyliathy3");
			reloadedKyliathy.load();

			expect(reloadedSusan.getDbFingerprint()).toMatchObject({
				databaseFile: join(dir, "susan.sqlite"),
				messageCount: 10,
			});
			expect(reloadedKyliathy.getDbFingerprint()).toMatchObject({
				databaseFile: join(dir, "kyliathy.sqlite"),
				messageCount: 99,
			});
		});
	});
});
