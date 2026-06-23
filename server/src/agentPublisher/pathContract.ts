import { dirname, join, resolve } from "path";
import type { DataSourceEntry } from "../types.js";
import type { PublishPlatform } from "./types.js";
import { inferProjectRoot, resolveAllowedPublishRoots } from "./pathPolicy.js";

/** Distinguishes project root from agent vs skill output directories in Publisher targets. */
export type PlatformPathContract = {
	projectRoot: string;
	agentOutputDir: string;
	skillRootDir: string;
};

/** Resolves default Codex agent collection directory for a data source. */
export function resolveDefaultCodexAgentOutputDir(source: DataSourceEntry): string
{
	if (Array.isArray(source.codexAgentPaths))
	{
		for (const item of source.codexAgentPaths)
		{
			if (typeof item === "string" && item.trim() !== "") return resolve(item);
		}
	}
	if (source.codexAgentPath && source.codexAgentPath.trim() !== "")
	{
		return resolve(source.codexAgentPath);
	}
	const allowed = resolveAllowedPublishRoots(source, "codex");
	return allowed[0] ?? inferProjectRoot(source);
}

/** Resolves native agent output directory for Copilot/GitHub. */
export function resolveDefaultCopilotAgentOutputDir(source: DataSourceEntry): string
{
	if (source.agentPath && source.agentPath.trim() !== "")
	{
		return resolve(source.agentPath);
	}
	return join(inferProjectRoot(source), ".github", "agents");
}

/** Resolves native agent output directory for Claude Code. */
export function resolveDefaultClaudeAgentOutputDir(source: DataSourceEntry): string
{
	if (source.claudeAgentPath && source.claudeAgentPath.trim() !== "")
	{
		return resolve(source.claudeAgentPath);
	}
	if (source.agentPath && source.agentPath.trim() !== "")
	{
		return resolve(dirname(dirname(source.agentPath)), ".claude", "agents");
	}
	return join(inferProjectRoot(source), ".claude", "agents");
}

/**
 * Resolves Cursor default agent output (project root) honoring publishRoots.cursor.
 * @param source - AgentBuilder data source entry.
 */
export function resolveDefaultCursorAgentOutputDir(source: DataSourceEntry): string
{
	const roots = source.publishRoots?.cursor;
	if (Array.isArray(roots) && roots.length > 0 && roots[0]?.trim())
	{
		return resolve(roots[0]);
	}
	return inferProjectRoot(source);
}

/** Resolves per-platform default directories for Publisher target initialization. */
export function resolvePlatformPathContract(source: DataSourceEntry, platform: PublishPlatform): PlatformPathContract
{
	const projectRoot = inferProjectRoot(source);
	let agentOutputDir = projectRoot;
	if (platform === "copilot") agentOutputDir = resolveDefaultCopilotAgentOutputDir(source);
	else if (platform === "claude") agentOutputDir = resolveDefaultClaudeAgentOutputDir(source);
	else if (platform === "codex") agentOutputDir = resolveDefaultCodexAgentOutputDir(source);
	else if (platform === "cursor") agentOutputDir = resolveDefaultCursorAgentOutputDir(source);
	else if (platform === "windsurf" || platform === "antigravity" || platform === "kiro")
	{
		const roots = source.publishRoots?.[platform];
		if (Array.isArray(roots) && roots.length > 0 && roots[0]?.trim())
		{
			agentOutputDir = resolve(roots[0]);
		}
	}

	return {
		projectRoot,
		agentOutputDir,
		skillRootDir: projectRoot,
	};
}
