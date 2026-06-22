/**
 * Server-backed directory browser for Vault Manager (read-only).
 *
 * Architecture: server/zz-reach2/architecture/agents/archi-agent-builder.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ap-agent-publisher-2.md (Part B), r2ve-vault-explorer.md
 */

import { existsSync, readdirSync, statSync } from "fs";
import { basename, dirname, resolve } from "path";

/** One browse root exposed to the Vault Manager UI. */
export type VaultRoot = {
	label: string;
	path: string;
};

/** One child directory in vault-children responses. */
export type VaultDirectoryEntry = {
	name: string;
	path: string;
	readable: boolean;
};

/** Response for GET /api/agent-builder/vault-roots. */
export type VaultRootsResponse = {
	roots: VaultRoot[];
};

/** Response for GET /api/agent-builder/vault-children. */
export type VaultChildrenResponse = {
	path: string;
	parentPath?: string;
	breadcrumbs: Array<{ name: string; path: string }>;
	directories: VaultDirectoryEntry[];
};

/** Response for GET /api/agent-builder/vault-info. */
export type VaultInfoResponse = {
	path: string;
	name: string;
	exists: boolean;
	isDirectory: boolean;
	readable: boolean;
	warnings: string[];
	alreadyConfigured: boolean;
};

const BROAD_ROOT_SEGMENTS = new Set(["", "/", "\\", "c:", "d:", "e:", "f:"]);

/**
 * Lists OS-specific browse roots (drives on Windows, / on Unix).
 */
export function listVaultRoots(): VaultRootsResponse
{
	const roots: VaultRoot[] = [];

	if (process.platform === "win32")
	{
		// Business logic: Windows Vault Manager starts from common drive letters so users need not type absolute paths first.
		for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ")
		{
			const drive = `${letter}:\\`;
			try
			{
				if (existsSync(drive))
				{
					roots.push({ label: `${letter}:`, path: drive });
				}
			}
			catch { /* skip inaccessible drives */ }
		}
		if (roots.length === 0)
		{
			roots.push({ label: process.cwd(), path: resolve(process.cwd()) });
		}
	}
	else
	{
		roots.push({ label: "/", path: "/" });
		const home = process.env.HOME;
		if (home && existsSync(home))
		{
			roots.push({ label: "Home", path: resolve(home) });
		}
	}

	roots.push({ label: "Server cwd", path: resolve(process.cwd()) });
	return { roots };
}

/**
 * Validates that a path is an absolute, existing, readable directory.
 * @param dirPath - Candidate directory path from query or request body.
 */
export function assertVaultDirectory(dirPath: string): string
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

	let stat;
	try
	{
		stat = statSync(resolved);
	}
	catch
	{
		throw Object.assign(new Error(`Path is not readable: ${resolved}`), { status: 403 });
	}

	if (!stat.isDirectory())
	{
		throw Object.assign(new Error(`Path is not a directory: ${resolved}`), { status: 400 });
	}

	return resolved;
}

/**
 * Builds breadcrumb segments from root to the current directory.
 * @param absolutePath - Current directory absolute path.
 */
export function buildVaultBreadcrumbs(absolutePath: string): Array<{ name: string; path: string }>
{
	const resolved = resolve(absolutePath);
	const crumbs: Array<{ name: string; path: string }> = [];
	let current = resolved;

	// Business logic: breadcrumbs must remain navigable on Windows drive roots without infinite parent loops.
	while (true)
	{
		crumbs.unshift({ name: basename(current) || current, path: current });
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}

	return crumbs;
}

/**
 * Lists immediate child directories for vault navigation.
 * @param dirPath - Parent directory absolute path.
 */
export function listVaultChildren(dirPath: string): VaultChildrenResponse
{
	const path = assertVaultDirectory(dirPath);
	const parentPath = dirname(path);
	const breadcrumbs = buildVaultBreadcrumbs(path);
	const directories: VaultDirectoryEntry[] = [];

	try
	{
		for (const name of readdirSync(path))
		{
			if (name === "." || name === "..") continue;
			const childPath = resolve(path, name);
			try
			{
				const stat = statSync(childPath);
				if (!stat.isDirectory()) continue;

				let readable = true;
				try
				{
					readdirSync(childPath);
				}
				catch
				{
					readable = false;
				}

				directories.push({ name, path: childPath, readable });
			}
			catch { /* skip unreadable children */ }
		}
	}
	catch
	{
		throw Object.assign(new Error(`Directory is not readable: ${path}`), { status: 403 });
	}

	directories.sort((a, b) => a.name.localeCompare(b.name));

	return {
		path,
		parentPath: parentPath !== path ? parentPath : undefined,
		breadcrumbs,
		directories,
	};
}

/**
 * Returns warnings for broad roots and duplicate detection hints.
 * @param dirPath - Selected directory path.
 * @param configuredPaths - Normalized paths of existing AgentBuilder sources.
 */
export function inspectVaultPath(dirPath: string, configuredPaths: Set<string>): VaultInfoResponse
{
	const warnings: string[] = [];
	let exists = false;
	let isDirectory = false;
	let readable = false;
	const resolved = resolve(dirPath.trim());

	try
	{
		if (existsSync(resolved))
		{
			exists = true;
			const stat = statSync(resolved);
			isDirectory = stat.isDirectory();
			if (isDirectory)
			{
				try
				{
					readdirSync(resolved);
					readable = true;
				}
				catch
				{
					readable = false;
					warnings.push("Directory exists but is not readable by the server process.");
				}
			}
		}
	}
	catch
	{
		warnings.push("Unable to stat the selected path.");
	}

	const normalized = resolved.replace(/\\/g, "/").toLowerCase();
	const segments = normalized.split("/").filter(Boolean);
	// Business logic: only the drive letter root (D:\) is broad — not every path that starts with D:\…
	const isDriveRoot =
		process.platform === "win32"
		&& segments.length === 1
		&& /^[a-z]:$/.test(segments[0] ?? "");
	const isRepoLike = existsSync(resolve(resolved, "node_modules"));

	// Business logic: indexing an entire drive or repo root creates slow/noisy Agent Builder cards — warn before add.
	if (isDriveRoot || segments.length <= 1 || BROAD_ROOT_SEGMENTS.has(normalized))
	{
		warnings.push("This path is very broad. Prefer a project folder to keep Agent Builder indexing fast.");
	}
	if (isRepoLike)
	{
		warnings.push("node_modules detected nearby — vault indexing may be slower on large trees.");
	}

	const alreadyConfigured = configuredPaths.has(
		process.platform === "win32" ? resolved.toLowerCase() : resolved,
	);

	return {
		path: resolved,
		name: basename(resolved),
		exists,
		isDirectory,
		readable,
		warnings,
		alreadyConfigured,
	};
}
