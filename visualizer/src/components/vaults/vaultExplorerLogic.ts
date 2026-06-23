/**
 * Vault Explorer pure logic — host copy, row actions, and App entry-point contracts.
 *
 * Architecture: visualizer/zz-reach2/architecture/agents/archi-agent-builder-ui.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ve-vault-explorer.md (Review §13–16, §28–30)
 */

/** Copy and affordances for the vault-manager host view. */
export type VaultManagerHostCopy = {
	heading: string;
	body: string;
	note: string;
	showReopenButton: boolean;
};

/** Directory row interaction target. */
export type DirectoryRowTarget = "row" | "openButton";

/** Resolved browse action for a directory row gesture. */
export type DirectoryRowAction = "select" | "open";

/** App-owned state snapshot for Vault Explorer entry points. */
export type VaultExplorerAppState = {
	vaultExplorerOpen: boolean;
	activeViewType: string;
	prepareCalls: number;
	searchCalls: number;
	createVaultCalls: number;
};

/** Minimal vault row used when opening edit mode from Vault Manager. */
export type VaultManagerRow = {
	path: string;
	name: string;
	type: string;
};

/** Explorer session fragment for edit mode opened from a manager row. */
export type VaultExplorerEditSession = {
	mode: "edit";
	editEntry: VaultManagerRow;
};

/**
 * Builds edit-mode explorer session state from a Vault Manager inventory row click.
 * @param vault - Vault row the user clicked in VaultManagerView.
 */
export function buildEditSessionFromVaultRow(vault: VaultManagerRow): VaultExplorerEditSession
{
	return {
		mode: "edit",
		editEntry: {
			path: vault.path,
			name: vault.name,
			type: vault.type,
		},
	};
}

/** API names that must never run during read-only browse. */
export const VAULT_BROWSE_FORBIDDEN_APIS = [
	"createVault",
	"fetchAgentBuilderPrepare",
	"search",
] as const;

/**
 * Returns host copy for open vs closed Vault Explorer on the vault-manager view.
 * @param explorerOpen - Whether VaultExplorerDialog is currently visible.
 */
export function getVaultManagerHostCopy(explorerOpen: boolean): VaultManagerHostCopy
{
	if (explorerOpen)
	{
		return {
			heading: "Vault Manager",
			body: "Vault Explorer is open. Browse a project directory, then use Save Vault to add an AgentBuilder source.",
			note: "Browsing is read-only until Save — cc.json is not changed during navigation.",
			showReopenButton: false,
		};
	}

	return {
		heading: "Vault Manager",
		body: "Add or browse AgentBuilder knowledge vaults on this machine.",
		note: "Open Vault Explorer to pick a directory. Save Vault writes cc.json and starts indexing.",
		showReopenButton: true,
	};
}

/**
 * Maps a directory row gesture to select-only vs navigate-open behavior.
 * @param clickCount - 1 for single click, 2+ for double click.
 * @param target - Whether the user clicked the row or the explicit open control.
 */
export function resolveDirectoryRowAction(clickCount: number, target: DirectoryRowTarget): DirectoryRowAction
{
	if (target === "openButton") return "open";
	if (clickCount >= 2) return "open";
	return "select";
}

/**
 * Opens Vault Explorer from Source Filter without changing the active view.
 * @param state - App-owned explorer and view state.
 */
export function applySourceFilterAddVault(state: VaultExplorerAppState): VaultExplorerAppState
{
	return {
		...state,
		vaultExplorerOpen: true,
	};
}

/**
 * Switches to Vault Manager host view without opening Vault Explorer.
 * @param state - App-owned explorer and view state.
 */
export function applyManageVaultsOpen(state: VaultExplorerAppState): VaultExplorerAppState
{
	return {
		...state,
		vaultExplorerOpen: false,
		activeViewType: "vault-manager",
	};
}

/**
 * Closes the explorer while staying on the vault-manager host view.
 * @param state - App-owned explorer and view state.
 */
export function applyCloseVaultExplorer(state: VaultExplorerAppState): VaultExplorerAppState
{
	return {
		...state,
		vaultExplorerOpen: false,
	};
}

/**
 * After Save from vault-manager, land on Agent Builder so the new source is visible in context.
 * @param state - App-owned explorer and view state.
 */
export function applyVaultSavedFromManagerHost(state: VaultExplorerAppState): VaultExplorerAppState
{
	return {
		...state,
		vaultExplorerOpen: false,
		activeViewType: "agent-builder",
	};
}

/**
 * Records a browse-only API call and throws when a forbidden Save/index action is attempted.
 * @param apiName - Client API identifier under test.
 */
export function assertVaultBrowseOnlyApi(apiName: string): void
{
	if ((VAULT_BROWSE_FORBIDDEN_APIS as readonly string[]).includes(apiName))
	{
		throw new Error(`Forbidden during Vault Explorer browse: ${apiName}`);
	}
}
