/**
 * Google Antigravity agent and skill publisher.
 *
 * Architecture: server/zz-reach2/architecture/agents/archi-agent-builder.md
 * Standards: server/zz-reach2/upgrades/2026-06/skills-agents-standards-2026-cursor-windsurf-antigravity.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ab3-agent-builder-3.md
 */

import { join } from "path";
import { AgentPublisherBase } from "../AgentPublisherBase.js";
import type { CanonicalAgentDefinition, PublishTarget, RenderedArtifact } from "../types.js";
import { appendGeneratedMarker, CXC_GENERATED_MARKER } from "../generatedMarker.js";
import { renderCursorAgentMarkdown } from "./AgentPublisherCursor.js";
import { renderSkillMarkdown, resolveSkillPath } from "../skillRenderer.js";

/** Antigravity publisher: portable AGENTS.md and .agents/skills SKILL.md. */
export class AgentPublisherAntigravity extends AgentPublisherBase
{
	readonly platform = "antigravity" as const;

	/**
	 * Renders Antigravity agent guidance and skills.
	 * @param def - Canonical definition.
	 * @param target - Publish target.
	 */
	render(def: CanonicalAgentDefinition, target: PublishTarget): RenderedArtifact[]
	{
		if (target.artifactKind === "skill")
		{
			const skillPath = resolveSkillPath(target.outputDir, def, "antigravity");
			return [{
				absolutePath: skillPath,
				content: renderSkillMarkdown(def, "antigravity"),
				platform: this.platform,
				artifactKind: "skill",
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
 * Optional GEMINI.md mirror content for Antigravity legacy compatibility.
 * @param def - Canonical agent definition.
 */
export function renderAntigravityGeminiMirror(def: CanonicalAgentDefinition): string
{
	return appendGeneratedMarker(`@AGENTS.md\n\n## ${def.name}\n\n${def.description.trim()}\n`);
}
