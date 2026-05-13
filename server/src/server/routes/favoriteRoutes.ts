import type { Express } from "express";
import type { RouteContext } from "../RouteContext.js";
import {
	normalizeFavoriteEntry,
	normalizeFavoriteViewSnapshot,
	type FavoriteEntry,
	type FavoriteViewSnapshot,
} from "../../models/FavoriteEntry.js";

/**
 * Ensures every viewId referenced by entries has a snapshot row so disk JSON stays self-describing.
 * @param entries - Normalized favorite rows.
 * @param views - Client-supplied view metadata (may omit ids that only appear as orphans).
 */
function ensureFavoriteViewCoverage(entries: FavoriteEntry[], views: FavoriteViewSnapshot[]): FavoriteViewSnapshot[]
{
	const byId = new Map<string, FavoriteViewSnapshot>();
	for (const row of views)
	{
		byId.set(row.id, row);
	}
	for (const entry of entries)
	{
		if (!byId.has(entry.viewId))
		{
			const short = entry.viewId.slice(0, 8);
			byId.set(entry.viewId, {
				id: entry.viewId,
				name: `Favorites (${short})`,
				emoji: "⭐",
				color: "#f59e0b",
			});
		}
	}
	return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function register(app: Express, ctx: RouteContext): void
{
	app.get("/api/favorites", (_req, res) =>
	{
		if (!ctx.favoriteStore)
		{
			res.json({ favorites: [], favoriteViews: [] });
			return;
		}

		res.json({
			favorites: ctx.favoriteStore.list(),
			favoriteViews: ctx.favoriteStore.listFavoriteViews(),
		});
	});

	app.post("/api/favorites", (req, res) =>
	{
		if (!ctx.favoriteStore)
		{
			res.status(404).json({ error: "Favorite store not available" });
			return;
		}

		const body = req.body as { favorites?: unknown; favoriteViews?: unknown };
		if (!Array.isArray(body.favorites))
		{
			res.status(400).json({ error: "favorites must be an array" });
			return;
		}

		const normalized: FavoriteEntry[] = [];
		for (const raw of body.favorites)
		{
			const entry = normalizeFavoriteEntry(raw);
			if (!entry)
			{
				res.status(400).json({ error: "Invalid favorite entry payload" });
				return;
			}
			normalized.push(entry);
		}

		const viewRows: FavoriteViewSnapshot[] = [];
		if (body.favoriteViews !== undefined && !Array.isArray(body.favoriteViews))
		{
			res.status(400).json({ error: "favoriteViews must be an array when provided" });
			return;
		}
		if (Array.isArray(body.favoriteViews))
		{
			for (const raw of body.favoriteViews)
			{
				const row = normalizeFavoriteViewSnapshot(raw);
				if (!row)
				{
					res.status(400).json({ error: "Invalid favoriteViews payload" });
					return;
				}
				viewRows.push(row);
			}
		}

		const mergedViews = ensureFavoriteViewCoverage(normalized, viewRows);
		ctx.favoriteStore.replaceAll(normalized, mergedViews);
		ctx.favoriteStore.save();

		res.json({ saved: normalized.length, savedViews: mergedViews.length });
	});
}
