import { beforeAll, describe, expect, test } from "bun:test";
import { initSearchIndex } from "../../search/searchEngine.js";
import { handleMessageTool } from "../tools/messages.js";
import { handleSearchTool } from "../tools/search.js";
import { handleTopicTool } from "../tools/topics.js";
import { buildMockDB, buildMockTopicStore, loadMessagesFixture } from "./loadFixtures.js";

let db: Awaited<ReturnType<typeof buildMockDB>>;
let topicStore: Awaited<ReturnType<typeof buildMockTopicStore>>;

function extractFirstMatch(text: string, pattern: RegExp): string
{
	const match = text.match(pattern);
	if (!match || !match[1])
	{
		throw new Error(`Failed to extract value with pattern ${pattern}`);
	}
	return match[1];
}

beforeAll(async () =>
{
	const messages = await loadMessagesFixture();
	initSearchIndex(messages);
	db = await buildMockDB();
	topicStore = await buildMockTopicStore();
});

describe("test_cross_tool (fixture-backed)", () =>
{
	test("search_messages(Dialog) -> get_message(id)", async () =>
	{
		const searchOut = await handleSearchTool("search_messages", { query: "Dialog" }, db, topicStore as any);
		const id = extractFirstMatch(searchOut, /ID:\s+([^\s|]+)/);

		const messageOut = handleMessageTool("get_message", { id }, db, topicStore as any);
		expect(messageOut).toContain(`ID: ${id}`);
	});

	test("search_threads(Dialog) -> get_session(sessionId)", async () =>
	{
		const searchOut = await handleSearchTool("search_threads", { query: "Dialog" }, db, topicStore as any);
		const sessionId = extractFirstMatch(searchOut, /Session:\s+([^\s]+)/);

		const sessionOut = handleMessageTool("get_session", { sessionId }, db, topicStore as any);
		expect(sessionOut).toContain(`=== Session: ${sessionId} ===`);
	});

	test("list_sessions() -> get_topic(sessionId)", () =>
	{
		const sessionsOut = handleMessageTool("list_sessions", { limit: 1 }, db, topicStore as any);
		const sessionId = extractFirstMatch(sessionsOut, /\[1\]\s+([^\s]+)/);

		let topicOut = handleTopicTool("get_topic", { sessionId }, topicStore as any);
		if (topicOut.startsWith("No topic entry found"))
		{
			handleTopicTool("set_topic", { sessionId, customTopic: "Cross-tool topic" }, topicStore as any);
			topicOut = handleTopicTool("get_topic", { sessionId }, topicStore as any);
		}

		expect(topicOut).toContain(`Session: ${sessionId}`);
	});
});
