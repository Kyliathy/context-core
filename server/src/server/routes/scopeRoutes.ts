import type { Express } from "express";
import type { RouteContext } from "../RouteContext.js";
import { normalizeScopeEntry } from "../routeUtils.js";

export function register(app: Express, ctx: RouteContext): void
{
	app.get("/api/list-scopes", (_req, res) =>
	{
		if (!ctx.scopeStore)
		{
			res.json([]);
			return;
		}

		res.json(ctx.scopeStore.list());
	});

	app.post("/api/scopes", (req, res) =>
	{
		if (!ctx.scopeStore)
		{
			res.status(404).json({ error: "Scope store not available" });
			return;
		}

		const body = req.body as { scopes?: unknown };
		if (!Array.isArray(body.scopes))
		{
			res.status(400).json({ error: "scopes must be an array" });
			return;
		}

		const normalizedScopes = [];
		for (const rawScope of body.scopes)
		{
			const normalized = normalizeScopeEntry(rawScope);
			if (!normalized)
			{
				res.status(400).json({ error: "Invalid scope entry payload" });
				return;
			}
			normalizedScopes.push(normalized);
		}

		ctx.scopeStore.replaceAll(normalizedScopes);
		ctx.scopeStore.save();

		res.json({ saved: normalizedScopes.length });
	});
}
