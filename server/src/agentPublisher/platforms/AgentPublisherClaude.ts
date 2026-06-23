import { join } from "path";
import { AgentPublisherBase } from "../AgentPublisherBase.js";
import type { CanonicalAgentDefinition, PublishTarget, RenderedArtifact } from "../types.js";
import { fromKnowledgeRefs } from "../canonical.js";
import { appendGeneratedMarker, CXC_GENERATED_MARKER } from "../generatedMarker.js";
import { renderSkillMarkdown, resolveSkillPath } from "../skillRenderer.js";

/** Claude Code sub-agent publisher (.md + .json). */
export class AgentPublisherClaude extends AgentPublisherBase
{
	readonly platform = "claude" as const;

	render(def: CanonicalAgentDefinition, target: PublishTarget): RenderedArtifact[]
	{
		if (target.artifactKind === "skill")
		{
			const skillPath = resolveSkillPath(target.outputDir, def, "claude");
			return [{
				absolutePath: skillPath,
				content: renderSkillMarkdown(def, "claude"),
				platform: "claude",
				artifactKind: "skill",
				previewStatus: this.previewStatusFor(skillPath, CXC_GENERATED_MARKER),
			}];
		}

		const mdPath = join(target.outputDir, `${def.name}.md`);
		const jsonPath = join(target.outputDir, `${def.name}.json`);
		const mdContent = renderClaudeAgentMarkdown(def);
		const jsonContent = JSON.stringify({
			projectName: def.projectName,
			agentName: def.name,
			description: def.description,
			"argument-hint": def["argument-hint"] ?? "",
			tools: def.tools ?? [],
			agentKnowledge: fromKnowledgeRefs(def.knowledge),
			platform: "claude",
		}, null, 2);

		return [
			{
				absolutePath: mdPath,
				content: mdContent,
				platform: "claude",
				artifactKind: "agent",
				previewStatus: this.previewStatusFor(mdPath, CXC_GENERATED_MARKER),
			},
			{
				absolutePath: jsonPath,
				content: jsonContent,
				platform: "claude",
				artifactKind: "agent",
				isCompanionJson: true,
			},
		];
	}
}

/** Builds Claude agent markdown content. */
export function renderClaudeAgentMarkdown(def: CanonicalAgentDefinition): string
{
	const knowledgeLines = def.knowledge.length > 0
		? [
			"To get context for your task, you MUST read the following files:",
			"",
			...def.knowledge.map((item) =>
			{
				if (item.kind === "file")
				{
					const normalized = item.value.replace(/\\/g, "/");
					const basename = normalized.split("/").pop() ?? normalized;
					return `- [${basename}](${item.value})`;
				}
				return `- ${item.value}`;
			}),
		]
		: [];

	return appendGeneratedMarker([
		"---",
		`name: ${def.name}`,
		`description: ${def.description}`,
		"---",
		"",
		...knowledgeLines,
		"",
	].join("\n"));
}
