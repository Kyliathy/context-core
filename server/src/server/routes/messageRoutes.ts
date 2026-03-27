import type { Express } from "express";
import type { MessageQueryFilters } from "../../db/IMessageStore.js";
import type { RouteContext } from "../RouteContext.js";
import { SearchResults } from "../../models/SearchResults.js";
import { parseSearchQuery } from "../../search/queryParser.js";
import { executeSearch } from "../../search/searchEngine.js";
import { resolveSubject, runQdrantSearch, applyTopicSubjects, parseProjectFilters, type ProjectFilter } from "../routeUtils.js";
import { withCache, buildSearchCacheKey, buildCacheFilenamePrefix } from "../../cache/ResponseCache.js";
import
{
	filterResultsBySymbols,
	filterResultsBySubject,
	filterMessagesBySymbols,
	filterMessagesBySubject,
} from "../../search/fieldFilters.js";

export function register(app: Express, ctx: RouteContext): void
{
	app.get("/api/messages/:id", (req, res) =>
	{
		const message = ctx.messageDB.getById(req.params.id);
		if (!message)
		{
			res.status(404).json({ error: "Message not found" });
			return;
		}
		const serialized = message.serialize();
		serialized.subject = resolveSubject(message.sessionId, message.subject, ctx.topicStore);
		res.json(serialized);
	});

	app.get("/api/messages", (req, res) =>
	{
		const filters: MessageQueryFilters = {
			role: typeof req.query.role === "string" ? req.query.role : undefined,
			harness: typeof req.query.harness === "string" ? req.query.harness : undefined,
			model: typeof req.query.model === "string" ? req.query.model : undefined,
			project: typeof req.query.project === "string" ? req.query.project : undefined,
			subject: typeof req.query.subject === "string" ? req.query.subject : undefined,
			from: typeof req.query.from === "string" ? req.query.from : undefined,
			to: typeof req.query.to === "string" ? req.query.to : undefined,
			page: typeof req.query.page === "string" ? Number(req.query.page) : undefined,
			pageSize: typeof req.query.pageSize === "string" ? Number(req.query.pageSize) : undefined,
		};

		// Log active filters
		const activeFilters = Object.entries(filters)
			.filter(([_, value]) => value !== undefined)
			.map(([key, value]) => `${key}=${value}`)
			.join(", ");
		console.log(`[Query] Active filters: ${activeFilters || "none"}`);

		const result = ctx.messageDB.queryMessages(filters);

		// Log breakdown by harness
		const harnessCounts = new Map<string, number>();
		for (const message of result.results)
		{
			const count = harnessCounts.get(message.harness) || 0;
			harnessCounts.set(message.harness, count + 1);
		}
		const breakdown = Array.from(harnessCounts.entries())
			.map(([harness, count]) => `${harness}=${count}`)
			.join(", ");
		console.log(`[Query] Returned ${result.results.length}/${result.total} messages (page ${result.page}): ${breakdown}`);

		res.json({
			total: result.total,
			page: result.page,
			results: result.results.map((message) =>
			{
				const serialized = message.serialize();
				serialized.subject = resolveSubject(message.sessionId, message.subject, ctx.topicStore);
				return serialized;
			}),
		});
	});

	app.post("/api/messages", async (req, res) =>
	{
		const body = req.body as {
			searchTerms?: unknown;
			symbols?: unknown;
			subject?: unknown;
			fromDate?: unknown;
			projects?: unknown;
			page?: unknown;
			pageSize?: unknown;
			role?: unknown;
			harness?: unknown;
			model?: unknown;
			project?: unknown;
			to?: unknown;
		};

		const searchTerms = typeof body.searchTerms === "string" ? body.searchTerms.trim() : "";
		const symbolsTerm = typeof body.symbols === "string" ? body.symbols.trim() : "";
		const subjectTerm = typeof body.subject === "string" ? body.subject.trim() : "";
		const rawFromDate = typeof body.fromDate === "string" ? body.fromDate.trim() : "";
		const fromIso = rawFromDate ? `${rawFromDate}T00:00:00.000Z` : undefined;
		const fromEpoch = fromIso ? Date.parse(fromIso) : Number.NaN;

		const rawProjects = Array.isArray(body.projects) ? body.projects : [];
		const projectFilters = parseProjectFilters(rawProjects);
		const projectFilterSet = projectFilters.length > 0
			? new Set(projectFilters.map((p) => `${p.harness.trim()}::${p.project.trim()}`))
			: null;

		const hasFieldFilters = symbolsTerm !== "" || subjectTerm !== "";

		if (!searchTerms)
		{
			// Field-only search: symbols/subject provided but no full-text query
			if (hasFieldFilters)
			{
				try
				{
					let messages = ctx.messageDB.getAllMessages();

					if (!Number.isNaN(fromEpoch))
						messages = messages.filter((m) => { const v = Date.parse(String(m.dateTime)); return !Number.isNaN(v) && v >= fromEpoch; });

					if (projectFilterSet)
						messages = messages.filter((m) => projectFilterSet.has(`${m.harness}::${m.project}`));

					if (symbolsTerm)
						messages = filterMessagesBySymbols(messages, symbolsTerm);

					if (subjectTerm)
						messages = filterMessagesBySubject(messages, subjectTerm);

					// Sort by date descending (no relevance score available)
					messages = messages.slice().sort((a, b) => b.dateTime.toMillis() - a.dateTime.toMillis());

					console.log(`[Messages/POST] Field-only search: symbols="${symbolsTerm}" subject="${subjectTerm}" → ${messages.length} results`);

					res.json({
						total: messages.length,
						page: 1,
						results: messages.map((message) =>
						{
							const serialized = message.serialize();
							serialized.subject = resolveSubject(message.sessionId, message.subject, ctx.topicStore);
							return serialized;
						}),
					});
				} catch (error)
				{
					console.error(`[Messages/POST] Field-only search error: ${(error as Error).message}`);
					res.status(500).json({ error: "Search failed" });
				}
				return;
			}

			// No search terms at all — paginated browse
			const page = typeof body.page === "number" ? body.page : (typeof body.page === "string" ? Number(body.page) : undefined);
			const pageSize = typeof body.pageSize === "number" ? body.pageSize : (typeof body.pageSize === "string" ? Number(body.pageSize) : undefined);
			const queryResult = ctx.messageDB.queryMessages({
				role: typeof body.role === "string" ? body.role : undefined,
				harness: typeof body.harness === "string" ? body.harness : undefined,
				model: typeof body.model === "string" ? body.model : undefined,
				project: typeof body.project === "string" ? body.project : undefined,
				from: fromIso,
				to: typeof body.to === "string" ? body.to : undefined,
				page,
				pageSize,
			});

			let results = queryResult.results;
			if (projectFilterSet)
			{
				results = results.filter((message) => projectFilterSet.has(`${message.harness}::${message.project}`));
			}

			console.log(`[Messages/POST] Sending ${results.length} results (paginated browse, page ${queryResult.page})`);
			res.json({
				total: results.length,
				page: queryResult.page,
				results: results.map((message) =>
				{
					const serialized = message.serialize();
					serialized.subject = resolveSubject(message.sessionId, message.subject, ctx.topicStore);
					return serialized;
				}),
			});
			return;
		}

		try
		{
			const cacheKey = buildSearchCacheKey('msg', searchTerms, {
				symbols: symbolsTerm || undefined,
				subject: subjectTerm || undefined,
				fromDate: rawFromDate || undefined,
				projects: projectFilters.length > 0 ? projectFilters : undefined,
			});
			const filenamePrefix = buildCacheFilenamePrefix('msg', searchTerms, {
				fromDate: rawFromDate || undefined,
			});

			const { data: responseData, cached } = await withCache(cacheKey, async () =>
			{
				const parsedQuery = parseSearchQuery(searchTerms);
				console.log(
					`[Messages/POST] Parsed query: mode=${parsedQuery.mode}, tokens=${parsedQuery.tokens.length}, query="${searchTerms}", symbols="${symbolsTerm}", subject="${subjectTerm}", projects=${projectFilters.length}`
				);

				let searchResults = executeSearch(parsedQuery);
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

				const fuseHits = searchResults.map((result) => ({
					score: result.rawFuseScore,
					message: result.message,
					matchedTerms: result.matchedTerms,
				}));

				// Subject-aware dual-channel Qdrant search
				let qdrantHits: Array<{ score: number; payload: any }> = [];
				if ((searchTerms || subjectTerm) && ctx.vectorServices)
				{
					try
					{
						qdrantHits = await runQdrantSearch(
							searchTerms, subjectTerm, symbolsTerm,
							searchResults.length || 50, projectFilters, ctx
						);
					} catch (error)
					{
						console.warn(`[Messages/POST] Qdrant search failed: ${(error as Error).message}`);
					}
				}

				const merged = SearchResults.merge(fuseHits, qdrantHits, searchTerms, ctx.messageDB);

				// Post-merge field filters — safety net so Qdrant-sourced results respect field constraints
				if (symbolsTerm)
				{
					const lower = symbolsTerm.toLowerCase();
					merged.results = merged.results.filter((r) =>
						r.symbols.some((sym) => sym.toLowerCase().includes(lower))
					);
				}
				if (subjectTerm)
				{
					const lower = subjectTerm.toLowerCase();
					merged.results = merged.results.filter((r) =>
						r.subject.toLowerCase().includes(lower)
					);
				}

				const data = merged.serialize();
				console.log(`[Messages/POST] Sending ${data.results?.length ?? 0} results`);

				applyTopicSubjects(data, ctx);

				return data;
			}, filenamePrefix);

			res.setHeader('X-Cache', cached ? 'HIT' : 'MISS');
			if (cached)
				console.log(`[Messages/POST] Cache HIT for "${searchTerms}"`);
			res.json(responseData);
		} catch (error)
		{
			console.error(`[Messages/POST] Error: ${(error as Error).message}`);
			if ((error as Error).message.includes("parse") || (error as Error).message.includes("unbalanced"))
			{
				res.status(400).json({ error: "Malformed query", details: (error as Error).message });
				return;
			}
			res.status(500).json({ error: "Search failed" });
		}
	});
}
