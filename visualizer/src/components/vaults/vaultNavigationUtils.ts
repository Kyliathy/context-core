/**
 * Vault Explorer navigation and save-guard helpers — pure logic for directory browse vs Save.
 *
 * Architecture: visualizer/zz-reach2/architecture/agents/archi-agent-builder-ui.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ve-vault-explorer.md (§21, §29)
 */

import type { KeyboardEvent } from "react";
import type { VaultInfoResponse } from "../../api/vaults";

/** Explorer session mode — add creates a new cc.json row; edit PATCHes an existing path. */
export type VaultExplorerMode = "add" | "edit";

/** Inputs for the Save Vault / Save changes guard — mirrors dialog footer enablement rules. */
export type VaultSaveGuardInput = {
	mode: VaultExplorerMode;
	selectedPath: string;
	/** Original cc.json path when mode is edit — PATCH lookup key. */
	editPath?: string;
	vaultName: string;
	vaultInfo: VaultInfoResponse | null;
	loading: boolean;
	saving: boolean;
};

/**
 * Derives whether Save may run — browse/validate must not imply persistence.
 * Business logic: edit mode must allow Save on alreadyConfigured paths because the vault already exists in cc.json.
 * @param input - Current dialog selection, mode, and validation snapshot.
 */
export function computeCanSaveVault(input: VaultSaveGuardInput): boolean
{
	if (input.mode === "edit")
	{
		return Boolean(
			input.editPath?.trim()
			&& input.vaultName.trim()
			&& input.vaultInfo?.exists
			&& input.vaultInfo.readable
			&& !input.loading
			&& !input.saving,
		);
	}

	return Boolean(
		input.selectedPath.trim()
		&& input.vaultName.trim()
		&& input.vaultInfo?.exists
		&& input.vaultInfo.isDirectory
		&& input.vaultInfo.readable
		&& !input.vaultInfo.alreadyConfigured
		&& !input.loading
		&& !input.saving,
	);
}

/**
 * Builds the dialog subtitle under the Vault Explorer header.
 * @param mode - Add vs edit session.
 * @param selectedPath - Currently selected browse path.
 * @param editVaultName - Configured vault name when editing.
 */
export function buildVaultExplorerSubtitle(
	mode: VaultExplorerMode,
	selectedPath: string,
	editVaultName?: string,
): string
{
	const truncated = truncatePathForSubtitle(selectedPath);
	if (mode === "edit" && editVaultName)
	{
		return `Edit vault: ${editVaultName}${truncated ? ` · ${truncated}` : ""}`;
	}
	return truncated ? `Add vault · ${truncated}` : "Add vault";
}

/**
 * Truncates long absolute paths for the dialog subtitle.
 * @param path - Absolute directory path.
 */
export function truncatePathForSubtitle(path: string, maxLen = 56): string
{
	const trimmed = path.trim();
	if (!trimmed) return "";
	if (trimmed.length <= maxLen) return trimmed;
	return `…${trimmed.slice(-maxLen + 1)}`;
}

/**
 * Whether to show the duplicate-source error in edit mode.
 * Business logic: the vault's own path is already configured — suppress the scary duplicate banner while editing that row.
 * @param mode - Add vs edit session.
 * @param editPath - Original cc.json path in edit mode.
 * @param selectedPath - Currently highlighted browse path.
 * @param alreadyConfigured - vault-info duplicate flag.
 */
export function shouldShowAlreadyConfiguredError(
	mode: VaultExplorerMode,
	editPath: string | undefined,
	selectedPath: string,
	alreadyConfigured: boolean,
): boolean
{
	if (!alreadyConfigured) return false;
	if (mode === "edit" && editPath?.trim() && selectedPath.trim() === editPath.trim())
	{
		return false;
	}
	return true;
}

/** Callbacks invoked by directory row keyboard handling. */
export type VaultDirectoryRowKeyHandlers = {
	selectDirectory: (path: string) => void;
	openDirectory: (path: string) => void;
};

/**
 * Keyboard affordances for dense directory rows — Enter opens, Space selects.
 * @param event - Key event from a focused directory row.
 * @param path - Absolute path for the focused row.
 * @param handlers - Selection and navigation callbacks (read-only browse only).
 */
export function onDirectoryRowKeyDown(
	event: KeyboardEvent,
	path: string,
	handlers: VaultDirectoryRowKeyHandlers,
): void
{
	if (event.key === "Enter")
	{
		event.preventDefault();
		handlers.openDirectory(path);
		return;
	}
	if (event.key === " ")
	{
		event.preventDefault();
		handlers.selectDirectory(path);
	}
}
