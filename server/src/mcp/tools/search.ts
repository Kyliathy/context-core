/**
 * MCP tool definitions and handlers for search.
 *
 * Tools:
 * - search_messages        — full-text + field search across individual messages
 * - search_threads         — thread-level search, results grouped by session
 * - search_thread_messages — search within a specific thread's messages
 * - search_by_symbol       — occurrence-counted symbol search
 *
 * Supports advanced query syntax:
 *   - Simple term: storyteller
 *   - Exact phrase: "error handling"
 *   - OR mode: term1 term2 (space-separated)
 *   - AND mode: term1 + term2 (plus-separated)
 *
 * search_messages, search_threads, and search_thread_messages support:
 *   - subject: case-insensitive substring filter on the message subject field
 *   - symbols: case-insensitive substring filter on the message symbols array
 *   - query is optional when subject or symbols are provided
 *   - Qdrant hybrid merge when vectorServices are available (Fuse.js + Qdrant
 *     dual-channel with combined scoring; falls back to Fuse-only gracefully)
 *   - Enhanced score display: "Score: X% (Q:Y% | F:Z%)" when Qdrant is active,
 *     plain "Score: X%" otherwise (detected via duck-typing on AgentMessageFound)
 */

import type { IMessageStore } from "../../db/IMessageStore.js";
import type { TopicStore } from "../../settings/TopicStore.js";
import type { ScopeStore } from "../../settings/ScopeStore.js";
import type { AgentMessage } from "../../models/AgentMessage.js";
import type { VectorServices } from "../MCPServer.js";
import type { RouteContext } from "../../server/RouteContext.js";
import { DateTime } from "luxon";
import { parseSearchQuery } from "../../search/queryParser.js";
import { executeSearch, type SearchResult } from "../../search/searchEngine.js";
import { aggregateToThreads } from "../../search/threadAggregator.js";
import { SearchResults } from "../../models/SearchResults.js";
import { runQdrantSearch, type ProjectFilter } from "../../server/routeUtils.js";
import
	{
		filterResultsBySymbols,
		filterResultsBySubject,
		filterMessagesBySymbols,
		filterMessagesBySubject,
		messagesToResults,
	} from "../../search/fieldFilters.js";
import
	{
		formatSearchResults,
		formatThreadList,
		formatSymbolSearchResults,
		formatThreadSearchResults,
	} from "../formatters.js";

/** Maximum query length to guard against pathological Fuse.js inputs. */
const MAX_QUERY_LENGTH = 500;

/**
 * Parses the optional `projects` argument into an array of pattern strings.
 * Returns an empty array when no filter is requested (meaning: search all projects).
 */
function extractProjectFilter(projects: unknown): string[]
{
	if (!Array.isArray(projects) || projects.length === 0) return [];
	return projects.filter((p): p is string => typeof p === "string" && p.trim() !== "").map((p) => p.trim());
}

/**
 * Tests whether a message's project name matches any of the given patterns.
 * Each pattern is treated as a case-insensitive substring (SQL LIKE %pattern%).
 */
export function matchesAnyProject(project: string, patterns: string[]): boolean
{
	if (patterns.length === 0) return true;
	const lower = project.toLowerCase();
	return patterns.some((p) => lower.includes(p.toLowerCase()));
}

type ParsedDateRange = {
	from?: DateTime;
	to?: DateTime;
	error?: string;
};

function parseDateRange(args: Record<string, unknown>): ParsedDateRange
{
	const fromRaw = typeof args.from === "string" ? args.from.trim() : "";
	const toRaw = typeof args.to === "string" ? args.to.trim() : "";

	let from: DateTime | undefined;
	let to: DateTime | undefined;

	if (fromRaw)
	{
		from = DateTime.fromISO(fromRaw);
		if (!from.isValid)
		{
			return { error: "Error: 'from' must be a valid ISO datetime (e.g., '2026-03-01' or '2026-03-01T00:00:00Z')." };
		}
	}

	if (toRaw)
	{
		to = DateTime.fromISO(toRaw);
		if (!to.isValid)
		{
			return { error: "Error: 'to' must be a valid ISO datetime (e.g., '2026-03-15' or '2026-03-15T23:59:59Z')." };
		}
	}

	// Intuitive default: specifying only `from` means "from that date until now".
	if (from && !to)
	{
		to = DateTime.now();
	}

	if (from && to && from.toMillis() > to.toMillis())
	{
		return { error: "Error: 'from' must be earlier than or equal to 'to'." };
	}

	return { from, to };
}

