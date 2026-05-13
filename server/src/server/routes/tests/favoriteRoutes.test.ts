import { describe, expect, test } from "bun:test";
import express, { type Express } from "express";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FavoriteStore } from "../../../settings/FavoriteStore.js";
import { register as registerFavoriteRoutes } from "../favoriteRoutes.js";
import type { RouteContext } from "../../RouteContext.js";

const minimalMessage = {
	id: "m1",
	sessionId: "s1",
	harness: "Cursor",
	machine: "m",
	role: "user",
	model: null,
	message: "hi",
	subject: "sub",
	context: [] as string[],
	symbols: [] as string[],
	history: [] as string[],
	tags: [] as string[],
	project: "P",
	parentId: null,
	tokenUsage: null,
	toolCalls: [] as unknown[],
	rationale: [] as string[],
	source: "src",
	dateTime: "2026-01-01T00:00:00.000Z",
};

async function withServer(app: Express, run: (baseUrl: string) => Promise<void>): Promise<void>
{
	const server = app.listen(0, "127.0.0.1");
	try
	{
		await new Promise<void>((resolve) => server.once("listening", () => resolve()));
		const addr = server.address();
		if (!addr || typeof addr === "string") throw new Error("Failed to bind test server");
		const baseUrl = `http://127.0.0.1:${addr.port}`;
		await run(baseUrl);
	}
	finally
	{
		await new Promise<void>((resolve, reject) =>
		{
			server.close((err) => (err ? reject(err) : resolve()));
		});
	}
}

describe("favoriteRoutes", () =>
{
	test("GET returns list from store", async () =>
	{
		const dir = mkdtempSync(join(tmpdir(), "cc-favr-"));
		const store = new FavoriteStore(dir);
		store.load();
		store.replaceAll(
			[
				{
					cardId: "c1",
					viewId: "v1",
					addedAt: 10,
					source: { type: "message", data: minimalMessage },
				},
			],
			[{ id: "v1", name: "My Favorites", emoji: "⭐", color: "#f59e0b" }],
		);
		store.save();

		const app = express();
		app.use(express.json());
		const ctx: RouteContext = { messageDB: {} as never, favoriteStore: store };
		registerFavoriteRoutes(app, ctx);

		await withServer(app, async (baseUrl) =>
		{
			const res = await fetch(`${baseUrl}/api/favorites`);
			expect(res.ok).toBe(true);
			const data = (await res.json()) as { favorites: unknown[]; favoriteViews: unknown[] };
			expect(Array.isArray(data.favorites)).toBe(true);
			expect(data.favorites.length).toBe(1);
			expect(Array.isArray(data.favoriteViews)).toBe(true);
			expect(data.favoriteViews.length).toBeGreaterThanOrEqual(1);
		});

		rmSync(dir, { recursive: true, force: true });
	});

	test("POST rejects invalid payload", async () =>
	{
		const dir = mkdtempSync(join(tmpdir(), "cc-favr-"));
		const store = new FavoriteStore(dir);
		store.load();

		const app = express();
		app.use(express.json());
		const ctx: RouteContext = { messageDB: {} as never, favoriteStore: store };
		registerFavoriteRoutes(app, ctx);

		await withServer(app, async (baseUrl) =>
		{
			const res = await fetch(`${baseUrl}/api/favorites`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ favorites: [{ cardId: "", viewId: "v", addedAt: 1, source: { type: "message", data: minimalMessage } }] }),
			});
			expect(res.status).toBe(400);
		});

		rmSync(dir, { recursive: true, force: true });
	});

	test("POST persists and reloads", async () =>
	{
		const dir = mkdtempSync(join(tmpdir(), "cc-favr-"));
		let store = new FavoriteStore(dir);
		store.load();

		const app = express();
		app.use(express.json());
		const ctx: RouteContext = { messageDB: {} as never, favoriteStore: store };
		registerFavoriteRoutes(app, ctx);

		await withServer(app, async (baseUrl) =>
		{
			const body = {
				favorites: [
					{
						cardId: "c2",
						viewId: "v2",
						addedAt: 20,
						source: { type: "message", data: { ...minimalMessage, id: "c2" } },
					},
				],
			};
			const res = await fetch(`${baseUrl}/api/favorites`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(res.ok).toBe(true);
		});

		store = new FavoriteStore(dir);
		store.load();
		expect(store.list().length).toBe(1);
		expect(store.list()[0]?.cardId).toBe("c2");
		expect(store.listFavoriteViews().length).toBeGreaterThanOrEqual(1);

		rmSync(dir, { recursive: true, force: true });
	});
});
