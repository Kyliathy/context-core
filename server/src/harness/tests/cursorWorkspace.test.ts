/**
 * Cursor workspace inference tests for bounded per-session and paged fallback reads.
 *
 * Architecture: server/zz-reach2/architecture/harness/archi-h-cursor.md
 * Upgrade plan: server/zz-reach2/upgrades/2026-06/r2so2-startup-optimization2.md
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	inferCursorWorkspaceForSessions,
	inferCursorWorkspacePagedFallback,
	type CursorProjectRuleSet,
} from "../cursor-matcher.js";

const ruleSet: CursorProjectRuleSet = {
	projectMappingRules: [
		{ path: "C:/repo/app", newProjectName: "AppProject" },
		{ path: "C:/repo/layout", newProjectName: "LayoutProject" },
		{ path: "C:/repo/fallback", newProjectName: "FallbackProject" },
	],
	projectNameMappingRules: [],
	genericProjectMappingRules: [],
};

/**
 * Runs a test against an isolated Cursor `cursorDiskKV` fixture.
 * @param fn - Test body receiving the open SQLite database.
 */
function withCursorKvDb(fn: (db: Database) => void): void
{
	const dir = mkdtempSync(join(tmpdir(), "cc-cursor-workspace-"));
	const db = new Database(join(dir, "state.vscdb"));
	try
	{
		db.run("CREATE TABLE cursorDiskKV (key TEXT, value TEXT)");
		fn(db);
	}
	finally
	{
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("Cursor bounded workspace inference", () =>
{
	test("resolves active sessions from direct composer and project-layout records", () =>
	{
		withCursorKvDb((db) =>
		{
			const insert = db.query<unknown, [string, string]>("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
			insert.run("composerData:session-aaaaaaaaaaaa", JSON.stringify({
				originalFileStates: {
					"file:///C:/repo/app/src/index.ts": {},
				},
			}));
			insert.run("messageRequestContext:session-bbbbbbbbbbbb:1", JSON.stringify({
				projectLayouts: [
					{
						rootPath: "C:/repo/layout",
						listDirV2Result: {
							directoryTreeRoot: {
								absPath: "C:/repo/layout/src/file.ts",
							},
						},
					},
				],
			}));

			const result = inferCursorWorkspaceForSessions(
				db,
				new Set(["session-aaaaaaaaaaaa", "session-bbbbbbbbbbbb"]),
				new Map(),
				ruleSet
			);

			expect(result.projectBySession.get("session-aaaaaaaaaaaa")).toBeDefined();
			expect(result.projectBySession.get("session-aaaaaaaaaaaa")).not.toBe("MISC");
			expect(result.projectBySession.get("session-bbbbbbbbbbbb")).toBeDefined();
			expect(result.projectBySession.get("session-bbbbbbbbbbbb")).not.toBe("MISC");
			expect(result.sourceCounts.composerFileUris).toBeGreaterThan(0);
			expect(result.sourceCounts.projectLayouts).toBeGreaterThan(0);
		});
	});

	test("paged fallback scans large cursorDiskKV fixtures in bounded pages", () =>
	{
		withCursorKvDb((db) =>
		{
			const insert = db.query<unknown, [string, string]>("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
			db.run("BEGIN");
			try
			{
				// Business logic: more than two pages of irrelevant rows prove the fallback
				// can find the active session without relying on a whole-table materialization.
				for (let i = 0; i < 11999; i += 1)
				{
					insert.run(`noise:${i}`, "{}");
				}
				insert.run("workspace:session-cccccccccccc", JSON.stringify({
					cwd: "C:/repo/fallback/src/index.ts",
				}));
				db.run("COMMIT");
			}
			catch (error)
			{
				db.run("ROLLBACK");
				throw error;
			}

			const result = inferCursorWorkspacePagedFallback(
				db,
				new Set(["session-cccccccccccc"]),
				new Map(),
				ruleSet
			);
			expect(result.projectBySession.get("session-cccccccccccc")).toBe("FallbackProject");
			expect(result.sessionsResolved).toBe(1);
		});
	});
});
