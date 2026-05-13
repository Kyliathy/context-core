import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FavoriteStore } from "../FavoriteStore.js";

describe("FavoriteStore", () =>
{
	test("load returns empty when file missing", () =>
	{
		const dir = mkdtempSync(join(tmpdir(), "cc-fav-"));
		try
		{
			const store = new FavoriteStore(dir);
			store.load();
			expect(store.list()).toEqual([]);
		}
		finally
		{
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("replaceAll and save writes valid JSON", () =>
	{
		const dir = mkdtempSync(join(tmpdir(), "cc-fav-"));
		try
		{
			const store = new FavoriteStore(dir);
			store.load();
			const rows = [
				{
					cardId: "c1",
					viewId: "v1",
					addedAt: 1,
					source: {
						type: "message" as const,
						data: {
							id: "c1",
							sessionId: "s1",
							harness: "Cursor",
							machine: "m",
							role: "user",
							model: null,
							message: "x",
							subject: "sub",
							context: [],
							symbols: [],
							history: [],
							tags: [],
							project: "P",
							parentId: null,
							tokenUsage: null,
							toolCalls: [],
							rationale: [],
							source: "src",
							dateTime: "2026-01-01T00:00:00.000Z",
						},
					},
				},
			];
			store.replaceAll(rows as never, []);
			store.save();
			const raw = readFileSync(join(dir, ".settings", "favorites.json"), "utf-8");
			const parsed = JSON.parse(raw) as { favorites?: unknown[]; favoriteViews?: unknown[] };
			expect(Array.isArray(parsed.favorites)).toBe(true);
			expect(parsed.favorites?.length).toBe(1);
			expect(Array.isArray(parsed.favoriteViews)).toBe(true);
		}
		finally
		{
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