function filterByDateRange<T extends { message: AgentMessage }>(
	results: T[],
	from?: DateTime,
	to?: DateTime
): T[]
{
	if (!from && !to) return results;

	return results.filter((r) =>
	{
		const ts = r.message.dateTime.toMillis();
		if (from && ts < from.toMillis()) return false;
		if (to && ts > to.toMillis()) return false;
		return true;
	});
}

function filterMessagesByDateRange(
	messages: AgentMessage[],
	from?: DateTime,
	to?: DateTime
): AgentMessage[]
{
	if (!from && !to) return messages;

	return messages.filter((m) =>
	{
		const ts = m.dateTime.toMillis();
		if (from && ts < from.toMillis()) return false;
		if (to && ts > to.toMillis()) return false;
		return true;
	});
}

/** Maximum symbol length for symbol search. */
const MAX_SYMBOL_LENGTH = 100;

/**
 * Counts occurrences of a symbol in message content using word-boundary matching.
 * This prevents false positives (e.g., "DB" won't match "MessageDB").
 */
function countSymbolOccurrences(content: string, symbol: string, caseSensitive: boolean): number
{
	// Escape special regex characters in the symbol
	const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

	// Build regex with word boundaries to match whole identifiers
	const flags = caseSensitive ? 'g' : 'gi';
	const regex = new RegExp(`\\b${escapedSymbol}\\b`, flags);

	// Count matches
	const matches = content.match(regex);
	return matches ? matches.length : 0;
}

