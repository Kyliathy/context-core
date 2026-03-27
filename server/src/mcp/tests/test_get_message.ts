import { beforeAll, describe, expect, test } from "bun:test";
import type { IMessageStore } from "../../db/IMessageStore.js";
import { handleMessageTool } from "../tools/messages.js";
import { buildMockDB } from "./loadFixtures.js";

let db: IMessageStore;

beforeAll(async () =>
{
	db = await buildMockDB();
});

describe("test_get_message (fixture-backed)", () =>
{
	test("retrieves known message e4480c597ba75b21", () =>
	{
		const out = handleMessageTool("get_message", { id: "e4480c597ba75b21" }, db);
		expect(out).toContain("e4480c597ba75b21");
		expect(out).toContain("f8b0015a-7954-4f5b-ae5a-a4ca14a11e60");
		expect(out).toContain("Kiro");
	});

	test("retrieves known message 90ef3f32820517e3", () =>
	{
		const out = handleMessageTool("get_message", { id: "90ef3f32820517e3" }, db);
		expect(out).toContain("90ef3f32820517e3");
		expect(out).toContain("Project:");
	});

	test("returns not found for unknown id", () =>
	{
		const out = handleMessageTool("get_message", { id: "zzznonexistent" }, db);
		expect(out).toContain("No message found with ID");
	});

	test("returns error for empty id", () =>
	{
		const out = handleMessageTool("get_message", { id: "  " }, db);
		expect(out).toBe("Error: 'id' is required.");
	});

	// ─── includeAssistantMessages ─────────────────────────────────────────────

	test("includeAssistantMessages=false rejects assistant message", () =>
	{
		// 2be752ee9023ca18 is a known assistant-role message in the fixture
		const out = handleMessageTool("get_message", { id: "2be752ee9023ca18", includeAssistantMessages: false }, db);
		expect(out).toContain("assistant message");
		expect(out).toContain("includeAssistantMessages");
	});
});
