import { beforeAll, describe, expect, test } from "bun:test";
import { readResource } from "../resources/index.js";
import { buildMockDB, buildMockTopicStore } from "./loadFixtures.js";

let db: Awaited<ReturnType<typeof buildMockDB>>;
let topicStore: Awaited<ReturnType<typeof buildMockTopicStore>>;

beforeAll(async () =>
{
	db = await buildMockDB();
	topicStore = await buildMockTopicStore();
});

describe("test_resources (fixture-backed)", () =>
{
	test("reads cxc://stats", () =>
	{
		const out = readResource("cxc://stats", db);
		expect(out).not.toBeNull();
		expect(out!).toContain("Total messages");
	});

	test("reads cxc://projects", () =>
	{
		const out = readResource("cxc://projects", db);
		expect(out).not.toBeNull();
		expect(out!).toContain("AXON");
	});

	test("reads cxc://harnesses", () =>
	{
		const out = readResource("cxc://harnesses", db);
		expect(out).not.toBeNull();
		expect(out!).toContain("Cursor");
	});

	test("reads cxc://projects/AXON/sessions", () =>
	{
		const out = readResource("cxc://projects/AXON/sessions", db, topicStore as any);
		expect(out).not.toBeNull();
		expect(out!).toContain("Sessions for project: AXON");
	});
});
