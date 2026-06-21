/**
 * StartupPlanner tests for machine-scoped startup ingest decisions.
 *
 * Architecture: server/zz-reach2/architecture/archi-context-core-level0.md
 * Upgrade plan: server/zz-reach2/upgrades/2026-06/r2so2-startup-optimization2.md
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { InMemoryMessageStore } from "../../db/InMemoryMessageStore.js";
import { collectSourceIdentity } from "../BookmarkValidation.js";
import { getHarnessParserEpoch, hashHarnessPaths } from "../IngestConfig.js";
import { GlobalSettingsStore } from "../../settings/GlobalSettingsStore.js";
import { planStartupHarness } from "../StartupPlanner.js";

/**
 * Creates a tiny Cursor SQLite fixture with one bubble row.
 * @param dir - Temporary directory for the SQLite file.
 * @returns Path to the created Cursor database.
 */
function createCursorDb(dir: string): string
{
	mkdirSync(dir, { recursive: true });
	const dbPath = join(dir, "state.vscdb");
	const db = new Database(dbPath);
	try
	{
		db.run("CREATE TABLE cursorDiskKV (key TEXT, value TEXT)");
		db.run("CREATE TABLE ItemTable (key TEXT, value TEXT)");
		db.query<unknown, [string, string]>("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run("bubbleId:s1:b1", "{}");
	}
	finally
	{
		db.close();
	}
	return dbPath;
}

/**
 * Creates a tiny OpenCode SQLite fixture with one session and N messages.
 * @param dir - Temporary directory for the SQLite file.
 * @param messageCount - Number of message/part rows to create.
 * @returns Path to the created OpenCode database.
 */
function createOpenCodeDb(dir: string, messageCount = 1): string
{
	mkdirSync(dir, { recursive: true });
	const dbPath = join(dir, "opencode.db");
	const db = new Database(dbPath);
	try
	{
		db.run("CREATE TABLE session (id TEXT, project_id TEXT, directory TEXT, title TEXT, slug TEXT, time_created INTEGER, time_updated INTEGER)");
		db.run("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)");
		db.run("CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
		db.query<unknown, [string, string, string, string, string, number, number]>("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)").run("s1", "p", "C:/repo/app", "t", "slug", 1000, 1000);
		const messageInsert = db.query<unknown, [string, string, number, number, string]>("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
		const partInsert = db.query<unknown, [string, string, string, number, string]>("INSERT INTO part VALUES (?, ?, ?, ?, ?)");
		// Business logic: each synthetic message needs a matching part row because the
		// OpenCode planner tracks both tables when deciding skip versus delta.
		for (let index = 1; index <= messageCount; index += 1)
		{
			messageInsert.run(`m${index}`, "s1", 1000 + index, 1000 + index, JSON.stringify({ role: "user" }));
			partInsert.run(`p${index}`, `m${index}`, "s1", 1000 + index, JSON.stringify({ type: "text", text: `hello ${index}` }));
		}
	}
	finally
	{
		db.close();
	}
	return dbPath;
}

/**
 * Runs a planner test against isolated storage, Cursor DB, settings, and message DB.
 * @param fn - Test body receiving the fixture context.
 */
function withPlanner(fn: (ctx: { dir: string; dbPath: string; store: GlobalSettingsStore; db: InMemoryMessageStore }) => void): void
{
	const dir = mkdtempSync(join(tmpdir(), "cc-startup-planner-"));
	const messageDB = new InMemoryMessageStore();
	try
	{
		const dbPath = createCursorDb(dir);
		const store = new GlobalSettingsStore(dir, "M");
		store.load();
		fn({ dir, dbPath, store, db: messageDB });
	}
	finally
	{
		messageDB.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("planStartupHarness Cursor decisions", () =>
{
	test("returns skip, delta, recovery, forced full, and crash recovery decisions", () =>
	{
		withPlanner(({ dir, dbPath, store, db }) =>
		{
			const config = { paths: [dbPath] };
			store.commitHarnessBookmark("Cursor", {
				mode: "rowid",
				parserEpoch: getHarnessParserEpoch("Cursor"),
				sourcePathHash: hashHarnessPaths(config),
				lastSuccessfulIngestAt: "2026-06-08T00:00:00.000Z",
				sourceIdentity: collectSourceIdentity(dbPath, {
					machineName: "M",
					sourceKind: "cursor-state-vscdb",
				}) ?? undefined,
				rowids: { cursorDiskKV: 1, ItemTable: 0 },
			});

			const baseContext = {
				storagePath: dir,
				machineName: "M",
				runInProgress: false,
				dbFingerprintValid: true,
				globalSettingsStore: store,
				messageDB: db,
			};

			expect(planStartupHarness("Cursor", config, baseContext).action).toBe("skipped");

			const sqlite = new Database(dbPath);
			try
			{
				sqlite.query<unknown, [string, string]>("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run("bubbleId:s1:b2", "{}");
			}
			finally
			{
				sqlite.close();
			}
			expect(planStartupHarness("Cursor", config, baseContext).action).toBe("delta");

			store.commitHarnessBookmark("Cursor", {
				...(store.getHarnessBookmark("Cursor")!),
				rowids: { cursorDiskKV: 99, ItemTable: 0 },
			});
			expect(planStartupHarness("Cursor", config, baseContext).action).toBe("recovery-full");

			process.env.FORCE_FULL_HARNESS_REFRESH = "Cursor";
			try
			{
				expect(planStartupHarness("Cursor", config, baseContext).action).toBe("forced-full");
			}
			finally
			{
				delete process.env.FORCE_FULL_HARNESS_REFRESH;
			}

			expect(planStartupHarness("Cursor", config, { ...baseContext, runInProgress: true }).action).toBe("recovery-full");
		});
	});

	test("does not treat another machine's higher Cursor rowid as local regression", () =>
	{
		const dir = mkdtempSync(join(tmpdir(), "cc-cursor-machine-scope-"));
		const messageDB = new InMemoryMessageStore();
		try
		{
			const highRowidDb = createCursorDb(join(dir, "machine-a"));
			const lowRowidDb = createCursorDb(join(dir, "machine-b"));
			const highConfig = { paths: [highRowidDb] };
			const lowConfig = { paths: [lowRowidDb] };

			const machineAStore = new GlobalSettingsStore(dir, "MachineA");
			machineAStore.load();
			machineAStore.commitHarnessBookmark("Cursor", {
				mode: "rowid",
				parserEpoch: getHarnessParserEpoch("Cursor"),
				sourcePathHash: hashHarnessPaths(highConfig),
				lastSuccessfulIngestAt: "2026-06-08T00:00:00.000Z",
				sourceIdentity: collectSourceIdentity(highRowidDb, {
					machineName: "MachineA",
					sourceKind: "cursor-state-vscdb",
				}) ?? undefined,
				rowids: { cursorDiskKV: 99, ItemTable: 0 },
			});

			const machineBStore = new GlobalSettingsStore(dir, "MachineB");
			machineBStore.load();
			const plan = planStartupHarness("Cursor", lowConfig, {
				storagePath: dir,
				machineName: "MachineB",
				runInProgress: false,
				dbFingerprintValid: true,
				globalSettingsStore: machineBStore,
				messageDB,
			});

			expect(plan.action).toBe("full");
			expect(plan.reason).toBe("missing Cursor bookmark");
		}
		finally
		{
			messageDB.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("resumes interrupted Cursor recovery from durable page progress", () =>
	{
		const dir = mkdtempSync(join(tmpdir(), "cc-cursor-resume-plan-"));
		const messageDB = new InMemoryMessageStore();
		try
		{
			const dbPath = createCursorDb(dir);
			const sqlite = new Database(dbPath);
			try
			{
				sqlite.query<unknown, [string, string]>("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run("bubbleId:s1:b2", "{}");
				sqlite.query<unknown, [string, string]>("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run("bubbleId:s1:b3", "{}");
			}
			finally
			{
				sqlite.close();
			}
			const config = { paths: [dbPath] };
			const store = new GlobalSettingsStore(dir, "M");
			store.load();
			store.commitHarnessBookmark("Cursor", {
				mode: "rowid",
				parserEpoch: getHarnessParserEpoch("Cursor"),
				sourcePathHash: hashHarnessPaths(config),
				lastSuccessfulIngestAt: "2026-06-08T00:00:00.000Z",
				sourceIdentity: collectSourceIdentity(dbPath, {
					machineName: "M",
					sourceKind: "cursor-state-vscdb",
				}) ?? undefined,
				rowids: { cursorDiskKV: 0, ItemTable: 0 },
				progress: {
					mode: "recovery-full",
					targetCursorDiskKVRowId: 3,
					targetItemTableRowId: 0,
					durableCursorDiskKVRowId: 1,
					durableItemTableRowId: 0,
					updatedAt: "2026-06-08T00:00:00.000Z",
				},
			});

			const plan = planStartupHarness("Cursor", config, {
				storagePath: dir,
				machineName: "M",
				runInProgress: true,
				dbFingerprintValid: true,
				globalSettingsStore: store,
				messageDB,
			});

			expect(plan.action).toBe("resume-recovery");
			expect(plan.readScope).toEqual({ kind: "cursor-rowid", sinceRowId: 1 });

			const missingFingerprintPlan = planStartupHarness("Cursor", config, {
				storagePath: dir,
				machineName: "M",
				runInProgress: true,
				dbFingerprintValid: false,
				globalSettingsStore: store,
				messageDB,
			});

			expect(missingFingerprintPlan.action).toBe("resume-recovery");
			expect(missingFingerprintPlan.reason).toBe("previous Cursor ingest interrupted; resuming from durable page progress");
		}
		finally
		{
			messageDB.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("source path config drift on one machine does not affect another machine", () =>
	{
		const dir = mkdtempSync(join(tmpdir(), "cc-cursor-path-scope-"));
		const messageDB = new InMemoryMessageStore();
		try
		{
			const oldDb = createCursorDb(join(dir, "old"));
			const newDb = createCursorDb(join(dir, "new"));
			const otherDb = createCursorDb(join(dir, "other"));
			const oldConfig = { paths: [oldDb] };
			const newConfig = { paths: [newDb] };
			const otherConfig = { paths: [otherDb] };

			const machineAStore = new GlobalSettingsStore(dir, "MachineA");
			machineAStore.load();
			machineAStore.commitHarnessBookmark("Cursor", {
				mode: "rowid",
				parserEpoch: getHarnessParserEpoch("Cursor"),
				sourcePathHash: hashHarnessPaths(oldConfig),
				sourceIdentity: collectSourceIdentity(oldDb, {
					machineName: "MachineA",
					sourceKind: "cursor-state-vscdb",
				}) ?? undefined,
				rowids: { cursorDiskKV: 1, ItemTable: 0 },
			});

			const machineBStore = new GlobalSettingsStore(dir, "MachineB");
			machineBStore.load();
			machineBStore.commitHarnessBookmark("Cursor", {
				mode: "rowid",
				parserEpoch: getHarnessParserEpoch("Cursor"),
				sourcePathHash: hashHarnessPaths(otherConfig),
				sourceIdentity: collectSourceIdentity(otherDb, {
					machineName: "MachineB",
					sourceKind: "cursor-state-vscdb",
				}) ?? undefined,
				rowids: { cursorDiskKV: 1, ItemTable: 0 },
			});

			const machineAPlan = planStartupHarness("Cursor", newConfig, {
				storagePath: dir,
				machineName: "MachineA",
				runInProgress: false,
				dbFingerprintValid: true,
				globalSettingsStore: machineAStore,
				messageDB,
			});
			const machineBPlan = planStartupHarness("Cursor", otherConfig, {
				storagePath: dir,
				machineName: "MachineB",
				runInProgress: false,
				dbFingerprintValid: true,
				globalSettingsStore: machineBStore,
				messageDB,
			});

			expect(machineAPlan.action).toBe("recovery-full");
			expect(machineAPlan.reason).toContain("source path config changed");
			expect(machineBPlan.action).toBe("skipped");
		}
		finally
		{
			messageDB.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("planStartupHarness OpenCode decisions", () =>
{
	test("returns first-run, no-op, delta, and replacement recovery decisions", () =>
	{
		const dir = mkdtempSync(join(tmpdir(), "cc-opencode-planner-"));
		const messageDB = new InMemoryMessageStore();
		try
		{
			const dbPath = createOpenCodeDb(dir, 1);
			const config = { paths: [dbPath] };
			const store = new GlobalSettingsStore(dir, "M");
			store.load();
			const baseContext = {
				storagePath: dir,
				machineName: "M",
				runInProgress: false,
				dbFingerprintValid: true,
				globalSettingsStore: store,
				messageDB,
			};

			expect(planStartupHarness("OpenCode", config, baseContext).action).toBe("full");

			store.commitHarnessBookmark("OpenCode", {
				mode: "rowid",
				parserEpoch: getHarnessParserEpoch("OpenCode"),
				sourcePathHash: hashHarnessPaths(config),
				lastSuccessfulIngestAt: "2026-06-08T00:00:00.000Z",
				sourceIdentity: collectSourceIdentity(dbPath, {
					machineName: "M",
					sourceKind: "opencode-db",
				}) ?? undefined,
				rowids: { session: 1, message: 1, part: 1 },
			});
			expect(planStartupHarness("OpenCode", config, baseContext).action).toBe("skipped");

			const sqlite = new Database(dbPath);
			try
			{
				sqlite.query<unknown, [string, string, number, number, string]>("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run("m2", "s1", 2000, 2000, JSON.stringify({ role: "user" }));
				sqlite.query<unknown, [string, string, string, number, string]>("INSERT INTO part VALUES (?, ?, ?, ?, ?)").run("p2", "m2", "s1", 2000, JSON.stringify({ type: "text", text: "hello 2" }));
			}
			finally
			{
				sqlite.close();
			}
			expect(planStartupHarness("OpenCode", config, baseContext).action).toBe("delta");

			rmSync(dbPath, { force: true });
			createOpenCodeDb(dir, 1);
			store.commitHarnessBookmark("OpenCode", {
				...(store.getHarnessBookmark("OpenCode")!),
				rowids: { session: 1, message: 2, part: 2 },
			});
			expect(planStartupHarness("OpenCode", config, baseContext).action).toBe("recovery-full");
		}
		finally
		{
			messageDB.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
