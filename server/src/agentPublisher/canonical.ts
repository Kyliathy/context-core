import { createHash } from "node:crypto";
import type { CreateAgentInput, AgentDefinition } from "../agentBuilder/AgentBuilder.js";
import type { ArtifactKind, CanonicalAgentDefinition, KnowledgeRef } from "./types.js";

/** Slugifies a canonical agent id from project + name. */
export function makeCanonicalAgentId(projectName: string, name: string): string
{
	const raw = `${projectName}-${name}`;
	const normalized = raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || "agent";
}

/** Returns true when a knowledge string looks like a file path rather than plain text. */
export function isFilePathKnowledge(entry: string): boolean
{
	const normalized = entry.replace(/\\/g, "/");
	return normalized.includes("/") && !/\s/.test(normalized);
}

/** Maps legacy string knowledge entries to structured KnowledgeRef items. */
export function toKnowledgeRefs(agentKnowledge: string[]): KnowledgeRef[]
{
	return agentKnowledge.map((value) => ({
		kind: isFilePathKnowledge(value) ? "file" : "text",
		value,
	}));
}

/** Maps structured knowledge refs back to legacy string array. */
export function fromKnowledgeRefs(knowledge: KnowledgeRef[]): string[]
{
	return knowledge.map((item) => item.value);
}

/** Maps legacy CreateAgentInput to CanonicalAgentDefinition. */
export function toCanonicalAgentDefinition(
	input: Omit<CreateAgentInput, "platform"> & {
		kind?: ArtifactKind;
		id?: string;
		whenToUse?: string;
		paths?: string[];
		disableModelInvocation?: boolean;
		body?: string;
		license?: string;
		compatibility?: string;
		metadata?: Record<string, string>;
	},
): CanonicalAgentDefinition
{
	const name = input.agentName;
	const id = input.id ?? input.codexEntryId ?? makeCanonicalAgentId(input.projectName, name);
	return {
		id,
		kind: input.kind ?? "agent",
		projectName: input.projectName,
		name,
		description: input.description,
		whenToUse: input.whenToUse,
		"argument-hint": input["argument-hint"],
		tools: input.tools ?? [],
		knowledge: toKnowledgeRefs(input.agentKnowledge),
		paths: input.paths,
		disableModelInvocation: input.disableModelInvocation,
		body: input.body,
		license: input.license,
		compatibility: input.compatibility,
		metadata: input.metadata,
	};
}

/** Maps canonical definition back to legacy AgentDefinition shape for compatibility callers. */
export function fromCanonicalAgentDefinition(
	def: CanonicalAgentDefinition,
	platform: "github" | "claude" | "codex" = "github",
): AgentDefinition
{
	return {
		projectName: def.projectName,
		agentName: def.name,
		description: def.description,
		"argument-hint": def["argument-hint"] ?? "",
		tools: def.tools ?? [],
		agentKnowledge: fromKnowledgeRefs(def.knowledge),
		platform,
		codexEntryId: platform === "codex" ? def.id : undefined,
		fromJson: true,
	};
}

/** Stable JSON string for canonical hash comparisons. */
export function stableCanonicalJson(def: CanonicalAgentDefinition): string
{
	const sorted = {
		...def,
		knowledge: [...def.knowledge].sort((a, b) => a.value.localeCompare(b.value)),
		tools: [...(def.tools ?? [])].sort(),
		paths: def.paths ? [...def.paths].sort() : undefined,
		metadata: def.metadata
			? Object.fromEntries(Object.entries(def.metadata).sort(([a], [b]) => a.localeCompare(b)))
			: undefined,
	};
	return JSON.stringify(sorted);
}

/** SHA-256 based canonical content hash (hex). */
export function canonicalHash(def: CanonicalAgentDefinition): string
{
	return createHash("sha256").update(stableCanonicalJson(def)).digest("hex");
}
