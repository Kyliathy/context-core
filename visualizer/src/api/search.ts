import type { SearchHit, SerializedAgentMessage, SerializedAgentThread, ThreadSearchResponse, ProjectGroup, SelectedProject, PrepareResponse, CreateAgentInput, CreateAgentResponse, AgentListResponse, GetAgentResponse, CreateTemplateInput, CreateTemplateResponse, TemplateListResponse, FileContentResponse, Scope } from "../types";

// Empty string = relative URL. In production, the visualizer is served from the same Express
// origin so /api/* resolves correctly. In dev, Vite's proxy (vite.config.ts) forwards to the server.
//[was originally http://localhost:3210]
const API_BASE = "";

export async function fetchProjects(): Promise<ProjectGroup[]>
{
	const response = await fetch(`${API_BASE}/api/projects`);
	if (!response.ok)
	{
		throw new Error(`Fetch projects failed`);
	}
	return await response.json();
}

export async function fetchScopes(): Promise<Scope[]>
{
	const response = await fetch(`${API_BASE}/api/list-scopes`);
	if (!response.ok)
	{
		throw new Error(`Fetch scopes failed`);
	}
	const data = await response.json();
	return Array.isArray(data) ? data as Scope[] : [];
}

export async function saveScopes(scopes: Scope[]): Promise<{ saved: number }>
{
	const response = await fetch(`${API_BASE}/api/scopes`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ scopes }),
	});
	if (!response.ok)
	{
		throw new Error(`Save scopes failed: ${response.status} ${response.statusText}`);
	}
	return response.json() as Promise<{ saved: number }>;
}

/** Shape returned by the server's /api/search endpoint. */
type SearchResponse = {
	results: Array<SerializedAgentMessage & {
		qdrantScore: number | null;
		fuseScore: number | null;
		combinedScore: number;
		hits: number;
	}>;
	query: string;
	engine: string;
	totalFuseResults: number;
	totalQdrantResults: number;
};

export async function searchMessages(searchTerms: string, fromDate: string, projects?: SelectedProject[], symbols?: string, subject?: string): Promise<SearchHit[]>
{
	const response = await fetch(`${API_BASE}/api/messages`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			searchTerms,
			fromDate,
			projects,
			symbols: symbols || undefined,
			subject: subject || undefined,
			page: 1,
			pageSize: 150,
		}),
	});

	if (!response.ok)
	{
		throw new Error(`Search failed: ${response.status} ${response.statusText}`);
	}
	const data = await response.json();

	// Support both new wrapped format and legacy flat array
	const items: unknown[] = Array.isArray(data)
		? data
		: Array.isArray(data?.results)
			? data.results
			: [];

	// Normalize each item to { score, message } shape the client expects
	return items.map((item: any) =>
	{
		// New format: scores are embedded on the message object itself
		if ("combinedScore" in item)
		{
			const { qdrantScore, fuseScore, combinedScore, hits, ...message } = item;
			return { score: combinedScore, hits: hits ?? 0, message } as SearchHit;
		}
		// Legacy format: { score, message }
		if ("score" in item && "message" in item)
		{
			return { ...(item as SearchHit), hits: (item as any).hits ?? 0 };
		}
		// Fallback: treat the whole object as a message with score 0
		return { score: 0, hits: 0, message: item } as SearchHit;
	});
}

export async function searchThreads(searchTerms: string, fromDate: string, projects?: SelectedProject[], symbols?: string, subject?: string, limit?: number): Promise<ThreadSearchResponse>
{
	const response = await fetch(`${API_BASE}/api/threads`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ searchTerms, fromDate, projects, symbols: symbols || undefined, subject: subject || undefined, limit: limit || undefined }),
	});

	if (!response.ok)
	{
		throw new Error(`Thread search failed: ${response.status} ${response.statusText}`);
	}
	return response.json();
}

export async function fetchSessions(): Promise<unknown[]>
{
	const response = await fetch(`${API_BASE}/api/sessions`);
	if (!response.ok)
	{
		throw new Error(`Sessions fetch failed: ${response.status} ${response.statusText}`);
	}
	const data = (await response.json()) as unknown[];
	return Array.isArray(data) ? data : [];
}

type MessagesResponse = {
	results: SerializedAgentMessage[];
};

