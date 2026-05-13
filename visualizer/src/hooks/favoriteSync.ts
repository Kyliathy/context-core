import type { FavoriteEntry, FavoriteSource, FavoriteViewSnapshot, ViewDefinition } from "../types";

/** Stable row identity for conflict detection. */
export function favoriteKey(entry: FavoriteEntry): string
{
	return `${entry.viewId}::${entry.cardId}`;
}

/** JSON snapshot of a FavoriteSource for equality checks. */
export function serializeFavoriteSource(source: FavoriteSource): string
{
	return JSON.stringify(source);
}

/** Deterministic signature for comparing two favorite lists regardless of Array order. */
export function buildFavoritesSignature(favorites: FavoriteEntry[]): string
{
	const sorted = [...favorites].sort((left, right) =>
	{
		if (left.viewId !== right.viewId) return left.viewId.localeCompare(right.viewId);
		if (left.cardId !== right.cardId) return left.cardId.localeCompare(right.cardId);
		return left.addedAt - right.addedAt;
	});
	return JSON.stringify(
		sorted.map((entry) => ({
			v: entry.viewId,
			c: entry.cardId,
			t: entry.addedAt,
			s: serializeFavoriteSource(entry.source),
			p:
				entry.position && Number.isFinite(entry.position.x) && Number.isFinite(entry.position.y)
					? { x: entry.position.x, y: entry.position.y }
					: null,
		})),
	);
}

/** Deterministic signature for favorites-type view metadata rows. */
export function buildFavoriteViewsSignature(views: FavoriteViewSnapshot[]): string
{
	const sorted = [...views].sort((left, right) => left.id.localeCompare(right.id));
	return JSON.stringify(
		sorted.map((row) => ({
			i: row.id,
			n: row.name,
			e: row.emoji,
			c: row.color,
			//All favorites tabs use CustomCardPositioning; legacy Auto in stored bundles must not fork signatures.
			p: "CustomCardPositioning" as const,
		})),
	);
}

/** Single signature covering both starred rows and their parent view labels (cross-machine safe). */
export function buildFavoritesBundleSignature(favorites: FavoriteEntry[], favoriteViews: FavoriteViewSnapshot[]): string
{
	return `${buildFavoritesSignature(favorites)}|v:${buildFavoriteViewsSignature(favoriteViews)}`;
}

/**
 * Builds the view snapshot list POSTed with favorites: every favorites-type tab plus any orphan viewIds from entries.
 * @param entries - Favorite rows about to be saved.
 * @param favoriteViews - Current favorites-type ViewDefinition rows from the visualizer.
 */
export function buildFavoriteViewsForSave(entries: FavoriteEntry[], favoriteViews: ViewDefinition[]): FavoriteViewSnapshot[]
{
	const byId = new Map<string, FavoriteViewSnapshot>();
	for (const view of favoriteViews)
	{
		if (view.type !== "favorites")
		{
			continue;
		}
		byId.set(view.id, {
			id: view.id,
			name: view.name,
			emoji: view.emoji,
			color: view.color,
			cardPositioningMode: "CustomCardPositioning",
		});
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
				cardPositioningMode: "CustomCardPositioning",
			});
		}
	}
	return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** Counts shown in the favorites sync conflict modal (global header). */
export type FavoriteConflictSummary = {
	localTotal: number;
	serverTotal: number;
	serverOnlyCount: number;
	localOnlyCount: number;
	removedByServerCount: number;
	changedCount: number;
};

/** One favorites-type view bucket inside the conflict modal scroll list. */
export type FavoritePerViewConflictRow = {
	viewId: string;
	displayName: string;
	localEntryCount: number;
	serverEntryCount: number;
	serverOnlyCount: number;
	localOnlyCount: number;
	changedCount: number;
	viewMetaLocal: FavoriteViewSnapshot | null;
	viewMetaServer: FavoriteViewSnapshot | null;
	viewMetaChanged: boolean;
};

