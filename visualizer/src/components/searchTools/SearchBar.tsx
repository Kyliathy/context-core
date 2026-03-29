/**
 * SearchBar.tsx — Query input bar with integrated view management controls.
 *
 * Layout (left → right):
 *   [+] [▾ View Dropdown] [✏️] [🔍 input + history panel] [Search button]
 *
 * Responsibilities:
 *   - Custom view-switcher dropdown (emoji + color swatch per option) with full
 *     keyboard navigation (arrows, enter, escape, home/end, typeahead).
 *   - Search history autocomplete panel (shown on input focus; substring-filtered;
 *     individual × removal and bulk "Clear All").
 *   - Disables input and Search button when the active view is "favorites" or "latest".
 *   - Owns local state for dropdown open/close and history panel open/close only;
 *     all other state is managed in App.tsx.
 *
 * Docs: zz-reach2/architecture/ui/archi-context-core-ui.md §4.1
 */
import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import type { ViewDefinition } from "../../types";
import SourceFilterDropdown from "../agentBuilder/SourceFilterDropdown";
import "./SearchBar.css";

type SearchBarProps = {
	onSearch: (value: string) => void;
	onValueChange: (value: string) => void;
	onDateRangeChange: (value: string) => void;
	onCustomSinceDateChange: (value: string) => void;
	isLoading: boolean;
	value: string;
	dateRangeValue: string;
	customSinceDate: string;
	views: ViewDefinition[];
	activeViewId: string;
	onSwitchView: (id: string) => void;
	onAddView: () => void;
	onEditView: () => void;
	onLaunchAgentBuilder: () => void;
	onListAgents: () => void;
	onCreateTemplate: () => void;
	onListTemplates: () => void;
	showSourceFilter?: boolean;
	sourceFilterSources?: string[];
	sourceFilterSelected?: Set<string>;
	onSourceFilterChange?: (selected: Set<string>) => void;
	isSearchDisabled: boolean;
	isEditDisabled: boolean;
	searchHistory: string[];
	onClearHistory: () => void;
	onRemoveHistory: (query: string) => void;
	getHistoryMatches: (input: string, limit?: number) => string[];
	onOpenFilter: () => void;
	hasActiveFilters: boolean;
	isFilterDisabled: boolean;
	searchExecutionToken?: number;

	isLatestView?: boolean;
	showLimit?: boolean;
	latestLimit?: number;
	onLatestLimitChange?: (val: number) => void;
	localFilterText?: string;
	onLocalFilterTextChange?: (val: string) => void;
};

