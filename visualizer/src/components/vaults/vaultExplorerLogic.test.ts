/**
 * Vault Explorer logic tests — host copy, row gestures, and App entry contracts.
 *
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ve-vault-explorer.md (Review §14–16)
 */

import { describe, expect, test } from "bun:test";
import {
	applyCloseVaultExplorer,
	applyManageVaultsOpen,
	applySourceFilterAddVault,
	applyVaultSavedFromManagerHost,
	assertVaultBrowseOnlyApi,
	buildEditSessionFromVaultRow,
	getVaultManagerHostCopy,
	resolveDirectoryRowAction,
	VAULT_BROWSE_FORBIDDEN_APIS,
} from "./vaultExplorerLogic";

describe("vaultExplorerLogic", () =>
{
	test("getVaultManagerHostCopy shows reopen button when explorer is closed", () =>
	{
		const closed = getVaultManagerHostCopy(false);
		expect(closed.showReopenButton).toBe(true);
		expect(closed.note).toContain("Open Vault Explorer");

		const open = getVaultManagerHostCopy(true);
		expect(open.showReopenButton).toBe(false);
		expect(open.body).toContain("Vault Explorer is open");
	});

	test("resolveDirectoryRowAction maps single click, double click, and open button", () =>
	{
		expect(resolveDirectoryRowAction(1, "row")).toBe("select");
		expect(resolveDirectoryRowAction(2, "row")).toBe("open");
		expect(resolveDirectoryRowAction(1, "openButton")).toBe("open");
	});

	test("applySourceFilterAddVault opens dialog without changing view", () =>
	{
		const next = applySourceFilterAddVault({
			vaultExplorerOpen: false,
			activeViewType: "agent-builder",
			prepareCalls: 0,
			searchCalls: 0,
			createVaultCalls: 0,
		});
		expect(next.vaultExplorerOpen).toBe(true);
		expect(next.activeViewType).toBe("agent-builder");
		expect(next.prepareCalls).toBe(0);
	});

	test("applyManageVaultsOpen switches to vault-manager without opening dialog", () =>
	{
		const next = applyManageVaultsOpen({
			vaultExplorerOpen: true,
			activeViewType: "search",
			prepareCalls: 0,
			searchCalls: 0,
			createVaultCalls: 0,
		});
		expect(next.vaultExplorerOpen).toBe(false);
		expect(next.activeViewType).toBe("vault-manager");
	});

	test("applyCloseVaultExplorer leaves host view with closed dialog", () =>
	{
		const next = applyCloseVaultExplorer({
			vaultExplorerOpen: true,
			activeViewType: "vault-manager",
			prepareCalls: 0,
			searchCalls: 0,
			createVaultCalls: 0,
		});
		expect(next.vaultExplorerOpen).toBe(false);
		expect(next.activeViewType).toBe("vault-manager");
		expect(getVaultManagerHostCopy(next.vaultExplorerOpen).showReopenButton).toBe(true);
	});

	test("applyVaultSavedFromManagerHost lands on agent-builder", () =>
	{
		const next = applyVaultSavedFromManagerHost({
			vaultExplorerOpen: true,
			activeViewType: "vault-manager",
			prepareCalls: 0,
			searchCalls: 0,
			createVaultCalls: 0,
		});
		expect(next.vaultExplorerOpen).toBe(false);
		expect(next.activeViewType).toBe("agent-builder");
	});

	test("assertVaultBrowseOnlyApi rejects Save/index APIs", () =>
	{
		for (const api of VAULT_BROWSE_FORBIDDEN_APIS)
		{
			expect(() => assertVaultBrowseOnlyApi(api)).toThrow(/Forbidden during Vault Explorer browse/);
		}
		expect(() => assertVaultBrowseOnlyApi("fetchVaultInfo")).not.toThrow();
	});

	test("buildEditSessionFromVaultRow maps manager row to edit session", () =>
	{
		const session = buildEditSessionFromVaultRow({
			path: "D:/Codez/Nexus/AIUL2/zz-reach2",
			name: "Codez",
			type: "Vault",
		});
		expect(session.mode).toBe("edit");
		expect(session.editEntry.name).toBe("Codez");
		expect(session.editEntry.path).toContain("AIUL2");
	});
});
