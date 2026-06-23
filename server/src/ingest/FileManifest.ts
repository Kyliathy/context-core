/**
 * File harness manifest tracking for startup delta planning.
 *
 * Architecture: server/zz-reach2/architecture/harness/archi-harness.md
 * Upgrade plan: server/zz-reach2/upgrades/2026-06/r2so2-startup-optimization2.md
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { basename, dirname, join, normalize, relative, resolve } from "path";
import type { HarnessConfig } from "../types.js";
import { getHarnessParserEpoch } from "./IngestConfig.js";

export const FILE_MANIFEST_HARNESSES = new Set(["ClaudeCode", "Kiro", "VSCode", "Codex"]);

export type FileManifestEntry = {
	relativePath: string;
	fullPath: string;
	sizeBytes: number;
	mtimeMs: number;
	parserEpoch: number;
	rawPath?: string;
};

export type FileManifest = {
	schemaVersion: 1;
	harnessName: string;
	machineName: string;
	createdAt: string;
	updatedAt: string;
	entries: Record<string, FileManifestEntry>;
};

export type FileManifestLoadResult = {
	manifest: FileManifest | null;
	invalid: boolean;
	reason: string;
};

export type FileManifestDiff = {
	newFiles: FileManifestEntry[];
	changedFiles: FileManifestEntry[];
	unchangedFiles: FileManifestEntry[];
	deletedFiles: FileManifestEntry[];
	liveEntries: FileManifestEntry[];
};

/**
 * Handles toPaths behavior for this CXC module.
 * @param config - Configuration object used by toPaths.
 * @returns Result produced by toPaths.
 */
function toPaths(config: HarnessConfig): string[]
{
	return Array.isArray(config.paths) ? config.paths : [config.paths];
}

/**
 * Handles walkFiles behavior for this CXC module.
 * @param rootPath - Path used by walkFiles to locate the relevant CXC resource.
 * @param accept - Value consumed by walkFiles.
 * @returns Result produced by walkFiles.
 */
function walkFiles(rootPath: string, accept: (absolutePath: string, fileName: string) => boolean): string[]
{
	const root = normalize(resolve(rootPath));
	if (!existsSync(root))
	{
		return [];
	}

	const files: string[] = [];
	const queue = [root];
	// Business logic: this iteration walks every relevant item so startup ingest planning and bookmark safety reflects the complete source set instead of a partial snapshot.

	while (queue.length > 0)
	{
		const current = queue.pop()!;
		let entries: Array<import("fs").Dirent<string>> = [];
		try
		{
			entries = readdirSync(current, { withFileTypes: true, encoding: "utf8" });
		}
		catch
		{
			continue;
		}		// Business logic: this iteration walks every relevant item so startup ingest planning and bookmark safety reflects the complete source set instead of a partial snapshot.


		for (const entry of entries)
		{
			const fullPath = join(current, entry.name);
			if (entry.isDirectory())
			{
				queue.push(fullPath);
			}
			else			// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting startup ingest planning and bookmark safety from partial or invalid state.
 if (entry.isFile() && accept(fullPath, entry.name))
			{
				files.push(fullPath);
			}
		}
	}
	return files.sort((a, b) => a.localeCompare(b));
}

/**
 * Handles listFileHarnessSourceFiles behavior for this CXC module.
 * @param harnessName - Harness name or harness data used by listFileHarnessSourceFiles.
 * @param config - Configuration object used by listFileHarnessSourceFiles.
 * @returns Result produced by listFileHarnessSourceFiles.
 */
export function listFileHarnessSourceFiles(harnessName: string, config: HarnessConfig): string[]
{
	const files: string[] = [];
	// Business logic: this iteration walks every relevant item so startup ingest planning and bookmark safety reflects the complete source set instead of a partial snapshot.

	for (const configuredPath of toPaths(config))
	{
		const root = normalize(resolve(configuredPath));
		if (harnessName === "ClaudeCode")
		{
			files.push(...walkFiles(root, (fullPath, fileName) =>
				normalize(resolve(fullPath)).split(/[\\/]/).length === root.split(/[\\/]/).length + 1 &&
				fileName.toLowerCase().endsWith(".jsonl")
			));
		}
		else if (harnessName === "Kiro")
		{
			files.push(...walkFiles(root, (fullPath, fileName) =>
				normalize(resolve(fullPath)).split(/[\\/]/).length === root.split(/[\\/]/).length + 1 &&
				fileName.toLowerCase().endsWith(".chat")
			));
		}
		else if (harnessName === "VSCode")
		{
			const chatSessions = join(root, "chatSessions");
			files.push(...walkFiles(chatSessions, (_fullPath, fileName) =>
				fileName.toLowerCase().endsWith(".json") || fileName.toLowerCase().endsWith(".jsonl")
			));
		}
		else if (harnessName === "Codex")
		{
			files.push(...walkFiles(root, (_fullPath, fileName) =>
				fileName.toLowerCase().startsWith("rollout-") && fileName.toLowerCase().endsWith(".jsonl")
			));
		}
	}
	return Array.from(new Set(files.map((file) => normalize(resolve(file))))).sort((a, b) => a.localeCompare(b));
}

/**
 * Returns the value managed by getManifestPath.
 * @param storagePath - Path used by getManifestPath to locate the relevant CXC resource.
 * @param machineName - Value consumed by getManifestPath.
 * @param harnessName - Harness name or harness data used by getManifestPath.
 * @returns Result produced by getManifestPath.
 */
