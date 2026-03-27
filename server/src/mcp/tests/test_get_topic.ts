import { beforeAll, describe, expect, test } from "bun:test";
import { handleTopicTool } from "../tools/topics.js";
import { buildMockTopicStore } from "./loadFixtures.js";

let topicStore: Awaited<ReturnType<typeof buildMockTopicStore>>;

beforeAll(async () =>
{
	topicStore = await buildMockTopicStore();
});

describe("test_get_topic (fixture-backed)", () =>
{
	test("returns topic for known session", () =>
	{
		const out = handleTopicTool("get_topic", { sessionId: "2f929f5c-0932-4039-93b4-99fcd9988643" }, topicStore as any);
		expect(out).not.toContain("No topic entry");
	});

	test("returns no-entry for unknown session", () =>
	{
		const out = handleTopicTool("get_topic", { sessionId: "zzz-unknown" }, topicStore as any);
		expect(out).toContain("No topic entry");
	});

	test("returns error when sessionId is empty", () =>
	{
		const out = handleTopicTool("get_topic", { sessionId: "" }, topicStore as any);
		expect(out).toContain("Error:");
	});
});
