/**
 * cc.json dataSources mutation for Add Vault and Edit Vault (PATCH).
 *
 * Architecture: server/zz-reach2/architecture/agents/archi-agent-builder.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ap-agent-publisher-2.md (Part B), r2ve-vault-explorer.md (§25)
 */

import { existsSync, statSync } from "fs";
import { resolve } from "path";
import type { ContextCoreConfig, DataSourceEntry, DataSources, MachineConfig } from "../types.js";
import {
	findMachineConfig,
	loadCcJson,
	updateMachineConfig,
	writeCcJson,
	type WriteCcJsonOptions,
} from "../config/ccJsonEditor.js";
import {
	collectExistingAgentBuilderNames,
	collectExistingAgentBuilderPaths,
	findAgentBuilderEntryByPath,
	makeVaultDataSource,
	normalizeVaultPath,
	resolveUniqueVaultName,
	type AddVaultInput,
} from "./vaultDefaults.js";

/** Result returned by createVaultDataSource after cc.json mutation. */
export type CreateVaultDataSourceResult = {
	entry: DataSourceEntry;
	category: string;
	configPath: string;
	machine: MachineConfig;
	config: ContextCoreConfig;
};

/** PATCH /api/agent-builder/vaults request body — path is the lookup key for an existing entry. */
export type UpdateVaultInput = {
	path: string;
	name: string;
	type: string;
	agentPath?: string;
};

/** Result returned by updateVaultDataSource after cc.json mutation. */
export type UpdateVaultDataSourceResult = {
	entry: DataSourceEntry;
	category: string;
	configPath: string;
	machine: MachineConfig;
	config: ContextCoreConfig;
	/** Display name before PATCH — used by the client to update source filter selection. */
	previousName: string;
};

/**
 * Validates that the selected path is an absolute readable directory.
 * @param dirPath - User-selected vault directory.
 */
export function validateVaultDirectoryPath(dirPath: string): string
{
	const trimmed = dirPath?.trim();
	if (!trimmed)
	{
		throw Object.assign(new Error("path is required"), { status: 400 });
	}

	const resolved = resolve(trimmed);
	if (!existsSync(resolved))
	{
		throw Object.assign(new Error(`Path does not exist: ${resolved}`), { status: 404 });
	}

	try
	{
		const stat = statSync(resolved);
		if (!stat.isDirectory())
		{
			throw Object.assign(new Error(`Path is not a directory: ${resolved}`), { status: 400 });
		}
	}
	catch (err: unknown)
	{
		if ((err as { status?: number }).status) throw err;
		throw Object.assign(new Error(`Path is not readable: ${resolved}`), { status: 403 });
	}

	return resolved;
}

/**
 * Appends an AgentBuilder vault entry to one machine in cc.json (atomic write).
 * @param configPath - Absolute path to cc.json.
 * @param machineName - Target machines[].machine value.
 * @param input - Add Vault request body.
 * @param writeOptions - Optional backup flag for atomic write.
 */
export function createVaultDataSource(
	configPath: string,
	machineName: string,
	input: AddVaultInput,
	writeOptions?: WriteCcJsonOptions,
): CreateVaultDataSourceResult
{
	const validatedPath = validateVaultDirectoryPath(input.path);
	const config = loadCcJson(configPath);
	const machine = findMachineConfig(config, machineName);
	if (!machine)
	{
		throw Object.assign(new Error(`Machine "${machineName}" not found in cc.json`), { status: 404 });
	}

	const { entry, category } = makeVaultDataSource({ ...input, path: validatedPath }, machine.dataSources);
	const nextMachine: MachineConfig = {
		...machine,
		dataSources: {
			...(machine.dataSources ?? {}),
			[category]: [...(machine.dataSources?.[category] ?? []), entry],
		},
	};

	const nextConfig = updateMachineConfig(config, machineName, () => nextMachine);
	writeCcJson(configPath, nextConfig, writeOptions);

	return {
		entry,
		category,
		configPath,
		machine: nextMachine,
		config: nextConfig,
	};
}

/**
 * Updates metadata on an existing AgentBuilder dataSources entry matched by normalized path.
 * Business logic: PATCH is keyed by path so metadata edits do not create duplicate vault rows or re-scan directories.
 * @param configPath - Absolute path to cc.json.
 * @param machineName - Target machines[].machine value.
 * @param input - PATCH body with lookup path and new name/type/agentPath.
 * @param writeOptions - Optional backup flag for atomic write.
 */
export function updateVaultDataSource(
	configPath: string,
	machineName: string,
	input: UpdateVaultInput,
	writeOptions?: WriteCcJsonOptions,
): UpdateVaultDataSourceResult
{
	const trimmedName = input.name?.trim();
	if (!trimmedName)
	{
		throw Object.assign(new Error("name is required"), { status: 400 });
	}

	const lookupPath = input.path?.trim();
	if (!lookupPath)
	{
		throw Object.assign(new Error("path is required"), { status: 400 });
	}

	const normalizedLookup = normalizeVaultPath(lookupPath);
	const config = loadCcJson(configPath);
	const machine = findMachineConfig(config, machineName);
	if (!machine)
	{
		throw Object.assign(new Error(`Machine "${machineName}" not found in cc.json`), { status: 404 });
	}

	const located = findAgentBuilderEntryByPath(machine.dataSources, normalizedLookup);
	if (!located)
	{
		throw Object.assign(new Error(`No AgentBuilder source found for path "${resolve(lookupPath)}"`), { status: 404 });
	}

	const previousName = located.entry.name?.trim() ?? "";
	const existingNames = collectExistingAgentBuilderNames(machine.dataSources)
		.filter((name) => name !== previousName);

	// Business logic: renaming must not collide with a different vault's display name in the source filter.
	if (existingNames.includes(trimmedName))
	{
		throw Object.assign(
			new Error(`An AgentBuilder source named "${trimmedName}" already exists`),
			{ status: 409 },
		);
	}

	const nextEntry: DataSourceEntry = {
		...located.entry,
		name: resolveUniqueVaultName(trimmedName, existingNames),
		type: input.type?.trim() || located.entry.type || "Vault",
	};

	if (input.agentPath?.trim())
	{
		nextEntry.agentPath = resolve(input.agentPath.trim());
	}

	const categoryEntries = [...(machine.dataSources?.[located.category] ?? [])];
	categoryEntries[located.index] = nextEntry;

	const nextMachine: MachineConfig = {
		...machine,
		dataSources: {
			...(machine.dataSources ?? {}),
			[located.category]: categoryEntries,
		},
	};

	const nextConfig = updateMachineConfig(config, machineName, () => nextMachine);
	writeCcJson(configPath, nextConfig, writeOptions);

	return {
		entry: nextEntry,
		category: located.category,
		configPath,
		machine: nextMachine,
		config: nextConfig,
		previousName,
	};
}

/**
 * Returns normalized configured AgentBuilder paths for duplicate checks in vault-info.
 * @param machine - Current machine config row.
 */
export function configuredVaultPaths(machine: MachineConfig): Set<string>
{
	return collectExistingAgentBuilderPaths(machine.dataSources);
}
