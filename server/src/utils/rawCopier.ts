/**
 * Utility for copying raw source files to the {machine}-RAW archive directory.
 * Each harness uses this to preserve original source data alongside normalized output.
 */

import { copyFileSync, existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from "fs";
import { basename, join } from "path";

/**
 * Checks if a source file has already been cached by comparing size and modification time.
 * Returns true if the cached file exists and matches the source file, indicating processing can be skipped.
 * @param sourceFilePath - Absolute path to the original source file.
 * @param rawBase - Raw archive root for this harness, e.g. `{storage}/{machine}-RAW/{harness}/`.
 * @param project - Project label (used as subdirectory).
 * @returns True if the file is already cached with matching size and mtime, false otherwise.
 */
export function isSourceFileCached(
	sourceFilePath: string,
	rawBase: string,
	project: string
): boolean
{
	const destDir = join(rawBase, project);
	const destPath = join(destDir, basename(sourceFilePath));

	if (!existsSync(destPath) || !existsSync(sourceFilePath))
	{
		return false;
	}

	try
	{
		const sourceStat = statSync(sourceFilePath);
		const destStat = statSync(destPath);

		// Compare file size and modification time
		const sizeMatches = sourceStat.size === destStat.size;
		const mtimeMatches = sourceStat.mtime.getTime() === destStat.mtime.getTime();

		return sizeMatches && mtimeMatches;
	} catch
	{
		return false;
	}
}

/**
 * Copies a source file to the raw archive under `{rawBase}/{project}/`.
 * Preserves the original filename and modification time. Skips if the target already exists.
 * @param rawBase - Raw archive root for this harness, e.g. `{storage}/{machine}-RAW/{harness}/`.
 * @param project - Project label (used as subdirectory).
 * @param sourceFilePath - Absolute path to the original source file.
 * @returns Destination path in the raw archive.
 */
export function copyRawSourceFile(
	rawBase: string,
	project: string,
	sourceFilePath: string
): string
{
	const destDir = join(rawBase, project);
	const destPath = join(destDir, basename(sourceFilePath));

	if (existsSync(destPath))
	{
		return destPath;
	}

	mkdirSync(destDir, { recursive: true });
	copyFileSync(sourceFilePath, destPath);

	// Preserve modification time for cache checking
	try
	{
		const sourceStat = statSync(sourceFilePath);
		utimesSync(destPath, sourceStat.atime, sourceStat.mtime);
	} catch
	{
		// Non-critical: if timestamp preservation fails, continue anyway
	}

	return destPath;
}

/**
 * Writes raw data (e.g. Cursor DB rows) as a JSON file in the raw archive.
 * Used when the source is a database, not a file.
 * Skips if the target already exists.
 * @param rawBase - Raw archive root for this harness.
 * @param project - Project label.
 * @param fileName - Destination filename (e.g. `bubbleId-abc.json`).
 * @param data - Data to serialize as JSON.
 * @returns Destination path in the raw archive.
 */
export function writeRawSourceData(
	rawBase: string,
	project: string,
	fileName: string,
	data: unknown
): string
{
	const destDir = join(rawBase, project);
	const destPath = join(destDir, fileName);

	if (existsSync(destPath))
	{
		return destPath;
	}

	mkdirSync(destDir, { recursive: true });
	writeFileSync(destPath, JSON.stringify(data, null, 2), "utf-8");
	return destPath;
}
