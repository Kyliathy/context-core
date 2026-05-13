import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FavoriteEntry, FavoriteSource, FavoriteViewSnapshot, SerializedAgentMessage, ViewDefinition } from "../types";
import { fetchFavorites, saveFavorites } from "../api/search";
import {
	buildFavoriteViewsForSave,
	buildFavoritesBundleSignature,
	decideFavoriteStartupSync,
	type FavoriteSyncConflict,
} from "./favoriteSync";

const FAVORITES_STORAGE_KEY = "ccv:favorites";
const SAVE_DEBOUNCE_MS = 400;

export type UseFavoritesOptions = {
	/** Live favorites-type tabs so POST bodies carry real names/emoji/color for each viewId. */
	favoriteViewsForSync: ViewDefinition[];
	/** Hydrates imported server view UUIDs into ccv:views when the user accepts the server bundle. */
	onMergeServerFavoriteViews: (snapshots: FavoriteViewSnapshot[]) => void;
};

type UseFavoritesResult = {
	favorites: FavoriteEntry[];
	storageError: string | null;
	syncError: string | null;
	isSyncing: boolean;
	isServerAvailable: boolean;
	hasUnsyncedLocalChanges: boolean;
	pendingConflict: FavoriteSyncConflict | null;
	isSavingConflictChoice: boolean;
	clearStorageError: () => void;
	getFavoritesForView: (viewId: string) => FavoriteEntry[];
	addFavorite: (viewId: string, source: FavoriteSource) => void;
	updateFavorite: (cardId: string, viewId: string, source: FavoriteSource) => void;
	updateFavoritePosition: (cardId: string, viewId: string, position: { x: number; y: number }) => void;
	removeFavorite: (cardId: string, viewId: string) => void;
	removeFavoritesForView: (viewId: string) => void;
	isFavorited: (cardId: string, viewId: string) => boolean;
	getFavoriteViewIds: (cardId: string) => string[];
	acceptServerFavorites: () => void;
	keepLocalFavorites: () => Promise<void>;
	dismissSyncConflict: () => void;
	retryFavoriteSync: () => void;
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

		//Filter valid entries and migrate legacy format
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
				const source = entry.source as { type?: string };
				if (source && typeof source === "object" && "type" in source && (source.type === "message" || source.type === "thread"))
				{
					return entry as FavoriteEntry;
				}

				return {
					...entry,
					source: { type: "message" as const, data: entry.source as unknown as SerializedAgentMessage },
				} as FavoriteEntry;
			});
	}
	catch
	{
		console.warn("[favorites] Failed to parse ccv:favorites. Falling back to empty list.");
		return [];
	}
}

