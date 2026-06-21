/**
 * Link strategy availability and feature flags for Agent Publisher.
 *
 * Architecture: server/zz-reach2/architecture/agents/archi-agent-builder.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ab3-agent-builder-3.md
 */

import type { ArtifactKind, LinkStrategy, PublishPlatform } from "./types.js";

/**
 * Internal gate for experimental symlink publishing.
 * Active product surface remains copy-only unless explicitly re-enabled.
 */
export const ENABLE_SYMLINK_PUBLISH = false;

/**
 * Returns supported link strategies for a platform and artifact kind.
 * @param platform - Publish platform identifier.
 * @param artifactKind - Agent or skill target kind.
 */
export function linkStrategiesForTarget(platform: PublishPlatform, artifactKind: ArtifactKind): LinkStrategy[]
{
	const strategies: LinkStrategy[] = ["copy"];
	// Business logic: import-shim is only meaningful for Claude agent guidance bridges to AGENTS.md.
	if (platform === "claude" && artifactKind === "agent")
	{
		strategies.push("import-shim");
	}
	if (ENABLE_SYMLINK_PUBLISH)
	{
		strategies.push("symlink");
	}
	return strategies;
}

/**
 * Builds per-artifact-kind strategy map for platform capability metadata.
 * @param platform - Publish platform identifier.
 */
export function linkStrategiesByKindForPlatform(
	platform: PublishPlatform,
): Partial<Record<ArtifactKind, LinkStrategy[]>>
{
	return {
		agent: linkStrategiesForTarget(platform, "agent"),
		skill: linkStrategiesForTarget(platform, "skill"),
	};
}

/**
 * Validates a requested link strategy for a publish target.
 * @param platform - Target platform.
 * @param artifactKind - Target artifact kind.
 * @param linkStrategy - Requested strategy; omitted means copy.
 */
export function assertLinkStrategyAllowed(
	platform: PublishPlatform,
	artifactKind: ArtifactKind,
	linkStrategy?: LinkStrategy,
): void
{
	const requested = linkStrategy ?? "copy";
	const allowed = linkStrategiesForTarget(platform, artifactKind);
	if (!allowed.includes(requested))
	{
		throw Object.assign(
			new Error(`linkStrategy "${requested}" is not supported for ${platform} ${artifactKind} targets`),
			{ status: 400 },
		);
	}
}
