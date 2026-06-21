import { join } from "path";
import { AgentPublisherBase } from "../AgentPublisherBase.js";
import type { CanonicalAgentDefinition, PublishTarget, RenderedArtifact } from "../types.js";
import { renderSkillMarkdown, resolveSkillPath } from "../skillRenderer.js";
import { generatedMarkersForPlatform } from "../generatedMarker.js";
import {
	buildCodexCollectionMarkdown,
	CODEX_AGENTS_FILE,
	CODEX_AGENTS_JSON_FILE,
	CODEX_GENERATED_MARKER,
	loadCodexCollection,
	makeUniqueCodexEntryId,
	slugifyId,
	toCodexCollection,
	toCodexEntryFromCanonical,
} from "./codexCollection.js";

/** Codex AGENTS.md collection publisher. */
export class AgentPublisherCodex extends AgentPublisherBase
{
	readonly platform = "codex" as const;

	render(def: CanonicalAgentDefinition, target: PublishTarget): RenderedArtifact[]
	{
		if (target.artifactKind === "skill")
		{
			const skillPath = resolveSkillPath(target.outputDir, def, "codex");
			return [{
				absolutePath: skillPath,
				content: renderSkillMarkdown(def, "codex"),
				platform: "codex",
				artifactKind: "skill",
				previewStatus: this.previewStatusFor(skillPath, generatedMarkersForPlatform("codex")),
			}];
		}

		const mdPath = join(target.outputDir, CODEX_AGENTS_FILE);
		const jsonPath = join(target.outputDir, CODEX_AGENTS_JSON_FILE);
		const existing = loadCodexCollection(mdPath, def.projectName);
		const existingIds = new Set(existing.agents.map((a) => a.id));

		let nextId: string;
		if (target.codexEntryId?.trim())
		{
			nextId = slugifyId(target.codexEntryId);
		}
		else
		{
			const existingByName = existing.agents.find((a) => a.agentName === def.name);
			nextId = existingByName ? existingByName.id : makeUniqueCodexEntryId(existingIds, def.id || def.name);
		}

		const nextEntry = toCodexEntryFromCanonical({ ...def, id: nextId }, nextId);
		const upsertIndex = existing.agents.findIndex((a) => a.id === nextEntry.id);
		const nextAgents = [...existing.agents];
		if (upsertIndex >= 0) nextAgents[upsertIndex] = nextEntry;
		else nextAgents.push(nextEntry);

		const normalizedIds = new Set<string>();
		const normalizedAgents = nextAgents.map((agent) =>
		{
			const id = makeUniqueCodexEntryId(normalizedIds, agent.id || agent.agentName);
			return { ...agent, id };
		});

		const collection = toCodexCollection(normalizedAgents);
		const mdContent = buildCodexCollectionMarkdown(collection);
		const jsonContent = JSON.stringify(collection, null, 2);

		return [
			{
				absolutePath: mdPath,
				content: mdContent,
				platform: "codex",
				artifactKind: "agent",
				artifactFormat: "codex-collection",
				previewStatus: this.previewStatusFor(mdPath, generatedMarkersForPlatform("codex")),
			},
			{
				absolutePath: jsonPath,
				content: jsonContent,
				platform: "codex",
				artifactKind: "agent",
				isCompanionJson: true,
			},
		];
	}
}