export function useFavorites(options: UseFavoritesOptions): UseFavoritesResult
{
	const favoriteViewsForSyncRef = useRef(options.favoriteViewsForSync);
	favoriteViewsForSyncRef.current = options.favoriteViewsForSync;
	const onMergeServerFavoriteViewsRef = useRef(options.onMergeServerFavoriteViews);
	onMergeServerFavoriteViewsRef.current = options.onMergeServerFavoriteViews;

	const [favorites, setFavorites] = useState<FavoriteEntry[]>(() => safeReadFavorites());
	const [storageError, setStorageError] = useState<string | null>(null);
	const [syncError, setSyncError] = useState<string | null>(null);
	const [isSyncing, setIsSyncing] = useState(false);
	const [isServerAvailable, setIsServerAvailable] = useState(false);
	const [hasUnsyncedLocalChanges, setHasUnsyncedLocalChanges] = useState(false);
	const [pendingConflict, setPendingConflict] = useState<FavoriteSyncConflict | null>(null);
	const [isSavingConflictChoice, setIsSavingConflictChoice] = useState(false);

	const favoritesRef = useRef(favorites);
	favoritesRef.current = favorites;

	const pendingConflictRef = useRef<FavoriteSyncConflict | null>(null);
	pendingConflictRef.current = pendingConflict;

	const isServerAvailableRef = useRef(isServerAvailable);
	isServerAvailableRef.current = isServerAvailable;

	const lastKnownServerSignatureRef = useRef<string | null>(null);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const latestForSaveRef = useRef<FavoriteEntry[]>(favorites);

	const persistLocalFavorites = useCallback((nextFavorites: FavoriteEntry[]) =>
	{
		if (typeof window === "undefined")
		{
			return;
		}
		try
		{
			window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(nextFavorites));
			setStorageError(null);
		}
		catch
		{
			setStorageError("Could not save favorites to localStorage.");
		}
	}, []);

	const runStartupSync = useCallback(async () =>
	{
		if (typeof window === "undefined" || !navigator.onLine)
		{
			return;
		}
		setIsSyncing(true);
		setSyncError(null);
		try
		{
			const { favorites: serverRows, favoriteViews: serverViews } = await fetchFavorites();
			setIsServerAvailable(true);
			const localFavorites = favoritesRef.current;
			const localViews = buildFavoriteViewsForSave(localFavorites, favoriteViewsForSyncRef.current);
			const decision = decideFavoriteStartupSync(localFavorites, serverRows, localViews, serverViews);
			if (decision.kind === "same")
			{
				lastKnownServerSignatureRef.current = buildFavoritesBundleSignature(serverRows, serverViews);
				setHasUnsyncedLocalChanges(false);
				setSyncError(null);
				return;
			}
			if (decision.kind === "accept-server")
			{
				setFavorites(decision.favorites);
				persistLocalFavorites(decision.favorites);
				onMergeServerFavoriteViewsRef.current(decision.favoriteViews);
				lastKnownServerSignatureRef.current = buildFavoritesBundleSignature(decision.favorites, decision.favoriteViews);
				return;
			}
			setPendingConflict(decision.conflict);
		}
		catch
		{
			setIsServerAvailable(false);
			setSyncError("Could not sync favorites from server.");
		}
		finally
		{
			setIsSyncing(false);
		}
	}, [persistLocalFavorites]);

	useEffect(() =>
	{
		return () =>
		{
			if (saveTimerRef.current !== null)
			{
				window.clearTimeout(saveTimerRef.current);
			}
		};
	}, []);

	useEffect(() =>
	{
		void runStartupSync();
	}, [runStartupSync]);

	const flushBackendSave = useCallback(async (toSave: FavoriteEntry[]) =>
	{
		const snapshots = buildFavoriteViewsForSave(toSave, favoriteViewsForSyncRef.current);
		const signatureAtQueue = buildFavoritesBundleSignature(toSave, snapshots);
		try
		{
			await saveFavorites(toSave, snapshots);
			const currentSnaps = buildFavoriteViewsForSave(favoritesRef.current, favoriteViewsForSyncRef.current);
			if (buildFavoritesBundleSignature(favoritesRef.current, currentSnaps) === signatureAtQueue)
			{
				setHasUnsyncedLocalChanges(false);
				setSyncError(null);
				lastKnownServerSignatureRef.current = signatureAtQueue;
			}
		}
		catch
		{
			setHasUnsyncedLocalChanges(true);
			setSyncError("Could not save favorites to server.");
		}
	}, []);

	const scheduleBackendSave = useCallback(
		(nextFavorites: FavoriteEntry[]) =>
		{
			if (typeof window === "undefined")
			{
				return;
			}
			if (pendingConflictRef.current)
			{
				return;
			}
			if (!navigator.onLine || !isServerAvailableRef.current)
			{
				setHasUnsyncedLocalChanges(true);
				return;
			}
			latestForSaveRef.current = nextFavorites;
			if (saveTimerRef.current !== null)
			{
				window.clearTimeout(saveTimerRef.current);
			}
			saveTimerRef.current = window.setTimeout(() =>
			{
				saveTimerRef.current = null;
				void flushBackendSave(latestForSaveRef.current);
			}, SAVE_DEBOUNCE_MS);
		},
		[flushBackendSave],
	);

	const retryAfterOnline = useCallback(async () =>
	{
		if (!navigator.onLine || pendingConflictRef.current || !hasUnsyncedLocalChanges)
		{
			return;
		}
		setSyncError(null);
		try
		{
			const { favorites: serverRows, favoriteViews: serverViews } = await fetchFavorites();
			const localFavorites = favoritesRef.current;
			const localViews = buildFavoriteViewsForSave(localFavorites, favoriteViewsForSyncRef.current);
			const decision = decideFavoriteStartupSync(localFavorites, serverRows, localViews, serverViews);
			if (decision.kind === "same")
			{
				lastKnownServerSignatureRef.current = buildFavoritesBundleSignature(serverRows, serverViews);
				setHasUnsyncedLocalChanges(false);
				setSyncError(null);
				return;
			}
			if (decision.kind === "ask-user")
			{
				setPendingConflict(decision.conflict);
				return;
			}
			if (decision.kind === "accept-server")
			{
				setFavorites(decision.favorites);
				persistLocalFavorites(decision.favorites);
				onMergeServerFavoriteViewsRef.current(decision.favoriteViews);
				lastKnownServerSignatureRef.current = buildFavoritesBundleSignature(decision.favorites, decision.favoriteViews);
				setHasUnsyncedLocalChanges(false);
				return;
			}
			await flushBackendSave(localFavorites);
		}
		catch
		{
			setSyncError("Could not sync favorites after reconnect.");
		}
	}, [flushBackendSave, hasUnsyncedLocalChanges, persistLocalFavorites]);

	useEffect(() =>
	{
		function onOnline(): void
		{
			void retryAfterOnline();
		}
		window.addEventListener("online", onOnline);
		return () => window.removeEventListener("online", onOnline);
	}, [retryAfterOnline]);

	const getFavoritesForView = useCallback((viewId: string) =>
	{
		return favorites
			.filter((entry) => entry.viewId === viewId)
			.sort((left, right) => left.addedAt - right.addedAt);
	}, [favorites]);

	const addFavorite = useCallback(
		(viewId: string, source: FavoriteSource) =>
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
				persistLocalFavorites(next);
				scheduleBackendSave(next);
				return next;
			});
		},
		[persistLocalFavorites, scheduleBackendSave],
	);

	const updateFavorite = useCallback(
		(cardId: string, viewId: string, source: FavoriteSource) =>
		{
			setFavorites((prev) =>
			{
				const next = prev.map((entry) =>
					entry.cardId === cardId && entry.viewId === viewId ? { ...entry, source } : entry,
				);
				persistLocalFavorites(next);
				scheduleBackendSave(next);
				return next;
			});
		},
		[persistLocalFavorites, scheduleBackendSave],
	);

	const updateFavoritePosition = useCallback(
		(cardId: string, viewId: string, position: { x: number; y: number }) =>
		{
			setFavorites((prev) =>
			{
				const next = prev.map((entry) =>
					entry.cardId === cardId && entry.viewId === viewId ? { ...entry, position } : entry,
				);
				persistLocalFavorites(next);
				scheduleBackendSave(next);
				return next;
			});
		},
		[persistLocalFavorites, scheduleBackendSave],
	);

	const removeFavorite = useCallback(
		(cardId: string, viewId: string) =>
		{
			setFavorites((prev) =>
			{
				const next = prev.filter((entry) => !(entry.cardId === cardId && entry.viewId === viewId));
				persistLocalFavorites(next);
				scheduleBackendSave(next);
				return next;
			});
		},
		[persistLocalFavorites, scheduleBackendSave],
	);

	const removeFavoritesForView = useCallback(
		(viewId: string) =>
		{
			setFavorites((prev) =>
			{
				const next = prev.filter((entry) => entry.viewId !== viewId);
				persistLocalFavorites(next);
				scheduleBackendSave(next);
				return next;
			});
		},
		[persistLocalFavorites, scheduleBackendSave],
	);

	const isFavorited = useCallback(
		(cardId: string, viewId: string) =>
		{
			return favorites.some((entry) => entry.cardId === cardId && entry.viewId === viewId);
		},
		[favorites],
	);

	const getFavoriteViewIds = useCallback(
		(cardId: string) =>
		{
			return favorites.filter((entry) => entry.cardId === cardId).map((entry) => entry.viewId);
		},
		[favorites],
	);

	const acceptServerFavorites = useCallback(() =>
	{
		const conflict = pendingConflictRef.current;
		if (!conflict)
		{
			return;
		}
		setFavorites(conflict.serverFavorites);
		persistLocalFavorites(conflict.serverFavorites);
		onMergeServerFavoriteViewsRef.current(conflict.serverFavoriteViews);
		lastKnownServerSignatureRef.current = buildFavoritesBundleSignature(conflict.serverFavorites, conflict.serverFavoriteViews);
		setPendingConflict(null);
		setHasUnsyncedLocalChanges(false);
		setSyncError(null);
	}, [persistLocalFavorites]);

	const keepLocalFavorites = useCallback(async () =>
	{
		const conflict = pendingConflictRef.current;
		if (!conflict)
		{
			return;
		}
		setIsSavingConflictChoice(true);
		setSyncError(null);
		try
		{
			const snapshots = buildFavoriteViewsForSave(conflict.localFavorites, favoriteViewsForSyncRef.current);
			await saveFavorites(conflict.localFavorites, snapshots);
			lastKnownServerSignatureRef.current = buildFavoritesBundleSignature(conflict.localFavorites, snapshots);
			setPendingConflict(null);
			setHasUnsyncedLocalChanges(false);
		}
		catch
		{
			setSyncError("Could not upload local favorites to server.");
		}
		finally
		{
			setIsSavingConflictChoice(false);
		}
	}, []);

	const dismissSyncConflict = useCallback(() =>
	{
		setPendingConflict(null);
		setHasUnsyncedLocalChanges(true);
		setSyncError("Favorites differ from server. Use retry sync when you are ready.");
	}, []);

	const retryFavoriteSync = useCallback(() =>
	{
		setSyncError(null);
		void runStartupSync();
	}, [runStartupSync]);

	const clearStorageError = useCallback(() =>
	{
		setStorageError(null);
		setSyncError(null);
	}, []);

	return useMemo(
		() => ({
			favorites,
			storageError,
			syncError,
			isSyncing,
			isServerAvailable,
			hasUnsyncedLocalChanges,
			pendingConflict,
			isSavingConflictChoice,
			clearStorageError,
			getFavoritesForView,
			addFavorite,
			updateFavorite,
			updateFavoritePosition,
			removeFavorite,
			removeFavoritesForView,
			isFavorited,
			getFavoriteViewIds,
			acceptServerFavorites,
			keepLocalFavorites,
			dismissSyncConflict,
			retryFavoriteSync,
		}),
		[
			favorites,
			storageError,
			syncError,
			isSyncing,
			isServerAvailable,
			hasUnsyncedLocalChanges,
			pendingConflict,
			isSavingConflictChoice,
			clearStorageError,
			getFavoritesForView,
			addFavorite,
			updateFavorite,
			updateFavoritePosition,
			removeFavorite,
			removeFavoritesForView,
			isFavorited,
			getFavoriteViewIds,
			acceptServerFavorites,
			keepLocalFavorites,
			dismissSyncConflict,
			retryFavoriteSync,
		],
	);
}
