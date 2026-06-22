/**
 * Vault Manager form helpers — vault name suggestion and touched-state during directory browse.
 *
 * Architecture: visualizer/zz-reach2/architecture/agents/archi-agent-builder-ui.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ve-vault-explorer.md (§20–22)
 */

/** Inputs for recomputing the Vault name field after the user selects or opens a directory. */
export type VaultNameOnPathChangeInput = {
	/** Current Vault name field value. */
	currentName: string;
	/** Basename from vault-info or the selected absolute path. */
	suggestedBasename: string;
	/** True after the user typed in the Vault name field — blocks auto-overwrite on browse. */
	nameTouched: boolean;
};

/** Result of applying path-based vault name suggestion rules. */
export type VaultNameOnPathChangeResult = {
	/** Value to assign to the Vault name input. */
	nextName: string;
	/** When true, show the optional "Use suggestion" hint below the field. */
	showSuggestionHint: boolean;
	/** Basename offered in the suggestion hint (may equal nextName when untouched). */
	suggestionBasename: string;
};

/**
 * Applies vault name suggestion when the selected directory path changes.
 * Business logic: intermediate folder clicks (e.g. D:\\Codez) must not stick when the user later selects a deeper project folder.
 * @param input - Current field value, server basename, and whether the user has edited the name.
 */
export function applyVaultNameOnPathChange(input: VaultNameOnPathChangeInput): VaultNameOnPathChangeResult
{
	if (!input.nameTouched)
	{
		return {
			nextName: input.suggestedBasename,
			showSuggestionHint: false,
			suggestionBasename: input.suggestedBasename,
		};
	}

	const differs = input.currentName.trim() !== input.suggestedBasename;
	return {
		nextName: input.currentName,
		showSuggestionHint: differs,
		suggestionBasename: input.suggestedBasename,
	};
}

/**
 * Applies the user-requested basename from the suggestion hint.
 * Business logic: accepting a suggestion clears touched so later browse can auto-suggest again.
 * @param suggestionBasename - Basename from the hint row.
 */
export function applyUseVaultNameSuggestion(suggestionBasename: string): {
	nextName: string;
	nameTouched: boolean;
}
{
	return { nextName: suggestionBasename, nameTouched: false };
}

/**
 * @deprecated Use {@link applyVaultNameOnPathChange} — only fills when empty, causing sticky intermediate folder names.
 * Suggests a source name from path validation only when the user has not typed one yet.
 * @param currentName - Current Source name field value.
 * @param suggestedName - Basename-derived default from server path info.
 */
export function suggestSourceNameIfEmpty(currentName: string, suggestedName: string): string
{
	return currentName.trim() ? currentName : suggestedName;
}
