/**
 * Classifies agent artifact paths by platform using path shape and publish ledger provenance.
 *
 * Architecture: server/zz-reach2/architecture/agents/archi-agent-builder.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ab3-agent-builder-3.md
 */

import { existsSync, readFileSync } from "fs";
import { basename } from "path";
import type { AgentsArtifactFormat, PublishLedgerEntry, PublishPlatform } from "./types.js";
import { CODEX_AGENTS_FILE, CODEX_AGENTS_JSON_FILE, CODEX_GENERATED_MARKER } from "./platforms/codexCollection.js";

/** Platform identity for a generic or specific agent artifact path. */
export type AgentArtifactClassification =
	| { platform: "codex"; artifactFormat: "codex-collection" }
	| { platform: "cursor" | "windsurf" | "kiro" | "antigravity"; artifactFormat: "plain-agents-md" }
	| { platform: "github"; artifactFormat?: undefined }
	| { platform: "claude"; artifactFormat?: undefined }
	| { platform: "unknown"; artifactFormat?: undefined };

const PLAIN_AGENTS_PLATFORMS = new Set<PublishPlatform>(["cursor", "windsurf", "kiro", "antigravity"]);

/**
 * Returns true when the path is a GitHub Copilot `.agent.md` file.
 * @param filePath - Absolute or relative agent file path.
 */
export function isAgentMdPath(filePath: string): boolean
{
	return filePath.toLowerCase().endsWith(".agent.md");
}

/**
 * Returns true when the path is a Claude sub-agent under `.claude/agents/`.
 * @param filePath - Absolute or relative agent file path.
 */
export function isClaudeAgentMdPath(filePath: string): boolean
{
	const normalized = filePath.replace(/\\/g, "/");
	return normalized.includes("/.claude/agents/")
		&& normalized.toLowerCase().endsWith(".md")
		&& !normalized.toLowerCase().endsWith(".agent.md");
}

/**
 * Returns true when basename is AGENTS.md (any directory).
 * @param filePath - Absolute or relative path.
 */
export function isAgentsMdBasenamePath(filePath: string): boolean
{
	return basename(filePath).toLowerCase() === CODEX_AGENTS_FILE.toLowerCase();
}

/**
 * Returns true when basename is AGENTS.override.md.
 * @param filePath - Absolute or relative path.
 */
export function isAgentsOverrideMdPath(filePath: string): boolean
{
	return basename(filePath).toLowerCase() === "agents.override.md";
}

/**
 * Heuristic: file content or companion JSON indicates a Codex multi-entry collection.
 * @param agentMdPath - Path to AGENTS.md.
 */
export function looksLikeCodexCollection(agentMdPath: string): boolean
{
	const jsonPath = agentMdPath.replace(/[/\\]agents\.md$/i, `/${CODEX_AGENTS_JSON_FILE}`);
	if (existsSync(jsonPath))
	{
		try
		{
			const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as { agents?: unknown[]; platform?: string; agentName?: string };
			if (Array.isArray(parsed.agents) && parsed.agents.length > 0) return true;
			// Business logic: legacy single-object AGENTS.json beside AGENTS.md is still a Codex artifact, not plain guidance.
			if (parsed.platform === "codex" || typeof parsed.agentName === "string") return true;
		} catch
		{
			// Fall through to markdown heuristics.
		}
	}

	if (!existsSync(agentMdPath)) return false;
	try
	{
		const content = readFileSync(agentMdPath, "utf8");
		// Business logic: only Codex-specific markers count; generic CXC marker is shared by all platforms.
		return content.includes("CXC-CODEX-ENTRY:") || content.includes(CODEX_GENERATED_MARKER);
	} catch
	{
		return false;
	}
}

/**
 * Classifies an agent artifact using ledger provenance first, then path/content heuristics.
 * @param absolutePath - Absolute artifact path.
 * @param ledgerEntry - Optional publish ledger row for this path.
 */
export function classifyAgentArtifactPath(
	absolutePath: string,
	ledgerEntry?: PublishLedgerEntry,
): AgentArtifactClassification
{
	if (ledgerEntry)
	{
		if (ledgerEntry.artifactFormat === "codex-collection")
		{
			return { platform: "codex", artifactFormat: "codex-collection" };
		}
		if (ledgerEntry.artifactFormat === "plain-agents-md" && PLAIN_AGENTS_PLATFORMS.has(ledgerEntry.platform))
		{
			return { platform: ledgerEntry.platform as "cursor" | "windsurf" | "kiro" | "antigravity", artifactFormat: "plain-agents-md" };
		}
		if (ledgerEntry.platform === "copilot") return { platform: "github" };
		if (ledgerEntry.platform === "claude") return { platform: "claude" };
		if (ledgerEntry.platform === "codex") return { platform: "codex", artifactFormat: "codex-collection" };
	}

	if (isAgentMdPath(absolutePath)) return { platform: "github" };
	if (isClaudeAgentMdPath(absolutePath)) return { platform: "claude" };

	if (isAgentsMdBasenamePath(absolutePath) || isAgentsOverrideMdPath(absolutePath))
	{
		// Business logic: unmanaged AGENTS.md without provenance must not be treated as Codex or Cursor.
		if (looksLikeCodexCollection(absolutePath))
		{
			return { platform: "codex", artifactFormat: "codex-collection" };
		}
		return { platform: "unknown" };
	}

	return { platform: "unknown" };
}

/**
 * Returns true when the path is a supported agent definition artifact for list/get-agent.
 * @param absolutePath - Absolute artifact path.
 * @param ledgerEntry - Optional ledger provenance.
 */
export function isListableAgentDefinitionPath(
	absolutePath: string,
	ledgerEntry?: PublishLedgerEntry,
): boolean
{
	const classification = classifyAgentArtifactPath(absolutePath, ledgerEntry);
	if (classification.platform === "unknown") return false;
	if (isAgentMdPath(absolutePath) || isClaudeAgentMdPath(absolutePath)) return true;
	if (classification.platform === "codex" && classification.artifactFormat === "codex-collection") return true;
	if (classification.artifactFormat === "plain-agents-md") return true;
	return false;
}
