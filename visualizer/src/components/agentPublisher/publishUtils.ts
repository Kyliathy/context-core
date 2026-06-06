import type { ArtifactKind, CanonicalAgentDefinition, PlatformDefaultDirs, PublishPlatform } from "../../types";

/** Resolves the output directory for a platform target from backend defaults. */
export function resolveDefaultOutputDir(
	defaultDirs: PlatformDefaultDirs | undefined,
	artifactKind: ArtifactKind,
): string
{
	if (!defaultDirs) return "";
	return artifactKind === "skill" ? defaultDirs.skillRootDir : defaultDirs.agentOutputDir;
}

/** Builds the resolved artifact path hint shown in Publisher platform rows. */
export function resolveFilenameHint(
	def: CanonicalAgentDefinition,
	platform: PublishPlatform,
	kind: ArtifactKind,
	outputDir: string,
): string
{
	const normalized = outputDir.replace(/\\/g, "/").replace(/\/+$/, "");
	if (kind === "skill")
	{
		if (platform === "copilot") return `${normalized}/.github/skills/${def.id}/SKILL.md`;
		if (platform === "claude") return `${normalized}/.claude/skills/${def.id}/SKILL.md`;
		if (platform === "codex") return `${normalized}/.agents/skills/${def.id}/SKILL.md`;
		return `${normalized}/skills/${def.id}/SKILL.md`;
	}
	if (platform === "copilot") return `${normalized}/${def.name}.agent.md`;
	if (platform === "claude") return `${normalized}/${def.name}.md`;
	if (platform === "codex") return `${normalized}/AGENTS.md`;
	return `${normalized}/${def.name}`;
}

/** Returns true when heat-suggested placement differs from the native default directory. */
export function heatDiffersFromNative(
	heatSuggestedDir: string | undefined,
	nativeDefaultDir: string,
): boolean
{
	if (!heatSuggestedDir || !nativeDefaultDir) return false;
	return heatSuggestedDir.replace(/\\/g, "/").replace(/\/+$/, "")
		!== nativeDefaultDir.replace(/\\/g, "/").replace(/\/+$/, "");
}
