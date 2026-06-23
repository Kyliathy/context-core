/**
 * Vault Explorer entry-point helper contract tests (not full React component renders).
 *
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ve-vault-explorer.md (Review §16)
 */

import { describe, expect, test } from "bun:test";
import {
	applyManageVaultsOpen,
	applySourceFilterAddVault,
} from "./vaultExplorerLogic";

describe("vaultExplorer entry point helpers", () =>
{
	test("Add Vault opens popup without changing active view", () =>
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

	test("Manage Vaults switches to vault-manager host without opening dialog", () =>
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
		expect(next.prepareCalls).toBe(0);
	});
});
