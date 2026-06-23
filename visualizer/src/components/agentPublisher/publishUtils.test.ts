import { describe, expect, test } from "bun:test";
import {
	applyPublishPrefillToTargets,
	buildInitialPublisherTargets,
	DEFAULT_PUBLISHER_PLATFORMS,
	filterHeatByMdSources,
	formatPublishStatusLabel,
	heatDiffersFromNative,
	initialSelectedMdSourcePaths,
	linkStrategiesForTarget,
	normalizeLinkStrategy,
	readLastSelectedPublisherPlatforms,
	outputDirFromArtifactPath,
	resolveDefaultOutputDir,
	resolveFilenameHint,
	resolvePlacementPlatform,
	saveLastSelectedPublisherPlatforms,
	selectedPlatformsFromTargets,
	sortPlatformsByLastSelected,
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

	test("initialSelectedMdSourcePaths checks basket docs only", () =>
	{
		const selected = initialSelectedMdSourcePaths([
			{ absolutePath: "D:/a.md", displayPath: "a.md", inBasket: true, isRelated: false, directoryPaths: [] },
			{ absolutePath: "D:/b.md", displayPath: "b.md", inBasket: false, isRelated: true, directoryPaths: [] },
		]);
		expect(selected.size).toBe(1);
		expect(selected.has("d:/a.md")).toBe(true);
	});

	test("filterHeatByMdSources rebuilds tree from selected sources", () =>
	{
		const heat = {
			projectName: "p",
			projectRoot: "D:/repo",
			totalHits: 3,
			droppedPathCount: 0,
			topPaths: [],
			tree: [{
				name: "repo",
				absolutePath: "D:/repo",
				directHits: 3,
				subtreeHits: 3,
				heat: 1,
				children: [{
					name: "server",
					absolutePath: "D:/repo/server",
					directHits: 3,
					subtreeHits: 3,
					heat: 1,
					children: [],
				}],
			}],
			mdSources: [
				{
					absolutePath: "D:/repo/docs/a.md",
					displayPath: "docs/a.md",
					inBasket: true,
					isRelated: false,
					directoryPaths: [{ absolutePath: "D:/repo/server", hits: 3 }],
				},
			],
		};
		const filtered = filterHeatByMdSources(heat, new Set(["d:/repo/docs/a.md"]));
		expect(filtered.totalHits).toBe(3);
		expect(filtered.tree[0]?.children[0]?.subtreeHits).toBe(3);
	});

	test("applyPublishPrefillToTargets uses published artifact parent directory", () =>
	{
		const targets = {
			codex: { selected: false, artifactKind: "agent" as const, outputDir: "" },
		};
		const next = applyPublishPrefillToTargets(targets as never, [{
			platform: "codex",
			artifactKind: "agent",
			absolutePath: "D:/repo/AGENTS.md",
			publishedAt: "2026-01-01T00:00:00.000Z",
		}]);
		expect(next.codex.outputDir).toBe("D:/repo");
		expect(next.codex.selected).toBe(true);
	});

	test("formatPublishStatusLabel shows drift state when present on published row", () =>
	{
		const label = formatPublishStatusLabel("copilot", "agent", [{
			platform: "copilot",
			artifactKind: "agent",
			absolutePath: "D:/repo/.github/agents/a.agent.md",
			publishedAt: "2026-06-21T00:00:00.000Z",
			state: "missing-file",
		}]);
		expect(label).toContain("missing-file");
	});

	test("formatPublishStatusLabel returns undefined when no ledger row", () =>
	{
		expect(formatPublishStatusLabel("cursor", "agent", [])).toBeUndefined();
	});

	test("sortPlatformsByLastSelected puts prior picks first", () =>
	{
		expect(sortPlatformsByLastSelected(["cursor", "codex"])).toEqual([
			"cursor",
			"codex",
			"claude",
			"copilot",
			"kiro",
			"windsurf",
			"antigravity",
		]);
	});

	test("buildInitialPublisherTargets uses last selected platforms", () =>
	{
		const targets = buildInitialPublisherTargets([], [], ["cursor", "kiro"]);
		expect(targets.cursor.selected).toBe(true);
		expect(targets.kiro.selected).toBe(true);
		expect(targets.codex.selected).toBe(false);
	});

	test("selectedPlatformsFromTargets collects checked rows", () =>
	{
		const selected = selectedPlatformsFromTargets({
			codex: { selected: true },
			claude: { selected: false },
			copilot: { selected: true },
			kiro: { selected: false },
			cursor: { selected: true },
			windsurf: { selected: false },
			antigravity: { selected: false },
		});
		expect(selected).toEqual(["codex", "copilot", "cursor"]);
	});

	test("publisher platform localStorage round-trip", () =>
	{
		if (typeof localStorage === "undefined") return;
		saveLastSelectedPublisherPlatforms(["cursor", "codex"]);
		expect(readLastSelectedPublisherPlatforms()).toEqual(["cursor", "codex"]);
		localStorage.removeItem("cxc-publisher-platforms");
		expect(readLastSelectedPublisherPlatforms()).toEqual([...DEFAULT_PUBLISHER_PLATFORMS]);
	});

	test("resolvePlacementPlatform prefers active when selected else first checked", () =>
	{
		const targets = {
			codex: { selected: false },
			claude: { selected: false },
			copilot: { selected: false },
			kiro: { selected: false },
			cursor: { selected: true },
			windsurf: { selected: false },
			antigravity: { selected: false },
		};
		expect(resolvePlacementPlatform(targets, "codex")).toBe("cursor");
		expect(resolvePlacementPlatform(targets, "cursor")).toBe("cursor");
	});

	test("outputDirFromArtifactPath strips file name", () =>
	{
		expect(outputDirFromArtifactPath("D:/repo/AGENTS.md")).toBe("D:/repo");
		expect(outputDirFromArtifactPath("D:/repo/.github/agents/worker.agent.md")).toBe("D:/repo/.github/agents");
	});
});