export function getManifestPath(storagePath: string, machineName: string, harnessName: string): string
{
	return join(storagePath, ".settings", "ingest-manifests", `${machineName}-${harnessName}.json`);
}

/**
 * Loads data needed by loadFileManifest from the configured CXC source.
 * @param manifestPath - Path used by loadFileManifest to locate the relevant CXC resource.
 * @returns Result produced by loadFileManifest.
 */
export function loadFileManifest(manifestPath: string): FileManifestLoadResult
{
	if (!existsSync(manifestPath))
	{
		return { manifest: null, invalid: false, reason: "manifest missing" };
	}
	try
	{
		const parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as FileManifest;
		// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting startup ingest planning and bookmark safety from partial or invalid state.

		if (!parsed || parsed.schemaVersion !== 1 || !parsed.entries || typeof parsed.entries !== "object")
		{
			return { manifest: null, invalid: true, reason: "manifest shape invalid" };
		}
		return { manifest: parsed, invalid: false, reason: "manifest loaded" };
	}
	catch (error)
	{
		return { manifest: null, invalid: true, reason: (error as Error).message };
	}
}

/**
 * Builds the value produced by buildLiveFileManifestEntries.
 * @param harnessName - Harness name or harness data used by buildLiveFileManifestEntries.
 * @param config - Configuration object used by buildLiveFileManifestEntries.
 * @returns Result produced by buildLiveFileManifestEntries.
 */
export function buildLiveFileManifestEntries(
	harnessName: string,
	config: HarnessConfig
): FileManifestEntry[]
{
	const parserEpoch = getHarnessParserEpoch(harnessName);
	const roots = toPaths(config).map((pathValue) => normalize(resolve(pathValue)));
	return listFileHarnessSourceFiles(harnessName, config).map((fullPath) =>
	{
		const stat = statSync(fullPath);
		const rootIndex = roots.findIndex((root) => fullPath.toLowerCase().startsWith(root.toLowerCase()));
		const root = rootIndex >= 0 ? roots[rootIndex] : normalize(resolve("."));
		return {
			relativePath: `${Math.max(0, rootIndex)}:${relative(root, fullPath).replace(/\\/g, "/")}`,
			fullPath,
			sizeBytes: stat.size,
			mtimeMs: stat.mtimeMs,
			parserEpoch,
		};
	});
}

/**
 * Creates the value or resource produced by createFileManifest.
 * @param harnessName - Harness name or harness data used by createFileManifest.
 * @param machineName - Value consumed by createFileManifest.
 * @param entries - Value consumed by createFileManifest.
 * @param now - Value consumed by createFileManifest.
 * @returns Result produced by createFileManifest.
 */
export function createFileManifest(
	harnessName: string,
	machineName: string,
	entries: FileManifestEntry[],
	now = new Date()
): FileManifest
{
	const entryMap: Record<string, FileManifestEntry> = {};
	// Business logic: this iteration walks every relevant item so startup ingest planning and bookmark safety reflects the complete source set instead of a partial snapshot.

	for (const entry of entries)
	{
		entryMap[entry.relativePath] = entry;
	}
	return {
		schemaVersion: 1,
		harnessName,
		machineName,
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
		entries: entryMap,
	};
}

/**
 * Saves data produced by saveFileManifest to the configured CXC target.
 * @param manifestPath - Path used by saveFileManifest to locate the relevant CXC resource.
 * @param manifest - Value consumed by saveFileManifest.
 */
export function saveFileManifest(manifestPath: string, manifest: FileManifest): void
{
	mkdirSync(dirname(manifestPath), { recursive: true });
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
}

/**
 * Handles diffFileManifest behavior for this CXC module.
 * @param manifest - Value consumed by diffFileManifest.
 * @param liveEntries - Value consumed by diffFileManifest.
 * @returns Result produced by diffFileManifest.
 */
export function diffFileManifest(
	manifest: FileManifest | null,
	liveEntries: FileManifestEntry[]
): FileManifestDiff
{
	const previous = manifest?.entries ?? {};
	const liveByKey = new Map(liveEntries.map((entry) => [entry.relativePath, entry]));
	const newFiles: FileManifestEntry[] = [];
	const changedFiles: FileManifestEntry[] = [];
	const unchangedFiles: FileManifestEntry[] = [];
	const deletedFiles: FileManifestEntry[] = [];
	// Business logic: this iteration walks every relevant item so startup ingest planning and bookmark safety reflects the complete source set instead of a partial snapshot.


	for (const entry of liveEntries)
	{
		const old = previous[entry.relativePath];
		if (!old)
		{
			newFiles.push(entry);
			continue;
		}		// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting startup ingest planning and bookmark safety from partial or invalid state.

		if (
			old.sizeBytes !== entry.sizeBytes ||
			old.mtimeMs !== entry.mtimeMs ||
			old.parserEpoch !== entry.parserEpoch ||
			basename(old.fullPath) !== basename(entry.fullPath)
		)
		{
			changedFiles.push(entry);
		}
		else
		{
			unchangedFiles.push(entry);
		}
	}	// Business logic: this iteration walks every relevant item so startup ingest planning and bookmark safety reflects the complete source set instead of a partial snapshot.


	for (const [key, entry] of Object.entries(previous))
	{
		if (!liveByKey.has(key))
		{
			deletedFiles.push(entry);
		}
	}

	return {
		newFiles,
		changedFiles,
		unchangedFiles,
		deletedFiles,
		liveEntries,
	};
}
