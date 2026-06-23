/**
 * Tests for r2ab3 Agent Publisher wave — collision, classifier, Cursor, ledger.
 *
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ab3-agent-builder-3.md
 */

import { describe, expect, test } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { decideAgentsCollision, applyIntraPreviewAgentsCollision } from "../agentsCollision.js";
import { classifyAgentArtifactPath, isListableAgentDefinitionPath, looksLikeCodexCollection } from "../agentArtifactClassifier.js";
import { AgentPublisherCursor, renderCursorAgentMarkdown } from "../platforms/AgentPublisherCursor.js";
import { AgentPublisher } from "../AgentPublisher.js";
import { AgentBuilder } from "../../agentBuilder/AgentBuilder.js";
import { CanonicalAgentStore } from "../CanonicalAgentStore.js";
import { PublishLedger } from "../PublishLedger.js";
import { toCanonicalAgentDefinition } from "../canonical.js";
import { resolvePlatformPathContract } from "../pathContract.js";
import type { MachineConfig } from "../../types.js";
import { buildImportShimPlan } from "../importShim.js";
import { CXC_GENERATED_MARKER } from "../generatedMarker.js";
import { CODEX_AGENTS_JSON_FILE } from "../platforms/codexCollection.js";
import { linkStrategiesForTarget, assertLinkStrategyAllowed } from "../linkStrategyPolicy.js";
import { writeSymlinkWithBackup, probeSymlinkSupport } from "../symlinkOps.js";
import { lstatSync } from "fs";
import { basename } from "path";

function testMachine(root: string): MachineConfig
{
	const sourcePath = join(root, "repo");
	mkdirSync(sourcePath, { recursive: true });
	return {
		machine: "T",
		harnesses: {},
		dataSources: {
			t: [{
				path: sourcePath,
				agentPath: join(root, ".github", "agents"),
				claudeAgentPath: join(root, ".claude", "agents"),
				projectRoot: root,
				name: "Test Project",
				type: "Repo",
				purpose: "AgentBuilder",
			}],
		},
	};
}

function canonicalDef()
{
	return {
		...toCanonicalAgentDefinition({
			projectName: "Test Project",
			agentName: "worker",
			description: "Worker agent",
			"argument-hint": "hint",
			tools: ["read"],
			agentKnowledge: ["docs/a.md"],
		}),
		paths: ["src/**/*.ts"],
		disableModelInvocation: true,
	};
}

describe("agentsCollision", () =>
{
	test("codex collection vs cursor plain-agents-md is incompatible", () =>
	{
		const decision = decideAgentsCollision(
			{ platform: "codex", artifactKind: "agent", artifactFormat: "codex-collection" },
			{ platform: "cursor", artifactKind: "agent", artifactFormat: "plain-agents-md" },
		);
		expect(decision.ok).toBe(false);
	});

	test("same platform and format is replaceable", () =>
	{
		const decision = decideAgentsCollision(
			{ platform: "cursor", artifactKind: "agent", artifactFormat: "plain-agents-md" },
			{ platform: "cursor", artifactKind: "agent", artifactFormat: "plain-agents-md" },
		);
		expect(decision.ok).toBe(true);
		if (decision.ok) expect(decision.mode).toBe("same-platform-replace");
	});

	test("intra-preview rejects codex plus cursor on same AGENTS.md", () =>
	{
		const agentsPath = "D:/repo/AGENTS.md";
		const errors: string[] = [];
		const result = applyIntraPreviewAgentsCollision([
			{
				platform: "codex",
				artifactKind: "agent",
				absolutePath: agentsPath,
				content: "codex",
				artifactFormat: "codex-collection",
			},
			{
				platform: "cursor",
				artifactKind: "agent",
				absolutePath: agentsPath,
				content: "cursor",
				artifactFormat: "plain-agents-md",
			},
		], errors);
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain("incompatible");
		expect(result.filter((a) => basename(a.absolutePath).toLowerCase() === "agents.md")).toHaveLength(0);
	});

	test("intra-preview collapses same-platform duplicates", () =>
	{
		const agentsPath = "D:/repo/AGENTS.md";
		const errors: string[] = [];
		const result = applyIntraPreviewAgentsCollision([
			{
				platform: "cursor",
				artifactKind: "agent",
				absolutePath: agentsPath,
				content: "first",
				artifactFormat: "plain-agents-md",
			},
			{
				platform: "cursor",
				artifactKind: "agent",
				absolutePath: agentsPath,
				content: "second",
				artifactFormat: "plain-agents-md",
			},
		], errors);
		expect(errors).toEqual([]);
		const agents = result.filter((a) => basename(a.absolutePath).toLowerCase() === "agents.md");
		expect(agents).toHaveLength(1);
		expect(agents[0]?.content).toBe("second");
	});
});

