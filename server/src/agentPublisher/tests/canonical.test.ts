import { describe, expect, test } from "bun:test";
import {
	fromCanonicalAgentDefinition,
	makeCanonicalAgentId,
	toCanonicalAgentDefinition,
	toKnowledgeRefs,
} from "../canonical.js";

describe("canonical conversion", () =>
{
	test("toCanonicalAgentDefinition maps agentName and knowledge", () =>
	{
		const def = toCanonicalAgentDefinition({
			projectName: "Context Core Server",
			agentName: "my-agent",
			description: "Does things",
			"argument-hint": "A task",
			tools: ["read"],
			agentKnowledge: ["docs/archi.md", "custom instruction text"],
		});
		expect(def.name).toBe("my-agent");
		expect(def.knowledge).toHaveLength(2);
		expect(def.knowledge[0]?.kind).toBe("file");
		expect(def.knowledge[1]?.kind).toBe("text");
	});

	test("preserves codexEntryId as canonical id", () =>
	{
		const def = toCanonicalAgentDefinition({
			projectName: "P",
			agentName: "a",
			description: "d",
			"argument-hint": "h",
			agentKnowledge: [],
			codexEntryId: "custom-id",
		});
		expect(def.id).toBe("custom-id");
	});

	test("empty tools become empty array", () =>
	{
		const def = toCanonicalAgentDefinition({
			projectName: "P",
			agentName: "a",
			description: "d",
			"argument-hint": "h",
			agentKnowledge: [],
		});
		expect(def.tools).toEqual([]);
	});

	test("fromCanonicalAgentDefinition round-trips legacy shape", () =>
	{
		const legacy = fromCanonicalAgentDefinition({
			id: "p-a",
			kind: "agent",
			projectName: "P",
			name: "a",
			description: "d",
			"argument-hint": "h",
			tools: [],
			knowledge: toKnowledgeRefs(["file.md"]),
		}, "claude");
		expect(legacy.agentName).toBe("a");
		expect(legacy.platform).toBe("claude");
		expect(legacy.fromJson).toBe(true);
	});

	test("makeCanonicalAgentId slugifies", () =>
	{
		expect(makeCanonicalAgentId("My Project", "My Agent")).toBe("my-project-my-agent");
	});
});
