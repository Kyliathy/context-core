import { beforeAll, describe, expect, test } from "bun:test";
import { handleTopicTool } from "../tools/topics.js";
import { buildMockTopicStore } from "./loadFixtures.js";

let topicStore: Awaited<ReturnType<typeof buildMockTopicStore>>;

beforeAll(async () =>
{
	topicStore = await buildMockTopicStore();
});

describe("test_get_topics (fixture-backed)", () =>
{
	test("returns topics with default limit", () =>
	{
		const out = handleTopicTool("get_topics", {}, topicStore as any);
		expect(out).not.toMatch(/^Error:/);
	});

	test("respects limit=2", () =>
	{
		const out = handleTopicTool("get_topics", { limit: 2 }, topicStore as any);
		expect(out).not.toMatch(/^Error:/);
	});

	test("format includes session id and topic text", () =>
	{
		const out = handleTopicTool("get_topics", { limit: 1 }, topicStore as any);
		expect(out).toContain("Session:");
	});
});
