/**
 * Vault Save integration tests — source refresh only after Save Vault / Save changes succeeds.
 *
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ve-vault-explorer.md (§17, §27)
 */

import { describe, expect, test } from "bun:test";
import {
	addVaultNameToSourceSelection,
	mapPrepareSourcesToInventory,
	mapVaultSaveToSourceSummaries,
	replaceVaultNameInSourceSelection,
} from "./vaultSaveIntegration";
import type { CreateVaultResponse } from "../../api/vaults";

const saveResult: CreateVaultResponse = {
	entry: {
		path: "D:/NewVault",
		name: "NewVault",
		type: "Vault",
		purpose: "AgentBuilder",
	},
	category: "vaults",
	configPath: "cc.json",
	prepare: {
		totalFiles: 3,
		sources: [{
			name: "NewVault",
			type: "Vault",
			path: "D:/NewVault",
			fileCount: 3,
		}],
		files: [],
	},
};

describe("vaultSaveIntegration", () =>
{
	test("mapPrepareSourcesToInventory preserves path and type from prepare", () =>
	{
		const rows = mapPrepareSourcesToInventory([
			{ name: "AIUL2", type: "Reach2 Repo", path: "D:/Codez/Nexus/AIUL2/zz-reach2", fileCount: 12 },
		]);
		expect(rows[0]?.path).toBe("D:/Codez/Nexus/AIUL2/zz-reach2");
		expect(rows[0]?.type).toBe("Reach2 Repo");
	});

	test("mapVaultSaveToSourceSummaries uses prepare path and type from Save response", () =>
	{
		const sources = mapVaultSaveToSourceSummaries(saveResult);
		expect(sources).toHaveLength(1);
		expect(sources[0]?.name).toBe("NewVault");
		expect(sources[0]?.path).toBe("D:/NewVault");
		expect(sources[0]?.type).toBe("Vault");
		expect(sources[0]?.fileCount).toBe(3);
	});

	test("mapVaultSaveToSourceSummaries falls back to entry when prepare omits saved source", () =>
	{
		const emptyPrepare: CreateVaultResponse = {
			...saveResult,
			prepare: { totalFiles: 0, sources: [], files: [] },
		};
		const sources = mapVaultSaveToSourceSummaries(emptyPrepare, [{
			name: "Existing",
			path: "D:/Existing",
			type: "Vault",
			fileCount: 1,
		}]);
		expect(sources.some((source) => source.name === "NewVault" && source.fileCount === 0)).toBe(true);
		expect(sources.some((source) => source.name === "Existing")).toBe(true);
	});

	test("mapVaultSaveToSourceSummaries removes previousName row on PATCH rename", () =>
	{
		const renamed: CreateVaultResponse = {
			...saveResult,
			entry: { ...saveResult.entry, name: "AIUL2" },
			prepare: {
				totalFiles: 3,
				sources: [{ name: "AIUL2", type: "Vault", path: "D:/NewVault", fileCount: 3 }],
				files: [],
			},
		};
		const sources = mapVaultSaveToSourceSummaries(renamed, [{
			name: "Codez",
			path: "D:/NewVault",
			type: "Vault",
			fileCount: 3,
		}], "Codez");
		expect(sources.some((s) => s.name === "Codez")).toBe(false);
		expect(sources.some((s) => s.name === "AIUL2")).toBe(true);
	});

	test("addVaultNameToSourceSelection preserves existing selections", () =>
	{
		const next = addVaultNameToSourceSelection(new Set(["Existing"]), "NewVault");
		expect([...next]).toEqual(["Existing", "NewVault"]);
	});

	test("replaceVaultNameInSourceSelection swaps selected rename", () =>
	{
		const next = replaceVaultNameInSourceSelection(new Set(["Codez", "Other"]), "Codez", "AIUL2");
		expect([...next].sort()).toEqual(["AIUL2", "Other"]);
	});
});