export const SEARCH_TOOL_DEFINITIONS = [
	{
		name: "search_messages",
		description:
			"Search for individual AI conversation messages. " +
			"Supports full-text search with advanced query syntax: simple terms (fuzzy), \"exact phrases\" (quoted), " +
			"OR mode (space-separated terms), and AND mode (term1 + term2). " +
			"Also supports field filtering by subject (AI-generated conversation subject) and symbols (code identifiers). " +
			"query is optional when subject or symbols are provided. " +
			"Returns ranked results with scores, matched terms, and 300-char excerpts. " +
			"By default returns only human (user) messages — set includeAssistantMessages: true for deep research into AI responses.",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description:
						"Full-text search query. Supports: simple terms (fuzzy), \"exact phrases\" (quoted), " +
						"OR mode (space-separated: 'auth token'), AND mode (plus-separated: 'JWT + refresh'). " +
						"Optional when subject or symbols are provided.",
				},
				subject: {
					type: "string",
					description:
						"Filter results to messages whose subject contains this term (case-insensitive substring). " +
						"Example: 'tile rendering'.",
				},
				symbols: {
					type: "string",
					description:
						"Filter results to messages referencing this code symbol (case-insensitive substring match " +
						"against the symbols array). Example: 'HexGrid'.",
				},
				maxResults: {
					type: "number",
					description: "Maximum results to return. Default: 20.",
				},
				projects: {
					type: "array",
					items: { type: "string" },
					description:
						"Optional list of project name patterns to restrict the search to. " +
						"Names are matched as case-insensitive substrings — e.g., 'reach2' matches 'zz-reach2' and 'reach2-web'. " +
						"When omitted or empty, all projects are searched. " +
						"Example: [\"AXON\", \"reach2\"].",
				},
				scope: {
					type: "string",
					description:
						"Name of a saved scope to search within. Scopes group multiple projects. " +
						"Resolved to its constituent projects and merged with any 'projects' list. " +
						"Example: 'Reach2'.",
				},
				from: {
					type: "string",
					description:
						"Filter results from this ISO datetime (inclusive). " +
						"When omitted, no lower bound. Example: '2026-03-01'.",
				},
				to: {
					type: "string",
					description:
						"Filter results until this ISO datetime (inclusive). " +
						"Defaults to now when 'from' is specified but 'to' is omitted. " +
						"Example: '2026-03-15'.",
				},
				includeAssistantMessages: {
					type: "boolean",
					description:
						"Include assistant/AI responses in results. Default: false. " +
						"Only set to true when performing deep research into what the AI suggested or implemented.",
				},
			},
		},
	},
	{
		name: "search_threads",
		description:
			"Search for conversation threads (sessions) matching a query or field filters. " +
			"Returns distinct sessions — useful for finding relevant conversations. " +
			"Supports the same query syntax as search_messages, plus subject and symbols field filters. " +
			"query is optional when subject or symbols are provided. " +
			"Each result includes: sessionId, subject, harness, message count, date range, first message, and match score.",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description:
						"Full-text search query. Supports: simple terms (fuzzy), \"exact phrases\" (quoted), " +
						"OR mode (space-separated: 'auth token'), AND mode (plus-separated: 'JWT + refresh'). " +
						"Optional when subject or symbols are provided.",
				},
				subject: {
					type: "string",
					description:
						"Filter results to threads whose messages contain this subject term " +
						"(case-insensitive substring). Highly effective for finding threads by topic. " +
						"Example: 'tile rendering'.",
				},
				symbols: {
					type: "string",
					description:
						"Filter results to threads that reference this code symbol " +
						"(case-insensitive substring match against the symbols array). Example: 'HexGrid'.",
				},
				maxResults: {
					type: "number",
					description: "Maximum threads to return. Default: 20.",
				},
				projects: {
					type: "array",
					items: { type: "string" },
					description:
						"Optional list of project name patterns to restrict the search to. " +
						"Names are matched as case-insensitive substrings — e.g., 'reach2' matches 'zz-reach2' and 'reach2-web'. " +
						"When omitted or empty, all projects are searched. " +
						"Example: [\"AXON\", \"reach2\"].",
				},
				scope: {
					type: "string",
					description:
						"Name of a saved scope to search within. Scopes group multiple projects. " +
						"Resolved to its constituent projects and merged with any 'projects' list. " +
						"Example: 'Reach2'.",
				},
				from: {
					type: "string",
					description:
						"Filter results from this ISO datetime (inclusive). " +
						"When omitted, no lower bound. Example: '2026-03-01'.",
				},
				to: {
					type: "string",
					description:
						"Filter results until this ISO datetime (inclusive). " +
						"Defaults to now when 'from' is specified but 'to' is omitted. " +
						"Example: '2026-03-15'.",
				},
			},
		},
	},
	{
		name: "search_thread_messages",
		description:
			"Search within the messages of a specific conversation thread. " +
			"Useful for drilling into a thread found via search_threads to locate the most relevant messages. " +
			"Supports full-text query, subject filter, and symbols filter — at least one must be provided. " +
			"Returns ranked messages scoped to the given sessionId. " +
			"By default returns only human (user) messages — set includeAssistantMessages: true for deep research into AI responses.",
		inputSchema: {
			type: "object",
			properties: {
				sessionId: {
					type: "string",
					description: "The session identifier of the thread to search within.",
				},
				query: {
					type: "string",
					description:
						"Full-text search query. Optional when subject or symbols are provided.",
				},
				subject: {
					type: "string",
					description:
						"Filter to messages whose subject contains this term (case-insensitive substring).",
				},
				symbols: {
					type: "string",
					description:
						"Filter to messages referencing this code symbol (case-insensitive substring).",
				},
				maxResults: {
					type: "number",
					description: "Maximum results to return. Default: 20.",
				},
				includeAssistantMessages: {
					type: "boolean",
					description:
						"Include assistant/AI responses in results. Default: false. " +
						"Only set to true when performing deep research into what the AI suggested or implemented.",
				},
			},
			required: ["sessionId"],
		},
	},
	{
		name: "search_by_symbol",
		description:
			"Search for messages containing a specific symbol (function, class, variable, etc.) " +
			"and rank by the number of references to that symbol. " +
			"Uses word-boundary matching to find whole identifiers only (e.g., 'DB' won't match 'MessageDB'). " +
			"Useful for finding which conversations discussed a particular code symbol most frequently. " +
			"Results are sorted by occurrence count descending. " +
			"By default returns only human (user) messages — set includeAssistantMessages: true for deep research into AI responses.",
		inputSchema: {
			type: "object",
			properties: {
				symbol: {
					type: "string",
					description:
						"The symbol name to search for (e.g., 'MessageDB', 'executeSearch', 'TopicStore'). " +
						"Can be a function name, class name, variable, or any identifier.",
				},
				maxResults: {
					type: "number",
					description: "Maximum results to return. Default: 20.",
				},
				caseSensitive: {
					type: "boolean",
					description: "Whether to match case-sensitively. Default: false.",
				},
				includeAssistantMessages: {
					type: "boolean",
					description:
						"Include assistant/AI responses in results. Default: false. " +
						"Only set to true when performing deep research into what the AI suggested or implemented.",
				},
			},
			required: ["symbol"],
		},
	},
];