const SearchBar = forwardRef<HTMLInputElement, SearchBarProps>(function SearchBar(
	{
		onSearch,
		onValueChange,
		onDateRangeChange,
		onCustomSinceDateChange,
		isLoading,
		value,
		dateRangeValue,
		customSinceDate,
		views,
		activeViewId,
		onSwitchView,
		onAddView,
		onEditView,
		onLaunchAgentBuilder,
		onListAgents,
		onCreateTemplate,
		onListTemplates,
		showSourceFilter = false,
		sourceFilterSources = [],
		sourceFilterSelected = new Set<string>(),
		onSourceFilterChange,
		isSearchDisabled,
		isEditDisabled,
		searchHistory,
		onClearHistory,
		onRemoveHistory,
		getHistoryMatches,
		onOpenFilter,
		hasActiveFilters,
		isFilterDisabled,
		searchExecutionToken = 0,
		isLatestView,
		showLimit,
		latestLimit = 100,
		onLatestLimitChange,
		localFilterText = "",
		onLocalFilterTextChange,
	},
	ref,
) {
	const [isDropdownOpen, setIsDropdownOpen] = useState(false);
	const [highlightedIndex, setHighlightedIndex] = useState(0);
	const [typeaheadHint, setTypeaheadHint] = useState("");
	const dropdownRef = useRef<HTMLDivElement>(null);
	const triggerButtonRef = useRef<HTMLButtonElement>(null);
	const launchButtonRef = useRef<HTMLButtonElement>(null);
	const listAgentsButtonRef = useRef<HTMLButtonElement>(null);
	const createTemplateButtonRef = useRef<HTMLButtonElement>(null);
	const listTemplatesButtonRef = useRef<HTMLButtonElement>(null);
	const [rightColumnFocusIndex, setRightColumnFocusIndex] = useState(0); // 0 = launch, 1 = list agents, 2 = create template, 3 = list templates
	const menuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
	const typeaheadBufferRef = useRef("");
	const typeaheadTimerRef = useRef<number | null>(null);

	const [isHistoryPanelOpen, setIsHistoryPanelOpen] = useState(false);
	const [highlightedHistoryIndex, setHighlightedHistoryIndex] = useState(0);
	const historyPanelRef = useRef<HTMLDivElement>(null);
	const historyItemRefs = useRef<Array<HTMLButtonElement | null>>([]);

	const timeRangeOptions = useMemo(
		() => [
			{ value: "all", label: "All" },
			{ value: "last-week", label: "Last week" },
			{ value: "last-2-weeks", label: "Last 2 weeks" },
			{ value: "last-3-weeks", label: "Last 3 weeks" },
			{ value: "last-month", label: "Last month" },
			{ value: "last-6-weeks", label: "Last 6 weeks" },
			{ value: "last-2-months", label: "Last 2 months" },
			{ value: "last-3-months", label: "Last 3 months" },
			{ value: "last-4-months", label: "Last 4 months" },
			{ value: "last-5-months", label: "Last 5 months" },
			{ value: "last-6-months", label: "Last 6 months" },
			{ value: "last-year", label: "Last year" },
			{ value: "last-18-months", label: "Last 18 months" },
			{ value: "last-2-years", label: "Last 2 years" },
			{ value: "last-3-years", label: "Last 3 years" },
			{ value: "custom", label: "Custom" },
		],
		[],
	);

	useEffect(() => {
		const onPointerDown = (event: PointerEvent) => {
			if (!dropdownRef.current) {
				return;
			}
			if (!dropdownRef.current.contains(event.target as Node)) {
				setIsDropdownOpen(false);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, []);

	useEffect(() => {
		const onPointerDown = (event: PointerEvent) => {
			if (!historyPanelRef.current) {
				return;
			}
			const target = event.target as Node;
			const inputElement = typeof ref === "function" ? null : ref?.current;
			if (!historyPanelRef.current.contains(target) && target !== inputElement) {
				setIsHistoryPanelOpen(false);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [ref]);

	useEffect(() => {
		setIsHistoryPanelOpen(false);
	}, [searchExecutionToken]);

	useEffect(() => {
		if (isLoading) {
			setIsHistoryPanelOpen(false);
		}
	}, [isLoading]);

	const triggerSearch = () => {
		if (isSearchDisabled || isLoading) {
			return;
		}
		setIsHistoryPanelOpen(false);
		onSearch(value);
	};

	const historyMatches = useMemo(() => getHistoryMatches(value), [getHistoryMatches, value]);

	const selectHistoryItem = (query: string) => {
		onValueChange(query);
		setIsHistoryPanelOpen(false);
		onSearch(query);
	};

	const moveHistoryHighlight = (nextIndex: number) => {
		if (historyMatches.length === 0) {
			return;
		}
		const normalized = Math.max(0, Math.min(nextIndex, historyMatches.length - 1));
		setHighlightedHistoryIndex(normalized);
	};

	const onHistoryKeyDown: React.KeyboardEventHandler = (event) => {
		if (!isHistoryPanelOpen) {
			return;
		}

		if (event.key === "Escape") {
			event.preventDefault();
			setIsHistoryPanelOpen(false);
			return;
		}

		if (event.key === "ArrowDown") {
			event.preventDefault();
			moveHistoryHighlight(highlightedHistoryIndex + 1);
			return;
		}

		if (event.key === "ArrowUp") {
			event.preventDefault();
			moveHistoryHighlight(highlightedHistoryIndex - 1);
			return;
		}

		if (event.key === "Enter" && historyMatches.length > 0) {
			event.preventDefault();
			selectHistoryItem(historyMatches[highlightedHistoryIndex]);
			return;
		}
	};

	const builtInViews = views
		.filter(
			(view) =>
				view.id.startsWith("built-in-") &&
				view.type !== "agent-builder" &&
				view.type !== "agent-list" &&
				view.type !== "template-create" &&
				view.type !== "template-list",
		)
		.sort((left, right) => left.createdAt - right.createdAt);
	const userFavoriteViews = views
		.filter((view) => !view.id.startsWith("built-in-") && view.type === "favorites")
		.sort((left, right) => left.createdAt - right.createdAt);
	const userSearchThreadViews = views
		.filter((view) => !view.id.startsWith("built-in-") && view.type === "search-threads")
		.sort((left, right) => left.createdAt - right.createdAt);
	const userSearchMessageViews = views
		.filter((view) => !view.id.startsWith("built-in-") && view.type === "search")
		.sort((left, right) => left.createdAt - right.createdAt);
	const orderedViews = useMemo(
		() => [...builtInViews, ...userSearchThreadViews, ...userSearchMessageViews, ...userFavoriteViews],
		[builtInViews, userSearchThreadViews, userSearchMessageViews, userFavoriteViews],
	);
	const activeView = useMemo(() => views.find((view) => view.id === activeViewId) ?? views[0], [activeViewId, views]);
	const activeViewIndex = useMemo(() => orderedViews.findIndex((view) => view.id === activeViewId), [activeViewId, orderedViews]);

	useEffect(() => {
		if (!isDropdownOpen) {
			return;
		}
		const nextIndex = activeViewIndex >= 0 ? activeViewIndex : 0;
		setHighlightedIndex(nextIndex);
		requestAnimationFrame(() => {
			menuItemRefs.current[nextIndex]?.focus();
		});
	}, [isDropdownOpen, activeViewIndex]);

	useEffect(() => {
		return () => {
			if (typeaheadTimerRef.current !== null) {
				window.clearTimeout(typeaheadTimerRef.current);
			}
		};
	}, []);

	const closeDropdown = () => {
		setIsDropdownOpen(false);
		setTypeaheadHint("");
		typeaheadBufferRef.current = "";
		if (typeaheadTimerRef.current !== null) {
			window.clearTimeout(typeaheadTimerRef.current);
			typeaheadTimerRef.current = null;
		}
		requestAnimationFrame(() => {
			triggerButtonRef.current?.focus();
		});
	};

	const selectViewByIndex = (index: number) => {
		const target = orderedViews[index];
		if (!target) {
			return;
		}
		onSwitchView(target.id);
		closeDropdown();
	};

	const moveHighlight = (nextIndex: number) => {
		if (orderedViews.length === 0) {
			return;
		}
		const normalized = (nextIndex + orderedViews.length) % orderedViews.length;
		setHighlightedIndex(normalized);
		menuItemRefs.current[normalized]?.focus();
	};

	const handleTypeahead = (key: string) => {
		const char = key.toLowerCase();
		if (!/[a-z0-9]/i.test(char) || orderedViews.length === 0) {
			return;
		}

		typeaheadBufferRef.current = `${typeaheadBufferRef.current}${char}`;
		setTypeaheadHint(typeaheadBufferRef.current);
		if (typeaheadTimerRef.current !== null) {
			window.clearTimeout(typeaheadTimerRef.current);
		}
		typeaheadTimerRef.current = window.setTimeout(() => {
			typeaheadBufferRef.current = "";
			setTypeaheadHint("");
			typeaheadTimerRef.current = null;
		}, 450);

		const searchValue = typeaheadBufferRef.current;
		const startIndex = (highlightedIndex + 1 + orderedViews.length) % orderedViews.length;
		for (let offset = 0; offset < orderedViews.length; offset += 1) {
			const index = (startIndex + offset) % orderedViews.length;
			const candidate = orderedViews[index];
			const label = `${candidate.name} ${candidate.emoji}`.toLowerCase();
			if (label.startsWith(searchValue)) {
				moveHighlight(index);
				return;
			}
		}
	};

	const onDropdownKeyDown: React.KeyboardEventHandler = (event) => {
		if (!isDropdownOpen) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				setIsDropdownOpen(true);
			}
			return;
		}

		if (event.key === "Escape") {
			event.preventDefault();
			closeDropdown();
			return;
		}

		if (event.key === "ArrowDown") {
			event.preventDefault();
			moveHighlight(highlightedIndex + 1);
			return;
		}

		if (event.key === "ArrowUp") {
			event.preventDefault();
			moveHighlight(highlightedIndex - 1);
			return;
		}

		if (event.key === "Enter") {
			event.preventDefault();
			selectViewByIndex(highlightedIndex);
			return;
		}

		if (event.key === "Home") {
			event.preventDefault();
			moveHighlight(0);
			return;
		}

		if (event.key === "End") {
			event.preventDefault();
			moveHighlight(orderedViews.length - 1);
			return;
		}

		if (event.key === "ArrowRight") {
			event.preventDefault();
			setRightColumnFocusIndex(0);
			launchButtonRef.current?.focus();
			return;
		}

		handleTypeahead(event.key);
	};

	const renderViewItem = (view: ViewDefinition) => (
		<>
			<span className="view-item-emoji" aria-hidden>
				{view.emoji}
			</span>
			<span className="view-item-swatch" style={{ backgroundColor: view.color }} aria-hidden />
			<span className="view-item-name">{view.name}</span>
		</>
	);

	return (
		<div className="search-bar">
			<button type="button" className="search-mini-btn" onClick={onAddView} title="Create view">
				+
			</button>
			<div className="view-dropdown" ref={dropdownRef}>
				<button
					type="button"
					ref={triggerButtonRef}
					className="view-select"
					onClick={() => setIsDropdownOpen((open) => !open)}
					onKeyDown={onDropdownKeyDown}
					title="Select view"
					aria-haspopup="listbox"
					aria-expanded={isDropdownOpen}>
					{activeView && renderViewItem(activeView)}
					<span className="view-select-caret" aria-hidden>
						▾
					</span>
				</button>
				{isDropdownOpen && (
					<div className="view-menu" onKeyDown={onDropdownKeyDown}>
						{/* Left column: view list */}
						<div
							className="view-menu-column view-menu-left"
							role="listbox"
							aria-label="Views"
							aria-activedescendant={orderedViews[highlightedIndex]?.id}>
							{typeaheadHint && <div className="view-typeahead-hint">Jump: {typeaheadHint}</div>}
							<div className="view-menu-group">Built-in Views</div>
							{builtInViews.map((view, index) => (
								<button
									type="button"
									key={view.id}
									id={view.id}
									ref={(element) => {
										menuItemRefs.current[index] = element;
									}}
									className={`view-menu-item ${view.id === activeViewId ? "is-active" : ""} ${index === highlightedIndex ? "is-highlighted" : ""}`}
									role="option"
									aria-selected={view.id === activeViewId}
									tabIndex={index === highlightedIndex ? 0 : -1}
									onFocus={() => setHighlightedIndex(index)}
									onClick={() => {
										selectViewByIndex(index);
									}}>
									{renderViewItem(view)}
								</button>
							))}
							{userSearchThreadViews.length > 0 && (
								<>
									<div className="view-menu-divider" />
									<div className="view-menu-group">Search Threads</div>
									{userSearchThreadViews.map((view, userIndex) => {
										const index = builtInViews.length + userIndex;
										return (
											<button
												type="button"
												key={view.id}
												id={view.id}
												ref={(element) => {
													menuItemRefs.current[index] = element;
												}}
												className={`view-menu-item ${view.id === activeViewId ? "is-active" : ""} ${index === highlightedIndex ? "is-highlighted" : ""}`}
												role="option"
												aria-selected={view.id === activeViewId}
												tabIndex={index === highlightedIndex ? 0 : -1}
												onFocus={() => setHighlightedIndex(index)}
												onClick={() => {
													selectViewByIndex(index);
												}}>
												{renderViewItem(view)}
											</button>
										);
									})}
								</>
							)}
							{userSearchMessageViews.length > 0 && (
								<>
									<div className="view-menu-divider" />
									<div className="view-menu-group">Search Messages</div>
									{userSearchMessageViews.map((view, userIndex) => {
										const index = builtInViews.length + userSearchThreadViews.length + userIndex;
										return (
											<button
												type="button"
												key={view.id}
												id={view.id}
												ref={(element) => {
													menuItemRefs.current[index] = element;
												}}
												className={`view-menu-item ${view.id === activeViewId ? "is-active" : ""} ${index === highlightedIndex ? "is-highlighted" : ""}`}
												role="option"
												aria-selected={view.id === activeViewId}
												tabIndex={index === highlightedIndex ? 0 : -1}
												onFocus={() => setHighlightedIndex(index)}
												onClick={() => {
													selectViewByIndex(index);
												}}>
												{renderViewItem(view)}
											</button>
										);
									})}
								</>
							)}
							{userFavoriteViews.length > 0 && (
								<>
									<div className="view-menu-divider" />
									<div className="view-menu-group">Favorites</div>
									{userFavoriteViews.map((view, userIndex) => {
										const index = builtInViews.length + userSearchThreadViews.length + userSearchMessageViews.length + userIndex;
										return (
											<button
												type="button"
												key={view.id}
												id={view.id}
												ref={(element) => {
													menuItemRefs.current[index] = element;
												}}
												className={`view-menu-item ${view.id === activeViewId ? "is-active" : ""} ${index === highlightedIndex ? "is-highlighted" : ""}`}
												role="option"
												aria-selected={view.id === activeViewId}
												tabIndex={index === highlightedIndex ? 0 : -1}
												onFocus={() => setHighlightedIndex(index)}
												onClick={() => {
													selectViewByIndex(index);
												}}>
												{renderViewItem(view)}
											</button>
										);
									})}
								</>
							)}
						</div>
						{/* Right column: Agent Builder */}
						<div className="view-menu-column view-menu-right" role="group" aria-label="Agent Builder">
							<div className="view-menu-group">Agent Builder</div>
							<button
								type="button"
								ref={launchButtonRef}
								className="agent-builder-launch-btn"
								onClick={() => {
									onLaunchAgentBuilder();
									closeDropdown();
								}}
								onKeyDown={(event) => {
									if (event.key === "ArrowLeft") {
										event.preventDefault();
										setRightColumnFocusIndex(0);
										moveHighlight(highlightedIndex);
									}
									if (event.key === "ArrowDown") {
										event.preventDefault();
										setRightColumnFocusIndex(1);
										listAgentsButtonRef.current?.focus();
									}
									if (event.key === "Escape") {
										event.preventDefault();
										closeDropdown();
									}
								}}>
								▶ Launch Builder
							</button>
							<button
								type="button"
								ref={listAgentsButtonRef}
								className="agent-builder-launch-btn agent-list-btn"
								onClick={() => {
									onListAgents();
									closeDropdown();
								}}
								onKeyDown={(event) => {
									if (event.key === "ArrowLeft") {
										event.preventDefault();
										setRightColumnFocusIndex(1);
										moveHighlight(highlightedIndex);
									}
									if (event.key === "ArrowUp") {
										event.preventDefault();
										setRightColumnFocusIndex(0);
										launchButtonRef.current?.focus();
									}
									if (event.key === "ArrowDown") {
										event.preventDefault();
										setRightColumnFocusIndex(2);
										createTemplateButtonRef.current?.focus();
									}
									if (event.key === "Escape") {
										event.preventDefault();
										closeDropdown();
									}
								}}>
								📋 List Agents
							</button>
							<div className="view-menu-divider" />
							<div className="view-menu-group">Templates</div>
							<button
								type="button"
								ref={createTemplateButtonRef}
								className="agent-builder-launch-btn agent-template-btn"
								onClick={() => {
									onCreateTemplate();
									closeDropdown();
								}}
								onKeyDown={(event) => {
									if (event.key === "ArrowLeft") {
										event.preventDefault();
										setRightColumnFocusIndex(2);
										moveHighlight(highlightedIndex);
									}
									if (event.key === "ArrowUp") {
										event.preventDefault();
										setRightColumnFocusIndex(1);
										listAgentsButtonRef.current?.focus();
									}
									if (event.key === "ArrowDown") {
										event.preventDefault();
										setRightColumnFocusIndex(3);
										listTemplatesButtonRef.current?.focus();
									}
									if (event.key === "Escape") {
										event.preventDefault();
										closeDropdown();
									}
								}}>
								📝 Create Template
							</button>
							<button
								type="button"
								ref={listTemplatesButtonRef}
								className="agent-builder-launch-btn agent-list-btn"
								onClick={() => {
									onListTemplates();
									closeDropdown();
								}}
								onKeyDown={(event) => {
									if (event.key === "ArrowLeft") {
										event.preventDefault();
										setRightColumnFocusIndex(3);
										moveHighlight(highlightedIndex);
									}
									if (event.key === "ArrowUp") {
										event.preventDefault();
										setRightColumnFocusIndex(2);
										createTemplateButtonRef.current?.focus();
									}
									if (event.key === "Escape") {
										event.preventDefault();
										closeDropdown();
									}
								}}>
								📚 List Templates
							</button>
						</div>
					</div>
				)}
			</div>
			<button type="button" className="search-mini-btn" onClick={onEditView} disabled={isEditDisabled} title="Edit view">
				✏️
			</button>
			{showSourceFilter && onSourceFilterChange && (
				<SourceFilterDropdown sources={sourceFilterSources} selected={sourceFilterSelected} onChange={onSourceFilterChange} />
			)}
			<div className="search-input-container">
				<span className="search-icon" aria-hidden>
					🔍
				</span>
				<span className="since-label">Since:</span>
				<select
					className="time-range-select"
					value={dateRangeValue}
					onChange={(event) => onDateRangeChange(event.target.value)}
					title="Select time range">
					{timeRangeOptions.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
				{dateRangeValue === "custom" && (
					<input
						type="date"
						className="since-date-input"
						value={customSinceDate}
						onChange={(event) => onCustomSinceDateChange(event.target.value)}
					/>
				)}
				{(showLimit || isLatestView) && (
					<label className="latest-limit-label">
						Limit:
						<select
							className="latest-limit-select"
							value={latestLimit}
							onChange={(event) => onLatestLimitChange?.(Number(event.target.value))}
							title="Select limit">
							{[50, 100, 150, 200, 300, 400, 500].map((limitOption) => (
								<option key={limitOption} value={limitOption}>
									{limitOption}
								</option>
							))}
						</select>
					</label>
				)}
				{!isLatestView && (
					<>
						<input
							ref={ref}
							type="text"
							value={value}
							disabled={isSearchDisabled}
							className="search-input"
							placeholder="Search ContextCore..."
							onChange={(event) => onValueChange(event.target.value)}
							onFocus={() => {
								if (!isSearchDisabled && !isLoading) {
									setIsHistoryPanelOpen(true);
									setHighlightedHistoryIndex(0);
								}
							}}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									triggerSearch();
								} else {
									onHistoryKeyDown(event);
								}
							}}
						/>
						<button type="button" className="search-button" onClick={triggerSearch} disabled={isLoading || isSearchDisabled}>
							{isLoading ? "Searching..." : "Search"}
						</button>
					</>
				)}
				<button
					type="button"
					className={`filter-button ${hasActiveFilters ? "has-active-filters" : ""}`}
					onClick={onOpenFilter}
					disabled={isFilterDisabled}
					title={hasActiveFilters ? "Filters active - click to modify" : "Filter results"}>
					Filter
					{hasActiveFilters && <span className="filter-badge" aria-label="Filters active" />}
				</button>
				<input
					type="text"
					className="local-filter-input"
					placeholder="Instant filter..."
					value={localFilterText}
					onChange={(event) => onLocalFilterTextChange?.(event.target.value)}
				/>
				{isHistoryPanelOpen && historyMatches.length > 0 && !isSearchDisabled && !isLatestView && (
					<div className="search-history-panel" ref={historyPanelRef} role="listbox">
						<div className="search-history-header">
							<span className="search-history-label">Search History</span>
							<button
								type="button"
								className="search-history-clear-btn"
								onClick={() => {
									onClearHistory();
									setIsHistoryPanelOpen(false);
								}}
								title="Clear all history">
								Clear All
							</button>
						</div>
						<div className="search-history-items">
							{historyMatches.map((query, index) => (
								<div key={`${query}-${index}`} className="search-history-item-wrapper">
									<button
										type="button"
										ref={(element) => {
											historyItemRefs.current[index] = element;
										}}
										className={`search-history-item ${index === highlightedHistoryIndex ? "is-highlighted" : ""}`}
										role="option"
										tabIndex={-1}
										onClick={() => selectHistoryItem(query)}>
										{query}
									</button>
									<button
										type="button"
										className="search-history-delete-btn"
										onClick={(event) => {
											event.stopPropagation();
											onRemoveHistory(query);
										}}
										title="Remove from history">
										×
									</button>
								</div>
							))}
						</div>
					</div>
				)}
			</div>
		</div>
	);
});

export default SearchBar;