export async function fetchLatestMessages(limit = 150): Promise<SerializedAgentMessage[]>
{
	const response = await fetch(`${API_BASE}/api/messages`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ searchTerms: "", page: 1, pageSize: limit }),
	});
	if (!response.ok)
	{
		throw new Error(`Latest messages fetch failed: ${response.status} ${response.statusText}`);
	}
	const data = (await response.json()) as Partial<MessagesResponse>;
	return Array.isArray(data.results) ? data.results : [];
}

export async function fetchLatestThreads(limit = 100, fromDate?: string): Promise<SerializedAgentThread[]>
{
	const response = await fetch(`${API_BASE}/api/threads/latest`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ limit, fromDate: fromDate || undefined }),
	});
	if (!response.ok)
	{
		throw new Error(`Latest threads fetch failed: ${response.status} ${response.statusText}`);
	}
	const data = (await response.json()) as { results: SerializedAgentThread[] };
	return Array.isArray(data.results) ? data.results : [];
}

export async function fetchAgentBuilderPrepare(name?: string): Promise<PrepareResponse>
{
	const response = await fetch(`${API_BASE}/api/agent-builder/prepare`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(name ? { name } : {}),
	});

	const payload = (await response.json()) as PrepareResponse | { error?: string };
	if (typeof (payload as { error?: unknown }).error === "string")
	{
		throw new Error((payload as { error: string }).error);
	}

	if (!response.ok)
	{
		throw new Error(`Agent Builder prepare failed: ${response.status} ${response.statusText}`);
	}

	return payload as PrepareResponse;
}

export async function fetchAgentBuilderCreate(input: CreateAgentInput): Promise<CreateAgentResponse>
{
	const response = await fetch(`${API_BASE}/api/agent-builder/create`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});

	if (!response.ok)
	{
		let details = "";
		try
		{
			const text = await response.text();
			details = text.trim();
		}
		catch
		{
			details = "";
		}
		const suffix = details ? ` - ${details}` : "";
		throw new Error(`Agent Builder create failed: ${response.status} ${response.statusText}${suffix}`);
	}

	return response.json() as Promise<CreateAgentResponse>;
}

export async function fetchAgentBuilderList(): Promise<AgentListResponse>
{
	const response = await fetch(`${API_BASE}/api/agent-builder/list`);
	if (!response.ok)
	{
		throw new Error(`Agent list failed: ${response.status} ${response.statusText}`);
	}
	return response.json() as Promise<AgentListResponse>;
}

export async function fetchAgentBuilderGetAgent(path: string, codexEntryId?: string): Promise<GetAgentResponse>
{
	const query = new URLSearchParams({ path });
	if (codexEntryId && codexEntryId.trim() !== "")
	{
		query.set("codexEntryId", codexEntryId.trim());
	}
	const response = await fetch(`${API_BASE}/api/agent-builder/get-agent?${query.toString()}`);
	if (!response.ok)
	{
		throw new Error(`Get agent failed: ${response.status} ${response.statusText}`);
	}
	return response.json() as Promise<GetAgentResponse>;
}

export async function fetchAgentBuilderAddTemplate(input: CreateTemplateInput): Promise<CreateTemplateResponse>
{
	const response = await fetch(`${API_BASE}/api/agent-builder/add-template`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	if (!response.ok)
	{
		throw new Error(`Add template failed: ${response.status}`);
	}
	return response.json() as Promise<CreateTemplateResponse>;
}

export async function fetchAgentBuilderListTemplates(): Promise<TemplateListResponse>
{
	const response = await fetch(`${API_BASE}/api/agent-builder/list-templates`);
	if (!response.ok)
	{
		throw new Error(`List templates failed: ${response.status}`);
	}
	return response.json() as Promise<TemplateListResponse>;
}

export async function fetchSessionMessages(sessionId: string): Promise<SerializedAgentMessage[]>
{
	const response = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}`);
	if (!response.ok)
	{
		throw new Error(`Session fetch failed: ${response.status} ${response.statusText}`);
	}
	const data = (await response.json()) as SerializedAgentMessage[];
	return Array.isArray(data) ? data : [];
}

export async function fetchAgentBuilderGetFileContent(absolutePath: string): Promise<FileContentResponse>
{
	const response = await fetch(`${API_BASE}/api/agent-builder/get-file-content?path=${encodeURIComponent(absolutePath)}`);
	if (!response.ok)
	{
		throw new Error(`Get file content failed: ${response.status} ${response.statusText}`);
	}
	return response.json() as Promise<FileContentResponse>;
}
