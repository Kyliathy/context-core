import { describe, expect, test } from "bun:test";
import {
	heatDiffersFromNative,
	linkStrategiesForTarget,
	normalizeLinkStrategy,
	resolveDefaultOutputDir,
	resolveFilenameHint,
} from "./publishUtils";
import type { CanonicalAgentDefinition } from "../../types";

const def: CanonicalAgentDefinition = {
	id: "test-project-worker",
	kind: "agent",
	projectName: "Test Project",
	name: "worker",
	description: "d",
	knowledge: [],
};

describe("publishUtils", () =>
{
	test("resolveDefaultOutputDir uses agentOutputDir for agents", () =>
	{
		const dirs = {
			projectRoot: "D:/repo",
			agentOutputDir: "D:/repo/.github/agents",
			skillRootDir: "D:/repo",
		};
		expect(resolveDefaultOutputDir(dirs, "agent")).toBe("D:/repo/.github/agents");
		expect(resolveDefaultOutputDir(dirs, "skill")).toBe("D:/repo");
	});

	test("resolveFilenameHint shows platform-native agent paths", () =>
	{
		const copilotHint = resolveFilenameHint(def, "copilot", "agent", "D:/repo/.github/agents");
		const claudeHint = resolveFilenameHint(def, "claude", "agent", "D:/repo/.claude/agents");
		const cursorHint = resolveFilenameHint(def, "cursor", "agent", "D:/repo");
		expect(copilotHint).toContain(".github/agents/worker.agent.md");
		expect(claudeHint).toContain(".claude/agents/worker.md");
		expect(cursorHint).toBe("D:/repo/AGENTS.md");
	});

	test("resolveFilenameHint shows skill path separately from agent dir", () =>
	{
		const hint = resolveFilenameHint(def, "copilot", "skill", "D:/repo");
		expect(hint).toBe("D:/repo/.github/skills/test-project-worker/SKILL.md");
	});

	test("heatDiffersFromNative detects mismatched directories", () =>
	{
		expect(heatDiffersFromNative("D:/repo/server", "D:/repo/.github/agents")).toBe(true);
		expect(heatDiffersFromNative("D:/repo/.github/agents", "D:/repo/.github/agents")).toBe(false);
	});

	test("linkStrategiesForTarget exposes import-shim only for Claude agents", () =>
	{
		expect(linkStrategiesForTarget("claude", "agent")).toEqual(["copy", "import-shim"]);
		expect(linkStrategiesForTarget("claude", "skill")).toEqual(["copy"]);
		expect(linkStrategiesForTarget("cursor", "agent")).toEqual(["copy"]);
	});

	test("normalizeLinkStrategy resets import-shim when switching to skill", () =>
	{
		expect(normalizeLinkStrategy("claude", "skill", "import-shim")).toBe("copy");
		expect(normalizeLinkStrategy("claude", "agent", "import-shim")).toBe("import-shim");
	});
});
