/**
 * Placement helpers — directory-only heat and markdown source chips.
 *
 * Architecture: server/zz-reach2/architecture/agents/archi-agent-builder.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ap-agent-publisher-2.md (Part C)
 */

import { existsSync, statSync } from "fs";
import { dirname, relative, resolve } from "path";
import type { PlacementMdSource } from "./types.js";

const MARKDOWN_EXT_RE = /\.(md|markdown)$/i;

/**
 * Returns true when a resolved path looks like a markdown document.
 * @param filePath - Absolute or relative candidate path.
 */
export function isMarkdownLikePath(filePath: string): boolean
{
	return MARKDOWN_EXT_RE.test(filePath.trim());
}

/**
 * Converts a file or directory mention into the directory key used for placement heat.
 * @param absolutePath - Resolved absolute path from PathResolver.
 */
export function toPlacementDirectory(absolutePath: string): string | undefined
{
	const resolved = resolve(absolutePath);
	try
	{
		if (!existsSync(resolved)) return undefined;
		const stat = statSync(resolved);
		return stat.isDirectory() ? resolved : dirname(resolved);
	}
	catch
	{
		return undefined;
	}
}

/**
 * Builds a display path for markdown source chips relative to project root when possible.
 * @param absolutePath - Absolute markdown file path.
 * @param projectRoot - Project root directory for the active definition.
 */
export function toDisplayPath(absolutePath: string, projectRoot: string): string
{
	const resolved = resolve(absolutePath);
	const rel = relative(projectRoot, resolved);
	if (rel && !rel.startsWith("..") && !resolve(rel).startsWith(".."))
	{
		return rel.replace(/\\/g, "/");
	}
	return resolved;
}

/**
 * Creates a PlacementMdSource row for heat UI chips.
 * @param absolutePath - Absolute markdown file path.
 * @param projectRoot - Project root for display path generation.
 * @param inBasket - Whether the file is already in the canonical knowledge basket.
 * @param isRelated - Whether the file was discovered via link expansion (not in basket).
 * @param directoryPaths - Per-directory hit counts attributed to this source file.
 */
export function makePlacementMdSource(
	absolutePath: string,
	projectRoot: string,
	inBasket: boolean,
	isRelated: boolean,
	directoryPaths: Array<{ absolutePath: string; hits: number }>,
): PlacementMdSource
{
	return {
		absolutePath: resolve(absolutePath),
		displayPath: toDisplayPath(absolutePath, projectRoot),
		inBasket,
		isRelated,
		directoryPaths,
	};
}

/**
 * De-duplicates related markdown paths that are not already in the basket set.
 * @param relatedPaths - Candidate related markdown absolute paths.
 * @param basketPaths - Absolute paths already selected in the knowledge basket.
 */
export function filterRelatedMarkdown(relatedPaths: string[], basketPaths: Set<string>): string[]
{
	const seen = new Set<string>();
	const result: string[] = [];

	// Business logic: related-doc chips should surface link-discovered markdown without duplicating basket selections.
	for (const candidate of relatedPaths)
	{
		const resolved = resolve(candidate);
		if (!isMarkdownLikePath(resolved)) continue;
		if (!existsSync(resolved)) continue;
		if (basketPaths.has(resolved)) continue;
		if (seen.has(resolved)) continue;
		seen.add(resolved);
		result.push(resolved);
	}

	return result;
}
