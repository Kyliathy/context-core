import { describe, expect, test } from "bun:test";
import type { FavoriteEntry, FavoriteViewSnapshot, ViewDefinition } from "../types";
import {
	buildFavoritesBundleSignature,
	buildFavoritesSignature,
	buildFavoriteViewsSignature,
	decideFavoriteStartupSync,
	favoriteKey,
	getFavoriteConflictSummary,
} from "./favoriteSync";

const sampleMessageSource = {
	type: "message" as const,
	data: {
		id: "m1",
		sessionId: "s1",
		harness: "Cursor",
		machine: "x",
		role: "user" as const,
		model: null,
		message: "hi",
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
};

function entry(cardId: string, viewId: string, addedAt: number): FavoriteEntry
{
	return { cardId, viewId, source: sampleMessageSource, addedAt };
}

const emptyViews: FavoriteViewSnapshot[] = [];

describe("favoriteSync", () =>
{
	test("favoriteKey joins view and card", () =>
	{
		expect(favoriteKey(entry("a", "v", 1))).toBe("v::a");
	});

	test("buildFavoritesSignature ignores row order", () =>
	{
		const a = [entry("a", "v", 1), entry("b", "v", 2)];
		const b = [entry("b", "v", 2), entry("a", "v", 1)];
		expect(buildFavoritesSignature(a)).toBe(buildFavoritesSignature(b));
	});

	test("getFavoriteConflictSummary counts removals", () =>
	{
		const local = [entry("a", "v", 1), entry("b", "v", 2)];
		const server = [entry("a", "v", 1)];
		const summary = getFavoriteConflictSummary(local, server);
		expect(summary.removedByServerCount).toBe(1);
		expect(summary.serverOnlyCount).toBe(0);
	});

	test("decideFavoriteStartupSync accepts server when local empty", () =>
	{
		const server = [entry("x", "v", 3)];
		const decision = decideFavoriteStartupSync([], server, emptyViews, emptyViews);
		expect(decision.kind).toBe("accept-server");
		if (decision.kind === "accept-server") expect(decision.favorites).toEqual(server);
	});

	test("decideFavoriteStartupSync asks user when server empty but local has rows", () =>
	{
		const local = [entry("x", "v", 3)];
		const decision = decideFavoriteStartupSync(local, [], emptyViews, emptyViews);
		expect(decision.kind).toBe("ask-user");
	});

	test("decideFavoriteStartupSync asks user on entry divergence", () =>
	{
		const local = [entry("a", "v", 1)];
		const server = [entry("b", "v", 2)];
		expect(decideFavoriteStartupSync(local, server, emptyViews, emptyViews).kind).toBe("ask-user");
	});

	test("decideFavoriteStartupSync asks user when entries match but view metadata differs", () =>
	{
		const rows = [entry("a", "v1", 1)];
		const localViews: FavoriteViewSnapshot[] = [{ id: "v1", name: "Local tab", emoji: "⭐", color: "#f59e0b" }];
		const serverViews: FavoriteViewSnapshot[] = [{ id: "v1", name: "Server tab", emoji: "🌟", color: "#f59e0b" }];
		expect(decideFavoriteStartupSync(rows, rows, localViews, serverViews).kind).toBe("ask-user");
	});

	test("buildFavoritesBundleSignature changes when view snapshots change", () =>
	{
		const rows = [entry("a", "v1", 1)];
		const a: FavoriteViewSnapshot[] = [{ id: "v1", name: "A", emoji: "⭐", color: "#f59e0b" }];
		const b: FavoriteViewSnapshot[] = [{ id: "v1", name: "B", emoji: "⭐", color: "#f59e0b" }];
		expect(buildFavoritesBundleSignature(rows, a)).not.toBe(buildFavoritesBundleSignature(rows, b));
	});

	test("buildFavoritesSignature changes when position changes", () =>
	{
		const a = [entry("a", "v", 1)];
		const b = [{ ...entry("a", "v", 1), position: { x: 10, y: 20 } }];
		expect(buildFavoritesSignature(a)).not.toBe(buildFavoritesSignature(b));
	});

	test("decideFavoriteStartupSync asks user when only position differs", () =>
	{
		const rowsA = [entry("a", "v", 1)];
		const rowsB = [{ ...entry("a", "v", 1), position: { x: 1, y: 2 } }];
		expect(decideFavoriteStartupSync(rowsA, rowsB, emptyViews, emptyViews).kind).toBe("ask-user");
	});

	test("buildFavoriteViewsSignature normalizes favorites tabs to CustomCardPositioning", () =>
	{
		const auto: FavoriteViewSnapshot[] = [{ id: "v1", name: "A", emoji: "⭐", color: "#f59e0b", cardPositioningMode: "Auto" }];
		const custom: FavoriteViewSnapshot[] = [
			{ id: "v1", name: "A", emoji: "⭐", color: "#f59e0b", cardPositioningMode: "CustomCardPositioning" },
		];
		const bare: FavoriteViewSnapshot[] = [{ id: "v1", name: "A", emoji: "⭐", color: "#f59e0b" }];
		expect(buildFavoriteViewsSignature(auto)).toBe(buildFavoriteViewsSignature(custom));
		expect(buildFavoriteViewsSignature(auto)).toBe(buildFavoriteViewsSignature(bare));
	});
});
