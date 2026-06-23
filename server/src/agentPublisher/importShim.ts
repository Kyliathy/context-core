/**
 * Claude CLAUDE.md import-shim planning for linkStrategy=import-shim.
 *
 * Architecture: server/zz-reach2/architecture/agents/archi-agent-builder.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ab3-agent-builder-3.md
 */

import { existsSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import type { PublishTarget } from "./types.js";
import { appendGeneratedMarker } from "./generatedMarker.js";

/** Resolved import-shim write plan for Claude guidance bridge. */
export type ImportShimPlan = {
	platform: "claude";
	artifactKind: "agent";
	shimPath: string;
	importedPath: string;
	relativeImport: string;
	content: string;
};

/**
 * Returns true when import-shim is supported for the given target.
 * @param target - Publish target from Publisher UI.
 */
export function isImportShimSupported(target: PublishTarget): boolean
{
	return target.platform === "claude" && target.artifactKind === "agent" && target.linkStrategy === "import-shim";
}

/**
 * Builds an import-shim plan or returns a user-facing error message.
 * @param target - Claude publish target requesting import-shim.
 * @param allowedRoots - Absolute directories permitted for publish output.
 */
export function buildImportShimPlan(
	target: PublishTarget,
	allowedRoots: string[],
): { plan: ImportShimPlan } | { error: string }
{
	if (!isImportShimSupported(target))
	{
		return { error: "import-shim is only supported for Claude agent targets." };
	}

	const outputDir = resolve(target.outputDir);
	const importedPath = join(outputDir, "AGENTS.md");
	if (!existsSync(importedPath))
	{
		return { error: `import-shim requires AGENTS.md in the selected output directory: ${importedPath}` };
	}

	const shimPath = join(outputDir, "CLAUDE.md");
	const relativeImport = toRelativeImportPath(shimPath, importedPath);

	// Business logic: both shim and imported file must stay inside allowed publish roots.
	if (!isPathInsideAnyRoot(importedPath, allowedRoots) || !isPathInsideAnyRoot(shimPath, allowedRoots))
	{
		return { error: "import-shim target paths must remain inside allowed publish roots." };
	}

	const content = appendGeneratedMarker(`@${relativeImport}\n`);
	return {
		plan: {
			platform: "claude",
			artifactKind: "agent",
			shimPath,
			importedPath,
			relativeImport,
			content,
		},
	};
}

/**
 * Computes a relative @import path from shim to AGENTS.md.
 * @param shimPath - Absolute CLAUDE.md output path.
 * @param importedPath - Absolute AGENTS.md source path.
 */
export function toRelativeImportPath(shimPath: string, importedPath: string): string
{
	const fromDir = dirname(shimPath);
	const rel = relative(fromDir, importedPath).replace(/\\/g, "/");
	return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * Returns true when child path is inside any allowed root directory.
 * @param child - Absolute path to validate.
 * @param roots - Allowed publish root directories.
 */
function isPathInsideAnyRoot(child: string, roots: string[]): boolean
{
	const normalizedChild = resolve(child).toLowerCase();
	// Business logic: publish roots form the safety boundary; import-shim must not escape them.
	for (const root of roots)
	{
		const normalizedRoot = resolve(root).toLowerCase();
		if (normalizedChild === normalizedRoot || normalizedChild.startsWith(`${normalizedRoot}\\`) || normalizedChild.startsWith(`${normalizedRoot}/`))
		{
			return true;
		}
	}
	return false;
}
