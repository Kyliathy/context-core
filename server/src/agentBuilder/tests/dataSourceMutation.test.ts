/**
 * Vault dataSource mutation tests — create and update cc.json AgentBuilder entries.
 *
 * Architecture: server/zz-reach2/architecture/agents/archi-agent-builder.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ve-vault-explorer.md (§25)
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { updateVaultDataSource } from "../dataSourceMutation.js";
import { makeTestMachineConfig } from "../../config/testFixtures.js";
import { writeCcJson } from "../../config/ccJsonEditor.js";
import type { ContextCoreConfig } from "../../types.js";

describe("updateVaultDataSource", () =>
{
	test("updates vault name in cc.json while keeping path unchanged", () =>
	{
		const base = mkdtempSync(join(tmpdir(), "cxc-vault-update-"));
		const vaultDir = join(base, "aiul2-vault");
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

		try
		{
			const result = updateVaultDataSource(configPath, "test-host", {
				path: vaultDir,
				name: "AIUL2",
				type: "Reach2 Repo",
			}, { backup: true });

			expect(result.previousName).toBe("Codez");
			expect(result.entry.name).toBe("AIUL2");
			expect(result.entry.path).toBe(vaultDir);
			expect(result.entry.type).toBe("Reach2 Repo");

			const reread = JSON.parse(readFileSync(configPath, "utf-8")) as ContextCoreConfig;
			const vaults = reread.machines[0].dataSources?.vaults ?? [];
			expect(vaults[0]?.name).toBe("AIUL2");
			expect(vaults[0]?.path).toBe(vaultDir);
		}
		finally
		{
			rmSync(base, { recursive: true, force: true });
		}
	});
});
