/**
 * Default AgentBuilder data source entries for Add Vault and Edit Vault lookup.
 *
 * Architecture: server/zz-reach2/architecture/agents/archi-agent-builder.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ap-agent-publisher-2.md (Part B), r2ve-vault-explorer.md (§25)
 */

import { basename, resolve } from "path";
import type { DataSourceEntry, DataSources } from "../types.js";
import { normalizeForCompare } from "../agentPublisher/pathPolicy.js";

/** User input for POST /api/agent-builder/vaults. */
export type AddVaultInput = {
	path: string;
	name?: string;
	type?: string;
	/** dataSources category key; defaults to vaults. */
	category?: string;
	projectRoot?: string;
	agentPath?: string;
};

/** Result of validating and building a vault data source entry. */
export type VaultDataSourceBuildResult = {
	entry: DataSourceEntry;
	category: string;
	normalizedPath: string;
};

/**
 * Normalizes an absolute directory path for duplicate comparisons.
 * @param dirPath - User-selected directory path.
 */
export function normalizeVaultPath(dirPath: string): string
{
	return normalizeForCompare(resolve(dirPath.trim()));
}

/**
 * Derives a unique display name when the basename collides with existing sources.
 * @param desiredName - User-provided or basename-derived name.
 * @param existingNames - Names already present in dataSources for this machine.
 */
export function resolveUniqueVaultName(desiredName: string, existingNames: string[]): string
{
	const base = desiredName.trim();
	if (!existingNames.includes(base)) return base;

	let suffix = 2;
	while (existingNames.includes(`${base} ${suffix}`))
	{
		suffix += 1;
	}
	return `${base} ${suffix}`;
}

/**
 * Collects all AgentBuilder source paths from a machine config for duplicate detection.
 * @param dataSources - Machine dataSources map from cc.json.
 */
export function collectExistingAgentBuilderPaths(dataSources?: DataSources): Set<string>
{
	const paths = new Set<string>();
	if (!dataSources) return paths;

	// Business logic: duplicate vault paths must be rejected across every category bucket, not only vaults.
	for (const entries of Object.values(dataSources))
	{
		for (const entry of entries)
		{
			if (entry.purpose === "AgentBuilder" && entry.path?.trim())
			{
				paths.add(normalizeVaultPath(entry.path));
			}
		}
	}
	return paths;
}

/**
 * Collects existing AgentBuilder source names for duplicate-name suffixing.
 * @param dataSources - Machine dataSources map from cc.json.
 */
export function collectExistingAgentBuilderNames(dataSources?: DataSources): string[]
{
	const names: string[] = [];
	if (!dataSources) return names;

	for (const entries of Object.values(dataSources))
	{
		for (const entry of entries)
		{
			if (entry.purpose === "AgentBuilder" && entry.name?.trim())
			{
				names.push(entry.name.trim());
			}
		}
	}
	return names;
}

/** Located AgentBuilder row inside a machine dataSources map. */
export type LocatedAgentBuilderEntry = {
	category: string;
	index: number;
	entry: DataSourceEntry;
};

/**
 * Finds an AgentBuilder entry by normalized absolute path across all dataSources categories.
 * Business logic: vault PATCH must locate the correct row even when entries live outside the vaults bucket.
 * @param dataSources - Machine dataSources map from cc.json.
 * @param normalizedPath - Path normalized via {@link normalizeVaultPath}.
 */
export function findAgentBuilderEntryByPath(
	dataSources: DataSources | undefined,
	normalizedPath: string,
): LocatedAgentBuilderEntry | null
{
	if (!dataSources) return null;

	// Business logic: scan every category — AgentBuilder sources are not guaranteed to live only under vaults.
	for (const [category, entries] of Object.entries(dataSources))
	{
		const index = entries.findIndex(
			(entry) => entry.purpose === "AgentBuilder"
				&& entry.path?.trim()
				&& normalizeVaultPath(entry.path) === normalizedPath,
		);
		if (index >= 0)
		{
			return { category, index, entry: entries[index]! };
		}
	}

	return null;
}

/**
 * Builds a new AgentBuilder data source entry from Add Vault input.
 * @param input - Validated vault request body.
 * @param existingDataSources - Current machine dataSources for duplicate checks.
 */
export function makeVaultDataSource(
	input: AddVaultInput,
	existingDataSources?: DataSources,
): VaultDataSourceBuildResult
{
	const root = resolve(input.path.trim());
	const normalizedPath = normalizeVaultPath(root);
	const existingPaths = collectExistingAgentBuilderPaths(existingDataSources);

	if (existingPaths.has(normalizedPath))
	{
		throw Object.assign(new Error(`An AgentBuilder source already exists for path "${root}"`), { status: 409 });
	}

	const basenameName = basename(root);
	const existingNames = collectExistingAgentBuilderNames(existingDataSources);
	const name = resolveUniqueVaultName(input.name?.trim() || basenameName, existingNames);
	const projectRoot = input.projectRoot?.trim() ? resolve(input.projectRoot.trim()) : root;
	const category = input.category?.trim() || "vaults";

	const entry: DataSourceEntry = {
		path: root,
		projectRoot,
		name,
		type: input.type?.trim() || "Vault",
		purpose: "AgentBuilder",
	};

	if (input.agentPath?.trim())
	{
		entry.agentPath = resolve(input.agentPath.trim());
	}

	return { entry, category, normalizedPath };
}