/**
 * Runs hybrid Fuse+Qdrant merge when vectorServices are available.
 * Falls back to Fuse-only results when Qdrant is absent or fails.
 * Mirrors the HTTP route pattern in messageRoutes.ts.
 */
async function hybridMerge(
	fuseResults: SearchResult[],
	query: string,
	subjectTerm: string,
	symbolsTerm: string,
	projectPatterns: string[],
	db: IMessageStore,
	vectorServices?: VectorServices
): Promise<SearchResult[]>
{
	if (!vectorServices || (!query && !subjectTerm)) return fuseResults;

	// Build a RouteContext-compatible object (runQdrantSearch only reads vectorServices)
	const ctx = { messageDB: db, vectorServices } as RouteContext;

	// Convert project patterns to ProjectFilter[] (runQdrantSearch uses .project for substring matching)
	const projectFilters: ProjectFilter[] = projectPatterns.map((p) => ({ harness: "", project: p }));

	// Build fuseHits array for merge
	const fuseHits = fuseResults.map((r) => ({
		score: r.rawFuseScore,
		message: r.message,
		matchedTerms: r.matchedTerms,
	}));

	// Run Qdrant search (failures are non-fatal — merge continues with Fuse-only)
	let qdrantHits: Array<{ score: number; payload: any }> = [];
	try
	{
		qdrantHits = await runQdrantSearch(
			query, subjectTerm, symbolsTerm,
			fuseResults.length || 50, projectFilters, ctx
		);
	} catch (error)
	{
		console.error(`[MCP/Search] Qdrant search failed: ${(error as Error).message}`);
	}

	if (qdrantHits.length === 0) return fuseResults;

	// Merge Fuse + Qdrant results
	const merged = SearchResults.merge(fuseHits, qdrantHits, query, db);

	// Post-merge safety net — ensure Qdrant-sourced results respect field constraints
	if (symbolsTerm)
	{
		const lower = symbolsTerm.toLowerCase();
		merged.results = merged.results.filter((r) =>
			r.symbols.some((s) => s.toLowerCase().includes(lower))
		);
	}
	if (subjectTerm)
	{
		const lower = subjectTerm.toLowerCase();
		merged.results = merged.results.filter((r) =>
			r.subject.toLowerCase().includes(lower)
		);
	}

	// Build matchedTerms lookup from original Fuse results
	const termsMap = new Map<string, string[]>();
	for (const r of fuseResults)
	{
		termsMap.set(r.message.id, r.matchedTerms);
	}

	// Convert AgentMessageFound[] back to SearchResult[] for formatters
	return merged.results.map((found) => ({
		message: found,
		score: found.combinedScore,
		rawFuseScore: found.fuseScore ?? 0,
		matchedTerms: termsMap.get(found.id) ?? [],
	}));
}

/**
 * Resolves a scope name to its project names and merges with explicit projects.
 * Returns the combined project patterns for substring matching, or an error object.
 */
function resolveProjectPatterns(
	args: Record<string, unknown>,
	scopeStore?: ScopeStore
): string[] | { error: string }
{
	const explicitProjects = extractProjectFilter(args.projects);
	const scopeName = typeof args.scope === "string" ? args.scope.trim() : "";

	if (!scopeName) return explicitProjects;

	if (!scopeStore)
	{
		return { error: "Error: Scope lookup is not available (ScopeStore not loaded)." };
	}

	const scopes = scopeStore.list();
	const match = scopes.find((s) => s.name.toLowerCase() === scopeName.toLowerCase());

	if (!match)
	{
		const available = scopes.map((s) => s.name).join(", ") || "(none)";
		return { error: `Error: Scope '${scopeName}' not found. Available scopes: ${available}` };
	}

	const scopeProjects = match.projectIds.map((p) => p.project);
	const merged = [...new Set([...explicitProjects, ...scopeProjects])];
	return merged;
}

