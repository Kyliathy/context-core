/**
 * AgentBuilder.prepare() tests — configured sources appear even with zero indexed files.
 *
 * Architecture: server/zz-reach2/architecture/agents/archi-agent-builder.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ve-vault-explorer.md (Review §13)
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AgentBuilder } from "../AgentBuilder.js";
import { CanonicalAgentStore } from "../../agentPublisher/CanonicalAgentStore.js";
import { makeTestMachineConfig } from "../../config/testFixtures.js";
import type { MachineConfig } from "../../types.js";

/**
 * Builds a machine config with one empty AgentBuilder vault source.
 * @param vaultPath - Absolute path to an empty vault directory.
 */
function makeMachineWithEmptyVault(vaultPath: string): MachineConfig
{
	return makeTestMachineConfig("test-host", {
		vaults: [{
			path: vaultPath,
			projectRoot: vaultPath,
			name: "EmptyVault",
			type: "Vault",
			purpose: "AgentBuilder",
		}],
	});
}

describe("AgentBuilder.prepare", () =>
{
	test("includes configured sources with fileCount 0 when directory has no indexed files", async () =>
	{
		const base = mkdtempSync(join(tmpdir(), "cxc-prepare-empty-"));
		const vaultDir = join(base, "empty-vault");
		const storageDir = join(base, "storage");
		mkdirSync(vaultDir, { recursive: true });
		mkdirSync(storageDir, { recursive: true });

		try
		{
			const machine = makeMachineWithEmptyVault(vaultDir);
			const store = new CanonicalAgentStore(storageDir);
			store.load();
			const builder = new AgentBuilder(machine, store, storageDir);
			await builder.index();

			const prepared = builder.prepare();
			const emptySource = prepared.sources.find((source) => source.name === "EmptyVault");
			expect(emptySource).toBeDefined();
			expect(emptySource?.fileCount).toBe(0);
			expect(emptySource?.path).toBe(vaultDir);
			expect(emptySource?.type).toBe("Vault");
		}
		finally
		{
			rmSync(base, { recursive: true, force: true });
		}
	});

	test("filterName still limits configured sources and files", async () =>
	{
		const base = mkdtempSync(join(tmpdir(), "cxc-prepare-filter-"));
		const vaultDir = join(base, "vault-a");
		const storageDir = join(base, "storage");
		mkdirSync(vaultDir, { recursive: true });
		mkdirSync(storageDir, { recursive: true });

		try
		{
			const machine = makeMachineWithEmptyVault(vaultDir);
			const store = new CanonicalAgentStore(storageDir);
			store.load();
			const builder = new AgentBuilder(machine, store, storageDir);
			await builder.index();

			const prepared = builder.prepare("EmptyVault");
			expect(prepared.sources).toHaveLength(1);
			expect(prepared.sources[0]?.name).toBe("EmptyVault");
		}
		finally
		{
			rmSync(base, { recursive: true, force: true });
		}
	});
});
