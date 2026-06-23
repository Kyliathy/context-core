/**
 * Cursor batched reader regression tests.
 *
 * Architecture: server/zz-reach2/architecture/harness/archi-harness.md
 * Upgrade plan: server/zz-reach2/upgrades/2026-06/r2so2-startup-optimization2.md
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readCursorChatsBatched } from "../cursor.js";
import type { HarnessIngestBatch } from "../../ingest/BatchPersistence.js";

/**
 * Creates the value or resource produced by createCursorDb.
 * @param rowCount - Numeric value used by createCursorDb.
 * @returns Result produced by createCursorDb.
 */
function createCursorDb(rowCount: number): { dir: string; dbPath: string }
{
	const dir = mkdtempSync(join(tmpdir(), "cc-cursor-batch-"));
	const dbPath = join(dir, "state.vscdb");
	const db = new Database(dbPath);
	try
	{
		db.run("CREATE TABLE cursorDiskKV (key TEXT, value TEXT)");
		db.run("CREATE TABLE ItemTable (key TEXT, value TEXT)");
		db.run("BEGIN");
		const insert = db.query<unknown, [string, string]>("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
		// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.

		for (let i = 1; i <= rowCount; i += 1)
		{
			insert.run(
				`bubbleId:s1:b${i}`,
				JSON.stringify({
					type: i % 2 === 0 ? 2 : 1,
					text: `message ${i}`,
					createdAt: `2026-06-08T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
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
	return { dir, dbPath };
}

describe("readCursorChatsBatched", () =>
{
	test("carries parent ids across pages for one session", () =>
	{
		const previous = process.env.CURSOR_INGEST_BATCH_SIZE;
		process.env.CURSOR_INGEST_BATCH_SIZE = "2";
		const { dir, dbPath } = createCursorDb(3);
		try
		{
			const batches: HarnessIngestBatch[] = [];
			readCursorChatsBatched(dbPath, join(dir, "raw"), {
				mode: "full",
				batchSize: 2,
				/**
				 * Provides test helper behavior for onBatch.
				 * @param batch - Value consumed by onBatch.
				 * @returns Result produced by onBatch.
				 */

				onBatch: (batch) => batches.push(batch),
			});

			const messages = batches.flatMap((batch) => batch.messages);
			expect(messages.length).toBe(3);
			expect(messages[0].parentId).toBeNull();
			expect(messages[1].parentId).toBe(messages[0].id);
			expect(messages[2].parentId).toBe(messages[1].id);
			expect(messages.every((message) => message.source.includes(".json"))).toBe(true);
			expect(batches.filter((batch) => batch.messages.length > 0).every((batch) => batch.messages.length <= 2)).toBe(true);
		}
		finally
		{
			if (previous === undefined)
			{
				delete process.env.CURSOR_INGEST_BATCH_SIZE;
			}
			else
			{
				process.env.CURSOR_INGEST_BATCH_SIZE = previous;
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("never emits a batch above the hard 5000 message cap", () =>
	{
		const previous = process.env.CURSOR_INGEST_BATCH_SIZE;
		process.env.CURSOR_INGEST_BATCH_SIZE = "5000";
		const { dir, dbPath } = createCursorDb(5001);
		try
		{
			const batches: HarnessIngestBatch[] = [];
			readCursorChatsBatched(dbPath, join(dir, "raw"), {
				mode: "full",
				batchSize: 9999,
				/**
				 * Provides test helper behavior for onBatch.
				 * @param batch - Value consumed by onBatch.
				 * @returns Result produced by onBatch.
				 */

				onBatch: (batch) => batches.push(batch),
			});

			const nonEmpty = batches.filter((batch) => batch.messages.length > 0);
			expect(nonEmpty.length).toBe(2);
			expect(nonEmpty[0].messages.length).toBe(5000);
			expect(nonEmpty[1].messages.length).toBe(1);
			expect(nonEmpty.every((batch) => batch.messages.length <= 5000)).toBe(true);
		}
		finally
		{
			if (previous === undefined)
			{
				delete process.env.CURSOR_INGEST_BATCH_SIZE;
			}
			else
			{
				process.env.CURSOR_INGEST_BATCH_SIZE = previous;
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