/**
 * Handles a call to any search tool.
 * Async to support optional Qdrant embedding calls.
 */
export async function handleSearchTool(
	toolName: string,
	args: Record<string, unknown>,
	db: IMessageStore,
	topicStore?: TopicStore,
	vectorServices?: VectorServices,
	scopeStore?: ScopeStore
): Promise<string>
{
	switch (toolName)
	{
		case "search_messages":
			{
				const query = String(args.query ?? "").trim();
				const subjectTerm = String(args.subject ?? "").trim();
				const symbolsTerm = String(args.symbols ?? "").trim();
				const includeAssistant = args.includeAssistantMessages === true;

				if (!query && !subjectTerm && !symbolsTerm)
				{
					return "Error: At least one of 'query', 'subject', or 'symbols' is required.";
				}

				if (query && query.length > MAX_QUERY_LENGTH)
				{
					return `Error: Query too long (${query.length} chars). Maximum is ${MAX_QUERY_LENGTH} characters.`;
				}

				const dateRange = parseDateRange(args);
				if (dateRange.error) return dateRange.error;

				const projectPatterns = resolveProjectPatterns(args, scopeStore);
				if ("error" in projectPatterns) return projectPatterns.error;
				const maxResults = typeof args.maxResults === "number" ? Math.max(1, args.maxResults) : 20;

				if (query)
				{
					// Full-text search path
					let parsed;
					try
					{
						parsed = parseSearchQuery(query);
					} catch (e)
					{
						return `Error: Malformed query — ${e instanceof Error ? e.message : String(e)}`;
					}

					if (parsed.tokens.length === 0) return `Query "${query}" produced no tokens to search.`;

					let results = executeSearch(parsed);

					results = filterByDateRange(results, dateRange.from, dateRange.to);

					if (projectPatterns.length > 0)
					{
						results = results.filter((r) => matchesAnyProject(r.message.project, projectPatterns));
					}

					if (symbolsTerm) results = filterResultsBySymbols(results, symbolsTerm);
					if (subjectTerm) results = filterResultsBySubject(results, subjectTerm);

					// Hybrid merge with Qdrant when available
					results = await hybridMerge(results, query, subjectTerm, symbolsTerm, projectPatterns, db, vectorServices);

					// Filter to human messages only (default), unless caller opts in to assistant messages
					if (!includeAssistant)
					{
						results = results.filter((r) => r.message.role === "user");
					}

					const trimmed = results.slice(0, maxResults);
					const total = results.length;
					const formatted = formatSearchResults(trimmed, query, topicStore);

					if (total > maxResults)
					{
						return formatted + `\n(Showing top ${maxResults} of ${total} results. Pass maxResults to see more.)`;
					}
					return formatted;
				}
				else
				{
					// Field-only search path
					let messages = db.getAllMessages();

					messages = filterMessagesByDateRange(messages, dateRange.from, dateRange.to);

					if (projectPatterns.length > 0)
					{
						messages = messages.filter((m) => matchesAnyProject(m.project, projectPatterns));
					}

					if (symbolsTerm) messages = filterMessagesBySymbols(messages, symbolsTerm);
					if (subjectTerm) messages = filterMessagesBySubject(messages, subjectTerm);

					// Filter to human messages only (default), unless caller opts in to assistant messages
					if (!includeAssistant)
					{
						messages = messages.filter((m) => m.role === "user");
					}

					// Sort by date descending
					messages = messages.slice().sort((a, b) => b.dateTime.toMillis() - a.dateTime.toMillis());

					const results = messagesToResults(messages, symbolsTerm, subjectTerm);
					const trimmed = results.slice(0, maxResults);
					const total = results.length;
					const label = [subjectTerm && `subject:"${subjectTerm}"`, symbolsTerm && `symbols:"${symbolsTerm}"`]
						.filter(Boolean).join(" + ");
					const formatted = formatSearchResults(trimmed, label, topicStore);

					if (total > maxResults)
					{
						return formatted + `\n(Showing top ${maxResults} of ${total} results. Pass maxResults to see more.)`;
					}
					return formatted;
				}
			}

		case "search_threads":
			{
				const query = String(args.query ?? "").trim();
				const subjectTerm = String(args.subject ?? "").trim();
				const symbolsTerm = String(args.symbols ?? "").trim();

				if (!query && !subjectTerm && !symbolsTerm)
				{
					return "Error: At least one of 'query', 'subject', or 'symbols' is required.";
				}

				if (query && query.length > MAX_QUERY_LENGTH)
				{
					return `Error: Query too long (${query.length} chars). Maximum is ${MAX_QUERY_LENGTH} characters.`;
				}

				const dateRange = parseDateRange(args);
				if (dateRange.error) return dateRange.error;

				const projectPatterns = resolveProjectPatterns(args, scopeStore);
				if ("error" in projectPatterns) return projectPatterns.error;
				const maxResults = typeof args.maxResults === "number" ? Math.max(1, args.maxResults) : 20;

				let messageResults;

				if (query)
				{
					let parsed;
					try
					{
						parsed = parseSearchQuery(query);
					} catch (e)
					{
						return `Error: Malformed query — ${e instanceof Error ? e.message : String(e)}`;
					}

					if (parsed.tokens.length === 0) return `Query "${query}" produced no tokens to search.`;

					messageResults = executeSearch(parsed);

					messageResults = filterByDateRange(messageResults, dateRange.from, dateRange.to);

					if (projectPatterns.length > 0)
					{
						messageResults = messageResults.filter((r) => matchesAnyProject(r.message.project, projectPatterns));
					}

					if (symbolsTerm) messageResults = filterResultsBySymbols(messageResults, symbolsTerm);
					if (subjectTerm) messageResults = filterResultsBySubject(messageResults, subjectTerm);

					// Hybrid merge with Qdrant when available
					messageResults = await hybridMerge(messageResults, query, subjectTerm, symbolsTerm, projectPatterns, db, vectorServices);
				}
				else
				{
					// Field-only path
					let messages = db.getAllMessages();

					messages = filterMessagesByDateRange(messages, dateRange.from, dateRange.to);

					if (projectPatterns.length > 0)
					{
						messages = messages.filter((m) => matchesAnyProject(m.project, projectPatterns));
					}

					if (symbolsTerm) messages = filterMessagesBySymbols(messages, symbolsTerm);
					if (subjectTerm) messages = filterMessagesBySubject(messages, subjectTerm);

					messageResults = messagesToResults(messages, symbolsTerm, subjectTerm);
				}

				const threadResult = aggregateToThreads(messageResults, db, topicStore);

				if (threadResult.total === 0)
				{
					const criteria = query || [subjectTerm && `subject:"${subjectTerm}"`, symbolsTerm && `symbols:"${symbolsTerm}"`].filter(Boolean).join(", ");
					return `No threads found matching: "${criteria}"`;
				}

				const threads = threadResult.results.slice(0, maxResults);
				const label = query
					? `Thread search results for: "${query}"`
					: `Thread search results for: ${[subjectTerm && `subject:"${subjectTerm}"`, symbolsTerm && `symbols:"${symbolsTerm}"`].filter(Boolean).join(" + ")}`;

				return formatThreadList(threads, label);
			}

		case "search_thread_messages":
			{
				const sessionId = String(args.sessionId ?? "").trim();
				if (!sessionId) return "Error: 'sessionId' is required.";

				const query = String(args.query ?? "").trim();
				const subjectTerm = String(args.subject ?? "").trim();
				const symbolsTerm = String(args.symbols ?? "").trim();
				const includeAssistant = args.includeAssistantMessages === true;

				if (!query && !subjectTerm && !symbolsTerm)
				{
					return "Error: At least one of 'query', 'subject', or 'symbols' is required.";
				}

				if (query && query.length > MAX_QUERY_LENGTH)
				{
					return `Error: Query too long (${query.length} chars). Maximum is ${MAX_QUERY_LENGTH} characters.`;
				}

				const sessionMessages = db.getBySessionId(sessionId);
				if (sessionMessages.length === 0)
				{
					return `No messages found for session: ${sessionId}`;
				}

				const maxResults = typeof args.maxResults === "number" ? Math.max(1, args.maxResults) : 20;

				let results;

				if (query)
				{
					let parsed;
					try
					{
						parsed = parseSearchQuery(query);
					} catch (e)
					{
						return `Error: Malformed query — ${e instanceof Error ? e.message : String(e)}`;
					}

					if (parsed.tokens.length === 0) return `Query "${query}" produced no tokens to search.`;

					// Run full search and filter to this session
					results = executeSearch(parsed).filter((r) => r.message.sessionId === sessionId);

					if (symbolsTerm) results = filterResultsBySymbols(results, symbolsTerm);
					if (subjectTerm) results = filterResultsBySubject(results, subjectTerm);

					// Hybrid merge with Qdrant when available, then re-filter to session
					results = await hybridMerge(results, query, subjectTerm, symbolsTerm, [], db, vectorServices);
					results = results.filter((r) => r.message.sessionId === sessionId);
				}
				else
				{
					// Field-only within session
					let messages = [...sessionMessages];
					if (symbolsTerm) messages = filterMessagesBySymbols(messages, symbolsTerm);
					if (subjectTerm) messages = filterMessagesBySubject(messages, subjectTerm);
					results = messagesToResults(messages, symbolsTerm, subjectTerm);
				}

				// Filter to human messages only (default), unless caller opts in to assistant messages
				if (!includeAssistant)
				{
					results = results.filter((r) => r.message.role === "user");
				}

				if (results.length === 0)
				{
					return `No messages found in session "${sessionId}" matching the search criteria.`;
				}

				const trimmed = results.slice(0, maxResults);
				const total = results.length;

				// Resolve session subject for the header
				const firstMsg = sessionMessages[0];
				const sessionSubject = firstMsg?.subject ?? "";

				const formatted = formatThreadSearchResults(trimmed, sessionId, sessionSubject, query, topicStore);

				if (total > maxResults)
				{
					return formatted + `\n(Showing top ${maxResults} of ${total} results. Pass maxResults to see more.)`;
				}
				return formatted;
			}

		case "search_by_symbol":
			{
				// Validate symbol parameter
				const symbol = String(args.symbol ?? "").trim();
				if (!symbol) return "Error: 'symbol' is required and must not be empty.";

				if (symbol.length > MAX_SYMBOL_LENGTH)
				{
					return `Error: Symbol too long (${symbol.length} chars). Maximum is ${MAX_SYMBOL_LENGTH} characters.`;
				}

				// Extract optional parameters
				const caseSensitive = args.caseSensitive === true;
				const maxResults = typeof args.maxResults === "number" ? Math.max(1, args.maxResults) : 20;
				const includeAssistant = args.includeAssistantMessages === true;

				// Get all messages and count occurrences
				const allMessages = db.getAllMessages();
				const results: Array<{ message: AgentMessage; occurrenceCount: number; score: number }> = [];

				for (const message of allMessages)
				{
					// Skip non-human messages by default; include them only when explicitly requested
					if (!includeAssistant && message.role !== "user") continue;

					const count = countSymbolOccurrences(message.message, symbol, caseSensitive);
					if (count > 0)
					{
						results.push({ message, occurrenceCount: count, score: 0 });
					}
				}

				// Handle no results
				if (results.length === 0)
				{
					return `No messages found containing symbol: "${symbol}"`;
				}

				// Sort by occurrence count descending
				results.sort((a, b) => b.occurrenceCount - a.occurrenceCount);

				// Normalize scores (count / maxCount)
				const maxCount = results[0].occurrenceCount;
				for (const result of results)
				{
					result.score = result.occurrenceCount / maxCount;
				}

				// Slice to maxResults
				const total = results.length;
				const trimmed = results.slice(0, maxResults);

				// Format results
				const formatted = formatSymbolSearchResults(trimmed, symbol, topicStore);

				if (total > maxResults)
				{
					return formatted + `\n(Showing top ${maxResults} of ${total} results. Pass maxResults to see more.)`;
				}

				return formatted;
			}

		default:
			throw new Error(`Unknown search tool: ${toolName}`);
	}
}