/** Payload passed into the sync conflict modal. */
export type FavoriteSyncConflict = {
	localFavorites: FavoriteEntry[];
	serverFavorites: FavoriteEntry[];
	localFavoriteViews: FavoriteViewSnapshot[];
	serverFavoriteViews: FavoriteViewSnapshot[];
	summary: FavoriteConflictSummary;
	perView: FavoritePerViewConflictRow[];
};

/**
 * Builds human-readable diff counts between local and server favorite lists.
 * @param localFavorites - Current client list (usually from localStorage).
 * @param serverFavorites - List returned by GET /api/favorites.
 */
export function getFavoriteConflictSummary(
	localFavorites: FavoriteEntry[],
	serverFavorites: FavoriteEntry[],
): FavoriteConflictSummary
{
	const localMap = new Map<string, FavoriteEntry>();
	const serverMap = new Map<string, FavoriteEntry>();
	for (const entry of localFavorites) localMap.set(favoriteKey(entry), entry);
	for (const entry of serverFavorites) serverMap.set(favoriteKey(entry), entry);

	let serverOnlyCount = 0;
	let localOnlyCount = 0;
	let changedCount = 0;

	for (const key of serverMap.keys())
	{
		if (!localMap.has(key)) serverOnlyCount++;
	}

	for (const key of localMap.keys())
	{
		if (!serverMap.has(key)) localOnlyCount++;
	}

	for (const key of localMap.keys())
	{
		const localRow = localMap.get(key)!;
		const serverRow = serverMap.get(key);
		if (!serverRow) continue;
		const posLocal = localRow.position;
		const posServer = serverRow.position;
		const posEqual =
			(!posLocal && !posServer)
			|| (Boolean(posLocal) && Boolean(posServer) && posLocal!.x === posServer!.x && posLocal!.y === posServer!.y);
		if (
			localRow.addedAt !== serverRow.addedAt
			|| serializeFavoriteSource(localRow.source) !== serializeFavoriteSource(serverRow.source)
			|| !posEqual
		)
		{
			changedCount++;
		}
	}

	return {
		localTotal: localFavorites.length,
		serverTotal: serverFavorites.length,
		serverOnlyCount,
		localOnlyCount,
		removedByServerCount: localOnlyCount,
		changedCount,
	};
}

function viewMetaEqual(left: FavoriteViewSnapshot | null, right: FavoriteViewSnapshot | null): boolean
{
	if (!left && !right) return true;
	if (!left || !right) return false;
	return (
		left.name === right.name
		&& left.emoji === right.emoji
		&& left.color === right.color
	);
}

/**
 * Builds per-view delta rows for the conflict modal (one card per viewId in the union).
 * @param localFavorites - Offline cache rows.
 * @param serverFavorites - Server rows.
 * @param localFavoriteViews - Client-side favorites-type view metadata.
 * @param serverFavoriteViews - Server-stored view metadata.
 */
