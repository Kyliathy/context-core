/**
 * Vault Manager API wrappers — server-backed directory browser and Save Vault / Save changes mutations.
 *
 * Architecture: visualizer/zz-reach2/architecture/agents/archi-agent-builder-ui.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ap-agent-publisher-2.md (Part B), r2ve-vault-explorer.md (§27)
 */

import type { PrepareResponse } from "../types";

const API_BASE = "";

export type VaultRoot = { label: string; path: string };

export type VaultDirectoryEntry = { name: string; path: string; readable: boolean };

export type VaultChildrenResponse = {
	path: string;
	parentPath?: string;
	breadcrumbs: Array<{ name: string; path: string }>;
	directories: VaultDirectoryEntry[];
};

export type VaultInfoResponse = {
	path: string;
	name: string;
	exists: boolean;
	isDirectory: boolean;
	readable: boolean;
	warnings: string[];
	alreadyConfigured: boolean;
};

export type CreateVaultInput = {
	path: string;
	name?: string;
	type?: string;
	category?: string;
	projectRoot?: string;
	agentPath?: string;
};

export type CreateVaultResponse = {
	entry: {
		path: string;
		name: string;
		type: string;
		purpose: string;
		projectRoot?: string;
	};
	category: string;
	configPath: string;
	prepare: PrepareResponse;
	previousName?: string;
};

/** PATCH /api/agent-builder/vaults request body. */
export type UpdateVaultInput = {
	path: string;
	name: string;
	type: string;
	agentPath?: string;
};

/** PATCH /api/agent-builder/vaults response — same shape as create with optional previousName. */
export type UpdateVaultResponse = CreateVaultResponse;

/**
 * Extracts a concise error message from vault browse/mutate JSON error bodies.
 * @param response - Failed fetch response from a vault route.
 */
async function readVaultApiError(response: Response): Promise<string>
{
	const text = await response.text();
	try
	{
		const body = JSON.parse(text) as { error?: string };
		return body.error ?? text;
	}
	catch
	{
		return text || response.statusText;
	}
}

/** Fetches browse roots for Vault Explorer (read-only). */
export async function fetchVaultRoots(): Promise<{ roots: VaultRoot[] }>
{
	const response = await fetch(`${API_BASE}/api/agent-builder/vault-roots`);
	if (!response.ok) throw new Error(await readVaultApiError(response));
	return response.json();
}

/**
 * Lists child directories for a vault path (one level, read-only).
 * @param path - Absolute directory path to browse.
 */
export async function fetchVaultChildren(path: string): Promise<VaultChildrenResponse>
{
	const query = new URLSearchParams({ path });
	const response = await fetch(`${API_BASE}/api/agent-builder/vault-children?${query.toString()}`);
	if (!response.ok) throw new Error(await readVaultApiError(response));
	return response.json();
}

/**
 * Validates a selected path and returns warnings (read-only).
 * @param path - Candidate vault directory path.
 */
export async function fetchVaultInfo(path: string): Promise<VaultInfoResponse>
{
	const query = new URLSearchParams({ path });
	const response = await fetch(`${API_BASE}/api/agent-builder/vault-info?${query.toString()}`);
	if (!response.ok) throw new Error(await readVaultApiError(response));
	return response.json();
}

/**
 * Persists a new AgentBuilder vault data source in cc.json (Save Vault only).
 * @param input - Save Vault request body.
 */
export async function createVault(input: CreateVaultInput): Promise<CreateVaultResponse>
{
	const response = await fetch(`${API_BASE}/api/agent-builder/vaults`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	if (!response.ok) throw new Error(await readVaultApiError(response));
	return response.json();
}

/**
 * Updates an existing AgentBuilder vault entry in cc.json (Save changes only).
 * @param input - PATCH body keyed by existing vault path.
 */
export async function updateVault(input: UpdateVaultInput): Promise<UpdateVaultResponse>
{
	const response = await fetch(`${API_BASE}/api/agent-builder/vaults`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	if (!response.ok) throw new Error(await readVaultApiError(response));
	return response.json();
}
