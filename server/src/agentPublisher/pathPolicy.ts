import { dirname, resolve, sep } from "path";
import type { DataSourceEntry } from "../types.js";
import type { PublishPlatform } from "./types.js";

/** Narrow config type duplicated to avoid circular imports from types.ts. */
export type PublishRootsConfig = Partial<Record<PublishPlatform, string[]>>;

const sepForCompare = sep === "\\" ? "\\" : "/";

/** Normalizes a path for case-insensitive Windows comparisons. */
export function normalizeForCompare(filePath: string): string
{
	const resolved = resolve(filePath);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Returns true when child is inside parent (or equal). */
export function isInside(parent: string, child: string): boolean
{
	const p = normalizeForCompare(parent);
	const c = normalizeForCompare(child);
	return c === p || c.startsWith(`${p}${sepForCompare}`);
}

/** Infers project root from data source configuration. */
export function inferProjectRoot(source: DataSourceEntry): string
{
	if (source.projectRoot && source.projectRoot.trim() !== "")
	{
		return resolve(source.projectRoot.trim());
	}

	if (source.agentPath && source.agentPath.trim() !== "")
	{
		const normalized = source.agentPath.replace(/\\/g, "/").replace(/\/+$/, "");
		if (/(^|\/)\.github\/agents$/i.test(normalized))
		{
			return resolve(dirname(dirname(source.agentPath)));
		}
	}

	return resolve(source.path);
}

/** Resolves allowed publish roots for a platform. */
export function resolveAllowedPublishRoots(source: DataSourceEntry, platform: PublishPlatform): string[]
{
	const publishRoots = source.publishRoots as PublishRootsConfig | undefined;
	const configured = publishRoots?.[platform];
	if (configured && configured.length > 0)
	{
		return configured.map((item) => resolve(item));
	}

	const root = inferProjectRoot(source);
	if (platform === "copilot" && source.agentPath)
	{
		return [resolve(source.agentPath), root];
	}
	if (platform === "claude")
	{
		if (source.claudeAgentPath) return [resolve(source.claudeAgentPath), root];
		if (source.agentPath)
		{
			return [resolve(dirname(dirname(source.agentPath)), ".claude", "agents"), root];
		}
	}
	if (platform === "codex")
	{
		const candidates: string[] = [];
		if (Array.isArray(source.codexAgentPaths))
		{
			for (const item of source.codexAgentPaths)
			{
				if (typeof item === "string" && item.trim() !== "") candidates.push(resolve(item));
			}
		}
		if (source.codexAgentPath) candidates.push(resolve(source.codexAgentPath));
		candidates.push(root);
		return [...new Set(candidates)];
	}

	return [root];
}

/** Throws Error with status 400 when outputDir is outside allowed roots. */
export function assertOutputDirAllowed(source: DataSourceEntry, platform: PublishPlatform, outputDir: string): void
{
	const resolved = resolve(outputDir);
	const allowed = resolveAllowedPublishRoots(source, platform);
	const ok = allowed.some((root) => isInside(root, resolved));
	if (!ok)
	{
		throw Object.assign(
			new Error(`outputDir "${outputDir}" is not inside allowed publish roots for platform "${platform}"`),
			{ status: 400 },
		);
	}
}

/** Path policy helper bound to data sources by project name. */
export class PathPolicy
{
	constructor(private readonly sources: DataSourceEntry[]) {}

	/** Finds source by projectName or throws 404. */
	findSource(projectName: string): DataSourceEntry
	{
		const source = this.sources.find((s) => s.name === projectName);
		if (!source)
		{
			throw Object.assign(new Error(`No AgentBuilder source found for project "${projectName}"`), { status: 404 });
		}
		return source;
	}

	/** Validates output directory for a project/platform pair. */
	assertOutputDirAllowed(projectName: string, platform: PublishPlatform, outputDir: string): void
	{
		const source = this.findSource(projectName);
		assertOutputDirAllowed(source, platform, outputDir);
	}

	/** Returns allowed roots for UI tree rendering. */
	getAllowedRoots(projectName: string, platform: PublishPlatform): string[]
	{
		const source = this.findSource(projectName);
		return resolveAllowedPublishRoots(source, platform);
	}

	/** Returns inferred project root for heat analysis. */
	getProjectRoot(projectName: string): string
	{
		return inferProjectRoot(this.findSource(projectName));
	}
}
