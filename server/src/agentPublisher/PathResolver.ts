import { existsSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { isInside, normalizeForCompare } from "./pathPolicy.js";

export type ResolvedPath = {
	absolutePath: string;
	source: "knowledge-file" | "project-root";
};

export type PathResolveResult = {
	resolved: ResolvedPath[];
	dropped: string[];
};

/** Resolves mention candidates relative to knowledge file dir and project roots. */
export function resolvePathMentions(
	candidates: string[],
	options: {
		knowledgeFileDir: string;
		projectRoots: string[];
	},
): PathResolveResult
{
	const resolved: ResolvedPath[] = [];
	const dropped: string[] = [];
	const seen = new Set<string>();

	for (const raw of candidates)
	{
		const attempts: Array<{ path: string; source: ResolvedPath["source"] }> = [];
		if (isAbsolute(raw))
		{
			attempts.push({ path: resolve(raw), source: "knowledge-file" });
		}
		else
		{
			attempts.push({ path: resolve(options.knowledgeFileDir, raw), source: "knowledge-file" });
			for (const root of options.projectRoots)
			{
				attempts.push({ path: resolve(root, raw), source: "project-root" });
			}
		}

		let matched = false;
		for (const attempt of attempts)
		{
			const allowed = options.projectRoots.some((root) => isInside(root, attempt.path));
			if (!allowed) continue;
			if (!existsSync(attempt.path)) continue;
			const key = normalizeForCompare(attempt.path);
			if (seen.has(key)) { matched = true; break; }
			seen.add(key);
			resolved.push({ absolutePath: attempt.path, source: attempt.source });
			matched = true;
			break;
		}
		if (!matched) dropped.push(raw);
	}

	return { resolved, dropped };
}

/** Walks ancestors from a path up to (but not above) project root. */
export function ancestorsUntilRoot(absolutePath: string, projectRoot: string): string[]
{
	const ancestors: string[] = [];
	let current = resolve(absolutePath);
	const root = resolve(projectRoot);
	while (isInside(root, current))
	{
		ancestors.push(current);
		if (normalizeForCompare(current) === normalizeForCompare(root)) break;
		const parent = resolve(current, "..");
		if (normalizeForCompare(parent) === normalizeForCompare(current)) break;
		current = parent;
	}
	return ancestors;
}
