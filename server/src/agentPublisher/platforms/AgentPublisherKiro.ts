/**
 * Kiro agent and skill publisher (AGENTS.md compatibility layer).
 *
 * Architecture: server/zz-reach2/architecture/agents/archi-agent-builder.md
 * Standards: server/zz-reach2/upgrades/2026-06/skills-agents-standards-2026-codex-claude-copilot.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ab3-agent-builder-3.md
 */

import { join } from "path";
import { AgentPublisherBase } from "../AgentPublisherBase.js";
import type { CanonicalAgentDefinition, PublishTarget, RenderedArtifact } from "../types.js";
import { CXC_GENERATED_MARKER } from "../generatedMarker.js";
import { renderCursorAgentMarkdown } from "./AgentPublisherCursor.js";
import { renderSkillMarkdown, resolveSkillPath } from "../skillRenderer.js";

/** Kiro publisher: root AGENTS.md compatibility and .kiro/skills native skills. */
export class AgentPublisherKiro extends AgentPublisherBase
{
	readonly platform = "kiro" as const;

	/**
	 * Renders Kiro compatibility guidance and skills.
	 * @param def - Canonical definition.
	 * @param target - Publish target.
	 */
	render(def: CanonicalAgentDefinition, target: PublishTarget): RenderedArtifact[]
	{
		if (target.artifactKind === "skill")
		{
			const skillPath = resolveSkillPath(target.outputDir, def, "kiro");
			return [{
				absolutePath: skillPath,
				content: renderSkillMarkdown(def, "kiro"),
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
