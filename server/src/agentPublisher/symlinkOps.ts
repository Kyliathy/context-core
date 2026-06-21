/**
 * Symlink capability probing and safe symlink writes for Publisher link strategies.
 *
 * Architecture: server/zz-reach2/architecture/agents/archi-agent-builder.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ab3-agent-builder-3.md
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync } from "fs";
import { dirname, resolve } from "path";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { backupUnmanagedFileIfNeeded } from "./fileOps.js";

/** Injectable probe for symlink host support (used in tests). */
export type SymlinkProbe = () => boolean;

/**
 * Probes whether the host can create symlinks in a temp directory.
 * @param tempRoot - Optional directory for probe files; defaults to OS temp.
 */
export function probeSymlinkSupport(tempRoot?: string): boolean
{
	const root = tempRoot ?? mkdtempSync(join(tmpdir(), "cxc-symlink-probe-"));
	const source = join(root, "source.txt");
	const link = join(root, "link.txt");
	try
	{
		writeFileSync(source, "probe", "utf8");
		if (existsSync(link)) unlinkSync(link);
		symlinkSync(source, link);
		return existsSync(link) && lstatSync(link).isSymbolicLink();
	} catch
	{
		return false;
	} finally
	{
		if (!tempRoot)
		{
			try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	}
}

export type SymlinkWriteOptions = {
	sourcePath: string;
	linkPath: string;
	generatedMarkers: string[];
};

/**
 * Creates a symlink at linkPath pointing to sourcePath with backup safety.
 * @param options - Source, destination, and generated markers for backup detection.
 */
export function writeSymlinkWithBackup(options: SymlinkWriteOptions): string | undefined
{
	const sourcePath = resolve(options.sourcePath);
	const linkPath = resolve(options.linkPath);
	mkdirSync(dirname(linkPath), { recursive: true });

	let backupPath: string | undefined;
	if (existsSync(linkPath))
	{
		const backup = backupUnmanagedFileIfNeeded(linkPath, options.generatedMarkers);
		if (!backup)
		{
			try
			{
				const stat = lstatSync(linkPath);
				if (stat.isSymbolicLink() || stat.isFile())
				{
					unlinkSync(linkPath);
				}
			} catch { /* replace best-effort */ }
		}
		else
		{
			unlinkSync(linkPath);
			backupPath = backup;
		}
	}

	try
	{
		symlinkSync(sourcePath, linkPath);
	} catch (error)
	{
		// Windows may require elevated privileges; caller downgrades to copy.
		throw error;
	}
	return backupPath;
}

/**
 * Reads symlink target content for drift hashing when actual strategy is symlink.
 * @param linkPath - Symlink path on disk.
 */
export function readSymlinkTargetContent(linkPath: string): string | undefined
{
	try
	{
		return readFileSync(linkPath, "utf8");
	} catch
	{
		return undefined;
	}
}
