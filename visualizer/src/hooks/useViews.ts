import { useCallback, useMemo, useState } from "react";
import type { ViewDefinition, ViewType } from "../types";

const VIEWS_STORAGE_KEY = "ccv:views";
const ACTIVE_VIEW_STORAGE_KEY = "ccv:activeViewId";

const LATEST_CHATS_VIEW: ViewDefinition = {
	id: "built-in-latest",
	name: "Latest Threads",
	type: "latest",
	emoji: "🕒",
	color: "#0ea5e9",
	query: "",
	autoQuery: false,
	autoRefreshSeconds: 0,
	createdAt: 0,
};

const DEFAULT_SEARCH_VIEW: ViewDefinition = {
	id: "built-in-search",
	name: "Search Messages",
	type: "search",
	emoji: "🔎",
	color: "#3b82f6",
	query: "",
	autoQuery: false,
	autoRefreshSeconds: 0,
	createdAt: 1,
};

const DEFAULT_SEARCH_THREADS_VIEW: ViewDefinition = {
	id: "built-in-search-threads",
	name: "Search Threads",
	type: "search-threads",
	emoji: "🧵",
	color: "#8b5cf6",
	query: "",
	autoQuery: false,
	autoRefreshSeconds: 0,
	createdAt: 1.5,
};

const DEFAULT_FAVORITES_VIEW: ViewDefinition = {
	id: "built-in-favorites",
	name: "Favorites",
	type: "favorites",
	emoji: "⭐",
	color: "#f59e0b",
	query: "",
	autoQuery: false,
	autoRefreshSeconds: 0,
	createdAt: 2,
};

const AGENT_BUILDER_VIEW: ViewDefinition = {
	id: "built-in-agent-builder",
	name: "Agent Builder",
	type: "agent-builder",
	emoji: "🏗️",
	color: "#f97316",
	query: "",
	autoQuery: false,
	autoRefreshSeconds: 0,
	createdAt: 3,
};

const AGENT_LIST_VIEW: ViewDefinition = {
	id: "built-in-agent-list",
	name: "Agent List",
	type: "agent-list",
	emoji: "📋",
	color: "#f97316",
	query: "",
	autoQuery: false,
	autoRefreshSeconds: 0,
	createdAt: 4,
};

const TEMPLATE_CREATE_VIEW: ViewDefinition = {
	id: "built-in-template-create",
	name: "Create Template",
	type: "template-create",
	emoji: "📝",
	color: "#8b5cf6",
	query: "",
	autoQuery: false,
	autoRefreshSeconds: 0,
	createdAt: 5,
};

const TEMPLATE_LIST_VIEW: ViewDefinition = {
	id: "built-in-template-list",
	name: "Template List",
	type: "template-list",
	emoji: "📚",
	color: "#8b5cf6",
	query: "",
	autoQuery: false,
	autoRefreshSeconds: 0,
	createdAt: 6,
};

const VIEW_TYPE_DEFAULTS: Record<ViewType, { emoji: string; color: string }> = {
	search: { emoji: "🔎", color: "#3b82f6" },
	"search-threads": { emoji: "🧵", color: "#8b5cf6" },
	latest: { emoji: "🕒", color: "#0ea5e9" },
	favorites: { emoji: "⭐", color: "#f59e0b" },
	"agent-builder": { emoji: "🏗️", color: "#f97316" },
	"agent-list": { emoji: "📋", color: "#f97316" },
	"template-create": { emoji: "📝", color: "#8b5cf6" },
	"template-list": { emoji: "📚", color: "#8b5cf6" },
};

type UseViewsResult = {
	views: ViewDefinition[];
	activeViewId: string;
	activeView: ViewDefinition;
	storageError: string | null;
	clearStorageError: () => void;
	switchView: (id: string) => void;
	createView: (def: Omit<ViewDefinition, "id" | "createdAt">) => string;
	updateView: (id: string, patch: Partial<ViewDefinition>) => void;
	deleteView: (id: string) => void;
};

function clampRefreshSeconds(value: number): number
{
	if (value <= 0)
	{
		return 0;
	}
	return Math.max(5, Math.floor(value));
}

function isValidHexColor(value: string): boolean
{
	return /^#([0-9a-f]{6})$/i.test(value.trim());
}

