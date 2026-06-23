import { describe, expect, test } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { AgentBuilder } from "../../agentBuilder/AgentBuilder.js";
import { CanonicalAgentStore } from "../CanonicalAgentStore.js";
import { AgentPublisherCopilot } from "../platforms/AgentPublisherCopilot.js";
import { AgentPublisherClaude } from "../platforms/AgentPublisherClaude.js";
import { CXC_GENERATED_MARKER } from "../generatedMarker.js";
import { backupUnmanagedFileIfNeeded } from "../fileOps.js";
import type { MachineConfig } from "../../types.js";

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
				name: "Test Project",
				type: "Repo",
				purpose: "AgentBuilder",
			}],
		},
	};
}

describe("review remediation integration", () =>
{
	test("canonical-only create survives store reload", () =>
	{
		const tempRoot = mkdtempSync(join(tmpdir(), "canonical-persist-"));
		const storage = join(tempRoot, "storage");
		try
		{
			const machine = testMachine(tempRoot);
			const store = new CanonicalAgentStore(storage);
			store.load();
			const builder = new AgentBuilder(machine, store);
			const result = builder.create({
				projectName: "Test Project",
				agentName: "worker",
				description: "d",
				"argument-hint": "h",
				agentKnowledge: [],
			});
			expect(result.persisted).toBe(true);
			expect(result.canonicalId).toBeDefined();

			const reloaded = new CanonicalAgentStore(storage);
			reloaded.load();
			expect(reloaded.get(result.canonicalId!)?.name).toBe("worker");
		}
		finally
		{
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test("default preview paths use platform-native agent directories", () =>
	{
		const tempRoot = mkdtempSync(join(tmpdir(), "native-preview-"));
		try
		{
			const copilotDir = join(tempRoot, ".github", "agents");
			const claudeDir = join(tempRoot, ".claude", "agents");
			mkdirSync(copilotDir, { recursive: true });
			mkdirSync(claudeDir, { recursive: true });
			const def = {
				id: "test-project-worker",
				kind: "agent" as const,
				projectName: "Test Project",
				name: "worker",
				description: "d",
				"argument-hint": "h",
				knowledge: [] as [],
			};
			const copilot = new AgentPublisherCopilot();
			const claude = new AgentPublisherClaude();
			const copilotPath = copilot.render(def, { platform: "copilot", artifactKind: "agent", outputDir: copilotDir })[0]!.absolutePath.replace(/\\/g, "/");
			const claudePath = claude.render(def, { platform: "claude", artifactKind: "agent", outputDir: claudeDir })[0]!.absolutePath.replace(/\\/g, "/");
			expect(copilotPath).toContain("/.github/agents/worker.agent.md");
			expect(claudePath).toContain("/.claude/agents/worker.md");
		}
		finally
		{
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test("re-publishing generated Copilot artifact does not create backup", () =>
	{
		const tempRoot = mkdtempSync(join(tmpdir(), "generated-backup-"));
		try
		{
			const target = join(tempRoot, "worker.agent.md");
			writeFileSync(target, `---\nname: worker\n---\n\n${CXC_GENERATED_MARKER}\n`, "utf8");
			expect(backupUnmanagedFileIfNeeded(target, CXC_GENERATED_MARKER)).toBeUndefined();
		}
		finally
		{
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test("overwriting unmanaged file still creates backup", () =>
	{
		const tempRoot = mkdtempSync(join(tmpdir(), "unmanaged-backup-"));
		try
		{
			const target = join(tempRoot, "worker.agent.md");
			writeFileSync(target, "user content", "utf8");
			const backup = backupUnmanagedFileIfNeeded(target, CXC_GENERATED_MARKER);
			expect(backup).toBeDefined();
			expect(existsSync(backup!)).toBe(true);
			expect(readFileSync(backup!, "utf8")).toBe("user content");
		}
		finally
		{
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});
});
