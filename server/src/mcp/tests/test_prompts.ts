import { beforeAll, describe, expect, test } from "bun:test";
import { initSearchIndex } from "../../search/searchEngine.js";
import { handlePrompt } from "../prompts/index.js";
import { buildMockDB, buildMockTopicStore, loadMessagesFixture } from "./loadFixtures.js";

let db: Awaited<ReturnType<typeof buildMockDB>>;
let topicStore: Awaited<ReturnType<typeof buildMockTopicStore>>;

beforeAll(async () =>
{
	const messages = await loadMessagesFixture();
	initSearchIndex(messages);
	db = await buildMockDB();
	topicStore = await buildMockTopicStore();
});

describe("test_prompts (fixture-backed)", () =>
{
	test("explore_history with Character returns prompt text", () =>
	{
		const out = handlePrompt("explore_history", { topic: "Character" }, db, topicStore as any);
		expect(out.messages.length).toBeGreaterThan(0);
		expect(out.messages[0].content.text).toContain("Character");
	});

	test("summarize_session with known session returns transcript prompt", () =>
	{
		const out = handlePrompt("summarize_session", { sessionId: "39057b0d-0c90-4dda-bf39-a110680381e6" }, db, topicStore as any);
		expect(out.messages.length).toBeGreaterThan(0);
		expect(out.messages[0].content.text).toContain("--- TRANSCRIPT ---");
	});

	test("find_decisions with HexGridView returns prompt text", () =>
	{
		const out = handlePrompt("find_decisions", { component: "HexGridView" }, db, topicStore as any);
		expect(out.messages.length).toBeGreaterThan(0);
		expect(out.messages[0].content.text).toContain("HexGridView");
	});

	test("debug_history with spinner returns prompt text", () =>
	{
		const out = handlePrompt("debug_history", { issue: "spinner" }, db, topicStore as any);
		expect(out.messages.length).toBeGreaterThan(0);
		expect(out.messages[0].content.text).toContain("spinner");
	});
});
