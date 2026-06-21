/**
 * Incremental watcher checkpoint regression tests.
 *
 * Architecture: server/zz-reach2/architecture/data/archi-file-watcher.md
 * Upgrade plan: server/zz-reach2/upgrades/2026-06/r2so2-startup-optimization2.md
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { InMemoryMessageStore } from "../../db/InMemoryMessageStore.js";
import type { StorageWriter } from "../../storage/StorageWriter.js";
import type { TopicStore } from "../../settings/TopicStore.js";
import { GlobalSettingsStore } from "../../settings/GlobalSettingsStore.js";
import { IncrementalPipeline } from "../IncrementalPipeline.js";

/**
 * Creates the value or resource produced by createCursorDbWithDelta.
 * @param dir - Value consumed by createCursorDbWithDelta.
 * @returns Result produced by createCursorDbWithDelta.
 */
function createCursorDbWithDelta(dir: string): string
{
	const dbPath = join(dir, "state.vscdb");
	const db = new Database(dbPath);
	try
	{
		db.run("CREATE TABLE cursorDiskKV (key TEXT, value TEXT)");
		db.run("CREATE TABLE ItemTable (key TEXT, value TEXT)");
		const insert = db.query<unknown, [string, string]>("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
		insert.run("noop", "{}");
		insert.run(
			"bubbleId:s1:b2",
			JSON.stringify({
				type: 1,
				text: "new message",
				createdAt: "2026-06-08T00:00:02.000Z",
			})
		);
	}
	finally
	{
		db.close();
	}
	return dbPath;
}

describe("IncrementalPipeline Cursor checkpoint commit", () =>
{
	test("does not advance the checkpoint when persistence fails", async () =>
	{
		const dir = mkdtempSync(join(tmpdir(), "cc-pipeline-checkpoint-"));
		const db = new InMemoryMessageStore();
		const settingsStore = new GlobalSettingsStore(dir);
		settingsStore.load();
		settingsStore.setCursorState({ cursorDiskKVRowId: 1, itemTableRowId: 0 });
		const cursorDbPath = createCursorDbWithDelta(dir);
		const writer = {
			/**
			 * Writes data for writeSession using the existing CXC storage contract.
			 * @returns Result produced by writeSession.
			 */
			writeSession(): string
			{
				throw new Error("storage failed");
			},
		} as unknown as StorageWriter;
		const pipeline = new IncrementalPipeline(
			db,
			writer,
			"M",
			dir,
			null,
			null,
			{} as TopicStore,
			settingsStore,
			null,
			null
		);

		try
		{
			await pipeline.ingest("Cursor", { paths: [cursorDbPath] }, join(dir, "raw"));
			expect(settingsStore.getCursorCheckpoint()).toEqual({ cursorDiskKVRowId: 1, itemTableRowId: 0 });
		}
		finally
		{
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
