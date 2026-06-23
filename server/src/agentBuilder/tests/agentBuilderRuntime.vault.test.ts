/**
 * AgentBuilderRuntime Save Vault integration tests — real cc.json write and prepare payload.
 *
 * Architecture: server/zz-reach2/architecture/agents/archi-agent-builder.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ve-vault-explorer.md (Review §13, §16)
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AgentBuilderRuntime } from "../AgentBuilderRuntime.js";
import { CanonicalAgentStore } from "../../agentPublisher/CanonicalAgentStore.js";
import { makeTestMachineConfig } from "../../config/testFixtures.js";
import { writeCcJson } from "../../config/ccJsonEditor.js";
import type { ContextCoreConfig } from "../../types.js";

describe("AgentBuilderRuntime.addVault", () =>
{
	test("saves empty vault to cc.json and returns prepare source with fileCount 0", async () =>
	{
		const base = mkdtempSync(join(tmpdir(), "cxc-runtime-vault-"));
		const vaultDir = join(base, "fresh-empty-vault");
		const storageDir = join(base, "storage");
		const configPath = join(base, "cc.json");
		mkdirSync(vaultDir, { recursive: true });
		mkdirSync(storageDir, { recursive: true });

		const machine = makeTestMachineConfig("test-host");
		const config: ContextCoreConfig = { storage: storageDir, machines: [machine] };
		writeCcJson(configPath, config, { backup: true });

		const store = new CanonicalAgentStore(storageDir);
		store.load();
		const runtime = new AgentBuilderRuntime(configPath, storageDir, store, machine);
		await runtime.initializeFromMachine(machine);

		try
		{
			const result = await runtime.addVault("test-host", {
				path: vaultDir,
				name: "FreshEmptyVault",
				type: "Vault",
			});

			expect(result.prepare.sources.some(
				(source) => source.name === "FreshEmptyVault" && source.fileCount === 0,
			)).toBe(true);
			expect(result.entry.name).toBe("FreshEmptyVault");

			const reread = JSON.parse(readFileSync(configPath, "utf-8")) as ContextCoreConfig;
			const vaults = reread.machines[0].dataSources?.vaults ?? [];
			expect(vaults.some((entry) => entry.name === "FreshEmptyVault" && entry.path === vaultDir)).toBe(true);
			expect(existsSync(`${configPath}.bak`)).toBe(true);
			expect(runtime.getAgentBuilder()).toBeDefined();
		}
		finally
		{
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("AgentBuilderRuntime.updateVault", () =>
{
	test("PATCH metadata updates cc.json and returns prepare with new name", async () =>
	{
		const base = mkdtempSync(join(tmpdir(), "cxc-runtime-update-"));
		const vaultDir = join(base, "rename-vault");
		const storageDir = join(base, "storage");
		const configPath = join(base, "cc.json");
		mkdirSync(vaultDir, { recursive: true });
		mkdirSync(storageDir, { recursive: true });

		const machine = makeTestMachineConfig("test-host", {
			vaults: [{
				path: vaultDir,
				name: "Codez",
				type: "Vault",
				purpose: "AgentBuilder",
			}],
		});
		const config: ContextCoreConfig = { storage: storageDir, machines: [machine] };
		writeCcJson(configPath, config, { backup: true });

		const store = new CanonicalAgentStore(storageDir);
		store.load();
		const runtime = new AgentBuilderRuntime(configPath, storageDir, store, machine);
		await runtime.initializeFromMachine(machine);

		try
		{
			const result = await runtime.updateVault("test-host", {
				path: vaultDir,
				name: "AIUL2",
				type: "Vault",
			});

			expect(result.previousName).toBe("Codez");
			expect(result.entry.name).toBe("AIUL2");
			expect(result.prepare.sources.some((source) => source.name === "AIUL2")).toBe(true);

			const reread = JSON.parse(readFileSync(configPath, "utf-8")) as ContextCoreConfig;
			expect(reread.machines[0].dataSources?.vaults?.[0]?.name).toBe("AIUL2");
		}
		finally
		{
			rmSync(base, { recursive: true, force: true });
		}
	});
});
