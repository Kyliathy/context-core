/**
 * Backend artifact path templates for Publisher capability metadata.
 *
 * Architecture: server/zz-reach2/architecture/agents/archi-agent-builder.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ab3-agent-builder-3.md
 */

import type { ArtifactKind, PlatformArtifactTemplate, PublishPlatform } from "./types.js";

/** Platform-specific notes surfaced in Publisher UI. */
export const PLATFORM_NOTES: Partial<Record<PublishPlatform, string[]>> = {
	cursor: ["Cursor AGENTS.md merges with ancestor directories; nested files scope to subtrees."],
	windsurf: ["Windsurf root AGENTS.md is always-on; subdirectory files become implicit glob rules."],
	antigravity: ["Antigravity also supports legacy GEMINI.md; portable skills use .agents/skills/."],
	kiro: ["Kiro AGENTS.md is compatibility-only; richer steering lives under .kiro/steering/."],
};

/**
 * Returns artifact path templates for a supported platform.
 * @param platform - Publish platform identifier.
 */
export function artifactTemplatesForPlatform(platform: PublishPlatform): PlatformArtifactTemplate[] | undefined
{
	switch (platform)
	{
		case "copilot":
			return [
				{ artifactKind: "agent", rootKey: "agentOutputDir", relativePathTemplate: "{name}.agent.md" },
				{ artifactKind: "skill", rootKey: "skillRootDir", relativePathTemplate: ".github/skills/{id}/SKILL.md" },
			];
		case "claude":
			return [
				{ artifactKind: "agent", rootKey: "agentOutputDir", relativePathTemplate: "{name}.md" },
				{ artifactKind: "skill", rootKey: "skillRootDir", relativePathTemplate: ".claude/skills/{id}/SKILL.md" },
			];
		case "codex":
			return [
				{ artifactKind: "agent", rootKey: "agentOutputDir", relativePathTemplate: "AGENTS.md" },
				{ artifactKind: "skill", rootKey: "skillRootDir", relativePathTemplate: ".agents/skills/{id}/SKILL.md" },
			];
		case "cursor":
			return [
				{ artifactKind: "agent", rootKey: "agentOutputDir", relativePathTemplate: "AGENTS.md" },
				{ artifactKind: "skill", rootKey: "skillRootDir", relativePathTemplate: ".agents/skills/{id}/SKILL.md" },
			];
		case "windsurf":
			return [
				{ artifactKind: "agent", rootKey: "agentOutputDir", relativePathTemplate: "AGENTS.md" },
				{ artifactKind: "skill", rootKey: "skillRootDir", relativePathTemplate: ".windsurf/skills/{id}/SKILL.md" },
			];
		case "antigravity":
			return [
				{ artifactKind: "agent", rootKey: "agentOutputDir", relativePathTemplate: "AGENTS.md" },
				{ artifactKind: "skill", rootKey: "skillRootDir", relativePathTemplate: ".agents/skills/{id}/SKILL.md" },
			];
		case "kiro":
			return [
				{ artifactKind: "agent", rootKey: "agentOutputDir", relativePathTemplate: "AGENTS.md" },
				{ artifactKind: "skill", rootKey: "skillRootDir", relativePathTemplate: ".kiro/skills/{id}/SKILL.md" },
			];
		default:
			return undefined;
	}
}

/**
 * Resolves a template relative path with definition placeholders.
 * @param template - Relative path template from artifactTemplatesForPlatform.
 * @param values - Placeholder values for id and name.
 */
export function resolveArtifactTemplatePath(
	template: string,
	values: { id: string; name: string },
): string
{
	return template
		.replaceAll("{id}", values.id)
		.replaceAll("{name}", values.name);
}

/**
 * Builds the full hint path for UI display.
 * @param outputDir - Selected output directory.
 * @param template - Platform artifact template row.
 * @param values - Placeholder values.
 */
export function resolveFullArtifactHintPath(
	outputDir: string,
	template: PlatformArtifactTemplate,
	values: { id: string; name: string },
): string
{
	const normalized = outputDir.replace(/\\/g, "/").replace(/\/+$/, "");
	const relative = resolveArtifactTemplatePath(template.relativePathTemplate, values);
	return `${normalized}/${relative}`;
}
