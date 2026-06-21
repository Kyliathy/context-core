/**
 * Local database fingerprint tests.
 *
 * Architecture: server/zz-reach2/architecture/data/archi-database.md
 * Upgrade plan: server/zz-reach2/upgrades/2026-06/r2so2-startup-optimization2.md
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DateTime } from "luxon";
import { AgentMessage } from "../../models/AgentMessage.js";
import { InMemoryMessageStore } from "../../db/InMemoryMessageStore.js";
import { collectDbFingerprint, validateDbFingerprint } from "../DbFingerprint.js";

/**
 * Provides test helper behavior for makeMessage.
 * @param id - Value consumed by makeMessage.
 * @param harness - Harness name or harness data used by makeMessage.
 * @returns Result produced by makeMessage.
 */
function makeMessage(id: string, harness = "Cursor"): AgentMessage
{
	return new AgentMessage({
		id,
		sessionId: "s-" + id,
		harness,
		machine: "m",
		role: "user",
		model: null,
		message: "hello",
		subject: "",
		context: [],
		symbols: [],
		history: [],
		tags: [],
		project: "P",
		parentId: null,
		tokenUsage: null,
		toolCalls: [],
		rationale: [],
		source: "",
		dateTime: DateTime.fromISO("2026-06-08T00:00:00.000Z"),
		length: 5,
	});
}

describe("DbFingerprint", () =>
{
	test("collects message, session, harness, and file metadata", () =>
	{
		const dir = mkdtempSync(join(tmpdir(), "cc-db-fingerprint-"));
		const store = new InMemoryMessageStore();
		try
		{
			const dbPath = join(dir, "cxc.sqlite");
			writeFileSync(dbPath, "db", "utf-8");
			store.addMessages([makeMessage("1"), makeMessage("2", "ClaudeCode")]);

			const fingerprint = collectDbFingerprint(dbPath, store);
			expect(fingerprint.databaseFile).toBe(dbPath);
			expect(fingerprint.messageCount).toBe(2);
			expect(fingerprint.sessionCount).toBe(2);
			expect(fingerprint.fileSizeBytes).toBeGreaterThan(0);
			expect(fingerprint.harnessCounts.Cursor).toBe(1);
			expect(fingerprint.harnessCounts.ClaudeCode).toBe(1);
		}
		finally
		{
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("validates conservative regression and missing-file cases", () =>
	{
		const stored = {
			databaseFile: "db.sqlite",
			messageCount: 10,
			sessionCount: 2,
			fileMtimeMs: 100,
			fileSizeBytes: 200,
			harnessCounts: { Cursor: 10 },
		};

		expect(validateDbFingerprint(stored, { ...stored }).ok).toBe(true);
		expect(validateDbFingerprint(null, stored).ok).toBe(false);
		expect(validateDbFingerprint(stored, { ...stored, databaseFile: "other.sqlite" }).ok).toBe(false);
		expect(validateDbFingerprint(stored, { ...stored, messageCount: 9 }).ok).toBe(false);
		expect(validateDbFingerprint(stored, { ...stored, harnessCounts: { Cursor: 9 } }).ok).toBe(false);
		expect(validateDbFingerprint(stored, { ...stored, fileMtimeMs: 0, fileSizeBytes: 0 }).ok).toBe(false);
	});
});
