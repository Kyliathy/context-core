/**
 * Post-Save Vault integration helpers — update source inventory from createVault/updateVault responses only.
 *
 * Architecture: visualizer/zz-reach2/architecture/agents/archi-agent-builder-ui.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ve-vault-explorer.md (§17, §27)
 */

import type { CreateVaultResponse, UpdateVaultResponse } from "../../api/vaults";

/** Agent Builder source row — source filter names plus Vault Manager inventory columns. */
export type VaultSourceSummary = {
	name: string;
	path: string;
	type: string;
	fileCount: number;
	codexDirectories?: string[];
	codexDefaultDirectory?: string;
};

/** Alias for Vault Manager list rows — same shape as {@link VaultSourceSummary}. */
export type VaultInventoryRow = VaultSourceSummary;

/** Minimal prepare source shape used when mapping server payloads into inventory rows. */
export type PrepareSourceLike = {
	name: string;
	type?: string;
	path?: string;
	fileCount: number;
	codexDirectories?: string[];
	codexDefaultDirectory?: string;
};

/**
 * Maps GET /prepare source rows into Vault Manager inventory rows.
 * @param sources - Prepare response sources from the server.
 */
export function mapPrepareSourcesToInventory(sources: PrepareSourceLike[]): VaultInventoryRow[]
{
	return sources.map((source) => ({
		name: source.name,
		path: source.path ?? "",
		type: source.type ?? "Vault",
		fileCount: source.fileCount,
		codexDirectories: source.codexDirectories,
		codexDefaultDirectory: source.codexDefaultDirectory,
	}));
}

/**
 * Maps POST/PATCH /vaults prepare payload into Agent Builder source inventory rows.
 * Business logic: Save is the only client action that should refresh sources — never call prepare during browse.
 * @param result - Successful Save Vault or Save changes response including indexed prepare summary.
 * @param previousSources - Existing rows to merge when prepare omits zero-file sources.
 * @param previousName - When renaming via PATCH, drop the old name row so the inventory does not show duplicates.
 */
export function mapVaultSaveToSourceSummaries(
	result: CreateVaultResponse | UpdateVaultResponse,
	previousSources: VaultSourceSummary[] = [],
	previousName?: string,
): VaultSourceSummary[]
{
	const byName = new Map<string, VaultSourceSummary>();
	for (const source of previousSources)
	{
		byName.set(source.name, source);
	}

	// Business logic: PATCH rename must remove the stale display name before merging prepare rows.
	if (previousName && previousName !== result.entry.name)
	{
		byName.delete(previousName);
	}

	for (const source of result.prepare.sources)
	{
		byName.set(source.name, {
			name: source.name,
			path: source.path ?? result.entry.path,
			type: source.type ?? result.entry.type,
			fileCount: source.fileCount,
			codexDirectories: source.codexDirectories,
			codexDefaultDirectory: source.codexDefaultDirectory,
		});
	}

	// Business logic: empty vaults may be absent from prepare on older backends — always surface the saved entry.
	if (!byName.has(result.entry.name))
	{
		byName.set(result.entry.name, {
			name: result.entry.name,
			path: result.entry.path,
			type: result.entry.type,
			fileCount: 0,
		});
	}

	return Array.from(byName.values());
}

/**
 * Adds a newly saved vault name to the user's source filter selection.
 * @param previous - Current selected source names.
 * @param sourceName - Name from the persisted dataSources entry.
 */
export function addVaultNameToSourceSelection(previous: Set<string>, sourceName: string): Set<string>
{
	const next = new Set(previous);
	next.add(sourceName);
	return next;
}

/**
 * Replaces a renamed vault in the source filter selection Set.
 * Business logic: users expect the same vault to stay selected after PATCH even when the display name changes.
 * @param previous - Current selected source names.
 * @param previousName - Name before PATCH (from server previousName).
 * @param nextName - Name after PATCH.
 */
export function replaceVaultNameInSourceSelection(
	previous: Set<string>,
	previousName: string,
	nextName: string,
): Set<string>
{
	const next = new Set(previous);
	if (next.has(previousName))
	{
		next.delete(previousName);
		next.add(nextName);
	}
	else
	{
		next.add(nextName);
	}
	return next;
}
