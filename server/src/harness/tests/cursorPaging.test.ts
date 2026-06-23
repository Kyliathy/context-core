/**
 * Cursor paging tests for bounded rowid reads.
 *
 * Architecture: server/zz-reach2/architecture/harness/archi-harness.md
 * Upgrade plan: server/zz-reach2/upgrades/2026-06/r2so2-startup-optimization2.md
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readCursorBubblePage, readCursorKvPage } from "../cursor-query.js";

/**
 * Provides test helper behavior for withCursorDb.
 * @param fn - Callback invoked by withCursorDb.
 */
function withCursorDb(fn: (db: Database) => void): void
{
	const dir = mkdtempSync(join(tmpdir(), "cc-cursor-page-"));
	const db = new Database(join(dir, "state.vscdb"));
	try
	{
		db.run("CREATE TABLE cursorDiskKV (key TEXT, value TEXT)");
		db.run("CREATE TABLE ItemTable (key TEXT, value TEXT)");
		const insert = db.query<unknown, [string, string]>("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
		// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.

		for (let i = 1; i <= 3; i += 1)
		{
			insert.run(
				`bubbleId:s1:b${i}`,
				JSON.stringify({
					type: i % 2 === 0 ? 2 : 1,
					text: `message ${i}`,
					createdAt: `2026-06-08T00:00:0${i}.000Z`,
				})
			);
		}
		fn(db);
	}
	finally
	{
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("Cursor row page reader", () =>
{
	test("reads bubble rows in rowid pages capped by CURSOR_INGEST_BATCH_SIZE", () =>
	{
		const previous = process.env.CURSOR_INGEST_BATCH_SIZE;
		process.env.CURSOR_INGEST_BATCH_SIZE = "2";
		try
		{
			withCursorDb((db) =>
			{
				const rows = readCursorKvPage(db, 0, 9999, "key LIKE 'bubbleId:%'");
				expect(rows.length).toBe(2);
				expect(rows[0].rowid).toBe(1);
				expect(rows[1].rowid).toBe(2);

				const firstPage = readCursorBubblePage(db, new Map(), new Map(), 0, "test-page");
				expect(firstPage).toMatchObject({
					firstRowId: 1,
					lastRowId: 2,
					selectedRows: 2,
					parsedRecords: 2,
					malformedRows: 0,
				});

				const secondPage = readCursorBubblePage(db, new Map(), new Map(), firstPage.lastRowId, "test-page");
				expect(secondPage).toMatchObject({
					firstRowId: 3,
					lastRowId: 3,
					selectedRows: 1,
					parsedRecords: 1,
				});
			});
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
		}
	});
});
