import { join } from "path";
import type { CanonicalAgentDefinition } from "./types.js";
import { appendGeneratedMarker } from "./generatedMarker.js";
import { renderKnowledgeSection } from "./platforms/knowledgeFormat.js";
import { renderYamlFrontmatter } from "./platforms/yamlFrontmatter.js";
import { resolveFieldMap } from "./FieldMapRegistry.js";
import type { PublishPlatform } from "./types.js";

/** Builds portable SKILL.md content for a platform. */
export function renderSkillMarkdown(def: CanonicalAgentDefinition, platform: PublishPlatform): string
{
	let description = def.description;
	const whenToUseMode = resolveFieldMap("whenToUse", platform);
	if (whenToUseMode.mode === "foldIntoDescription" && def.whenToUse)
	{
		description = `${description}\n\nWhen to use: ${def.whenToUse}`;
	}

	const frontmatter: Record<string, string | string[] | undefined> = {
		name: def.name,
		description,
	};
	if (whenToUseMode.mode === "frontmatter" && def.whenToUse)
	{
		frontmatter[whenToUseMode.key ?? "when_to_use"] = def.whenToUse;
	}
	if (def.license) frontmatter.license = def.license;
	if (def.compatibility) frontmatter.compatibility = def.compatibility;
	if (def.metadata)
	{
		for (const [key, value] of Object.entries(def.metadata))
		{
			frontmatter[key] = value;
		}
	}

	const bodyParts: string[] = [];
	if (def.body?.trim()) bodyParts.push(def.body.trim());
	const knowledgeLines = renderKnowledgeSection(def, platform === "claude" ? "claude" : "github");
	if (knowledgeLines.length > 0) bodyParts.push(...knowledgeLines);

	return appendGeneratedMarker([
		...renderYamlFrontmatter(frontmatter),
		"",
		...bodyParts,
		"",
	].join("\n"));
}

/**
 * Resolves skill output path for a platform publisher.
 * @param outputDir - Skill root directory selected in Publisher.
 * @param def - Canonical skill definition (uses id for folder name).
 * @param platform - Target publish platform.
 */
export function resolveSkillPath(outputDir: string, def: CanonicalAgentDefinition, platform: PublishPlatform): string
{
	const id = def.id || def.name;
	if (platform === "copilot") return join(outputDir, ".github", "skills", id, "SKILL.md");
	if (platform === "claude") return join(outputDir, ".claude", "skills", id, "SKILL.md");
	if (platform === "codex") return join(outputDir, ".agents", "skills", id, "SKILL.md");
	if (platform === "cursor" || platform === "antigravity") return join(outputDir, ".agents", "skills", id, "SKILL.md");
	if (platform === "windsurf") return join(outputDir, ".windsurf", "skills", id, "SKILL.md");
	if (platform === "kiro") return join(outputDir, ".kiro", "skills", id, "SKILL.md");
	return join(outputDir, "skills", id, "SKILL.md");
}
