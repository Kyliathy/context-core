import { beforeAll, describe, expect, test } from "bun:test";
import type { IMessageStore } from "../../db/IMessageStore.js";
import { handleMessageTool } from "../tools/messages.js";
import { buildMockDB } from "./loadFixtures.js";

let db: IMessageStore;

beforeAll(async () =>
{
	db = await buildMockDB();
});

describe("test_query_messages (fixture-backed)", () =>
{
	test("filters role=user", () =>
	{
		const out = handleMessageTool("query_messages", { role: "user", pageSize: 5 }, db);
		expect(out).toContain("Messages: page");
	});

	test("filters role=assistant", () =>
	{
		const out = handleMessageTool("query_messages", { role: "assistant", pageSize: 5 }, db);
		expect(out).toContain("Messages: page");
	});

	test("filters harness=Cursor", () =>
	{
		const out = handleMessageTool("query_messages", { harness: "Cursor", pageSize: 5 }, db);
		expect(out).toContain("Messages: page");
	});

	test("filters project=AXON", () =>
	{
		const out = handleMessageTool("query_messages", { project: "AXON", pageSize: 5 }, db);
		expect(out).toContain("Messages: page");
	});

	test("supports page 1 size 5", () =>
	{
		const out = handleMessageTool("query_messages", { page: 1, pageSize: 5 }, db);
		expect(out).toContain("page 1");
	});

	test("supports page 2 size 5", () =>
	{
		const out = handleMessageTool("query_messages", { page: 2, pageSize: 5 }, db);
		expect(out).toContain("page 2");
	});
});
