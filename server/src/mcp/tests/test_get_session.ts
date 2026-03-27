import { beforeAll, describe, expect, test } from "bun:test";
import type { IMessageStore } from "../../db/IMessageStore.js";
import { handleMessageTool } from "../tools/messages.js";
import { buildMockDB } from "./loadFixtures.js";

let db: IMessageStore;

beforeAll(async () =>
{
	db = await buildMockDB();
});

describe("test_get_session (fixture-backed)", () =>
{
	test("retrieves known session with multiple messages", () =>
	{
		const out = handleMessageTool("get_session", { sessionId: "39057b0d-0c90-4dda-bf39-a110680381e6" }, db);
		expect(out).toContain("39057b0d-0c90-4dda-bf39-a110680381e6");
		expect(out).toContain("Messages:");
	});

	test("retrieves session with maxMessages=2", () =>
	{
		const out = handleMessageTool(
			"get_session",
			{ sessionId: "39057b0d-0c90-4dda-bf39-a110680381e6", maxMessages: 2 },
			db
		);
		expect(out).toContain("Session:");
	});

	test("returns not found for unknown session", () =>
	{
		const out = handleMessageTool("get_session", { sessionId: "zzz-session" }, db);
		expect(out).toContain("No messages found for session");
	});

	test("supports default maxMessages path", () =>
	{
		const out = handleMessageTool("get_session", { sessionId: "f8b0015a-7954-4f5b-ae5a-a4ca14a11e60" }, db);
		expect(out).toContain("f8b0015a-7954-4f5b-ae5a-a4ca14a11e60");
	});

	// ─── includeAssistantMessages ─────────────────────────────────────────────

	test("includeAssistantMessages=false filters to human messages only", () =>
	{
		// Session 020ecf0f has only an assistant-role message — filtering should yield no human messages
		const out = handleMessageTool(
			"get_session",
			{ sessionId: "020ecf0f-35ba-4b06-aa16-9c4b85d1ac6c", includeAssistantMessages: false },
			db
		);
		expect(out).toContain("No human messages found for session");
	});
});
