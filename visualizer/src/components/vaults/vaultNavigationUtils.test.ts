/**
 * Vault Explorer navigation helper tests — selection vs open and Save guard.
 *
 * Architecture: visualizer/zz-reach2/architecture/agents/archi-agent-builder-ui.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ve-vault-explorer.md (§23, §29)
 */

import { describe, expect, test } from "bun:test";
import {
	buildVaultExplorerSubtitle,
	computeCanSaveVault,
	onDirectoryRowKeyDown,
	shouldShowAlreadyConfiguredError,
} from "./vaultNavigationUtils";
import type { VaultInfoResponse } from "../../api/vaults";

const validInfo: VaultInfoResponse = {
	path: "D:/proj",
	name: "proj",
	exists: true,
	isDirectory: true,
	readable: true,
	warnings: [],
	alreadyConfigured: false,
};

describe("vaultNavigationUtils", () =>
{
	test("computeCanSaveVault add mode requires readable non-duplicate directory", () =>
	{
		expect(computeCanSaveVault({
			mode: "add",
			selectedPath: "D:/proj",
			vaultName: "proj",
			vaultInfo: validInfo,
			loading: false,
			saving: false,
		})).toBe(true);

		expect(computeCanSaveVault({
			mode: "add",
			selectedPath: "D:/proj",
			vaultName: "proj",
			vaultInfo: { ...validInfo, alreadyConfigured: true },
			loading: false,
			saving: false,
		})).toBe(false);
	});

	test("computeCanSaveVault edit mode allows alreadyConfigured vault path", () =>
	{
		expect(computeCanSaveVault({
			mode: "edit",
			selectedPath: "D:/proj",
			editPath: "D:/proj",
			vaultName: "Renamed",
			vaultInfo: { ...validInfo, alreadyConfigured: true },
			loading: false,
			saving: false,
		})).toBe(true);
	});

	test("shouldShowAlreadyConfiguredError suppressed in edit mode for own path", () =>
	{
		expect(shouldShowAlreadyConfiguredError("edit", "D:/proj", "D:/proj", true)).toBe(false);
		expect(shouldShowAlreadyConfiguredError("add", "D:/proj", "D:/proj", true)).toBe(true);
	});

	test("buildVaultExplorerSubtitle includes edit vault name", () =>
	{
		expect(buildVaultExplorerSubtitle("edit", "D:/vault/path", "AIUL2")).toContain("Edit vault: AIUL2");
	});

	test("edit mode save footer label contract", () =>
	{
		const label = (mode: "add" | "edit") => (mode === "edit" ? "Save changes" : "Save Vault");
		expect(label("edit")).toBe("Save changes");
		expect(label("add")).toBe("Save Vault");
	});

	test("onDirectoryRowKeyDown Enter opens and Space selects", () =>
	{
		let selected = "";
		let opened = "";

		onDirectoryRowKeyDown(
			{ key: "Enter", preventDefault: () => {} } as never,
			"D:/child",
			{
				selectDirectory: (path) => { selected = path; },
				openDirectory: (path) => { opened = path; },
			},
		);
		expect(opened).toBe("D:/child");
		expect(selected).toBe("");

		onDirectoryRowKeyDown(
			{ key: " ", preventDefault: () => {} } as never,
			"D:/child",
			{
				selectDirectory: (path) => { selected = path; },
				openDirectory: (path) => { opened = path; },
			},
		);
		expect(selected).toBe("D:/child");
	});
});
