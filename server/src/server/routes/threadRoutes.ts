import type { Express } from "express";
import type { RouteContext } from "../RouteContext.js";
import { parseSearchQuery } from "../../search/queryParser.js";
import { executeSearch } from "../../search/searchEngine.js";
import { aggregateToThreads, getLatestThreads } from "../../search/threadAggregator.js";
import { runQdrantSearch, parseProjectFilters, type ProjectFilter } from "../routeUtils.js";
import { withCache, buildSearchCacheKey, buildCacheFilenamePrefix } from "../../cache/ResponseCache.js";
import
{
	filterResultsBySymbols,
	filterResultsBySubject,
	filterMessagesBySymbols,
	filterMessagesBySubject,
	messagesToResults,
} from "../../search/fieldFilters.js";

export function register(app: Express, ctx: RouteContext): void
{
	app.post("/api/threads", async (req, res) =>
	{
		const body = req.body as { searchTerms?: unknown; symbols?: unknown; subject?: unknown; fromDate?: unknown; projects?: unknown; limit?: unknown };
		const searchTerms = typeof body.searchTerms === "string" ? body.searchTerms.trim() : "";
		const threadLimit = typeof body.limit === "number" ? body.limit : typeof body.limit === "string" ? Number(body.limit) : 0;
		const symbolsTerm = typeof body.symbols === "string" ? body.symbols.trim() : "";
		const subjectTerm = typeof body.subject === "string" ? body.subject.trim() : "";
		const rawFromDate = typeof body.fromDate === "string" ? body.fromDate.trim() : "";
		const fromIso = rawFromDate ? `${rawFromDate}T00:00:00.000Z` : undefined;
		const fromEpoch = fromIso ? Date.parse(fromIso) : Number.NaN;

		const hasFieldFilters = symbolsTerm !== "" || subjectTerm !== "";

		if (!searchTerms && !hasFieldFilters)
		{
			// Empty search with no field filters — return latest threads (same as GET /api/threads/latest)
			const effectiveLimit = threadLimit > 0 ? threadLimit : 100;
			const fromEpochForLatest = !Number.isNaN(fromEpoch) ? fromEpoch : undefined;
			const threadResults = getLatestThreads(ctx.messageDB, effectiveLimit, ctx.topicStore, fromEpochForLatest);
			console.log(`[Threads/POST] Empty search → latest ${effectiveLimit} threads (${threadResults.total} found)`);
			res.json({
				total: threadResults.total,
				page: threadResults.page,
				results: threadResults.results.map((thread) => ({
					sessionId: thread.sessionId,
					subject: thread.subject,
					harness: thread.harness,
					project: thread.project,
					messageCount: thread.messageCount,
					totalLength: thread.totalLength,
					firstDateTime: thread.firstDateTime,
					lastDateTime: thread.lastDateTime,
					firstMessage: thread.firstMessage,
					matchingMessageIds: thread.matchingMessageIds,
					bestMatchScore: thread.bestMatchScore,
					hits: thread.hits,
				})),
			});
			return;
		}

		const rawProjects = Array.isArray(body.projects) ? body.projects : [];
		const projectFilters = parseProjectFilters(rawProjects);
		const projectFilterSet = projectFilters.length > 0
			? new Set(projectFilters.map((p) => `${p.harness.trim()}::${p.project.trim()}`))
			: null;

		try
		{
			const cacheKey = buildSearchCacheKey('thr', searchTerms || `field:${symbolsTerm}|${subjectTerm}`, {
				symbols: symbolsTerm || undefined,
				subject: subjectTerm || undefined,
				fromDate: rawFromDate || undefined,
				projects: projectFilters.length > 0 ? projectFilters : undefined,
				limit: threadLimit > 0 ? threadLimit : undefined,
			});
			const filenamePrefix = buildCacheFilenamePrefix('thr', searchTerms || `field-${symbolsTerm || subjectTerm}`, {
				fromDate: rawFromDate || undefined,
				limit: threadLimit > 0 ? threadLimit : undefined,
			});

			const { data: responseData, cached } = await withCache(cacheKey, async () =>
			{
				let searchResults;

				if (!searchTerms)
				{
					// Field-only search: build result set from all messages then filter
					let messages = ctx.messageDB.getAllMessages();

					if (!Number.isNaN(fromEpoch))
						messages = messages.filter((m) => { const v = Date.parse(String(m.dateTime)); return !Number.isNaN(v) && v >= fromEpoch; });

					if (projectFilterSet)
						messages = messages.filter((m) => projectFilterSet.has(`${m.harness}::${m.project}`));

					if (symbolsTerm)
						messages = filterMessagesBySymbols(messages, symbolsTerm);

					if (subjectTerm)
						messages = filterMessagesBySubject(messages, subjectTerm);

					console.log(`[Threads/POST] Field-only search: symbols="${symbolsTerm}" subject="${subjectTerm}" → ${messages.length} messages`);
					searchResults = messagesToResults(messages, symbolsTerm, subjectTerm);
				}
				else
				{
					const parsedQuery = parseSearchQuery(searchTerms);
					console.log(
						`[Threads/POST] Parsed query: mode=${parsedQuery.mode}, tokens=${parsedQuery.tokens.length}, query="${searchTerms}", symbols="${symbolsTerm}", subject="${subjectTerm}", projects=${projectFilters.length}`
					);

					searchResults = executeSearch(parsedQuery);

					if (!Number.isNaN(fromEpoch))
					{
						searchResults = searchResults.filter((result) =>
						{
							const value = Date.parse(String(result.message.dateTime));
							return !Number.isNaN(value) && value >= fromEpoch;
						});
					}

					if (projectFilterSet)
					{
						searchResults = searchResults.filter((result) =>
							projectFilterSet.has(`${result.message.harness}::${result.message.project}`)
						);
					}

					// Apply field-targeted filters (post-Fuse, scores preserved)
					if (symbolsTerm)
						searchResults = filterResultsBySymbols(searchResults, symbolsTerm);

					if (subjectTerm)
						searchResults = filterResultsBySubject(searchResults, subjectTerm);
				}

				// Qdrant vector search — merge additional hits into searchResults
				if ((searchTerms || subjectTerm) && ctx.vectorServices)
				{
					try
					{
						const qdrantHits = await runQdrantSearch(
							searchTerms, subjectTerm, symbolsTerm,
							searchResults.length || 50, projectFilters, ctx
						);

						const queryTerms = searchTerms
							? parseSearchQuery(searchTerms).tokens.map((t) => t.type === "exact" ? `"${t.phrase}"` : t.term)
							: [];

						const existingIds = new Set(searchResults.map((r) => r.message.id));
						for (const hit of qdrantHits)
						{
							if (existingIds.has(hit.payload.messageId)) continue;
							const message = ctx.messageDB.getById(hit.payload.messageId);
							if (!message) continue;

							// Apply fromDate filter to Qdrant-sourced entries
							if (!Number.isNaN(fromEpoch))
							{
								const v = Date.parse(String(message.dateTime));
								if (Number.isNaN(v) || v < fromEpoch) continue;
							}

							searchResults.push({
								message,
								score: hit.score,
								rawFuseScore: 1,
								matchedTerms: queryTerms,
							});
						}

						// Post-merge field filters on Qdrant-sourced entries
						if (symbolsTerm)
						{
							const lower = symbolsTerm.toLowerCase();
							searchResults = searchResults.filter((r) =>
								r.message.symbols.some((sym) => sym.toLowerCase().includes(lower))
							);
						}
						if (subjectTerm)
						{
							const lower = subjectTerm.toLowerCase();
							searchResults = searchResults.filter((r) =>
								r.message.subject.toLowerCase().includes(lower)
							);
						}
					} catch (error)
					{
						console.warn(`[Threads/POST] Qdrant search failed: ${(error as Error).message}`);
					}
				}

				const threadResults = aggregateToThreads(searchResults, ctx.messageDB, ctx.topicStore);
				if (threadLimit > 0 && threadResults.results.length > threadLimit)
				{
					threadResults.results = threadResults.results.slice(0, threadLimit);
					threadResults.total = threadResults.results.length;
				}
				console.log(`[Threads/POST] Sending ${threadResults.total} threads${threadLimit > 0 ? ` (limit ${threadLimit})` : ""}`);

				return {
					total: threadResults.total,
					page: threadResults.page,
					results: threadResults.results.map((thread) => ({
						sessionId: thread.sessionId,
						subject: thread.subject,
						harness: thread.harness,
						project: thread.project,
						messageCount: thread.messageCount,
						totalLength: thread.totalLength,
						firstDateTime: thread.firstDateTime,
						lastDateTime: thread.lastDateTime,
						firstMessage: thread.firstMessage,
						matchingMessageIds: thread.matchingMessageIds,
						bestMatchScore: thread.bestMatchScore,
						hits: thread.hits,
					})),
				};
			}, filenamePrefix);

			res.setHeader('X-Cache', cached ? 'HIT' : 'MISS');
			if (cached)
				console.log(`[Threads/POST] Cache HIT for "${searchTerms || `field:${symbolsTerm}|${subjectTerm}`}"`);
			res.json(responseData);
		} catch (error)
		{
			console.error(`[Threads/POST] Error: ${(error as Error).message}`);
			if ((error as Error).message.includes("parse") || (error as Error).message.includes("unbalanced"))
			{
				res.status(400).json({ error: "Malformed query", details: (error as Error).message });
				return;
			}
			res.status(500).json({ error: "Thread search failed", details: (error as Error).message });
		}
	});

	app.post("/api/threads/latest", async (req, res) =>
	{
		try
		{
			const body = req.body as { limit?: unknown; fromDate?: unknown };

			// Parse limit parameter (default 100)
			const limit = typeof body.limit === "number" ? body.limit : typeof body.limit === "string" ? Number(body.limit) : 100;

			if (isNaN(limit) || limit < 1)
			{
				res.status(400).json({ error: "Invalid limit parameter" });
				return;
			}

			const rawFromDate = typeof body.fromDate === "string" ? body.fromDate.trim() : "";
			const fromEpoch = rawFromDate ? Date.parse(`${rawFromDate}T00:00:00.000Z`) : undefined;

			const cacheKey = `thr-latest|lim:${limit}${rawFromDate ? `|from:${rawFromDate}` : ''}`;
			const filenamePrefix = buildCacheFilenamePrefix('thr', 'latest', {
				fromDate: rawFromDate || undefined,
				limit,
			});
			const LATEST_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

			const { data: response, cached } = await withCache(cacheKey, () =>
			{
				console.log(`[LatestThreads] Fetching latest ${limit} threads${rawFromDate ? ` from ${rawFromDate}` : ""}`);

				const threadResults = getLatestThreads(ctx.messageDB, limit, ctx.topicStore, fromEpoch);
				console.log(`[LatestThreads] Returning ${threadResults.total} threads`);

				return {
					total: threadResults.total,
					page: threadResults.page,
					results: threadResults.results.map((thread) => ({
						sessionId: thread.sessionId,
						subject: thread.subject,
						harness: thread.harness,
						project: thread.project,
						messageCount: thread.messageCount,
						totalLength: thread.totalLength,
						firstDateTime: thread.firstDateTime,
						lastDateTime: thread.lastDateTime,
						firstMessage: thread.firstMessage,
						matchingMessageIds: thread.matchingMessageIds,
						bestMatchScore: thread.bestMatchScore,
						hits: thread.hits,
					})),
				};
			}, filenamePrefix, LATEST_CACHE_TTL);

			res.setHeader('X-Cache', cached ? 'HIT' : 'MISS');
			if (cached)
				console.log(`[LatestThreads] Cache HIT (lim:${limit}${rawFromDate ? ` from:${rawFromDate}` : ''})`);
			res.json(response);
		} catch (error)
		{
			console.error(`[LatestThreads] Error: ${(error as Error).message}`);
			res.status(500).json({ error: "Failed to fetch latest threads" });
		}
	});
}
