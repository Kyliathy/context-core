import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname } from "path";

/** Formats a backup timestamp suffix. */
function formatBackupTimestamp(date: Date): string
{
	const y = String(date.getFullYear());
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	const hh = String(date.getHours()).padStart(2, "0");
	const mm = String(date.getMinutes()).padStart(2, "0");
	const ss = String(date.getSeconds()).padStart(2, "0");
	return `${y}${m}${d}-${hh}${mm}${ss}`;
}

/** Ensures parent directory exists for a file path. */
export function ensureDirForFile(filePath: string): void
{
	mkdirSync(dirname(filePath), { recursive: true });
}

/**
 * Writes file content through a same-directory temporary file, then replaces the
 * destination via rename to reduce partial-write risk.
 */
export function writeFileAtomic(targetPath: string, content: string): void
{
	ensureDirForFile(targetPath);
	const tempPath = `${targetPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
	writeFileSync(tempPath, content, "utf8");
	try
	{
		renameSync(tempPath, targetPath);
	} catch (error)
	{
		try { unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
		throw error;
	}
}

/**
 * Creates a timestamped backup when an existing file is about to be overwritten
 * and does not contain any of the generated markers.
 */
export function backupUnmanagedFileIfNeeded(filePath: string, generatedMarker?: string | string[]): string | undefined
{
	if (!existsSync(filePath)) return undefined;
	const currentContent = readFileSync(filePath, "utf8");
	const markers = generatedMarker
		? (Array.isArray(generatedMarker) ? generatedMarker : [generatedMarker])
		: [];
	if (markers.some((marker) => currentContent.includes(marker))) return undefined;

	const stamp = formatBackupTimestamp(new Date());
	let backupPath = `${filePath}.bak.${stamp}`;
	let suffix = 1;
	while (existsSync(backupPath))
	{
		backupPath = `${filePath}.bak.${stamp}-${suffix}`;
		suffix++;
	}

	writeFileSync(backupPath, currentContent, "utf8");
	return backupPath;
}

/** SHA-256 hash of string content (hex). */
export function hashContent(content: string): string
{
	return createHash("sha256").update(content).digest("hex");
}

/** SHA-256 hash of file content when present; undefined when missing/unreadable. */
export function hashFileIfExists(filePath: string): string | undefined
{
	if (!existsSync(filePath)) return undefined;
	try
	{
		return hashContent(readFileSync(filePath, "utf8"));
	} catch
	{
		return undefined;
	}
}
