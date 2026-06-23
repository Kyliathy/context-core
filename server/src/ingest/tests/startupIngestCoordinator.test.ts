/**
 * StartupIngestCoordinator tests for resumable Cursor startup progress.
 *
 * Architecture: server/zz-reach2/architecture/archi-context-core-level0.md
 * Upgrade plan: server/zz-reach2/upgrades/2026-06/r2so2-startup-optimization2.md
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { InMemoryMessageStore } from "../../db/InMemoryMessageStore.js";
import { GlobalSettingsStore } from "../../settings/GlobalSettingsStore.js";
import { StorageWriter } from "../../storage/StorageWriter.js";
import type { AgentMessage } from "../../models/AgentMessage.js";
import type { MachineConfig } from "../../types.js";
import { StartupIngestCoordinator } from "../StartupIngestCoordinator.js";

/**
 * Creates a Cursor DB fixture with one session and deterministic bubble rows.
 * @param dir - Temporary directory that will receive `state.vscdb`.
 * @param rowCount - Number of bubble rows to insert.
 * @returns Path to the created Cursor DB.
 */
function createCursorDb(dir: string, rowCount: number): string
{
	const dbPath = join(dir, "state.vscdb");
	const db = new Database(dbPath);
	try
	{
		db.run("CREATE TABLE cursorDiskKV (key TEXT, value TEXT)");
		db.run("CREATE TABLE ItemTable (key TEXT, value TEXT)");
		db.run("BEGIN");
		const insert = db.query<unknown, [string, string]>("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
		// Business logic: every row belongs to one session so parent-chain continuity
		// across an interrupted startup can be observed after resume.
		for (let index = 1; index <= rowCount; index += 1)
		{
			insert.run(
				`bubbleId:s1:b${index}`,
				JSON.stringify({
					type: index % 2 === 0 ? 2 : 1,
					text: `message ${index}`,
					createdAt: `2026-06-08T00:00:0${index}.000Z`,
				})
			);
		}
		db.run("COMMIT");
	}
	catch (error)
	{
		db.run("ROLLBACK");
		throw error;
	}
	finally
	{
		db.close();
	}
	return dbPath;
}

/**
 * Builds the minimal machine config needed for Cursor startup ingest.
 * @param cursorDbPath - Path to the Cursor fixture DB.
 * @returns Machine config with only the Cursor harness enabled.
 */
function createMachine(cursorDbPath: string): MachineConfig
{
	return {
		machine: "M",
		harnesses: {
			Cursor: {
				paths: [cursorDbPath],
			},
		},
	};
}

class FailingStorageWriter extends StorageWriter
{
	private writeCount = 0;

	/**
	 * Creates a storage writer that throws after a fixed number of writes.
	 * @param storageRoot - Root storage directory.
	 * @param failAfterWrites - Number of successful writes allowed before failing.
	 */
	constructor(storageRoot: string, private readonly failAfterWrites: number)
	{
		super(storageRoot);
	}

	/**
	 * Writes a session until the configured failure threshold is crossed.
	 * @param messages - Session messages to persist.
	 * @param machine - Machine segment for storage output.
	 * @param harness - Harness segment for storage output.
	 * @param project - Project segment for storage output.
	 * @param overwrite - Whether to overwrite the complete session file.
	 * @returns Output path from the parent writer.
	 */
	override writeSession(
		messages: Array<AgentMessage>,
		machine: string,
		harness: string,
		project: string,
		overwrite = false
	): string | null
	{
		this.writeCount += 1;
		if (this.writeCount > this.failAfterWrites)
		{
			throw new Error("planned storage failure");
		}
		return super.writeSession(messages, machine, harness, project, overwrite);
	}
}

describe("StartupIngestCoordinator Cursor resume", () =>
{
	test("persists page progress after failure and resumes remaining Cursor rows", () =>
	{
		const previousBatchSize = process.env.CURSOR_INGEST_BATCH_SIZE;
		process.env.CURSOR_INGEST_BATCH_SIZE = "1";
		const dir = mkdtempSync(join(tmpdir(), "cc-startup-coordinator-"));
		const dbPath = createCursorDb(dir, 3);
		const messageDB = new InMemoryMessageStore();
		const store = new GlobalSettingsStore(dir, "M");
		store.load();

		try
		{
			const machine = createMachine(dbPath);
			const failingWriter = new FailingStorageWriter(dir, 2);
			const firstCoordinator = new StartupIngestCoordinator(
				messageDB,
				failingWriter,
				dir,
				machine,
				store,
				false,
				true
			);
			firstCoordinator.run();

			const interruptedBookmark = store.getHarnessBookmark("Cursor");
			expect(interruptedBookmark?.progress).toMatchObject({
				durableCursorDiskKVRowId: 1,
				targetCursorDiskKVRowId: 3,
			});
			expect(messageDB.getMessageCount()).toBe(1);

			const secondCoordinator = new StartupIngestCoordinator(
				messageDB,
				new StorageWriter(dir),
				dir,
				machine,
				store,
				true,
				false
			);
			secondCoordinator.run();

			const completedBookmark = store.getHarnessBookmark("Cursor");
			expect(completedBookmark?.progress).toBeUndefined();
			expect(completedBookmark?.rowids).toMatchObject({ cursorDiskKV: 3, ItemTable: 0 });
			expect(messageDB.getMessageCount()).toBe(3);
			expect(messageDB.getBySessionId("s1").every((message) => message.parentId !== message.id)).toBe(true);
		}
		finally
		{
			if (previousBatchSize === undefined)
			{
				delete process.env.CURSOR_INGEST_BATCH_SIZE;
			}
			else
			{
				process.env.CURSOR_INGEST_BATCH_SIZE = previousBatchSize;
			}
			messageDB.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
