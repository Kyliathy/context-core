import { useCallback, useMemo, useState } from "react";
import { fetchLatestMessages, fetchLatestThreads, fetchAgentBuilderPrepare, fetchAgentBuilderList, fetchAgentBuilderListTemplates, searchMessages, searchThreads } from "../api/search";
import { getSymbolColor } from "../d3/colors";
import type { AgentListEntry, CardData, CreateTemplateInput, FavoriteEntry, IndexedFile, SearchHit, SerializedAgentMessage, SerializedAgentThread, ThreadCardData, ViewDefinition } from "../types";

function normalizeExcerpt(value: string, maxLength: number): string
{
	return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function toCards(results: SearchHit[]): CardData[]
{
	return toCardsFromMessages(results.map((result) => ({ score: result.score, hits: result.hits, message: result.message })));
}

function toCardsFromMessages(results: Array<{ score: number; hits?: number; message: SerializedAgentMessage }>): CardData[]
{
	return results.map((result) =>
	{
		const source = result.message;
		const title = source.subject?.trim() || normalizeExcerpt(source.message, 80) || "Untitled";
		const customColor = source.tags?.find((tag) => tag.startsWith("customColor:"))?.slice(12);
		const customEmoji = source.tags?.find((tag) => tag.startsWith("customEmoji:"))?.slice(12);
		return {
			id: source.id,
			sessionId: source.sessionId,
			x: 0,
			y: 0,
			w: 0,
			h: 0,
			title,
			harness: source.harness,
			project: source.project,
			model: source.model,
			role: source.role,
			dateTime: source.dateTime,
			score: result.score,
			hits: result.hits ?? 0,
			symbols: (source.symbols ?? []).map((label) => ({
				label,
				color: customColor && label === "Custom" ? customColor : getSymbolColor(label),
			})),
			excerptShort: normalizeExcerpt(source.message, 120),
			excerptMedium: normalizeExcerpt(source.message, 400),
			excerptLong: normalizeExcerpt(source.message, 1200),
			source,
			customColor,
			customEmoji,
		};
	});
}

function formatFileSize(bytes: number): string
{
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${bytes} B`;
}

function toAgentBuilderCards(files: IndexedFile[]): CardData[]
{
	return files.map((file) =>
	{
		const fileName = file.relativePath.split("/").pop() ?? file.relativePath;
		const meta = `${file.sourceName} · ${file.sourceType} · ${formatFileSize(file.size)}`;
		const fakeSource: SerializedAgentMessage = {
			id: file.absolutePath,
			sessionId: file.sourceName,
			harness: file.origin === "agent" ? "AgentFile" : "ContentFile",
			machine: "",
			role: "system",
			model: file.sourceType,
			// At high zoom (detail-3+) the D3 engine renders source.message — use the excerpt so real content is shown.
			message: file.excerpt ?? file.relativePath,
			subject: fileName,
			context: [],
			symbols: [file.sourceName, file.origin],
			history: [],
			tags: [],
			project: file.sourceName,
			parentId: null,
			tokenUsage: null,
			toolCalls: [],
			rationale: [],
			source: "",
			dateTime: file.lastModified,
		};
		return {
			id: file.absolutePath,
			sessionId: file.sourceName,
			x: 0,
			y: 0,
			w: 0,
			h: 0,
			title: fileName,
			harness: file.origin === "agent" ? "AgentFile" : "ContentFile",
			project: file.sourceName,
			model: file.sourceType,
			role: "system",
			dateTime: file.lastModified,
			score: 1.0,
			hits: 0,
			symbols: [
				{ label: file.sourceName, color: getSymbolColor(file.sourceName) },
				{ label: file.origin, color: getSymbolColor(file.origin) },
			],
			excerptShort: file.relativePath,
			excerptMedium: meta,
			excerptLong: file.excerpt ?? `${file.relativePath}\n${meta}`,
			source: fakeSource,
		};
	});
}

function toAgentListCards(agents: AgentListEntry[]): CardData[]
{
	return agents.map((agent) =>
	{
		const fakeSource: SerializedAgentMessage = {
			id: agent.path,
			sessionId: agent.name,
			harness: "AgentCard",
			machine: "",
			role: "system",
			model: null,
			message: agent.excerpt,
			subject: agent.name,
			context: [],
			symbols: [],
			history: [],
			tags: [],
			project: agent.name,
			parentId: null,
			tokenUsage: null,
			toolCalls: [],
			rationale: [],
			source: "",
			dateTime: new Date().toISOString(),
		};
		return {
			id: agent.path,
			sessionId: agent.name,
			x: 0,
			y: 0,
			w: 0,
			h: 0,
			title: agent.name,
			harness: "AgentCard",
			project: agent.name,
			model: null,
			role: "system",
			dateTime: new Date().toISOString(),
			score: 1.0,
			hits: 0,
			symbols: [],
			excerptShort: agent.description,
			excerptMedium: agent.description + (agent.hint ? `\nhint: ${agent.hint}` : ""),
			excerptLong: agent.excerpt,
			source: fakeSource,
		};
	});
}

function toTemplateListCards(templates: CreateTemplateInput[]): CardData[]
{
	return templates.map((template) =>
	{
		const fakeSource: SerializedAgentMessage = {
			id: template.templateName,
			sessionId: template.templateName,
			harness: "TemplateCard",
			machine: "",
			role: "system",
			model: null,
			// Keep complete template data for edit/use flows.
			message: JSON.stringify(template),
			subject: template.templateName,
			context: [],
			symbols: [],
			history: [],
			tags: [],
			project: template.templateName,
			parentId: null,
			tokenUsage: null,
			toolCalls: [],
			rationale: [],
			source: "",
			dateTime: new Date().toISOString(),
		};

		const hint = template["argument-hint"]?.trim();
		const hintPart = hint ? `\nhint: ${hint}` : "";
		return {
			id: template.templateName,
			sessionId: template.templateName,
			x: 0,
			y: 0,
			w: 0,
			h: 0,
			title: template.templateName,
			harness: "TemplateCard",
			project: template.templateName,
			model: null,
			role: "system",
			dateTime: new Date().toISOString(),
			score: 1.0,
			hits: 0,
			symbols: [],
			excerptShort: template.description,
			excerptMedium: `${template.description}${hintPart}`,
			excerptLong: (template.agentKnowledge ?? []).join("\n"),
			source: fakeSource,
		};
	});
}

function toThreadCards(threads: SerializedAgentThread[]): ThreadCardData[]
{
	return threads.map((thread) => ({
		id: thread.sessionId,
		sessionId: thread.sessionId,
		x: 0,
		y: 0,
		w: 0,
		h: 0,
		title: thread.subject || `Thread (${thread.messageCount} messages)`,
		harness: thread.harness,
		project: thread.project ?? "",
		messageCount: thread.messageCount,
		totalLength: thread.totalLength,
		firstDateTime: thread.firstDateTime,
		lastDateTime: thread.lastDateTime,
		matchCount: thread.matchingMessageIds.length,
		matchingMessageIds: thread.matchingMessageIds,
		score: thread.bestMatchScore,
		hits: thread.hits ?? 0,
		source: thread,
	}));
}

type UseSearchParams = {
	activeView: ViewDefinition;
	favoritesForActiveView: FavoriteEntry[];
	fromDate: string;
	limit?: number;
};

export function useSearch({ activeView, favoritesForActiveView, fromDate, limit }: UseSearchParams)
{
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<SearchHit[]>([]);
	const [cards, setCards] = useState<CardData[]>([]);
	const [threadCards, setThreadCards] = useState<ThreadCardData[]>([]);
	const [searchResetToken, setSearchResetToken] = useState(0);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [latencyMs, setLatencyMs] = useState<number | null>(null);
	const [hasSearched, setHasSearched] = useState(false);
	const projectsKey = useMemo(() => JSON.stringify(activeView.projects ?? []), [activeView.projects]);

	const search = useCallback(async (input: string) =>
	{
		const trimmed = input.trim();
		setQuery((activeView.type === "search" || activeView.type === "search-threads") ? trimmed : activeView.query);
		setHasSearched(true);

		if (activeView.type === "favorites")
		{
			setResults([]);
			const sorted = favoritesForActiveView.sort((left, right) => left.addedAt - right.addedAt);

			const messageEntries = sorted.filter((entry) => entry.source.type === "message");
			const threadEntries = sorted.filter((entry) => entry.source.type === "thread");

			const cardsFromFavorites = toCardsFromMessages(
				messageEntries.map((entry) => ({
					score: 0.01,
					message: entry.source.data as SerializedAgentMessage,
				}))
			);

			const threadCardsFromFavorites = toThreadCards(
				threadEntries.map((entry) => entry.source.data as SerializedAgentThread)
			);

			setCards(cardsFromFavorites);
			setThreadCards(threadCardsFromFavorites);
			setLatencyMs(0);
			setError(null);
			setSearchResetToken((current) => current + 1);
			return;
		}

		const hasFieldFilters = !!(activeView.symbols?.trim() || activeView.subject?.trim());

		setIsLoading(true);
		setError(null);
		const startedAt = performance.now();
		try
		{
			if (activeView.type === "search")
			{
				const fetched = await searchMessages(trimmed, fromDate, activeView.projects, activeView.symbols, activeView.subject);
				setResults(fetched);
				setCards(toCards(fetched));
				setThreadCards([]);
			}
			else if (activeView.type === "search-threads")
			{
				const response = await searchThreads(trimmed, fromDate, activeView.projects, activeView.symbols, activeView.subject, limit);
				setResults([]);
				setCards([]);
				setThreadCards(toThreadCards(response.results));
			}
			else if (activeView.type === "latest")
			{
				const latestThreads = await fetchLatestThreads(limit ?? 100, fromDate || undefined);
				setResults([]);
				setCards([]);
				setThreadCards(toThreadCards(latestThreads));
			}
			else if (activeView.type === "agent-builder")
			{
				const prepared = await fetchAgentBuilderPrepare();
				setResults([]);
				setCards(toAgentBuilderCards(prepared.files));
				setThreadCards([]);
			}
			else if (activeView.type === "agent-list")
			{
				const listed = await fetchAgentBuilderList();
				setResults([]);
				setCards(toAgentListCards(listed.agents));
				setThreadCards([]);
			}
			else if (activeView.type === "template-list")
			{
				const listed = await fetchAgentBuilderListTemplates();
				setResults([]);
				setCards(toTemplateListCards(listed.templates));
				setThreadCards([]);
			}
			else if (activeView.type === "template-create")
			{
				setResults([]);
				setCards([]);
				setThreadCards([]);
			}
			else
			{
				const fetchedLatest = await fetchLatestMessages(150);
				setResults([]);
				setCards(toCardsFromMessages(fetchedLatest.map((message) => ({ score: 0.01, message }))));
				setThreadCards([]);
			}
			setLatencyMs(Math.round(performance.now() - startedAt));
		}
		catch (caughtError)
		{
			const message = !navigator.onLine
				? "Offline — showing cached results if available"
				: caughtError instanceof Error ? caughtError.message : "Unknown search error";
			setError(message);
			setResults([]);
			setCards([]);
			setThreadCards([]);
			setLatencyMs(Math.round(performance.now() - startedAt));
		}
		finally
		{
			setIsLoading(false);
			setSearchResetToken((current) => current + 1);
		}
	}, [activeView.query, activeView.type, activeView.projects, activeView.symbols, activeView.subject, projectsKey, favoritesForActiveView, fromDate, limit]);

	const clearError = useCallback(() => setError(null), []);

	const clearResults = useCallback(() =>
	{
		setQuery("");
		setResults([]);
		setCards([]);
		setThreadCards([]);
		setError(null);
		setLatencyMs(null);
		setHasSearched(false);
	}, []);

	return useMemo(
		() => ({
			query,
			results,
			cards,
			threadCards,
			searchResetToken,
			isLoading,
			error,
			latencyMs,
			hasSearched,
			search,
			clearError,
			clearResults,
		}),
		[query, results, cards, threadCards, searchResetToken, isLoading, error, latencyMs, hasSearched, search, clearError, clearResults]
	);
}
