import { beforeAll, describe, expect, test } from "bun:test";
import { handleTopicTool } from "../tools/topics.js";
import { buildMockTopicStore } from "./loadFixtures.js";

let topicStore: Awaited<ReturnType<typeof buildMockTopicStore>>;

beforeAll(async () =>
{
	topicStore = await buildMockTopicStore();
});

describe("test_set_topic (fixture-backed)", () =>
{
	test("sets custom topic on known session", () =>
	{
		const out = handleTopicTool(
			"set_topic",
			{ sessionId: "2f929f5c-0932-4039-93b4-99fcd9988643", customTopic: "Custom topic test" },
			topicStore as any
		);
		expect(out).toContain("Custom topic set");
	});

	test("clears custom topic with empty string", () =>
	{
		const out = handleTopicTool(
			"set_topic",
			{ sessionId: "2f929f5c-0932-4039-93b4-99fcd9988643", customTopic: "" },
			topicStore as any
		);
		expect(out).toContain("Custom topic cleared");
	});

	test("returns error for empty sessionId", () =>
	{
		const out = handleTopicTool("set_topic", { sessionId: "", customTopic: "x" }, topicStore as any);
		expect(out).toContain("Error:");
	});
});
