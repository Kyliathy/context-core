import type { CanonicalAgentDefinition, KnowledgeRef } from "../types.js";

/** Returns true when a knowledge string looks like a file path. */
export function isFilePath(entry: string): boolean
{
	const normalized = entry.replace(/\\/g, "/");
	return normalized.includes("/") && !/\s/.test(normalized);
}

/** Formats one knowledge ref as a markdown list item. */
export function formatKnowledgeEntry(entry: KnowledgeRef, style: "github" | "claude"): string
{
	if (entry.kind === "file" || isFilePath(entry.value))
	{
		if (style === "claude")
		{
			const normalized = entry.value.replace(/\\/g, "/");
			const basename = normalized.split("/").pop() ?? normalized;
			return `- [${basename}](${entry.value})`;
		}
		return `- [${entry.value}](${entry.value})`;
	}
	return `- ${entry.value}`;
}

/** Renders the standard knowledge section body lines. */
export function renderKnowledgeSection(def: CanonicalAgentDefinition, style: "github" | "claude"): string[]
{
	if (def.knowledge.length === 0) return [];
	return [
		"To get context for your task, you MUST read the following files:",
		"",
		...def.knowledge.map((item) => formatKnowledgeEntry(item, style)),
	];
}
