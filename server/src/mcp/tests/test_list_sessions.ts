import { beforeAll, describe, expect, test } from "bun:test";
import type { IMessageStore } from "../../db/IMessageStore.js";
import { handleMessageTool } from "../tools/messages.js";
import { buildMockDB } from "./loadFixtures.js";

let db: IMessageStore;

beforeAll(async () =>
{
	db = await buildMockDB();
});

function countListedSessions(output: string): number
{
	return output.match(/^\[\d+\]/gm)?.length ?? 0;
}

describe("test_list_sessions (fixture-backed)", () =>
{
	test("lists sessions with default limit", () =>
	{
		const out = handleMessageTool("list_sessions", {}, db);
		expect(out).toContain("Sessions (showing");
		expect(out).toContain("Harness:");
	});

	test("respects limit=3", () =>
	{
		const out = handleMessageTool("list_sessions", { limit: 3 }, db);
		expect(countListedSessions(out)).toBeLessThanOrEqual(3);
	});

	test("respects limit=1", () =>
	{
		const out = handleMessageTool("list_sessions", { limit: 1 }, db);
		expect(countListedSessions(out)).toBe(1);
	});
});
