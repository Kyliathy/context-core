import { join } from "path";
import { AgentPublisherBase } from "../AgentPublisherBase.js";
import type { CanonicalAgentDefinition, PublishTarget, RenderedArtifact } from "../types.js";
import { appendGeneratedMarker, CXC_GENERATED_MARKER } from "../generatedMarker.js";
import { renderSkillMarkdown, resolveSkillPath } from "../skillRenderer.js";

/** GitHub Copilot publisher (.agent.md + .agent.json). */
export class AgentPublisherCopilot extends AgentPublisherBase
{
	readonly platform = "copilot" as const;

	render(def: CanonicalAgentDefinition, target: PublishTarget): RenderedArtifact[]
	{
		if (target.artifactKind === "skill")
		{
			const skillPath = resolveSkillPath(target.outputDir, def, "copilot");
			return [{
				absolutePath: skillPath,
				content: renderSkillMarkdown(def, "copilot"),
				platform: "copilot",
				artifactKind: "skill",
				previewStatus: this.previewStatusFor(skillPath, CXC_GENERATED_MARKER),
			}];
		}

		const mdPath = join(target.outputDir, `${def.name}.agent.md`);
		const jsonPath = join(target.outputDir, `${def.name}.agent.json`);
		const mdContent = renderAgentMarkdown(def);
		const jsonContent = JSON.stringify({
			projectName: def.projectName,
			agentName: def.name,
			description: def.description,
			"argument-hint": def["argument-hint"] ?? "",
			tools: def.tools ?? [],
			agentKnowledge: def.knowledge.map((k) => k.value),
			platform: "github",
		}, null, 2);

		return [
			{
				absolutePath: mdPath,
				content: mdContent,
				platform: "copilot",
				artifactKind: "agent",
				previewStatus: this.previewStatusFor(mdPath, CXC_GENERATED_MARKER),
			},
			{
				absolutePath: jsonPath,
				content: jsonContent,
				platform: "copilot",
				artifactKind: "agent",
				isCompanionJson: true,
			},
		];
	}
}

/** Pure GitHub .agent.md renderer (matches legacy AgentBuilder output). */
export function renderAgentMarkdown(def: CanonicalAgentDefinition): string
{
	const toolsLine = def.tools && def.tools.length > 0
		? `tools: [${def.tools.map((t) => `'${t}'`).join(", ")}]`
		: `# tools: [] # specify the tools this agent can use. If not set, all enabled tools are allowed.`;

	const knowledgeLines = def.knowledge.length > 0
		? [
			"To get context for your task, you MUST read the following files:",
			"",
			...def.knowledge.map((item) =>
				item.kind === "file" ? `- [${item.value}](${item.value})` : `- ${item.value}`
			),
		]
		: [];

	return appendGeneratedMarker([
		"---",
		`name: ${def.name}`,
		`description: ${def.description}`,
		`argument-hint: ${def["argument-hint"] ?? ""}`,
		toolsLine,
		"---",
		"",
		...knowledgeLines,
		"",
	].join("\n"));
}
