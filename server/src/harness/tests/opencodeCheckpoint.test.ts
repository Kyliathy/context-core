/**
 * OpenCode checkpoint tests for rowid startup planning.
 *
 * Architecture: server/zz-reach2/architecture/harness/archi-harness.md
 * Upgrade plan: server/zz-reach2/upgrades/2026-06/r2so2-startup-optimization2.md
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	getOpenCodeAffectedSessionIds,
	getOpenCodeRowIdCheckpoint,
	readOpenCodeChatsIncremental,
} from "../opencode.js";

/**
 * Creates the value or resource produced by createOpenCodeDb.
 * @returns Result produced by createOpenCodeDb.
 */
function createOpenCodeDb(): { dir: string; dbPath: string }
{
	const dir = mkdtempSync(join(tmpdir(), "cc-opencode-"));
	const dbPath = join(dir, "opencode.db");
	const db = new Database(dbPath);
	try
	{
		db.run("CREATE TABLE session (id TEXT, project_id TEXT, directory TEXT, title TEXT, slug TEXT, time_created INTEGER, time_updated INTEGER)");
		db.run("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)");
		db.run("CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
		db.query<unknown, [string, string, string, string, string, number, number]>("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)").run("s1", "p", "C:/repo/app", "t", "slug", 1000, 1000);
		db.query<unknown, [string, string, number, number, string]>("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run("m1", "s1", 1000, 1000, JSON.stringify({ role: "user" }));
		db.query<unknown, [string, string, string, number, string]>("INSERT INTO part VALUES (?, ?, ?, ?, ?)").run("p1", "m1", "s1", 1000, JSON.stringify({ type: "text", text: "hello" }));
	}
	finally
	{
		db.close();
	}
	return { dir, dbPath };
}

describe("OpenCode rowid helpers", () =>
{
	test("collects checkpoints, affected sessions, and incremental messages", () =>
	{
		const { dir, dbPath } = createOpenCodeDb();
		try
		{
			expect(getOpenCodeRowIdCheckpoint(dbPath)).toEqual({
				sessionRowId: 1,
				messageRowId: 1,
				partRowId: 1,
			});

			const db = new Database(dbPath);
			try
			{
				expect(getOpenCodeAffectedSessionIds(db, { sessionRowId: 0, messageRowId: 0, partRowId: 0 })).toEqual(["s1"]);
			}
			finally
			{
				db.close();
			}

			const result = readOpenCodeChatsIncremental(dbPath, join(dir, "raw"), {
				sessionRowId: 0,
				messageRowId: 0,
				partRowId: 0,
			});
			expect(result.affectedSessionIds).toEqual(["s1"]);
			expect(result.messages.length).toBe(1);
			expect(result.checkpoint.messageRowId).toBe(1);
		}
		finally
		{
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
