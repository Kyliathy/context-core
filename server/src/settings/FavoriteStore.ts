/**
 * FavoriteStore — persistence layer for visualizer favorites snapshots.
 * Stores entries in .settings/favorites.json.
 */

import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import type { FavoriteEntry, FavoriteViewSnapshot } from "../models/FavoriteEntry.js";
import { normalizeFavoriteViewSnapshot } from "../models/FavoriteEntry.js";

/** On-disk shape for favorites.json (legacy bare Array is still accepted on load). */
export type FavoritesFilePayload = {
	favorites: FavoriteEntry[];
	favoriteViews: FavoriteViewSnapshot[];
};

export class FavoriteStore
{
	private readonly settingsDir: string;
	private readonly favoritesFilePath: string;
	private favorites: FavoriteEntry[];
	private favoriteViews: FavoriteViewSnapshot[];

	/**
	 * Creates a FavoriteStore instance.
	 * @param storagePath - Root storage directory (e.g. CXC storage root).
	 */
	constructor(storagePath: string)
	{
		this.settingsDir = join(storagePath, ".settings");
		this.favoritesFilePath = join(this.settingsDir, "favorites.json");
		this.favorites = [];
		this.favoriteViews = [];

		if (!existsSync(this.settingsDir))
		{
			mkdirSync(this.settingsDir, { recursive: true });
		}
	}

	/**
	 * Loads favorites from favorites.json.
	 * If missing or invalid, starts with empty lists.
	 */
	load(): void
	{
		if (!existsSync(this.favoritesFilePath))
		{
			this.favorites = [];
			this.favoriteViews = [];
			return;
		}

		try
		{
			const fileContent = readFileSync(this.favoritesFilePath, "utf-8");
			const parsed = JSON.parse(fileContent) as unknown;
			if (Array.isArray(parsed))
			{
				this.favorites = parsed as FavoriteEntry[];
				this.favoriteViews = [];
				return;
			}
			if (!parsed || typeof parsed !== "object")
			{
				this.favorites = [];
				this.favoriteViews = [];
				return;
			}
			const record = parsed as Record<string, unknown>;
			const fav = record.favorites;
			this.favorites = Array.isArray(fav) ? (fav as FavoriteEntry[]) : [];
			const rawViews = record.favoriteViews;
			const parsedViews: FavoriteViewSnapshot[] = [];
			if (Array.isArray(rawViews))
			{
				for (const item of rawViews)
				{
					const row = normalizeFavoriteViewSnapshot(item);
					if (row) parsedViews.push(row);
				}
			}
			this.favoriteViews = parsedViews;
		}
		catch (error)
		{
			console.warn(
				`[FavoriteStore] Failed to parse favorites.json: ${(error as Error).message}. Starting with empty list.`
			);
			this.favorites = [];
			this.favoriteViews = [];
		}
	}

	/**
	 * Saves favorites rows and view metadata to favorites.json.
	 */
	save(): void
	{
		const payload: FavoritesFilePayload = { favorites: this.favorites, favoriteViews: this.favoriteViews };
		const jsonContent = JSON.stringify(payload, null, 2);
		writeFileSync(this.favoritesFilePath, jsonContent, "utf-8");
	}

	/**
	 * Returns all stored favorite rows (same list shape as the visualizer uses).
	 */
	list(): FavoriteEntry[]
	{
		return this.favorites;
	}

	/**
	 * Returns stored favorites-type view labels and styling for cross-machine imports.
	 */
	listFavoriteViews(): FavoriteViewSnapshot[]
	{
		return this.favoriteViews;
	}

	/**
	 * Replaces all stored favorites and view snapshots in memory.
	 * @param favorites - Full entry list to store.
	 * @param favoriteViews - Parallel metadata list (names, emoji, color per view id).
	 */
	replaceAll(favorites: FavoriteEntry[], favoriteViews: FavoriteViewSnapshot[]): void
	{
		this.favorites = favorites;
		this.favoriteViews = favoriteViews;
	}
}
