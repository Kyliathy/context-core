/**
 * FavoriteEntry — persisted favorites snapshot rows for the visualizer.
 * Mirrors `visualizer/src/types.ts` shapes without importing the SPA.
 */

export type FavoriteSource =
	| { type: "message"; data: SerializedAgentMessage }
	| { type: "thread"; data: SerializedAgentThread };

/** Serialized message body stored inside a favorite snapshot. */
export type SerializedAgentMessage = {
	id: string;
	sessionId: string;
	harness: string;
	machine: string;
	role: string;
	model: string | null;
	message: string;
	subject: string;
	context: string[];
	symbols: string[];
	history: string[];
	tags: string[];
	project: string;
	parentId: string | null;
	tokenUsage: unknown;
	toolCalls: unknown[];
	rationale: string[];
	source: string;
	dateTime: string;
};

/** Serialized thread summary stored inside a favorite snapshot. */
export type SerializedAgentThread = {
	sessionId: string;
	subject: string;
	harness: string;
	project: string;
	messageCount: number;
	totalLength: number;
	firstDateTime: string;
	lastDateTime: string;
	firstMessage: string;
	matchingMessageIds: string[];
	bestMatchScore: number;
	hits: number;
};

/** Optional persisted map coordinates for CustomCardPositioning rows. */
export type FavoriteEntryPosition = {
	x: number;
	y: number;
};

/** One starred row in a favorites-type view. */
export type FavoriteEntry = {
	cardId: string;
	viewId: string;
	source: FavoriteSource;
	addedAt: number;
	position?: FavoriteEntryPosition;
};

/** How a favorites-type tab lays out cards (mirrors visualizer ViewDefinition). */
export type CardPositioningMode = "Auto" | "CustomCardPositioning";

/** Human-readable favorites view metadata stored beside rows so imports stay legible across machines. */
export type FavoriteViewSnapshot = {
	id: string;
	name: string;
	emoji: string;
	color: string;
	cardPositioningMode?: CardPositioningMode;
};

function isValidHexColor(value: string): boolean
{
	return /^#([0-9a-f]{6})$/i.test(value.trim());
}

/**
 * Validates and returns a FavoriteViewSnapshot, or null when the payload is invalid.
 * @param raw - Parsed JSON element from the HTTP body or favorites.json.
 */
export function normalizeFavoriteViewSnapshot(raw: unknown): FavoriteViewSnapshot | null
{
	if (!raw || typeof raw !== "object") return null;
	const row = raw as Record<string, unknown>;
	if (!isNonEmptyString(row.id)) return null;
	if (typeof row.name !== "string") return null;
	const name = row.name.trim().slice(0, 60);
	if (!name) return null;
	const emojiRaw = typeof row.emoji === "string" ? row.emoji.trim() : "";
	const emoji = Array.from(emojiRaw).slice(0, 2).join("") || "⭐";
	const colorRaw = typeof row.color === "string" ? row.color.trim().toLowerCase() : "";
	const color = isValidHexColor(colorRaw) ? colorRaw : "#f59e0b";
	const out: FavoriteViewSnapshot = { id: row.id, name, emoji, color };
	//Favorites-type tabs always use CustomCardPositioning in this version; coerce legacy Auto payloads from disk or POST.
	out.cardPositioningMode = "CustomCardPositioning";
	return out;
}

function isNonEmptyString(value: unknown): value is string
{
	return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is string[]
{
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isSerializedAgentMessage(value: unknown): value is SerializedAgentMessage
{
	if (!value || typeof value !== "object") return false;
	const row = value as Record<string, unknown>;
	return (
		isNonEmptyString(row.id) &&
		isNonEmptyString(row.sessionId) &&
		isNonEmptyString(row.harness) &&
		isNonEmptyString(row.machine) &&
		isNonEmptyString(row.role) &&
		(row.model === null || typeof row.model === "string") &&
		typeof row.message === "string" &&
		typeof row.subject === "string" &&
		isStringArray(row.context) &&
		isStringArray(row.symbols) &&
		isStringArray(row.history) &&
		isStringArray(row.tags) &&
		isNonEmptyString(row.project) &&
		(row.parentId === null || typeof row.parentId === "string") &&
		isStringArray(row.rationale) &&
		typeof row.source === "string" &&
		typeof row.dateTime === "string" &&
		Array.isArray(row.toolCalls)
	);
}

function isSerializedAgentThread(value: unknown): value is SerializedAgentThread
{
	if (!value || typeof value !== "object") return false;
	const row = value as Record<string, unknown>;
	return (
		isNonEmptyString(row.sessionId) &&
		typeof row.subject === "string" &&
		isNonEmptyString(row.harness) &&
		isNonEmptyString(row.project) &&
		typeof row.messageCount === "number" &&
		typeof row.totalLength === "number" &&
		typeof row.firstDateTime === "string" &&
		typeof row.lastDateTime === "string" &&
		typeof row.firstMessage === "string" &&
		isStringArray(row.matchingMessageIds) &&
		typeof row.bestMatchScore === "number" &&
		typeof row.hits === "number"
	);
}

function isFavoriteSource(value: unknown): value is FavoriteSource
{
	if (!value || typeof value !== "object") return false;
	const row = value as { type?: unknown; data?: unknown };
	if (row.type === "message" && isSerializedAgentMessage(row.data))
	{
		return true;
	}
	if (row.type === "thread" && isSerializedAgentThread(row.data))
	{
		return true;
	}
	return false;
}

/**
 * Validates and returns a FavoriteEntry, or null when the payload is invalid.
 * @param raw - Parsed JSON element from the HTTP body.
 */
export function normalizeFavoriteEntry(raw: unknown): FavoriteEntry | null
{
	if (!raw || typeof raw !== "object") return null;
	const row = raw as Record<string, unknown>;
	if (!isNonEmptyString(row.cardId) || !isNonEmptyString(row.viewId)) return null;
	if (typeof row.addedAt !== "number" || !Number.isFinite(row.addedAt)) return null;
	if (!isFavoriteSource(row.source)) return null;
	let position: FavoriteEntryPosition | undefined;
	const rawPos = row.position;
	if (rawPos && typeof rawPos === "object")
	{
		const pr = rawPos as Record<string, unknown>;
		if (typeof pr.x === "number" && Number.isFinite(pr.x) && typeof pr.y === "number" && Number.isFinite(pr.y))
		{
			position = { x: pr.x, y: pr.y };
		}
	}
	const out: FavoriteEntry = {
		cardId: row.cardId,
		viewId: row.viewId,
		source: row.source,
		addedAt: row.addedAt,
	};
	if (position !== undefined)
	{
		out.position = position;
	}
	return out;
}
