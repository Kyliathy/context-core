import type {
	ArtifactKind,
	CanonicalAgentDefinition,
	DirHeatNode,
	DriftReport,
	PathHeatResult,
	PlatformCapability,
	PublishStatusResponse,
	PreviewResult,
	PublishPlatform,
	PublishResult,
	PublishTarget,
} from "../types";

const API_BASE = "";

export async function fetchPublisherPlatforms(projectName?: string): Promise<{ platforms: PlatformCapability[] }>
{
	const query = projectName ? `?projectName=${encodeURIComponent(projectName)}` : "";
	const response = await fetch(`${API_BASE}/api/agent-publisher/platforms${query}`);
	if (!response.ok) throw new Error(await response.text());
	return response.json();
}

export async function fetchPublisherTree(projectName: string): Promise<{ tree: DirHeatNode[] }>
{
	const response = await fetch(`${API_BASE}/api/agent-publisher/tree?projectName=${encodeURIComponent(projectName)}`);
	if (!response.ok) throw new Error(await response.text());
	return response.json();
}

export async function fetchPublisherHeat(definition: CanonicalAgentDefinition): Promise<PathHeatResult>
{
	const response = await fetch(`${API_BASE}/api/agent-publisher/heat`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ definition }),
	});
	if (!response.ok) throw new Error(await response.text());
	return response.json();
}

export async function fetchPublisherPreview(body: {
	definition: CanonicalAgentDefinition;
	targets: PublishTarget[];
}): Promise<PreviewResult>
{
	const response = await fetch(`${API_BASE}/api/agent-publisher/preview`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(await response.text());
	return response.json();
}

export async function fetchPublisherPublish(body: {
	definition: CanonicalAgentDefinition;
	targets: PublishTarget[];
}): Promise<PublishResult>
{
	const response = await fetch(`${API_BASE}/api/agent-publisher/publish`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(await response.text());
	return response.json();
}

export async function fetchPublisherStatus(canonicalId: string): Promise<PublishStatusResponse>
{
	const response = await fetch(`${API_BASE}/api/agent-publisher/status?canonicalId=${encodeURIComponent(canonicalId)}`);
	if (!response.ok) throw new Error(await response.text());
	return response.json();
}

export async function fetchPublisherDrift(
	canonicalId: string,
	definition?: CanonicalAgentDefinition,
): Promise<DriftReport>
{
	if (definition)
	{
		const response = await fetch(`${API_BASE}/api/agent-publisher/drift`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ canonicalId, definition }),
		});
		if (!response.ok) throw new Error(await response.text());
		return response.json();
	}
	const response = await fetch(`${API_BASE}/api/agent-publisher/drift?canonicalId=${encodeURIComponent(canonicalId)}`);
	if (!response.ok) throw new Error(await response.text());
	return response.json();
}

export async function fetchAgentBuilderGetDefinition(canonicalId: string): Promise<{ definition: CanonicalAgentDefinition }>
{
	const response = await fetch(`${API_BASE}/api/agent-builder/get-definition?canonicalId=${encodeURIComponent(canonicalId)}`);
	if (!response.ok) throw new Error(await response.text());
	return response.json();
}

/** Maps legacy agent definition from get-agent to canonical publisher shape. */
export function agentDefinitionToCanonical(agent: {
	projectName: string;
	agentName: string;
	description: string;
	"argument-hint": string;
	tools?: string[];
	agentKnowledge: string[];
	codexEntryId?: string;
}): CanonicalAgentDefinition
{
	const isFile = (value: string): boolean =>
	{
		const normalized = value.replace(/\\/g, "/");
		return normalized.includes("/") && !/\s/.test(normalized);
	};
	const id = agent.codexEntryId
		?? `${agent.projectName}-${agent.agentName}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return {
		id: id || "agent",
		kind: "agent",
		projectName: agent.projectName,
		name: agent.agentName,
		description: agent.description,
		"argument-hint": agent["argument-hint"],
		tools: agent.tools ?? [],
		knowledge: agent.agentKnowledge.map((value) => ({
			kind: isFile(value) ? "file" : "text",
			value,
		})),
	};
}

export type { PublishPlatform, ArtifactKind, PublishTarget };
