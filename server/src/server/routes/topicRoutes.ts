import type { Express } from "express";
import type { RouteContext } from "../RouteContext.js";
import type { TopicEntry } from "../../models/TopicEntry.js";

export function register(app: Express, ctx: RouteContext): void
{
	app.get("/api/topics", (_req, res) =>
	{
		if (!ctx.topicStore)
		{
			res.json([]);
			return;
		}
		const sessions = ctx.messageDB.listSessions();
		const entries = sessions
			.map((s) => ctx.topicStore!.getBySessionId(s.sessionId))
			.filter((e) => e !== undefined);
		res.json(entries);
	});

	app.get("/api/topics/:sessionId", (req, res) =>
	{
		if (!ctx.topicStore)
		{
			res.status(404).json({ error: "Topic store not available" });
			return;
		}
		const entry = ctx.topicStore.getBySessionId(req.params.sessionId);
		if (!entry)
		{
			res.status(404).json({ error: "Topic not found" });
			return;
		}
		res.json(entry);
	});

	app.post("/api/topics", (req, res) =>
	{
		if (!ctx.topicStore)
		{
			res.status(404).json({ error: "Topic store not available" });
			return;
		}

		const { sessionId, customTopic } = req.body as { sessionId?: unknown; customTopic?: unknown };

		if (typeof sessionId !== "string" || sessionId.trim().length === 0)
		{
			res.status(400).json({ error: "sessionId must be a non-empty string" });
			return;
		}

		if (typeof customTopic !== "string")
		{
			res.status(400).json({ error: "customTopic must be a string" });
			return;
		}

		const normalizedSessionId = sessionId.trim();
		const existingEntry = ctx.topicStore.getBySessionId(normalizedSessionId);

		const updatedEntry: TopicEntry = existingEntry
			? {
				sessionId: existingEntry.sessionId,
				charsSent: existingEntry.charsSent,
				aiSummary: existingEntry.aiSummary,
				customTopic,
			}
			: {
				sessionId: normalizedSessionId,
				charsSent: 0,
				aiSummary: "",
				customTopic,
			};

		ctx.topicStore.upsert(updatedEntry);
		ctx.topicStore.save();

		// Consistency model (R2BQ — T26/T27): invalidate cached summary embedding immediately.
		// Re-embedding happens on next IncrementalPipeline run or full startup reindex.
		// Stale Qdrant points retain old summary vectors until re-indexed.
		if (ctx.summaryEmbeddingCache)
		{
			ctx.summaryEmbeddingCache.delete(normalizedSessionId);
			ctx.summaryEmbeddingCache.save();
			ctx.summaryEmbeddingCache.saveSynced();
		}

		res.json(updatedEntry);
	});
}