describe("agentArtifactClassifier", () =>
{
	test("unmanaged AGENTS.md is unknown", () =>
	{
		const tempRoot = mkdtempSync(join(tmpdir(), "classifier-unknown-"));
		try
		{
			const agentsPath = join(tempRoot, "AGENTS.md");
			writeFileSync(agentsPath, "# Manual\n\nUser guidance.\n", "utf8");
			const result = classifyAgentArtifactPath(agentsPath);
			expect(result.platform).toBe("unknown");
			expect(isListableAgentDefinitionPath(agentsPath)).toBe(false);
		}
		finally
		{
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test("cursor provenance classifies plain AGENTS.md", () =>
	{
		const agentsPath = "D:/repo/AGENTS.md";
		const result = classifyAgentArtifactPath(agentsPath, {
			canonicalId: "test",
			platform: "cursor",
			artifactKind: "agent",
			absolutePath: agentsPath,
			canonicalHash: "a",
			artifactHash: "b",
			knowledge: [],
			referencedPaths: [],
			publishedAt: new Date().toISOString(),
			artifactFormat: "plain-agents-md",
		});
		expect(result.platform).toBe("cursor");
		expect(result.artifactFormat).toBe("plain-agents-md");
	});

	test("generated cursor AGENTS.md without ledger is unknown not codex", () =>
	{
		const tempRoot = mkdtempSync(join(tmpdir(), "classifier-cursor-gen-"));
		try
		{
			const agentsPath = join(tempRoot, "AGENTS.md");
			writeFileSync(agentsPath, `# worker\n\n${CXC_GENERATED_MARKER}\n`, "utf8");
			expect(looksLikeCodexCollection(agentsPath)).toBe(false);
			const result = classifyAgentArtifactPath(agentsPath);
			expect(result.platform).toBe("unknown");
			expect(isListableAgentDefinitionPath(agentsPath)).toBe(false);
		}
		finally
		{
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test("legacy AGENTS.json beside AGENTS.md classifies as codex", () =>
	{
		const tempRoot = mkdtempSync(join(tmpdir(), "classifier-legacy-codex-"));
		try
		{
			const agentsPath = join(tempRoot, "AGENTS.md");
			writeFileSync(agentsPath, "# Codex\n", "utf8");
			writeFileSync(
				join(tempRoot, CODEX_AGENTS_JSON_FILE),
				JSON.stringify({ platform: "codex", agentName: "worker" }),
				"utf8",
			);
			expect(looksLikeCodexCollection(agentsPath)).toBe(true);
			const result = classifyAgentArtifactPath(agentsPath);
			expect(result.platform).toBe("codex");
		}
		finally
		{
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});
});

describe("AgentPublisherCursor", () =>
{
	test("renders plain AGENTS.md agent snapshot", () =>
	{
		const md = renderCursorAgentMarkdown(canonicalDef());
		expect(md).toContain("# worker");
		expect(md).toContain("Worker agent");
		expect(md).toContain("Generated by ContextCore AgentPublisher");
		expect(md).not.toContain("---");
	});

	test("skill path uses .agents/skills", () =>
	{
		const publisher = new AgentPublisherCursor();
		const artifacts = publisher.render(canonicalDef(), {
			platform: "cursor",
			artifactKind: "skill",
			outputDir: "/repo",
		});
		expect(artifacts[0]?.absolutePath.replace(/\\/g, "/")).toContain("/.agents/skills/");
		expect(artifacts[0]?.content).toContain("disable-model-invocation: true");
	});
});

describe("pathContract cursor", () =>
{
	test("cursor defaults to project root", () =>
	{
		const source = {
			path: "D:/repo/src",
			projectRoot: "D:/repo",
			name: "P",
			type: "Repo",
			purpose: "AgentBuilder",
		};
		const contract = resolvePlatformPathContract(source, "cursor");
		expect(contract.agentOutputDir.replace(/\\/g, "/")).toBe("D:/repo");
	});
});

describe("PublishLedger artifactFormat", () =>
{
	test("round-trips artifactFormat and linkStrategy", () =>
	{
		const tempRoot = mkdtempSync(join(tmpdir(), "ledger-format-"));
		try
		{
			const ledger = new PublishLedger(tempRoot);
			ledger.load();
			ledger.upsert({
				canonicalId: "a",
				platform: "cursor",
				artifactKind: "agent",
				absolutePath: join(tempRoot, "AGENTS.md"),
				canonicalHash: "h1",
				artifactHash: "h2",
				knowledge: [],
				referencedPaths: [],
				publishedAt: new Date().toISOString(),
				artifactFormat: "plain-agents-md",
				actualLinkStrategy: "copy",
			});
			ledger.save();
			const reloaded = new PublishLedger(tempRoot);
			reloaded.load();
			const entry = reloaded.getByAbsolutePath(join(tempRoot, "AGENTS.md"));
			expect(entry?.artifactFormat).toBe("plain-agents-md");
			expect(entry?.actualLinkStrategy).toBe("copy");
		}
		finally
		{
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});
});

describe("AgentPublisher integration", () =>
{
	test("publish persists canonical definition before write", () =>
	{
		const tempRoot = mkdtempSync(join(tmpdir(), "publish-canonical-"));
		const storage = join(tempRoot, "storage");
		try
		{
			const machine = testMachine(tempRoot);
			const store = new CanonicalAgentStore(storage);
			store.load();
			const builder = new AgentBuilder(machine, store, storage);
			const publisher = new AgentPublisher(machine.dataSources!.t, storage, builder, undefined, store, () => false);
			const def = canonicalDef();
			const outputDir = join(tempRoot, "repo");
			mkdirSync(outputDir, { recursive: true });
			const result = publisher.publish(def, [{
				platform: "cursor",
				artifactKind: "agent",
				outputDir,
			}]);
			expect(result.errors).toEqual([]);
			expect(existsSync(join(outputDir, "AGENTS.md"))).toBe(true);
			const reloaded = new CanonicalAgentStore(storage);
			reloaded.load();
			expect(reloaded.get(def.id)?.name).toBe("worker");
			const artifacts = reloaded.get(def.id)?.publishedArtifacts ?? [];
			expect(artifacts.length).toBe(1);
			expect(artifacts[0]?.platform).toBe("cursor");
			expect(artifacts[0]?.artifactKind).toBe("agent");
			expect(artifacts[0]?.absolutePath).toContain("AGENTS.md");
		}
		finally
		{
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test("preview blocks cursor after codex on same AGENTS.md", () =>
	{
		const tempRoot = mkdtempSync(join(tmpdir(), "collision-preview-"));
		const storage = join(tempRoot, "storage");
		try
		{
			const machine = testMachine(tempRoot);
			const outputDir = join(tempRoot, "repo");
			mkdirSync(outputDir, { recursive: true });
			const publisher = new AgentPublisher(machine.dataSources!.t, storage, undefined, undefined, undefined, () => false);
			const def = canonicalDef();
			publisher.publish(def, [{ platform: "codex", artifactKind: "agent", outputDir }]);
			const cursorPreview = publisher.preview(def, [{ platform: "cursor", artifactKind: "agent", outputDir }]);
			expect(cursorPreview.errors.some((e) => e.includes("different platform format"))).toBe(true);
		}
		finally
		{
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test("preview blocks codex and cursor selected together in one request", () =>
	{
		const tempRoot = mkdtempSync(join(tmpdir(), "collision-intra-"));
		const storage = join(tempRoot, "storage");
		try
		{
			const machine = testMachine(tempRoot);
			const outputDir = join(tempRoot, "repo");
			mkdirSync(outputDir, { recursive: true });
			const publisher = new AgentPublisher(machine.dataSources!.t, storage, undefined, undefined, undefined, () => false);
			const def = canonicalDef();
			const preview = publisher.preview(def, [
				{ platform: "codex", artifactKind: "agent", outputDir },
				{ platform: "cursor", artifactKind: "agent", outputDir },
			]);
			expect(preview.errors.some((e) => e.includes("incompatible"))).toBe(true);
			expect(preview.artifacts.filter((a) => basename(a.absolutePath).toLowerCase() === "agents.md")).toHaveLength(0);
		}
		finally
		{
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test("list shows cursor after publish when ledger cache was primed empty", () =>
	{
		const tempRoot = mkdtempSync(join(tmpdir(), "list-cursor-ledger-"));
		const storage = join(tempRoot, "storage");
		try
		{
			const machine = testMachine(tempRoot);
			const store = new CanonicalAgentStore(storage);
			store.load();
			const builder = new AgentBuilder(machine, store, storage);
			builder.list();
			const publisher = new AgentPublisher(
				machine.dataSources!.t,
				storage,
				builder,
				(sourceName, artifacts) => builder.upsertPublishedArtifacts(sourceName, artifacts),
				store,
				() => false,
			);
			const def = canonicalDef();
			const outputDir = join(tempRoot, "repo");
			mkdirSync(outputDir, { recursive: true });
			const publishResult = publisher.publish(def, [{
				platform: "cursor",
				artifactKind: "agent",
				outputDir,
			}]);
			expect(publishResult.errors).toEqual([]);
			const listed = builder.list();
			const worker = listed.agents.find((a) => a.name === "worker");
			expect(worker?.canonicalId).toBe(def.id);
			expect(worker?.unpublished).toBe(false);
			expect(worker?.publishedTo.some((p) => p.platform === "cursor")).toBe(true);
			expect(worker?.publishedTo.some((p) => p.platform === "codex")).toBe(false);
		}
		finally
		{
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test("getPlatforms omits symlink and scopes claude import-shim to agents", () =>
	{
		const tempRoot = mkdtempSync(join(tmpdir(), "platforms-cap-"));
		try
		{
			const machine = testMachine(tempRoot);
			const publisher = new AgentPublisher(machine.dataSources!.t, join(tempRoot, "storage"), undefined, undefined, undefined, () => false);
			const platforms = publisher.getPlatforms();
			const claude = platforms.find((p) => p.platform === "claude");
			expect(claude?.supportedLinkStrategiesByKind?.agent).toEqual(["copy", "import-shim"]);
			expect(claude?.supportedLinkStrategiesByKind?.skill).toEqual(["copy"]);
			expect(platforms.every((p) => !(p.supportedLinkStrategiesByKind?.agent ?? []).includes("symlink"))).toBe(true);
		}
		finally
		{
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test("preview rejects claude skill import-shim", () =>
	{
		const tempRoot = mkdtempSync(join(tmpdir(), "import-shim-skill-"));
		const storage = join(tempRoot, "storage");
		try
		{
			const machine = testMachine(tempRoot);
			const outputDir = join(tempRoot, "repo", ".claude", "agents");
			mkdirSync(outputDir, { recursive: true });
			const publisher = new AgentPublisher(machine.dataSources!.t, storage, undefined, undefined, undefined, () => false);
			const def = canonicalDef();
			const preview = publisher.preview(def, [{
				platform: "claude",
				artifactKind: "skill",
				outputDir: join(tempRoot, "repo"),
				linkStrategy: "import-shim",
			}]);
			expect(preview.errors.some((e) => e.includes("import-shim"))).toBe(true);
		}
		finally
		{
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});
});

describe("importShim", () =>
{
	test("rejects unsupported platform", () =>
	{
		const result = buildImportShimPlan({
			platform: "cursor",
			artifactKind: "agent",
			outputDir: "/tmp",
			linkStrategy: "import-shim",
		}, ["/tmp"]);
		expect("error" in result).toBe(true);
	});
});

describe("linkStrategyPolicy", () =>
{
	test("claude agent allows import-shim; skill is copy-only", () =>
	{
		expect(linkStrategiesForTarget("claude", "agent")).toEqual(["copy", "import-shim"]);
		expect(linkStrategiesForTarget("claude", "skill")).toEqual(["copy"]);
		expect(() => assertLinkStrategyAllowed("claude", "skill", "import-shim")).toThrow();
	});
});

describe("symlinkOps", () =>
{
	test.skipIf(!probeSymlinkSupport())("writeSymlinkWithBackup replaces unmanaged file with symlink", () =>
	{
		const tempRoot = mkdtempSync(join(tmpdir(), "symlink-backup-"));
		try
		{
			const source = join(tempRoot, "source.md");
			const link = join(tempRoot, "target.md");
			writeFileSync(source, "source content", "utf8");
			writeFileSync(link, "unmanaged user file", "utf8");
			const backup = writeSymlinkWithBackup({
				sourcePath: source,
				linkPath: link,
				generatedMarkers: ["<!-- generated -->"],
			});
			expect(backup).toBeDefined();
			expect(existsSync(backup!)).toBe(true);
			expect(lstatSync(link).isSymbolicLink()).toBe(true);
			expect(readFileSync(link, "utf8")).toBe("source content");
		}
		finally
		{
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});
});

describe("canonical optional fields", () =>
{
	test("old JSON without paths still loads", () =>
	{
		const store = new CanonicalAgentStore(mkdtempSync(join(tmpdir(), "canon-old-")));
		store.load();
		const def = toCanonicalAgentDefinition({
			projectName: "P",
			agentName: "a",
			description: "d",
			"argument-hint": "h",
			agentKnowledge: [],
		});
		store.upsert(def);
		store.save();
		expect(store.get(def.id)?.paths).toBeUndefined();
	});
});
