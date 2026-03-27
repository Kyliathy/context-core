import { useCallback, useMemo, useState } from "react";
import type { FavoriteEntry, FavoriteSource } from "../types";

const FAVORITES_STORAGE_KEY = "ccv:favorites";

type UseFavoritesResult = {
	favorites: FavoriteEntry[];
	storageError: string | null;
	clearStorageError: () => void;
	getFavoritesForView: (viewId: string) => FavoriteEntry[];
	addFavorite: (viewId: string, source: FavoriteSource) => void;
	updateFavorite: (cardId: string, viewId: string, source: FavoriteSource) => void;
	removeFavorite: (cardId: string, viewId: string) => void;
	removeFavoritesForView: (viewId: string) => void;
	isFavorited: (cardId: string, viewId: string) => boolean;
	getFavoriteViewIds: (cardId: string) => string[];
};

function safeReadFavorites(): FavoriteEntry[]
{
	if (typeof window === "undefined")
	{
		return [];
	}

	try
	{
		const raw = window.localStorage.getItem(FAVORITES_STORAGE_KEY);
		if (!raw)
		{
			return [];
		}
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed))
		{
			return [];
		}

		// Filter valid entries and migrate legacy format
		return parsed
			.filter((entry): entry is Partial<FavoriteEntry> & { cardId: string; viewId: string; source: unknown } =>
			{
				if (!entry || typeof entry !== "object")
				{
					return false;
				}
				const candidate = entry as Partial<FavoriteEntry>;
				return typeof candidate.cardId === "string" && typeof candidate.viewId === "string" && Boolean(candidate.source);
			})
			.map((entry) =>
			{
				// Check if source has the new discriminated union format
				const source = entry.source as any;
				if (source && typeof source === "object" && "type" in source && (source.type === "message" || source.type === "thread"))
				{
					// New format - already has type discriminator
					return entry as FavoriteEntry;
				}

				// Legacy format - wrap SerializedAgentMessage with type: "message"
				return {
					...entry,
					source: { type: "message" as const, data: source },
				} as FavoriteEntry;
			});
	}
	catch
	{
		console.warn("[favorites] Failed to parse ccv:favorites. Falling back to empty list.");
		return [];
	}
}

export function useFavorites(): UseFavoritesResult
{
	const [favorites, setFavorites] = useState<FavoriteEntry[]>(() => safeReadFavorites());
	const [storageError, setStorageError] = useState<string | null>(null);

	const persistFavorites = useCallback((nextFavorites: FavoriteEntry[]) =>
	{
		if (typeof window === "undefined")
		{
			return;
		}
		try
		{
			window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(nextFavorites));
		}
		catch
		{
			setStorageError("Could not save favorites to localStorage.");
		}
	}, []);

	const getFavoritesForView = useCallback((viewId: string) =>
	{
		return favorites
			.filter((entry) => entry.viewId === viewId)
			.sort((left, right) => left.addedAt - right.addedAt);
	}, [favorites]);

	const addFavorite = useCallback((viewId: string, source: FavoriteSource) =>
	{
		setFavorites((prev) =>
		{
			const cardId = source.type === "message" ? source.data.id : source.data.sessionId;
			if (prev.some((entry) => entry.viewId === viewId && entry.cardId === cardId))
			{
				return prev;
			}
			const next = [
				...prev,
				{
					cardId,
					viewId,
					source,
					addedAt: Date.now(),
				},
			];
			persistFavorites(next);
			return next;
		});
	}, [persistFavorites]);

	const updateFavorite = useCallback((cardId: string, viewId: string, source: FavoriteSource) =>
	{
		setFavorites((prev) =>
		{
			const next = prev.map((entry) =>
				entry.cardId === cardId && entry.viewId === viewId
					? { ...entry, source }
					: entry
			);
			persistFavorites(next);
			return next;
		});
	}, [persistFavorites]);

	const removeFavorite = useCallback((cardId: string, viewId: string) =>
	{
		setFavorites((prev) =>
		{
			const next = prev.filter((entry) => !(entry.cardId === cardId && entry.viewId === viewId));
			persistFavorites(next);
			return next;
		});
	}, [persistFavorites]);

	const removeFavoritesForView = useCallback((viewId: string) =>
	{
		setFavorites((prev) =>
		{
			const next = prev.filter((entry) => entry.viewId !== viewId);
			persistFavorites(next);
			return next;
		});
	}, [persistFavorites]);

	const isFavorited = useCallback((cardId: string, viewId: string) =>
	{
		return favorites.some((entry) => entry.cardId === cardId && entry.viewId === viewId);
	}, [favorites]);

	const getFavoriteViewIds = useCallback((cardId: string) =>
	{
		return favorites.filter((entry) => entry.cardId === cardId).map((entry) => entry.viewId);
	}, [favorites]);

	const clearStorageError = useCallback(() => setStorageError(null), []);

	return useMemo(() => ({
		favorites,
		storageError,
		clearStorageError,
		getFavoritesForView,
		addFavorite,
		updateFavorite,
		removeFavorite,
		removeFavoritesForView,
		isFavorited,
		getFavoriteViewIds,
	}), [favorites, storageError, clearStorageError, getFavoritesForView, addFavorite, updateFavorite, removeFavorite, removeFavoritesForView, isFavorited, getFavoriteViewIds]);
}
