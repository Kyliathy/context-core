/**
 * Startup batch persistence regression tests.
 *
 * Architecture: server/zz-reach2/architecture/archi-context-core-level0.md
 * Upgrade plan: server/zz-reach2/upgrades/2026-06/r2so2-startup-optimization2.md
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DateTime } from "luxon";
import { InMemoryMessageStore } from "../../db/InMemoryMessageStore.js";
import { AgentMessage } from "../../models/AgentMessage.js";
import type { StorageWriter } from "../../storage/StorageWriter.js";
import { persistIngestBatch } from "../BatchPersistence.js";

/**
 * Provides test helper behavior for makeMessage.
 * @param id - Value consumed by makeMessage.
 * @param sessionId - Session identifier or session data used by makeMessage.
 * @returns Result produced by makeMessage.
 */
function makeMessage(id: string, sessionId = "s1"): AgentMessage
{
	return new AgentMessage({
		id,
		sessionId,
		harness: "",
		machine: "",
		role: "user",
		model: null,
		message: "hello " + id,
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
		length: 7,
	});
}

describe("persistIngestBatch", () =>
{
	test("persists new messages, ignores duplicates, and overwrites touched sessions", () =>
	{
		const dir = mkdtempSync(join(tmpdir(), "cc-batch-persistence-"));
		const db = new InMemoryMessageStore();
		const writes: Array<{ sessionId: string; overwrite: boolean }> = [];
		const writer = {
			/**
			 * Writes data for writeSession using the existing CXC storage contract.
			 * @param messages - Message data processed by writeSession.
			 * @param _machine - Value consumed by writeSession.
			 * @param _harness - Harness name or harness data used by writeSession.
			 * @param _project - Value consumed by writeSession.
			 * @param overwrite - Value consumed by writeSession.
			 * @returns Result produced by writeSession.
			 */
			writeSession(messages: Array<AgentMessage>, _machine: string, _harness: string, _project: string, overwrite = false): string
			{
				writes.push({ sessionId: messages[0]?.sessionId ?? "", overwrite });
				return join(dir, `${messages[0]?.sessionId ?? "empty"}.json`);
			},
		} as unknown as StorageWriter;

		try
		{
			const messages = [makeMessage("1"), makeMessage("2")];
			const first = persistIngestBatch(
				{ harnessName: "Cursor", messages, isFinalBatch: true },
				{ messageDB: db, storageWriter: writer, machineName: "M", storagePath: dir }
			);

			expect(first.messagesAdded).toBe(2);
			expect(first.touchedSessionIds.has("s1")).toBe(true);
			expect(first.storageFilesWritten).toBe(1);
			expect(first.storageFilesOverwritten).toBe(1);
			expect(writes.some((write) => write.overwrite)).toBe(true);

			const second = persistIngestBatch(
				{ harnessName: "Cursor", messages: [makeMessage("1"), makeMessage("2")], isFinalBatch: true },
				{ messageDB: db, storageWriter: writer, machineName: "M", storagePath: dir }
			);
			expect(second.messagesAdded).toBe(0);
			expect(second.touchedSessionIds.size).toBe(0);
		}
		finally
		{
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("collects session-level storage errors without marking the whole batch fatal", () =>
	{
		const dir = mkdtempSync(join(tmpdir(), "cc-batch-persistence-"));
		const db = new InMemoryMessageStore();
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

		try
		{
			const result = persistIngestBatch(
				{ harnessName: "Cursor", messages: [makeMessage("1")], isFinalBatch: true },
				{ messageDB: db, storageWriter: writer, machineName: "M", storagePath: dir }
			);
			expect(result.fatalError).toBe(false);
			expect(result.sessionErrors).toEqual([{ sessionId: "s1", error: "storage failed" }]);
			expect(result.messagesAdded).toBe(0);
		}
		finally
		{
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("accepts final empty checkpoint batches and rejects non-final empty checkpoint batches", () =>
	{
		const dir = mkdtempSync(join(tmpdir(), "cc-batch-persistence-"));
		const db = new InMemoryMessageStore();
		const writer = {
			/**
			 * Writes data for writeSession using the existing CXC storage contract.
			 * @returns Result produced by writeSession.
			 */
			writeSession(): string
			{
				return join(dir, "unused.json");
			},
		} as unknown as StorageWriter;

		try
		{
			const finalResult = persistIngestBatch(
				{
					harnessName: "Cursor",
					messages: [],
					checkpointCandidate: { cursorDiskKVRowId: 2, itemTableRowId: 0 },
					isFinalBatch: true,
				},
				{ messageDB: db, storageWriter: writer, machineName: "M", storagePath: dir }
			);
			expect(finalResult.fatalError).toBe(false);

			const nonFinalResult = persistIngestBatch(
				{
					harnessName: "Cursor",
					messages: [],
					checkpointCandidate: { cursorDiskKVRowId: 2, itemTableRowId: 0 },
					isFinalBatch: false,
				},
				{ messageDB: db, storageWriter: writer, machineName: "M", storagePath: dir }
			);
			expect(nonFinalResult.fatalError).toBe(true);
			expect(nonFinalResult.sessionErrors[0]?.error).toBe("empty checkpoint batch must be final");
		}
		finally
		{
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
