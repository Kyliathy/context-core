/**
 * AGENTS.md collision policy for Publisher preview and publish.
 *
 * Architecture: server/zz-reach2/architecture/agents/archi-agent-builder.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ab3-agent-builder-3.md
 */

import type { AgentsArtifactFormat, PublishedArtifactProvenance, RenderedArtifact } from "./types.js";
import { normalizeForCompare } from "./pathPolicy.js";

/** Outcome when comparing existing vs incoming AGENTS.md provenance. */
export type AgentsCollisionDecision =
	| { ok: true; mode: "same-platform-replace" | "compatible-generated" }
	| { ok: false; reason: string };

/**
 * Decides whether an incoming AGENTS.md publish may replace an existing generated file.
 * @param existing - Ledger or on-disk provenance for the target path, if any.
 * @param incoming - Provenance for the artifact about to be written.
 */
export function decideAgentsCollision(
	existing: PublishedArtifactProvenance | undefined,
	incoming: PublishedArtifactProvenance,
): AgentsCollisionDecision
{
	if (!existing)
	{
		return { ok: true, mode: "compatible-generated" };
	}

	// Business logic: same platform and same artifact format means a re-publish of our own generated file.
	if (existing.platform === incoming.platform && existing.artifactFormat === incoming.artifactFormat)
	{
		return { ok: true, mode: "same-platform-replace" };
	}

	return {
		ok: false,
		reason: "Existing generated AGENTS.md belongs to a different platform format.",
	};
}

/**
 * Returns true when a basename is an AGENTS-style guidance file subject to collision rules.
 * @param absolutePath - Absolute artifact path to inspect.
 */
export function isAgentsMdBasename(absolutePath: string): boolean
{
	const normalized = absolutePath.replace(/\\/g, "/");
	const base = normalized.split("/").pop()?.toLowerCase() ?? "";
	return base === "agents.md" || base === "agents.override.md";
}

/**
 * Maps AGENTS.override.md ledger format for collision comparisons.
 * @param absolutePath - Absolute artifact path.
 */
export function agentsFormatFromPath(absolutePath: string): AgentsArtifactFormat | undefined
{
	const normalized = absolutePath.replace(/\\/g, "/");
	if (normalized.toLowerCase().endsWith("/agents.override.md"))
	{
		return "plain-agents-override-md";
	}
	if (normalized.toLowerCase().endsWith("/agents.md"))
	{
		return "plain-agents-md";
	}
	return undefined;
}

/**
 * Builds a provenance comparison key for intra-preview collision grouping.
 * @param artifact - Rendered AGENTS.md artifact from preview.
 */
function provenanceGroupKey(artifact: RenderedArtifact): string
{
	return `${artifact.platform}|${artifact.artifactFormat ?? "none"}`;
}

/**
 * Rejects incompatible AGENTS.md targets that share the same path within one preview request.
 * @param artifacts - All rendered preview artifacts for the request.
 * @param errors - Mutable error list for blocked collisions.
 */
export function applyIntraPreviewAgentsCollision(
	artifacts: RenderedArtifact[],
	errors: string[],
): RenderedArtifact[]
{
	const nonAgents: RenderedArtifact[] = [];
	const agentsByPath = new Map<string, RenderedArtifact[]>();

	// Business logic: group same-request AGENTS.md artifacts before ledger checks so Codex+Cursor cannot both pass as "new".
	for (const artifact of artifacts)
	{
		if (!isAgentsMdBasename(artifact.absolutePath) || artifact.isCompanionJson)
		{
			nonAgents.push(artifact);
			continue;
		}
		const pathKey = normalizeForCompare(artifact.absolutePath);
		const group = agentsByPath.get(pathKey) ?? [];
		group.push(artifact);
		agentsByPath.set(pathKey, group);
	}

	const allowedAgents: RenderedArtifact[] = [];
	for (const group of agentsByPath.values())
	{
		const formatKeys = new Set(group.map(provenanceGroupKey));
		if (formatKeys.size > 1)
		{
			errors.push(`${group[0]!.absolutePath}: Multiple incompatible AGENTS.md targets in the same publish request.`);
			continue;
		}
		// Business logic: same platform/format duplicates collapse to the last target in request order.
		allowedAgents.push(group[group.length - 1]!);
	}

	return [...nonAgents, ...allowedAgents];
}
