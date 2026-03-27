import { beforeAll, describe, expect, test } from "bun:test";
import type { IMessageStore } from "../../db/IMessageStore.js";
import { handleMessageTool } from "../tools/messages.js";
import { buildMockDB } from "./loadFixtures.js";

// Fixture: messages_storyteller_nncharacter.json
// Date range: 2025-08-07 to 2026-03-06, 22 unique sessions
// Sessions with msgs after 2026-01-01: 19

let db: IMessageStore;

beforeAll(async () =>
{
	db = await buildMockDB();
});

function countListedThreads(output: string): number
{
	return output.match(/^\[\d+\]/gm)?.length ?? 0;
}

describe("test_get_latest_threads (fixture-backed)", () =>
{
	// ─── Basic functionality ──────────────────────────────────────────────────

	test("returns latest threads with default limit", () =>
	{
		const out = handleMessageTool("get_latest_threads", {}, db);
		expect(out).toContain("Latest threads");
		expect(out).toContain("Session:");
	});

	test("respects limit=5", () =>
	{
		const out = handleMessageTool("get_latest_threads", { limit: 5 }, db);
		expect(countListedThreads(out)).toBeLessThanOrEqual(5);
	});

	test("respects limit=1", () =>
	{
		const out = handleMessageTool("get_latest_threads", { limit: 1 }, db);
		expect(countListedThreads(out)).toBe(1);
	});

	// ─── fromDate filtering ───────────────────────────────────────────────────

	test("fromDate=2026-01-01 returns fewer threads than no filter", () =>
	{
		// Fixture has 22 sessions total, 19 have messages on or after 2026-01-01
		const all = handleMessageTool("get_latest_threads", { limit: 100 }, db);
		const filtered = handleMessageTool("get_latest_threads", { limit: 100, fromDate: "2026-01-01" }, db);

		const allCount = countListedThreads(all);
		const filteredCount = countListedThreads(filtered);

		expect(allCount).toBeGreaterThan(filteredCount);
		// Filtered should have 19 sessions (3 sessions have only msgs before 2026-01-01)
		expect(filteredCount).toBeLessThan(allCount);
		expect(filteredCount).toBeGreaterThan(0);
	});

	test("fromDate before all messages returns all threads", () =>
	{
		// All messages are >= 2025-08-07, so fromDate in the past should return all
		const all = handleMessageTool("get_latest_threads", { limit: 100 }, db);
		const filtered = handleMessageTool("get_latest_threads", { limit: 100, fromDate: "2025-07-01" }, db);

		const allCount = countListedThreads(all);
		const filteredCount = countListedThreads(filtered);

		expect(filteredCount).toBe(allCount);
	});

	test("fromDate in the future returns no threads", () =>
	{
		const out = handleMessageTool("get_latest_threads", { limit: 100, fromDate: "2030-01-01" }, db);
		// No messages exist after 2030, so no threads
		expect(out).toContain("No threads found");
	});

	test("fromDate with limit respects both constraints", () =>
	{
		const out = handleMessageTool("get_latest_threads", { limit: 3, fromDate: "2026-01-01" }, db);
		expect(countListedThreads(out)).toBeLessThanOrEqual(3);
	});
});
