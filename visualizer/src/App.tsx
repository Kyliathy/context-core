/**
 * App.tsx — Top-level orchestration component.
 *
 * The single integration point for the entire visualizer SPA. Responsibilities:
 *   - Mounts all custom hooks (useViews, useFavorites, useSearch, useSearchHistory).
 *   - Wires hook outputs to child components via props.
 *   - Owns all modal open/close state (EditResultsView, FavoritesPickerDialog,
 *     ChatViewDialog, FilterDialog).
 *   - Dispatches D3 engine events (hover, viewport-change, line-click, card-star,
 *     title-click) into the appropriate state or hook calls.
 *   - Runs the auto-refresh interval for search views.
 *   - Derives filteredCards via useMemo (role + minScore filter applied here).
 *
 * Docs: zz-reach2/architecture/ui/archi-context-core-ui.md §2
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import SearchBar from "./components/searchTools/SearchBar";
import ChatMap from "./components/searchView/ChatMap";
import {
	fetchAgentBuilderPrepare,
	fetchAgentBuilderCreate,
	fetchAgentBuilderGetAgent,
	fetchAgentBuilderAddTemplate,
	fetchAgentBuilderGetFileContent,
} from "./api/search";
import HoverPanel from "./components/searchTools/HoverPanel";
import StatusBar from "./components/searchTools/StatusBar";
import ClipboardBasket from "./components/searchView/ClipboardBasket";
import AgentBasket from "./components/agentBuilder/AgentBuilder";
import EditResultsView from "./components/searchView/EditResultsView";
import AddFavoriteMessage, { type CustomTextInitial } from "./components/favorites/AddFavoriteMessage";
import FavoritesPickerDialog from "./components/favorites/FavoritesPickerDialog";
import ChatViewDialog from "./components/searchView/ChatViewDialog";
import ContentFileDialog from "./components/agentBuilder/ContentFileDialog";
import FilterDialog from "./components/searchTools/FilterDialog";
import { useViews, VIEW_TYPE_DEFAULTS, AGENT_LIST_VIEW, TEMPLATE_LIST_VIEW } from "./hooks/useViews";
import { useFavorites } from "./hooks/useFavorites";
import { useSearch } from "./hooks/useSearch";
import { useSearchHistory } from "./hooks/useSearchHistory";
import { useOnlineStatus } from "./hooks/useOnlineStatus";
import { useScopes } from "./hooks/useScopes";
import { groupIntoMasterCards } from "./d3/grouping";
import UpdatePrompt from "./components/UpdatePrompt";
import type {
	HoverEventDetail,
	ViewportChangeDetail,
	LineClickEventDetail,
	BasketLine,
	CardStarEventDetail,
	ViewDefinition,
	TitleClickEventDetail,
	AgentRole,
	FilterState,
	AgentKnowledgeEntry,
	CreateAgentInput,
	CardAddKnowledgeEventDetail,
	CardEditAgentEventDetail,
	CardUseTemplateEventDetail,
} from "./types";
import "./App.css";

const HOVER_PANEL_MAX_ZOOM = 1.0;

function lodFromZoom(k: number): string {
	if (k < 0.7) {
		return "minimal";
	}
	if (k < 1.2) {
		return "summary";
	}
	if (k < 2.5) {
		return "medium";
	}
	return "full";
}

type DateRangePreset =
	| "all"
	| "last-week"
	| "last-2-weeks"
	| "last-3-weeks"
	| "last-month"
	| "last-6-weeks"
	| "last-2-months"
	| "last-3-months"
	| "last-4-months"
	| "last-5-months"
	| "last-6-months"
	| "last-year"
	| "last-18-months"
	| "last-2-years"
	| "last-3-years"
	| "custom";

const VALID_DATE_PRESETS: ReadonlySet<string> = new Set<DateRangePreset>([
	"all",
	"last-week",
	"last-2-weeks",
	"last-3-weeks",
	"last-month",
	"last-6-weeks",
	"last-2-months",
	"last-3-months",
	"last-4-months",
	"last-5-months",
	"last-6-months",
	"last-year",
	"last-18-months",
	"last-2-years",
	"last-3-years",
	"custom",
]);

function toIsoDate(value: Date): string {
	const year = value.getFullYear();
	const month = String(value.getMonth() + 1).padStart(2, "0");
	const day = String(value.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function shiftDate(base: Date, unit: "weeks" | "months" | "years", amount: number): Date {
	const copy = new Date(base);
	if (unit === "weeks") {
		copy.setDate(copy.getDate() - amount * 7);
		return copy;
	}
	if (unit === "months") {
		copy.setMonth(copy.getMonth() - amount);
		return copy;
	}
	copy.setFullYear(copy.getFullYear() - amount);
	return copy;
}

function resolveFromDate(preset: DateRangePreset, customSinceDate: string): string {
	if (preset === "all") {
		return "";
	}

	if (preset === "custom") {
		return customSinceDate;
	}

	const now = new Date();
	const mapping: Record<Exclude<DateRangePreset, "custom" | "all">, Date> = {
		"last-week": shiftDate(now, "weeks", 1),
		"last-2-weeks": shiftDate(now, "weeks", 2),
		"last-3-weeks": shiftDate(now, "weeks", 3),
		"last-month": shiftDate(now, "months", 1),
		"last-6-weeks": shiftDate(now, "weeks", 6),
		"last-2-months": shiftDate(now, "months", 2),
		"last-3-months": shiftDate(now, "months", 3),
		"last-4-months": shiftDate(now, "months", 4),
		"last-5-months": shiftDate(now, "months", 5),
		"last-6-months": shiftDate(now, "months", 6),
		"last-year": shiftDate(now, "years", 1),
		"last-18-months": shiftDate(now, "months", 18),
		"last-2-years": shiftDate(now, "years", 2),
		"last-3-years": shiftDate(now, "years", 3),
	};

	return toIsoDate(mapping[preset]);
}

/** Find the next unreplaced placeholder entry ID after the given index. Wraps around. */
function findNextPlaceholderId(entries: AgentKnowledgeEntry[], afterIndex: number): string | null {
	for (let i = afterIndex + 1; i < entries.length; i++) {
		if (entries[i].kind === "placeholder") return entries[i].id;
	}
	for (let i = 0; i <= afterIndex; i++) {
		if (entries[i].kind === "placeholder") return entries[i].id;
	}
	return null;
}