function normalizeEmoji(value: string, type: ViewType): string
{
	const trimmed = value.trim();
	if (!trimmed)
	{
		return VIEW_TYPE_DEFAULTS[type].emoji;
	}
	return Array.from(trimmed).slice(0, 2).join("");
}

function normalizeView(view: ViewDefinition): ViewDefinition
{
	const type = view.type;
	const fallback = VIEW_TYPE_DEFAULTS[type] ?? VIEW_TYPE_DEFAULTS.search;
	const normalizedColor = typeof view.color === "string" && isValidHexColor(view.color) ? view.color.toLowerCase() : fallback.color;
	return {
		...view,
		name: view.name.trim().slice(0, 60),
		emoji: normalizeEmoji(view.emoji ?? fallback.emoji, type),
		color: normalizedColor,
		query: view.query ?? "",
		autoQuery: Boolean(view.autoQuery),
		autoRefreshSeconds: clampRefreshSeconds(Number(view.autoRefreshSeconds ?? 0)),
		projects: Array.isArray(view.projects) ? view.projects : [],
	};
}

function seedViews(): ViewDefinition[]
{
	return [LATEST_CHATS_VIEW, DEFAULT_SEARCH_VIEW, DEFAULT_SEARCH_THREADS_VIEW, DEFAULT_FAVORITES_VIEW, AGENT_BUILDER_VIEW, AGENT_LIST_VIEW, TEMPLATE_CREATE_VIEW, TEMPLATE_LIST_VIEW];
}

function safeReadViews(): ViewDefinition[]
{
	if (typeof window === "undefined")
	{
		return seedViews();
	}

	try
	{
		const raw = window.localStorage.getItem(VIEWS_STORAGE_KEY);
		if (!raw)
		{
			return seedViews();
		}

		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed))
		{
			return seedViews();
		}

		const incoming = parsed.filter((item): item is Partial<ViewDefinition> =>
		{
			if (!item || typeof item !== "object")
			{
				return false;
			}
			const candidate = item as Partial<ViewDefinition> & { type?: unknown };
			return typeof candidate.id === "string" && typeof candidate.name === "string" && ["search", "search-threads", "latest", "favorites", "agent-builder", "agent-list", "template-create", "template-list"].includes(String(candidate.type));
		});

		const userViews = incoming
			.filter((view) => view.id !== LATEST_CHATS_VIEW.id && view.id !== DEFAULT_SEARCH_VIEW.id && view.id !== DEFAULT_SEARCH_THREADS_VIEW.id && view.id !== DEFAULT_FAVORITES_VIEW.id && view.id !== AGENT_BUILDER_VIEW.id && view.id !== AGENT_LIST_VIEW.id && view.id !== TEMPLATE_CREATE_VIEW.id && view.id !== TEMPLATE_LIST_VIEW.id)
			.map((view) => normalizeView({
				id: view.id as string,
				name: view.name as string,
				type: view.type as ViewType,
				emoji: (view.emoji as string | undefined) ?? "",
				color: (view.color as string | undefined) ?? "",
				query: (view.query as string | undefined) ?? "",
				autoQuery: Boolean(view.autoQuery),
				autoRefreshSeconds: Number(view.autoRefreshSeconds ?? 0),
				createdAt: Number(view.createdAt ?? Date.now()),
				projects: Array.isArray(view.projects) ? view.projects : [],
			}));
		return [LATEST_CHATS_VIEW, normalizeView(DEFAULT_SEARCH_VIEW), normalizeView(DEFAULT_SEARCH_THREADS_VIEW), normalizeView(DEFAULT_FAVORITES_VIEW), AGENT_BUILDER_VIEW, AGENT_LIST_VIEW, TEMPLATE_CREATE_VIEW, TEMPLATE_LIST_VIEW, ...userViews].sort((left, right) => left.createdAt - right.createdAt);
	}
	catch
	{
		console.warn("[views] Failed to parse ccv:views. Falling back to defaults.");
		return seedViews();
	}
}