export function buildFavoritePerViewConflictRows(
	localFavorites: FavoriteEntry[],
	serverFavorites: FavoriteEntry[],
	localFavoriteViews: FavoriteViewSnapshot[],
	serverFavoriteViews: FavoriteViewSnapshot[],
): FavoritePerViewConflictRow[]
{
	const viewIds = new Set<string>();
	for (const entry of localFavorites) viewIds.add(entry.viewId);
	for (const entry of serverFavorites) viewIds.add(entry.viewId);
	for (const row of localFavoriteViews) viewIds.add(row.id);
	for (const row of serverFavoriteViews) viewIds.add(row.id);

	const localViewMap = new Map(localFavoriteViews.map((row) => [row.id, row]));
	const serverViewMap = new Map(serverFavoriteViews.map((row) => [row.id, row]));

	const sortedIds = [...viewIds].sort((left, right) => left.localeCompare(right));
	const rows: FavoritePerViewConflictRow[] = [];

	for (const viewId of sortedIds)
	{
		const localRows = localFavorites.filter((entry) => entry.viewId === viewId);
		const serverRows = serverFavorites.filter((entry) => entry.viewId === viewId);
		const summary = getFavoriteConflictSummary(localRows, serverRows);
		const vmLocal = localViewMap.get(viewId) ?? null;
		const vmServer = serverViewMap.get(viewId) ?? null;
		const displayName = vmLocal?.name ?? vmServer?.name ?? `View ${viewId.slice(0, 8)}`;
		const viewMetaChanged = !viewMetaEqual(vmLocal, vmServer);
		rows.push({
			viewId,
			displayName,
			localEntryCount: localRows.length,
			serverEntryCount: serverRows.length,
			serverOnlyCount: summary.serverOnlyCount,
			localOnlyCount: summary.localOnlyCount,
			changedCount: summary.changedCount,
			viewMetaLocal: vmLocal,
			viewMetaServer: vmServer,
			viewMetaChanged,
		});
	}

	return rows;
}

/** Returns true when a per-view row should appear in the scrollable delta list (hides identical quiet tabs). */
export function favoritePerViewRowHasDelta(row: FavoritePerViewConflictRow): boolean
{
	if (row.viewMetaChanged) return true;
	if (row.serverOnlyCount > 0 || row.localOnlyCount > 0 || row.changedCount > 0) return true;
	if (row.localEntryCount !== row.serverEntryCount) return true;
	if (Boolean(row.viewMetaLocal) !== Boolean(row.viewMetaServer)) return true;
	return false;
}

function buildConflict(
	localFavorites: FavoriteEntry[],
	serverFavorites: FavoriteEntry[],
	localFavoriteViews: FavoriteViewSnapshot[],
	serverFavoriteViews: FavoriteViewSnapshot[],
): FavoriteSyncConflict
{
	return {
		localFavorites,
		serverFavorites,
		localFavoriteViews,
		serverFavoriteViews,
		summary: getFavoriteConflictSummary(localFavorites, serverFavorites),
		perView: buildFavoritePerViewConflictRows(
			localFavorites,
			serverFavorites,
			localFavoriteViews,
			serverFavoriteViews,
		),
	};
}

/** Result of comparing local vs server favorites on startup or after reconnect. */
export type FavoriteStartupDecision =
	| { kind: "same" }
	| { kind: "accept-server"; favorites: FavoriteEntry[]; favoriteViews: FavoriteViewSnapshot[] }
	| { kind: "ask-user"; conflict: FavoriteSyncConflict };

/**
 * Decides how to reconcile localStorage favorites with the server list and view metadata.
 * @param localFavorites - Normalized list from localStorage.
 * @param serverFavorites - Rows from GET /api/favorites.
 * @param localFavoriteViews - Snapshots derived from the live favorites-type tabs.
 * @param serverFavoriteViews - Snapshots from the server bundle.
 */
export function decideFavoriteStartupSync(
	localFavorites: FavoriteEntry[],
	serverFavorites: FavoriteEntry[],
	localFavoriteViews: FavoriteViewSnapshot[],
	serverFavoriteViews: FavoriteViewSnapshot[],
): FavoriteStartupDecision
{
	const localBundle = buildFavoritesBundleSignature(localFavorites, localFavoriteViews);
	const serverBundle = buildFavoritesBundleSignature(serverFavorites, serverFavoriteViews);
	if (localBundle === serverBundle)
	{
		return { kind: "same" };
	}
	if (localFavorites.length === 0 && serverFavorites.length > 0)
	{
		return { kind: "accept-server", favorites: serverFavorites, favoriteViews: serverFavoriteViews };
	}
	return { kind: "ask-user", conflict: buildConflict(localFavorites, serverFavorites, localFavoriteViews, serverFavoriteViews) };
}