export default function App() {
	const searchInputRef = useRef<HTMLInputElement>(null);
	const {
		views,
		activeViewId,
		activeView,
		storageError: viewStorageError,
		clearStorageError: clearViewStorageError,
		switchView,
		createView,
		updateView,
		deleteView,
	} = useViews();
	const {
		favorites,
		storageError: favoritesStorageError,
		clearStorageError: clearFavoritesStorageError,
		getFavoritesForView,
		addFavorite,
		updateFavorite,
		removeFavorite,
		removeFavoritesForView,
		isFavorited,
		getFavoriteViewIds,
	} = useFavorites();
	const favoritesForActiveView = useMemo(() => getFavoritesForView(activeViewId), [activeViewId, getFavoritesForView]);
	const [searchInputValue, setSearchInputValue] = useState(activeView.type === "search-threads" ? "" : activeView.query);
	const [dateRangePreset, setDateRangePreset] = useState<DateRangePreset>(() => {
		try {
			const stored = window.localStorage.getItem("cxc-search-date-preset");
			if (stored && VALID_DATE_PRESETS.has(stored)) return stored as DateRangePreset;
		} catch {}
		return "last-3-months";
	});
	const [customSinceDate, setCustomSinceDate] = useState(() => {
		try {
			const stored = window.localStorage.getItem("cxc-search-custom-since");
			if (stored) return stored;
		} catch {}
		return toIsoDate(shiftDate(new Date(), "months", 3));
	});
	const [latestLimit, setLatestLimit] = useState<number>(() => {
		try {
			const stored = window.localStorage.getItem("cxc-search-limit");
			if (stored) {
				const parsed = parseInt(stored, 10);
				if (!isNaN(parsed) && parsed > 0) return parsed;
			}
		} catch {}
		return 100;
	});
	const [localFilterText, setLocalFilterText] = useState<string>("");

	const { query, cards, threadCards, searchResetToken, isLoading, error, latencyMs, hasSearched, search, clearError, clearResults } = useSearch(
		{
			activeView,
			favoritesForActiveView,
			fromDate: resolveFromDate(dateRangePreset, customSinceDate),
			limit: latestLimit,
		},
	);

	const { history: searchHistory, addToHistory, clearHistory, removeFromHistory, getMatches } = useSearchHistory();
	const { isOnline } = useOnlineStatus();
	const { scopes, setScopes } = useScopes();
	const [pendingSearch, setPendingSearch] = useState<string | null>(null);
	const [filterRoles, setFilterRoles] = useState<Set<AgentRole>>(new Set(["user", "assistant", "tool", "system"]));
	const [filterMinScore, setFilterMinScore] = useState(0);
	const [agentBuilderSelectedSources, setAgentBuilderSelectedSources] = useState<Set<string>>(() => {
		try {
			const raw = window.localStorage.getItem("cxc-agent-sources");
			if (raw) return new Set<string>(JSON.parse(raw));
		} catch {}
		return new Set<string>();
	});

	// Agent-builder source + text filter (client-side, no server call)
	const agentBuilderFilteredCards = useMemo(() => {
		if (activeView.type !== "agent-builder" && activeView.type !== "agent-list" && activeView.type !== "template-list") {
			return cards;
		}
		return cards.filter((card) => {
			// Source filter (only for agent-builder, not agent-list)
			// empty set = none selected — nothing passes
			if (activeView.type === "agent-builder" && !agentBuilderSelectedSources.has(card.project)) {
				return false;
			}
			// Text search
			const q = searchInputValue.trim().toLowerCase();
			if (q) {
				if (activeView.type === "template-list") {
					return card.title.toLowerCase().includes(q) || card.excerptShort.toLowerCase().includes(q);
				}
				return card.title.toLowerCase().includes(q) || card.excerptLong.toLowerCase().includes(q);
			}
			return true;
		});
	}, [activeView.type, cards, agentBuilderSelectedSources, searchInputValue]);

	// Filter logic
	const filteredCards = useMemo(() => {
		return agentBuilderFilteredCards.filter((card) => {
			if (!filterRoles.has(card.role)) {
				return false;
			}
			if (card.score < filterMinScore) {
				return false;
			}
			return true;
		});
	}, [agentBuilderFilteredCards, filterRoles, filterMinScore]);

	const locallyFilteredCards = useMemo(() => {
		if (!localFilterText.trim()) return filteredCards;
		const q = localFilterText.toLowerCase();
		return filteredCards.filter((card) => {
			return (
				card.title.toLowerCase().includes(q) ||
				card.excerptShort.toLowerCase().includes(q) ||
				card.excerptMedium.toLowerCase().includes(q) ||
				card.excerptLong.toLowerCase().includes(q)
			);
		});
	}, [filteredCards, localFilterText]);

	const locallyFilteredThreadCards = useMemo(() => {
		if (!localFilterText.trim()) return threadCards;
		const q = localFilterText.toLowerCase();
		return threadCards.filter((thread) => {
			return thread.title.toLowerCase().includes(q) || thread.project.toLowerCase().includes(q);
		});
	}, [threadCards, localFilterText]);

	const masterCards = useMemo(() => {
		const groupableTypes = new Set(["latest", "search-threads", "search"]);
		if (!groupableTypes.has(activeView.type)) return [];
		if (locallyFilteredCards.length === 0 && locallyFilteredThreadCards.length === 0) return [];
		return groupIntoMasterCards(locallyFilteredCards, locallyFilteredThreadCards, scopes);
	}, [locallyFilteredCards, locallyFilteredThreadCards, scopes, activeView.type]);

	const availableRoles = useMemo(() => {
		const rolesSet = new Set<AgentRole>();
		cards.forEach((card) => rolesSet.add(card.role));
		return Array.from(rolesSet).sort();
	}, [cards]);

	const hasActiveFilters = useMemo(() => {
		return filterRoles.size < 4 || filterMinScore > 0;
	}, [filterRoles, filterMinScore]);
	const [dialogMode, setDialogMode] = useState<"add" | "edit">("add");
	const [isEditResultsViewOpen, setIsEditResultsViewOpen] = useState(false);
	const [isAddFavoriteMessageOpen, setIsAddFavoriteMessageOpen] = useState(false);
	const [editingCustomCardId, setEditingCustomCardId] = useState<string | null>(null);
	const [isFavoritesPickerOpen, setIsFavoritesPickerOpen] = useState(false);
	const [chatViewTarget, setChatViewTarget] = useState<{ sessionId: string; messageId: string } | null>(null);
	const [pendingStarDetail, setPendingStarDetail] = useState<CardStarEventDetail | null>(null);
	const [editingView, setEditingView] = useState<ViewDefinition | undefined>(undefined);
	const [hoverDetail, setHoverDetail] = useState<HoverEventDetail | null>(null);
	const [viewport, setViewport] = useState<ViewportChangeDetail>({ x: 0, y: 0, k: 1 });
	const [basketLines, setBasketLines] = useState<BasketLine[]>([]);
	const [isFilterDialogOpen, setIsFilterDialogOpen] = useState(false);
	const [agentBuilderSources, setAgentBuilderSources] = useState<{ name: string; fileCount: number }[]>([]);
	const [agentKnowledgeEntries, setAgentKnowledgeEntries] = useState<AgentKnowledgeEntry[]>([]);
	const [isCreatingAgent, setIsCreatingAgent] = useState(false);
	const [agentCreateError, setAgentCreateError] = useState<string | null>(null);
	const [agentCreateSuccess, setAgentCreateSuccess] = useState<string | null>(null);
	const [agentFlashId, setAgentFlashId] = useState<string | null>(null);
	const [editingAgentPath, setEditingAgentPath] = useState<string | null>(null);
	const [agentEditInitial, setAgentEditInitial] = useState<{
		projectName: string;
		agentName: string;
		description: string;
		hint: string;
		tools: string;
		platform?: "github" | "claude";
	} | null>(null);
	const [isFromTemplate, setIsFromTemplate] = useState(false);
	const [activePlaceholderId, setActivePlaceholderId] = useState<string | null>(null);
	const [contentFileTarget, setContentFileTarget] = useState<{
		absolutePath: string;
		relativePath: string;
		sourceName: string;
	} | null>(null);
	const [importedTools, setImportedTools] = useState<string[]>([]);

	// Derive basket mode from active view + template state
	const basketMode: "agent" | "template" | "agent-from-template" =
		activeView.type === "template-create"
			? "template"
			: isFromTemplate && activeView.type === "agent-builder"
				? "agent-from-template"
				: "agent";
	const handleHover = useCallback((detail: HoverEventDetail) => setHoverDetail(detail), []);
	const handleViewportChange = useCallback((detail: ViewportChangeDetail) => setViewport(detail), []);

	const handleLineClick = useCallback((detail: LineClickEventDetail) => {
		const id = `${detail.cardId}-${detail.lineIndex}-${Date.now()}`;
		setBasketLines((prev) => [...prev, { id, text: detail.text, cardId: detail.cardId, addedAt: Date.now() }]);
	}, []);

	const handleBasketRemove = useCallback((id: string) => {
		setBasketLines((prev) => prev.filter((l) => l.id !== id));
	}, []);

	const handleBasketClear = useCallback(() => {
		setBasketLines([]);
	}, []);

	const handleBasketSendToBuilder = useCallback(() => {
		const now = Date.now();
		setAgentKnowledgeEntries(
			basketLines.map((line, index) => ({
				id: `ak-clipboard-${line.id}-${index}`,
				value: line.text,
				kind: "custom" as const,
				addedAt: now + index,
			})),
		);
		setAgentCreateError(null);
		setAgentCreateSuccess(null);
		setEditingAgentPath(null);
		setAgentEditInitial(null);
		setIsFromTemplate(false);
		setActivePlaceholderId(null);
		switchView("built-in-agent-builder");
	}, [basketLines, switchView]);

	const handleBasketMoveUp = useCallback((id: string) => {
		setBasketLines((prev) => {
			const index = prev.findIndex((l) => l.id === id);
			if (index <= 0) return prev;
			const newLines = [...prev];
			[newLines[index - 1], newLines[index]] = [newLines[index], newLines[index - 1]];
			return newLines;
		});
	}, []);

	const handleBasketMoveDown = useCallback((id: string) => {
		setBasketLines((prev) => {
			const index = prev.findIndex((l) => l.id === id);
			if (index < 0 || index >= prev.length - 1) return prev;
			const newLines = [...prev];
			[newLines[index], newLines[index + 1]] = [newLines[index + 1], newLines[index]];
			return newLines;
		});
	}, []);

	const favoriteViews = useMemo(
		() => views.filter((view) => view.type === "favorites").sort((left, right) => left.createdAt - right.createdAt),
		[views],
	);

	const starredCardIds = useMemo(() => {
		if (activeView.type === "favorites") {
			return new Set(favoritesForActiveView.map((entry) => entry.cardId));
		}
		return new Set(favorites.map((entry) => entry.cardId));
	}, [activeView.type, favorites, favoritesForActiveView]);

	useEffect(() => {
		setSearchInputValue(activeView.type === "search-threads" ? "" : activeView.query);
		setLocalFilterText("");
		clearResults();
		setHoverDetail(null);
	}, [activeView.id, activeView.query, activeView.type, clearResults]);

	useEffect(() => {
		if (activeView.type === "search" || activeView.type === "search-threads") {
			if (activeView.autoQuery) {
				search(activeView.query);
			}
			return;
		}
		if (activeView.type === "latest") {
			search(activeView.query);
			return;
		}
	}, [
		activeView.id,
		activeView.type,
		activeView.query,
		activeView.autoQuery,
		search,
		latestLimit,
	]);

	// Re-run search when date range changes (for search/search-threads, regardless of autoQuery)
	const dateKey = `${dateRangePreset}|${customSinceDate}`;
	const prevDateKeyRef = useRef(dateKey);
	useEffect(() => {
		if (dateKey === prevDateKeyRef.current) return;
		prevDateKeyRef.current = dateKey;
		if (activeView.type === "search" || activeView.type === "search-threads") {
			search(activeView.query);
		}
	}, [dateKey, activeView.type, activeView.query, search]);

	// Auto-fetch for other built-in views that don't depend on date/limit
	useEffect(() => {
		if (
			activeView.type === "search" ||
			activeView.type === "search-threads" ||
			activeView.type === "latest" ||
			activeView.type === "template-create"
		) {
			return;
		}
		search(activeView.query);
	}, [activeView.id, activeView.type, activeView.query, search]);

	useEffect(() => {
		if (activeView.type !== "search") {
			return;
		}
		if (activeView.autoRefreshSeconds <= 0) {
			return;
		}

		const refreshSeconds = Math.max(5, activeView.autoRefreshSeconds);
		const timer = window.setInterval(() => {
			search(activeView.query);
		}, refreshSeconds * 1000);

		return () => {
			window.clearInterval(timer);
		};
	}, [activeView.id, activeView.type, activeView.query, activeView.autoRefreshSeconds, search]);

	const favoritesSignature = useMemo(
		() => favoritesForActiveView.map((entry) => `${entry.cardId}:${entry.addedAt}`).join("|"),
		[favoritesForActiveView],
	);

	useEffect(() => {
		if (activeView.type === "favorites") {
			search(activeView.query);
		}
	}, [activeView.id, activeView.type, activeView.query, favoritesSignature, search]);

	useEffect(() => {
		if (pendingSearch !== null) {
			search(pendingSearch);
			setPendingSearch(null);
		}
	}, [pendingSearch, search]);

	const handleSearch = useCallback(
		(value: string) => {
			// Agent-builder/list and template-list use client-side filtering — no server round-trip
			if (activeView.type === "agent-builder" || activeView.type === "agent-list" || activeView.type === "template-list") {
				setSearchInputValue(value);
				requestAnimationFrame(() => {
					searchInputRef.current?.focus();
				});
				return;
			}
			if (activeView.type !== "search" && activeView.type !== "search-threads") {
				return;
			}
			const trimmed = value.trim();
			if (trimmed) {
				addToHistory(trimmed);
			}
			if (activeView.type === "search") {
				updateView(activeView.id, { query: value });
			}
			search(value);
			requestAnimationFrame(() => {
				searchInputRef.current?.focus();
			});
		},
		[activeView.id, activeView.type, addToHistory, search, updateView],
	);

	const handleSearchInputChange = useCallback((value: string) => {
		setSearchInputValue(value);
	}, []);

	const handleDateRangeChange = useCallback((value: string) => {
		setDateRangePreset(value as DateRangePreset);
	}, []);

	const handleCustomSinceDateChange = useCallback((value: string) => {
		setCustomSinceDate(value);
	}, []);

	const handleAddView = useCallback(() => {
		setDialogMode("add");
		setEditingView(undefined);
		setIsEditResultsViewOpen(true);
	}, []);

	const handleEditView = useCallback(() => {
		if (activeView.id === "built-in-latest") {
			return;
		}
		setDialogMode("edit");
		setEditingView(activeView);
		setIsEditResultsViewOpen(true);
	}, [activeView]);

	const closeEditResultsView = useCallback(() => {
		setIsEditResultsViewOpen(false);
		setEditingView(undefined);
	}, []);

	const handleSaveView = useCallback(
		(payload: {
			name: string;
			type: import("./types").ViewType;
			emoji: string;
			color: string;
			query: string;
			autoQuery: boolean;
			autoRefreshSeconds: number;
			projects: import("./types").SelectedProject[];
		}) => {
			if (dialogMode === "add") {
				createView({
					name: payload.name,
					type: payload.type,
					emoji: payload.emoji,
					color: payload.color,
					query: payload.type === "search" ? payload.query : "",
					autoQuery: payload.type === "search" ? payload.autoQuery : false,
					autoRefreshSeconds: payload.type === "search" ? payload.autoRefreshSeconds : 0,
					projects: payload.projects,
				});
			} else if (editingView) {
				updateView(editingView.id, {
					name: payload.name,
					type: payload.type,
					emoji: payload.emoji,
					color: payload.color,
					query: payload.type === "search" ? payload.query : "",
					autoQuery: payload.type === "search" ? payload.autoQuery : false,
					autoRefreshSeconds: payload.type === "search" ? payload.autoRefreshSeconds : 0,
					projects: payload.projects,
				});
			}
			if (payload.type === "search") {
				setPendingSearch(payload.query);
			}
			closeEditResultsView();
		},
		[closeEditResultsView, createView, dialogMode, editingView, updateView],
	);

	const handleDeleteView = useCallback(() => {
		if (!editingView) {
			return;
		}
		if (editingView.type === "favorites") {
			removeFavoritesForView(editingView.id);
		}
		deleteView(editingView.id);
		closeEditResultsView();
	}, [closeEditResultsView, deleteView, editingView, removeFavoritesForView]);

	// Fetch agent builder sources once on mount for the dropdown preview
	useEffect(() => {
		fetchAgentBuilderPrepare()
			.then((prepared) => {
				setAgentBuilderSources(prepared.sources.map((s) => ({ name: s.name, fileCount: s.fileCount })));
			})
			.catch(() => {
				// Server not yet updated or no sources — leave empty, dropdown shows "No data sources configured"
			});
	}, []);

	// Reconcile source selection when server sources arrive
	useEffect(() => {
		if (agentBuilderSources.length === 0) return;
		const serverNames = new Set(agentBuilderSources.map((s) => s.name));
		setAgentBuilderSelectedSources((prev) => {
			// Fresh load with no localStorage value — select all
			if (prev.size === 0) return serverNames;
			// Otherwise intersect stored selection with valid server names
			const next = new Set([...prev].filter((n) => serverNames.has(n)));
			return next;
		});
	}, [agentBuilderSources]);

	// Persist source selection to localStorage
	useEffect(() => {
		try {
			window.localStorage.setItem("cxc-agent-sources", JSON.stringify([...agentBuilderSelectedSources]));
		} catch {}
	}, [agentBuilderSelectedSources]);

	// Persist search bar settings to localStorage
	useEffect(() => {
		try {
			window.localStorage.setItem("cxc-search-date-preset", dateRangePreset);
		} catch {}
	}, [dateRangePreset]);

	useEffect(() => {
		try {
			window.localStorage.setItem("cxc-search-custom-since", customSinceDate);
		} catch {}
	}, [customSinceDate]);

	useEffect(() => {
		try {
			window.localStorage.setItem("cxc-search-limit", String(latestLimit));
		} catch {}
	}, [latestLimit]);

	const handleLaunchAgentBuilder = useCallback(() => {
		switchView("built-in-agent-builder");
	}, [switchView]);

	const handleListAgents = useCallback(() => {
		switchView(AGENT_LIST_VIEW.id);
	}, [switchView]);

	const handleCreateTemplate = useCallback(() => {
		switchView("built-in-template-create");
	}, [switchView]);

	const handleListTemplates = useCallback(() => {
		switchView(TEMPLATE_LIST_VIEW.id);
	}, [switchView]);

	// --- Agent basket handlers (E2) ---

	const handleAddKnowledgeFromCard = useCallback(
		(detail: CardAddKnowledgeEventDetail) => {
			// Agent explode: if clicking 💾 on an AgentFile card, fetch agent definition and
			// spread all its knowledge entries individually into the basket.
			if (detail.harness === "AgentFile") {
				fetchAgentBuilderGetAgent(detail.cardId)
					.then((response) => {
						const agent = response.agent;
						setAgentKnowledgeEntries((prev) => {
							const existingValues = new Set(prev.filter((e) => e.kind === "file").map((e) => e.value));
							const newEntries: AgentKnowledgeEntry[] = [];
							for (const entry of agent.agentKnowledge) {
								if (!existingValues.has(entry)) {
									newEntries.push({
										id: `ak-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
										value: entry,
										kind: "file",
										sourceName: detail.sourceName,
										addedAt: Date.now(),
									});
									existingValues.add(entry);
								}
							}
							return [...prev, ...newEntries];
						});
						if (agent.tools && agent.tools.length > 0) {
							setImportedTools(agent.tools);
						}
						const agentName = agent.agentName || detail.relativePath;
						const imported = agent.agentKnowledge.length;
						setAgentCreateSuccess(`Imported ${imported} knowledge ${imported === 1 ? "entry" : "entries"} from ${agentName}`);
						setTimeout(() => setAgentCreateSuccess(null), 5000);
					})
					.catch(() => {
						// Fallback: add the agent file itself as a single reference
						_addSingleKnowledgeEntry(detail);
					});
				return;
			}

			_addSingleKnowledgeEntry(detail);
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[basketMode, activePlaceholderId],
	);

	const _addSingleKnowledgeEntry = useCallback(
		(detail: CardAddKnowledgeEventDetail) => {
			setAgentKnowledgeEntries((prev) => {
				// In agent-from-template mode, replace the active placeholder
				if (basketMode === "agent-from-template" && activePlaceholderId) {
					const idx = prev.findIndex((e) => e.id === activePlaceholderId);
					if (idx >= 0 && prev[idx].kind === "placeholder") {
						const updated = [...prev];
						updated[idx] = {
							...prev[idx],
							value: detail.relativePath,
							kind: "file",
							sourceName: detail.sourceName,
						};
						const nextId = findNextPlaceholderId(updated, idx);
						setActivePlaceholderId(nextId);
						return updated;
					}
				}
				const existing = prev.find((e) => e.kind === "file" && e.value === detail.relativePath);
				if (existing) {
					// H1: duplicate — flash the existing entry instead of adding
					setAgentFlashId(existing.id);
					setTimeout(() => setAgentFlashId(null), 600);
					return prev;
				}
				return [
					...prev,
					{
						id: `ak-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
						value: detail.relativePath,
						kind: "file",
						sourceName: detail.sourceName,
						addedAt: Date.now(),
					},
				];
			});
		},
		[basketMode, activePlaceholderId],
	);

	const handleAddCustomKnowledge = useCallback(
		(text: string) => {
			setAgentKnowledgeEntries((prev) => {
				// In agent-from-template mode, replace the active placeholder
				if (basketMode === "agent-from-template" && activePlaceholderId) {
					const idx = prev.findIndex((e) => e.id === activePlaceholderId);
					if (idx >= 0 && prev[idx].kind === "placeholder") {
						const updated = [...prev];
						updated[idx] = {
							...prev[idx],
							value: text,
							kind: "custom",
						};
						const nextId = findNextPlaceholderId(updated, idx);
						setActivePlaceholderId(nextId);
						return updated;
					}
				}
				return [
					...prev,
					{
						id: `ak-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
						value: text,
						kind: "custom",
						addedAt: Date.now(),
					},
				];
			});
		},
		[basketMode, activePlaceholderId],
	);

	const handleUpdateKnowledge = useCallback((id: string, newValue: string) => {
		setAgentKnowledgeEntries((prev) => prev.map((e) => (e.id === id ? { ...e, value: newValue } : e)));
	}, []);

	const handleRemoveKnowledge = useCallback(
		(id: string) => {
			setAgentKnowledgeEntries((prev) => {
				const entry = prev.find((e) => e.id === id);
				if (!entry) return prev;
				// In agent-from-template mode: if removing a replaced placeholder, restore it
				if (basketMode === "agent-from-template" && entry.placeholderIndex !== undefined && entry.kind !== "placeholder") {
					const restored = prev.map((e) =>
						e.id === id ? { ...e, kind: "placeholder" as const, value: "<PLACEHOLDER>", sourceName: undefined } : e,
					);
					if (!activePlaceholderId) {
						setActivePlaceholderId(id);
					}
					return restored;
				}
				return prev.filter((e) => e.id !== id);
			});
		},
		[basketMode, activePlaceholderId],
	);

	const handleMoveKnowledgeUp = useCallback((id: string) => {
		setAgentKnowledgeEntries((prev) => {
			const index = prev.findIndex((e) => e.id === id);
			if (index <= 0) return prev;
			const next = [...prev];
			[next[index - 1], next[index]] = [next[index], next[index - 1]];
			return next;
		});
	}, []);

	const handleMoveKnowledgeDown = useCallback((id: string) => {
		setAgentKnowledgeEntries((prev) => {
			const index = prev.findIndex((e) => e.id === id);
			if (index < 0 || index >= prev.length - 1) return prev;
			const next = [...prev];
			[next[index], next[index + 1]] = [next[index + 1], next[index]];
			return next;
		});
	}, []);

	const handleClearKnowledge = useCallback(() => {
		setAgentKnowledgeEntries([]);
		setAgentCreateError(null);
		setAgentCreateSuccess(null);
		setEditingAgentPath(null);
		setAgentEditInitial(null);
		setIsFromTemplate(false);
		setActivePlaceholderId(null);
	}, []);

	const handleCancelEdit = useCallback(() => {
		setEditingAgentPath(null);
		setAgentEditInitial(null);
		setAgentKnowledgeEntries([]);
		setIsFromTemplate(false);
		setActivePlaceholderId(null);
	}, []);

	const handleCreateAgent = useCallback(
		async (input: Omit<CreateAgentInput, "platform">, platforms: ("github" | "claude")[]) => {
			setIsCreatingAgent(true);
			setAgentCreateError(null);
			setAgentCreateSuccess(null);
			const successPaths: string[] = [];
			try {
				for (const platform of platforms) {
					const result = await fetchAgentBuilderCreate({ ...input, platform });
					successPaths.push(result.path);
				}
				setAgentCreateSuccess(successPaths.join(" · "));
				// H4: In agent-from-template mode, clear template state and switch to agent-list
				if (isFromTemplate) {
					setIsFromTemplate(false);
					setActivePlaceholderId(null);
					setAgentEditInitial(null);
					setTimeout(() => {
						switchView(AGENT_LIST_VIEW.id);
					}, 1500);
				}
			} catch (err) {
				setAgentCreateError(err instanceof Error ? err.message : String(err));
			} finally {
				setIsCreatingAgent(false);
			}
		},
		[isFromTemplate, switchView],
	);

	// Auto-dismiss agent success banner after 5s
	useEffect(() => {
		if (!agentCreateSuccess) return;
		const timer = setTimeout(() => setAgentCreateSuccess(null), 5000);
		return () => clearTimeout(timer);
	}, [agentCreateSuccess]);

	// --- Template handlers (G2, G3) ---

	const handleCreateTemplateSubmit = useCallback(
		async (input: import("./types").CreateTemplateInput) => {
			setIsCreatingAgent(true);
			setAgentCreateError(null);
			setAgentCreateSuccess(null);
			try {
				const result = await fetchAgentBuilderAddTemplate(input);
				setAgentCreateSuccess(result.path);
				// Auto-switch to template-list after save
				setTimeout(() => {
					switchView(TEMPLATE_LIST_VIEW.id);
				}, 1500);
			} catch (err) {
				setAgentCreateError(err instanceof Error ? err.message : String(err));
			} finally {
				setIsCreatingAgent(false);
			}
		},
		[switchView],
	);

	const handleAddPlaceholder = useCallback(() => {
		setAgentKnowledgeEntries((prev) => [
			...prev,
			{
				id: `ak-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
				value: "<PLACEHOLDER>",
				kind: "placeholder",
				addedAt: Date.now(),
			},
		]);
	}, []);

	const openFilterDialog = useCallback(() => {
		setIsFilterDialogOpen(true);
	}, []);

	const closeFilterDialog = useCallback(() => {
		setIsFilterDialogOpen(false);
	}, []);

	const handleApplyFilters = useCallback((filters: FilterState) => {
		setFilterRoles(filters.roles);
		setFilterMinScore(filters.minScore);
		setIsFilterDialogOpen(false);
	}, []);

	const handleResetFilters = useCallback(() => {
		setFilterRoles(new Set(["user", "assistant", "tool", "system"]));
		setFilterMinScore(0);
		setIsFilterDialogOpen(false);
	}, []);

	const applyStarToView = useCallback(
		(targetViewId: string, detail: CardStarEventDetail | null) => {
			if (!detail) {
				return;
			}
			if (isFavorited(detail.cardId, targetViewId)) {
				removeFavorite(detail.cardId, targetViewId);
			} else {
				addFavorite(targetViewId, detail.source);
			}
		},
		[addFavorite, isFavorited, removeFavorite],
	);

	const handleCreateFavoriteView = useCallback(
		(name: string): string | null => {
			const trimmed = name.trim();
			if (!trimmed) {
				return null;
			}
			return createView({
				name: trimmed,
				type: "favorites",
				emoji: VIEW_TYPE_DEFAULTS.favorites.emoji,
				color: VIEW_TYPE_DEFAULTS.favorites.color,
				query: "",
				autoQuery: false,
				autoRefreshSeconds: 0,
			});
		},
		[createView],
	);

	const closeFavoritesPicker = useCallback(() => {
		setIsFavoritesPickerOpen(false);
		setPendingStarDetail(null);
	}, []);

	const handleSaveFavorites = useCallback(
		(viewIdsToSelect: string[]) => {
			if (!pendingStarDetail) return;
			const { cardId, source } = pendingStarDetail;

			favoriteViews.forEach((view) => {
				const shouldBeFav = viewIdsToSelect.includes(view.id);
				const isFav = isFavorited(cardId, view.id);

				if (shouldBeFav && !isFav) {
					addFavorite(view.id, source);
				} else if (!shouldBeFav && isFav) {
					removeFavorite(cardId, view.id);
				}
			});

			closeFavoritesPicker();
		},
		[favoriteViews, isFavorited, addFavorite, removeFavorite, pendingStarDetail, closeFavoritesPicker],
	);

	const handleCardStar = useCallback(
		(detail: CardStarEventDetail) => {
			const isCurrentlyFavorited = favoriteViews.some((v) => isFavorited(detail.cardId, v.id));

			if (!isCurrentlyFavorited && favoriteViews.length === 1) {
				applyStarToView(favoriteViews[0].id, detail);
				return;
			}

			setPendingStarDetail(detail);
			setIsFavoritesPickerOpen(true);
		},
		[applyStarToView, favoriteViews, isFavorited],
	);

	const handleTitleClick = useCallback(
		(detail: TitleClickEventDetail) => {
			if (!detail.sessionId) return;
			if (activeView.type === "agent-builder") {
				// In agent-builder mode, open Content File viewer instead of Chat Session
				const card = cards.find((c) => c.id === detail.messageId);
				const relativePath = card?.excerptShort ?? detail.messageId;
				setContentFileTarget({
					absolutePath: detail.messageId,
					relativePath,
					sourceName: detail.sessionId,
				});
			} else {
				setChatViewTarget({ sessionId: detail.sessionId, messageId: detail.messageId });
			}
		},
		[activeView.type, cards],
	);

	const handleCardEditAgent = useCallback(
		async (detail: CardEditAgentEventDetail) => {
			const card = cards.find((c) => c.id === detail.cardId);
			// Custom text card — open edit dialog
			if (card && card.harness === "custom") {
				setEditingCustomCardId(card.id);
				setIsAddFavoriteMessageOpen(true);
				return;
			}
			// H3: Check if this is a template card (edit template flow)
			if (card && card.harness === "TemplateCard") {
				// H2: Edit template — populate basket in template mode
				try {
					const template: import("./types").CreateTemplateInput = JSON.parse(card.source.message);
					const entries: AgentKnowledgeEntry[] = template.agentKnowledge.map((val, idx) => ({
						id: `ak-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
						value: val,
						kind: (val === "<PLACEHOLDER>" ? "placeholder" : "file") as "placeholder" | "file",
						addedAt: Date.now(),
						placeholderIndex: val === "<PLACEHOLDER>" ? idx : undefined,
					}));
					setAgentKnowledgeEntries(entries);
					setAgentEditInitial({
						projectName: "",
						agentName: template.templateName,
						description: template.description,
						hint: template["argument-hint"],
						tools: template.tools?.join(", ") ?? "",
					});
					setEditingAgentPath(null);
					setIsFromTemplate(false);
					setActivePlaceholderId(null);
					switchView("built-in-template-create");
				} catch {
					setAgentCreateError("Failed to parse template data");
				}
				return;
			}
			// Standard agent edit flow
			try {
				const response = await fetchAgentBuilderGetAgent(detail.agentPath);
				const agent = response.agent;
				// Populate knowledge entries from agent definition
				setAgentKnowledgeEntries(
					agent.agentKnowledge.map((path) => ({
						id: `ak-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
						value: path,
						kind: "file" as const,
						addedAt: Date.now(),
					})),
				);
				// Set initial form values for AgentBasket
				setAgentEditInitial({
					projectName: agent.projectName,
					agentName: agent.agentName,
					description: agent.description,
					hint: agent["argument-hint"],
					tools: agent.tools?.join(", ") ?? "",
					platform: agent.platform,
				});
				setEditingAgentPath(detail.agentPath);
				setIsFromTemplate(false);
				setActivePlaceholderId(null);
				// Switch to agent-builder view so user can modify knowledge files
				switchView("built-in-agent-builder");
			} catch (err) {
				setAgentCreateError(err instanceof Error ? err.message : String(err));
			}
		},
		[cards, switchView],
	);

	const handleCardUseTemplate = useCallback(
		(detail: CardUseTemplateEventDetail) => {
			// H1: Extract template from card, populate knowledge entries, switch to agent-builder
			const card = cards.find((c) => c.id === detail.cardId);
			if (!card) return;
			try {
				const template: import("./types").CreateTemplateInput = JSON.parse(card.source.message);
				const entries: AgentKnowledgeEntry[] = template.agentKnowledge.map((val, idx) => ({
					id: `ak-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
					value: val,
					kind: (val === "<PLACEHOLDER>" ? "placeholder" : "file") as "placeholder" | "file",
					addedAt: Date.now(),
					placeholderIndex: idx,
				}));
				setAgentKnowledgeEntries(entries);
				setAgentEditInitial({
					projectName: "",
					agentName: "",
					description: template.description,
					hint: template["argument-hint"],
					tools: template.tools?.join(", ") ?? "",
				});
				setEditingAgentPath(null);
				setIsFromTemplate(true);
				const firstPlaceholder = entries.find((e) => e.kind === "placeholder");
				setActivePlaceholderId(firstPlaceholder?.id ?? null);
				switchView("built-in-agent-builder");
			} catch {
				setAgentCreateError("Failed to parse template data");
			}
		},
		[cards, switchView],
	);

	const closeChatView = useCallback(() => {
		setChatViewTarget(null);
	}, []);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const active = document.activeElement;
			const isInputFocused =
				active instanceof HTMLInputElement ||
				active instanceof HTMLTextAreaElement ||
				(active instanceof HTMLElement && active.isContentEditable);
			if (event.key === "/" && !isInputFocused) {
				event.preventDefault();
				searchInputRef.current?.focus();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);

	const hoverVisible = useMemo(() => {
		return viewport.k < HOVER_PANEL_MAX_ZOOM && hoverDetail?.phase !== "leave" && Boolean(hoverDetail?.data);
	}, [hoverDetail, viewport.k]);
	const storageError = viewStorageError ?? favoritesStorageError;
	const clearStorageError = useCallback(() => {
		clearViewStorageError();
		clearFavoritesStorageError();
	}, [clearFavoritesStorageError, clearViewStorageError]);

	return (
		<div className="app-root">
			<UpdatePrompt />
			<SearchBar
				ref={searchInputRef}
				onSearch={handleSearch}
				onValueChange={handleSearchInputChange}
				onDateRangeChange={handleDateRangeChange}
				onCustomSinceDateChange={handleCustomSinceDateChange}
				isLoading={isLoading}
				value={searchInputValue}
				dateRangeValue={dateRangePreset}
				customSinceDate={customSinceDate}
				views={views}
				activeViewId={activeViewId}
				onSwitchView={switchView}
				onAddView={handleAddView}
				onEditView={handleEditView}
				onLaunchAgentBuilder={handleLaunchAgentBuilder}
				onListAgents={handleListAgents}
				onCreateTemplate={handleCreateTemplate}
				onListTemplates={handleListTemplates}
				showSourceFilter={activeView.type === "agent-builder"}
				sourceFilterSources={agentBuilderSources.map((s) => s.name)}
				sourceFilterSelected={agentBuilderSelectedSources}
				onSourceFilterChange={setAgentBuilderSelectedSources}
				isSearchDisabled={
					activeView.type !== "search" &&
					activeView.type !== "search-threads" &&
					activeView.type !== "agent-builder" &&
					activeView.type !== "agent-list" &&
					activeView.type !== "template-list"
				}
				isEditDisabled={
					activeView.id === "built-in-latest" ||
					activeView.id === "built-in-agent-builder" ||
					activeView.id === "built-in-agent-list" ||
					activeView.id === "built-in-template-create" ||
					activeView.id === "built-in-template-list"
				}
				searchHistory={searchHistory}
				onClearHistory={clearHistory}
				onRemoveHistory={removeFromHistory}
				getHistoryMatches={getMatches}
				onOpenFilter={openFilterDialog}
				hasActiveFilters={hasActiveFilters}
				isFilterDisabled={
					activeView.type === "agent-builder" ||
					activeView.type === "agent-list" ||
					activeView.type === "template-create" ||
					activeView.type === "template-list" ||
					(locallyFilteredCards.length === 0 && cards.length === 0 && locallyFilteredThreadCards.length === 0)
				}
				searchExecutionToken={searchResetToken}
				isLatestView={activeView.type === "latest"}
				showLimit={activeView.type === "latest" || activeView.type === "search-threads"}
				latestLimit={latestLimit}
				onLatestLimitChange={setLatestLimit}
				localFilterText={localFilterText}
				onLocalFilterTextChange={setLocalFilterText}
			/>
			{storageError && (
				<div className="error-banner">
					<span>{storageError}</span>
					<button type="button" className="error-dismiss" onClick={clearStorageError}>
						×
					</button>
				</div>
			)}
			{error && (
				<div className="error-banner">
					<span>
						{error}
						{error === "No data sources defined" && (
							<>
								{" — "}
								<a
									href="/README-DATA-SOURCES.MD"
									target="_blank"
									rel="noopener noreferrer"
									style={{ color: "#fca5a5", textDecoration: "underline" }}>
									Instructions for how to add Data Sources / Agent Paths
								</a>
							</>
						)}
					</span>
					<button type="button" className="error-dismiss" onClick={clearError}>
						×
					</button>
				</div>
			)}
			<div className="main-content-row">
				{(activeView.type === "agent-builder" ||
					activeView.type === "agent-list" ||
					activeView.type === "template-create" ||
					activeView.type === "template-list") && (
					<AgentBasket
						entries={agentKnowledgeEntries}
						onRemoveEntry={handleRemoveKnowledge}
						onUpdateEntry={handleUpdateKnowledge}
						onMoveUp={handleMoveKnowledgeUp}
						onMoveDown={handleMoveKnowledgeDown}
						onAddCustomEntry={handleAddCustomKnowledge}
						onClear={handleClearKnowledge}
						onCreateAgent={handleCreateAgent}
						sources={agentBuilderSources}
						isCreating={isCreatingAgent}
						createError={agentCreateError}
						createSuccess={agentCreateSuccess}
						flashId={agentFlashId}
						editMode={editingAgentPath !== null && basketMode === "agent"}
						initialValues={agentEditInitial}
						onCancelEdit={handleCancelEdit}
						mode={basketMode}
						onCreateTemplate={handleCreateTemplateSubmit}
						onAddPlaceholder={handleAddPlaceholder}
						activePlaceholderId={activePlaceholderId}
						onSetActivePlaceholder={setActivePlaceholderId}
						importedTools={importedTools}
						onClearImportedTools={() => setImportedTools([])}
					/>
				)}
				<ChatMap
					cards={locallyFilteredCards}
					threadCards={locallyFilteredThreadCards}
					masterCards={masterCards}
					resetViewportToken={searchResetToken}
					hasSearched={hasSearched}
					query={activeView.type === "search" || activeView.type === "search-threads" ? query : activeView.name}
					isLoading={isLoading}
					viewType={activeView.type}
					onHover={handleHover}
					onViewportChange={handleViewportChange}
					onLineClick={handleLineClick}
					onCardStar={handleCardStar}
					onTitleClick={handleTitleClick}
					onCardAddKnowledge={handleAddKnowledgeFromCard}
					onCardEditAgent={handleCardEditAgent}
					onCardUseTemplate={handleCardUseTemplate}
					starredCardIds={starredCardIds}
				/>
			</div>
			<HoverPanel
				data={hoverDetail?.data ?? null}
				x={hoverDetail?.pageX ?? 0}
				y={hoverDetail?.pageY ?? 0}
				visible={hoverVisible}
				zoomLevel={viewport.k}
				viewType={activeView.type}
			/>
			<StatusBar
				resultCount={locallyFilteredCards.length}
				threadCount={locallyFilteredThreadCards.length}
				zoomLevel={viewport.k}
				lodTier={lodFromZoom(viewport.k)}
				latencyMs={latencyMs}
				isLoading={isLoading}
				isOnline={isOnline}
				resultLabel={
					activeView.type === "agent-list"
						? `${locallyFilteredCards.length} agents`
						: activeView.type === "template-list"
							? `${locallyFilteredCards.length} templates`
							: activeView.type === "template-create"
								? "Template Creator"
								: undefined
				}
			/>
			{activeView.type !== "agent-builder" &&
				activeView.type !== "agent-list" &&
				activeView.type !== "template-create" &&
				activeView.type !== "template-list" && (
					<ClipboardBasket
						lines={basketLines}
						isThreadMode={activeView.type === "latest" || activeView.type === "search-threads"}
						onRemove={handleBasketRemove}
						onClear={handleBasketClear}
						onSendToBuilder={handleBasketSendToBuilder}
						onMoveUp={handleBasketMoveUp}
						onMoveDown={handleBasketMoveDown}
					/>
				)}

			{activeView.type === "favorites" && (
				<button type="button" className="add-custom-favorite-btn" onClick={() => setIsAddFavoriteMessageOpen(true)}>
					➕ Custom Text
				</button>
			)}

			<AddFavoriteMessage
				open={isAddFavoriteMessageOpen}
				initial={(() => {
					if (!editingCustomCardId) return null;
					const fav = favoritesForActiveView.find((e) => e.cardId === editingCustomCardId);
					if (!fav || fav.source.type !== "message") return null;
					const msg = fav.source.data;
					return {
						title: msg.subject,
						text: msg.message,
						emoji: msg.tags?.find((t) => t.startsWith("customEmoji:"))?.slice(12) ?? "",
						color: msg.tags?.find((t) => t.startsWith("customColor:"))?.slice(12) ?? "#6b7280",
					} satisfies CustomTextInitial;
				})()}
				onSave={(title, text, emoji, color) => {
					const tags: string[] = [];
					if (color) tags.push(`customColor:${color}`);
					if (emoji) tags.push(`customEmoji:${emoji}`);

					if (editingCustomCardId) {
						const fav = favoritesForActiveView.find((e) => e.cardId === editingCustomCardId);
						if (fav && fav.source.type === "message") {
							updateFavorite(editingCustomCardId, activeView.id, {
								type: "message",
								data: { ...fav.source.data, subject: title || "Custom Favorite", message: text, tags },
							});
						}
					} else {
						addFavorite(activeView.id, {
							type: "message",
							data: {
								id: crypto.randomUUID(),
								sessionId: crypto.randomUUID(),
								harness: "custom",
								machine: "local",
								role: "user",
								model: null,
								message: text,
								subject: title || "Custom Favorite",
								context: [],
								symbols: ["Custom"],
								history: [],
								tags,
								project: "Manual",
								parentId: null,
								tokenUsage: null,
								toolCalls: [],
								rationale: [],
								source: "Manual",
								dateTime: new Date().toISOString(),
							},
						});
					}
					setEditingCustomCardId(null);
					setIsAddFavoriteMessageOpen(false);
				}}
				onCancel={() => {
					setEditingCustomCardId(null);
					setIsAddFavoriteMessageOpen(false);
				}}
			/>

			<EditResultsView
				open={isEditResultsViewOpen}
				mode={dialogMode}
				initialQuery={searchInputValue}
				view={editingView}
				scopes={scopes}
				onScopesChange={setScopes}
				onSave={handleSaveView}
				onCancel={closeEditResultsView}
				onDelete={handleDeleteView}
				canDelete={Boolean(
					editingView &&
					editingView.id !== "built-in-search" &&
					editingView.id !== "built-in-latest" &&
					editingView.id !== "built-in-favorites",
				)}
			/>
			<FavoritesPickerDialog
				open={isFavoritesPickerOpen}
				views={favoriteViews}
				selectedViewIds={favoriteViews.filter((v) => isFavorited(pendingStarDetail?.cardId ?? "", v.id)).map((v) => v.id)}
				onClose={closeFavoritesPicker}
				onSave={handleSaveFavorites}
				onCreate={handleCreateFavoriteView}
			/>
			{chatViewTarget && (
				<ChatViewDialog
					sessionId={chatViewTarget.sessionId}
					messageId={chatViewTarget.messageId}
					onClose={closeChatView}
					onAddToBasket={(text, messageId) => {
						const id = `${messageId}-sel-${Date.now()}`;
						setBasketLines((prev) => [...prev, { id, text, cardId: messageId, addedAt: Date.now() }]);
					}}
				/>
			)}
			{contentFileTarget && (
				<ContentFileDialog
					absolutePath={contentFileTarget.absolutePath}
					relativePath={contentFileTarget.relativePath}
					sourceName={contentFileTarget.sourceName}
					onClose={() => setContentFileTarget(null)}
					onAddToAgent={handleAddKnowledgeFromCard}
				/>
			)}
			<FilterDialog
				open={isFilterDialogOpen}
				availableRoles={availableRoles}
				currentFilters={{ roles: filterRoles, minScore: filterMinScore }}
				onApply={handleApplyFilters}
				onCancel={closeFilterDialog}
				onReset={handleResetFilters}
			/>
		</div>
	);
}