function safeReadActiveViewId(views: ViewDefinition[]): string
{
	if (typeof window === "undefined")
	{
		return LATEST_CHATS_VIEW.id;
	}

	try
	{
		const raw = window.localStorage.getItem(ACTIVE_VIEW_STORAGE_KEY);
		if (!raw)
		{
			return LATEST_CHATS_VIEW.id;
		}
		const exists = views.some((view) => view.id === raw);
		return exists ? raw : LATEST_CHATS_VIEW.id;
	}
	catch
	{
		console.warn("[views] Failed to parse ccv:activeViewId. Falling back to default view.");
		return LATEST_CHATS_VIEW.id;
	}
}

export function useViews(): UseViewsResult
{
	const [views, setViews] = useState<ViewDefinition[]>(() => safeReadViews());
	const [activeViewId, setActiveViewId] = useState<string>(() => safeReadActiveViewId(safeReadViews()));
	const [storageError, setStorageError] = useState<string | null>(null);

	const persistViews = useCallback((nextViews: ViewDefinition[]) =>
	{
		if (typeof window === "undefined")
		{
			return;
		}
		try
		{
			window.localStorage.setItem(VIEWS_STORAGE_KEY, JSON.stringify(nextViews));
		}
		catch
		{
			setStorageError("Could not save views to localStorage.");
		}
	}, []);

	const persistActiveView = useCallback((id: string) =>
	{
		if (typeof window === "undefined")
		{
			return;
		}
		try
		{
			window.localStorage.setItem(ACTIVE_VIEW_STORAGE_KEY, id);
		}
		catch
		{
			setStorageError("Could not save active view to localStorage.");
		}
	}, []);

	const switchView = useCallback((id: string) =>
	{
		setActiveViewId(id);
		persistActiveView(id);
	}, [persistActiveView]);

	const createView = useCallback((def: Omit<ViewDefinition, "id" | "createdAt">) =>
	{
		const now = Date.now();
		const id = crypto.randomUUID();
		const next: ViewDefinition = normalizeView({
			...def,
			id,
			createdAt: now,
		});
		setViews((prev) =>
		{
			const nextViews = [...prev, next].sort((left, right) => left.createdAt - right.createdAt);
			persistViews(nextViews);
			return nextViews;
		});
		setActiveViewId(id);
		persistActiveView(id);
		return id;
	}, [persistActiveView, persistViews]);

	const updateView = useCallback((id: string, patch: Partial<ViewDefinition>) =>
	{
		setViews((prev) =>
		{
			const nextViews = prev.map((view) =>
			{
				if (view.id !== id)
				{
					return view;
				}
				return normalizeView({ ...view, ...patch });
			});
			persistViews(nextViews);
			return nextViews;
		});
	}, [persistViews]);

	const deleteView = useCallback((id: string) =>
	{
		if (id === LATEST_CHATS_VIEW.id || id === DEFAULT_SEARCH_VIEW.id || id === DEFAULT_SEARCH_THREADS_VIEW.id || id === DEFAULT_FAVORITES_VIEW.id || id === AGENT_BUILDER_VIEW.id || id === AGENT_LIST_VIEW.id || id === TEMPLATE_CREATE_VIEW.id || id === TEMPLATE_LIST_VIEW.id)
		{
			return;
		}

		setViews((prev) =>
		{
			const nextViews = prev.filter((view) => view.id !== id);
			persistViews(nextViews);
			return nextViews;
		});

		setActiveViewId((prev) =>
		{
			if (prev !== id)
			{
				return prev;
			}
			persistActiveView(LATEST_CHATS_VIEW.id);
			return LATEST_CHATS_VIEW.id;
		});
	}, [persistActiveView, persistViews]);

	const activeView = useMemo(() => views.find((view) => view.id === activeViewId) ?? LATEST_CHATS_VIEW, [activeViewId, views]);

	const clearStorageError = useCallback(() => setStorageError(null), []);

	return {
		views,
		activeViewId,
		activeView,
		storageError,
		clearStorageError,
		switchView,
		createView,
		updateView,
		deleteView,
	};
}

export { DEFAULT_SEARCH_VIEW, DEFAULT_SEARCH_THREADS_VIEW, DEFAULT_FAVORITES_VIEW, LATEST_CHATS_VIEW, AGENT_BUILDER_VIEW, AGENT_LIST_VIEW, TEMPLATE_LIST_VIEW, VIEW_TYPE_DEFAULTS };
