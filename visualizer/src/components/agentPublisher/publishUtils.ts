/**
 * Publisher UI path hint helpers.
 *
 * Architecture: visualizer/zz-reach2/architecture/agents/archi-agent-builder-ui.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ab3-agent-builder-3.md
 */

import type {
	ArtifactKind,
	CanonicalAgentDefinition,
	LinkStrategy,
	PlatformArtifactTemplate,
	PlatformCapability,
	PlatformDefaultDirs,
	PublishPlatform,
} from "../../types";

/**
 * Resolves link strategies for a platform row (mirrors backend linkStrategyPolicy).
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
	return strategies;
}

/**
 * Normalizes link strategy when artifact kind changes.
 * @param platform - Publish platform.
 * @param artifactKind - Selected artifact kind.
 * @param linkStrategy - Current row strategy.
 */
export function normalizeLinkStrategy(
	platform: PublishPlatform,
	artifactKind: ArtifactKind,
	linkStrategy: LinkStrategy,
): LinkStrategy
{
	const allowed = linkStrategiesForTarget(platform, artifactKind);
	return allowed.includes(linkStrategy) ? linkStrategy : "copy";
}

/**
 * Resolves the output directory for a platform target from backend defaults.
 * @param defaultDirs - Backend-provided native directories.
 * @param artifactKind - Agent or skill target kind.
 */
export function resolveDefaultOutputDir(
	defaultDirs: PlatformDefaultDirs | undefined,
	artifactKind: ArtifactKind,
): string
{
	if (!defaultDirs) return "";
	return artifactKind === "skill" ? defaultDirs.skillRootDir : defaultDirs.agentOutputDir;
}

/**
 * Resolves a template relative path with definition placeholders.
 * @param template - Relative path template from backend capability metadata.
 * @param values - Placeholder values.
 */
export function resolveTemplatePath(template: string, values: { id: string; name: string }): string
{
	return template
		.replaceAll("{id}", values.id)
		.replaceAll("{name}", values.name);
}

/**
 * Builds the resolved artifact path hint shown in Publisher platform rows.
 * @param def - Canonical definition being published.
 * @param platform - Target platform.
 * @param kind - Agent or skill artifact kind.
 * @param outputDir - Selected output directory.
 * @param capability - Optional backend capability row with artifact templates.
 */
export function resolveFilenameHint(
	def: CanonicalAgentDefinition,
	platform: PublishPlatform,
	kind: ArtifactKind,
	outputDir: string,
	capability?: PlatformCapability,
): string
{
	const normalized = outputDir.replace(/\\/g, "/").replace(/\/+$/, "");
	const template = capability?.artifactTemplates?.find((row) => row.artifactKind === kind);
	if (template)
	{
		const relative = resolveTemplatePath(template.relativePathTemplate, { id: def.id, name: def.name });
		return `${normalized}/${relative}`;
	}

	// Fallback for older backend responses without artifactTemplates.
	if (kind === "skill")
	{
		if (platform === "copilot") return `${normalized}/.github/skills/${def.id}/SKILL.md`;
		if (platform === "claude") return `${normalized}/.claude/skills/${def.id}/SKILL.md`;
		if (platform === "codex" || platform === "cursor" || platform === "antigravity") return `${normalized}/.agents/skills/${def.id}/SKILL.md`;
		if (platform === "windsurf") return `${normalized}/.windsurf/skills/${def.id}/SKILL.md`;
		if (platform === "kiro") return `${normalized}/.kiro/skills/${def.id}/SKILL.md`;
		return `${normalized}/skills/${def.id}/SKILL.md`;
	}
	if (platform === "copilot") return `${normalized}/${def.name}.agent.md`;
	if (platform === "claude") return `${normalized}/${def.name}.md`;
	if (platform === "codex" || platform === "cursor" || platform === "windsurf" || platform === "kiro" || platform === "antigravity")
	{
		return `${normalized}/AGENTS.md`;
	}
	return `${normalized}/${def.name}`;
}

/**
 * Returns true when heat-suggested placement differs from the native default directory.
 * @param heatSuggestedDir - Heat analyzer suggestion.
 * @param nativeDefaultDir - Platform-native default directory.
 */
export function heatDiffersFromNative(
	heatSuggestedDir: string | undefined,
	nativeDefaultDir: string,
): boolean
{
	if (!heatSuggestedDir || !nativeDefaultDir) return false;
	return heatSuggestedDir.replace(/\\/g, "/").replace(/\/+$/, "")
		!== nativeDefaultDir.replace(/\\/g, "/").replace(/\/+$/, "");
}

export type { PlatformArtifactTemplate };
