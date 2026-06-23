/**
 * Cursor IDE agent and skill publisher.
 *
 * Architecture: server/zz-reach2/architecture/agents/archi-agent-builder.md
 * Standards: server/zz-reach2/upgrades/2026-06/skills-agents-standards-2026-cursor-windsurf-antigravity.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ab3-agent-builder-3.md
 */

import { join } from "path";
import { AgentPublisherBase } from "../AgentPublisherBase.js";
import type { CanonicalAgentDefinition, PublishTarget, RenderedArtifact } from "../types.js";
import { appendGeneratedMarker, CXC_GENERATED_MARKER } from "../generatedMarker.js";
import { renderKnowledgeSection } from "./knowledgeFormat.js";
import { renderYamlFrontmatter } from "./yamlFrontmatter.js";

/** Cursor publisher: plain AGENTS.md agents and .agents/skills SKILL.md. */
export class AgentPublisherCursor extends AgentPublisherBase
{
	readonly platform = "cursor" as const;

	/**
	 * Renders Cursor agent or skill artifacts for one publish target.
	 * @param def - Canonical definition to materialize.
	 * @param target - Selected Cursor output directory and artifact kind.
	 */
	render(def: CanonicalAgentDefinition, target: PublishTarget): RenderedArtifact[]
	{
		if (target.artifactKind === "skill")
		{
			const skillPath = join(target.outputDir, ".agents", "skills", def.id || def.name, "SKILL.md");
			return [{
				absolutePath: skillPath,
				content: renderCursorSkillMarkdown(def),
				platform: this.platform,
				artifactKind: "skill",
				artifactFormat: undefined,
				canonicalId: def.id,
				previewStatus: this.previewStatusFor(skillPath, CXC_GENERATED_MARKER),
			}];
		}

		const mdPath = join(target.outputDir, "AGENTS.md");
		return [{
			absolutePath: mdPath,
			content: renderCursorAgentMarkdown(def),
			platform: this.platform,
			artifactKind: "agent",
			artifactFormat: "plain-agents-md",
			canonicalId: def.id,
			previewStatus: this.previewStatusFor(mdPath, CXC_GENERATED_MARKER),
		}];
	}
}

/**
 * Renders plain Markdown AGENTS.md for Cursor (no YAML frontmatter).
 * @param def - Canonical agent definition.
 */
export function renderCursorAgentMarkdown(def: CanonicalAgentDefinition): string
{
	const lines: string[] = [`# ${def.name}`, "", def.description.trim()];

	if (def.whenToUse?.trim())
	{
		lines.push("", "## When to use", "", def.whenToUse.trim());
	}

	if (def["argument-hint"]?.trim())
	{
		lines.push("", "## Argument hint", "", def["argument-hint"].trim());
	}

	if (def.tools && def.tools.length > 0)
	{
		lines.push("", "## Tools", "", ...def.tools.map((tool) => `- ${tool}`));
	}

	const knowledge = renderKnowledgeSection(def, "github");
	if (knowledge.length > 0)
	{
		lines.push("", "## Knowledge", "", ...knowledge);
	}

	if (def.body?.trim())
	{
		lines.push("", def.body.trim());
	}

	return appendGeneratedMarker(lines.join("\n"));
}

/**
 * Renders Cursor SKILL.md with portable core fields plus Cursor extensions.
 * @param def - Canonical skill definition.
 */
export function renderCursorSkillMarkdown(def: CanonicalAgentDefinition): string
{
	let description = def.description;
	if (def.whenToUse?.trim())
	{
		description = `${description}\n\nWhen to use: ${def.whenToUse.trim()}`;
	}

	const frontmatter: Record<string, string | string[] | boolean | undefined> = {
		name: def.name,
		description,
	};
	if (def.paths && def.paths.length > 0) frontmatter.paths = def.paths;
	if (def.disableModelInvocation === true) frontmatter["disable-model-invocation"] = "true";
	if (def.metadata)
	{
		for (const [key, value] of Object.entries(def.metadata))
		{
			frontmatter[key] = value;
		}
	}

	const bodyParts: string[] = [];
	if (def.body?.trim()) bodyParts.push(def.body.trim());
	const knowledge = renderKnowledgeSection(def, "github");
	if (knowledge.length > 0) bodyParts.push(...knowledge);

	return appendGeneratedMarker([
		...renderYamlFrontmatter(frontmatter as Record<string, string | string[] | undefined>),
		"",
		...bodyParts,
		"",
	].join("\n"));
}
