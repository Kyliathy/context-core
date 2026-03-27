/**
 * EditResultsView.tsx - Modal for creating and editing named views.
 *
 * Operates in two modes:
 *   - "add": blank form; type defaults (emoji, color) applied automatically
 *     when the type radio changes; query pre-filled from the active search bar value.
 *   - "edit": fields pre-filled from the existing ViewDefinition; type is frozen
 *     (cannot change an existing view's type).
 *
 * Fields: name, type (search/favorites), emoji, color, search query (search only),
 *   "Auto Refresh when switched to" checkbox (search only), "Perpetual Refresh Rate"
 *   in seconds (search only, 0 = disabled).
 *
 * Delete flow: only shown in edit mode when canDelete is true; requires an inline
 * "Are you sure?" confirmation step before calling onDelete.
 *
 * "Latest Chats" (built-in-latest) is never passed as an editable view - the
 * edit button in SearchBar is disabled when that view is active.
 *
 * Docs: zz-reach2/architecture/ui/archi-context-core-visualizer-ui.md section 4.2
 */
import { useEffect, useMemo, useState } from "react";
import type { ViewDefinition, ViewType, SelectedProject, ProjectGroup, Scope } from "../../types";
import { fetchProjects } from "../../api/search";
import { VIEW_TYPE_DEFAULTS } from "../../hooks/useViews";
import { getHarnessColor } from "../../d3/colors";
import EditScope from "./EditScope";
import "./EditResultsView.css";

const PROJECT_GRID_COLUMNS = 2;
const PROJECT_GRID_MIN_HEIGHT_PX = 80;
const PROJECT_GRID_ROW_PX = 28;
const PROJECT_GRID_ROW_GAP_PX = 8;

type SavePayload = {
	name: string;
	type: ViewType;
	emoji: string;
	color: string;
	query: string;
	autoQuery: boolean;
	autoRefreshSeconds: number;
	projects: SelectedProject[];
};

type EditResultsViewProps = {
	open: boolean;
	mode: "add" | "edit";
	initialQuery: string;
	view?: ViewDefinition;
	scopes: Scope[];
	onScopesChange: (nextScopes: Scope[]) => void;
	onSave: (payload: SavePayload) => void;
	onCancel: () => void;
	onDelete?: () => void;
	canDelete?: boolean;
};

export default function EditResultsView({
	open,
	mode,
	initialQuery,
	view,
	scopes,
	onScopesChange,
	onSave,
	onCancel,
	onDelete,
	canDelete = false,
}: EditResultsViewProps) {
	const [name, setName] = useState("");
	const [type, setType] = useState<ViewType>("search-threads");
	const [emoji, setEmoji] = useState(VIEW_TYPE_DEFAULTS["search-threads"].emoji);
	const [color, setColor] = useState(VIEW_TYPE_DEFAULTS["search-threads"].color);
	const [query, setQuery] = useState("");
	const [autoQuery, setAutoQuery] = useState(true);
	const [autoRefreshSeconds, setAutoRefreshSeconds] = useState(0);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [projects, setProjects] = useState<SelectedProject[]>([]);
	const [availableProjects, setAvailableProjects] = useState<ProjectGroup[]>([]);
	const [projectFilter, setProjectFilter] = useState("");
	const [selectedScopeIds, setSelectedScopeIds] = useState<Set<string>>(new Set());
	const [scopeEditorMode, setScopeEditorMode] = useState<"create" | "modify" | null>(null);

	useEffect(() => {
		fetchProjects()
			.then(setAvailableProjects)
			.catch((err) => console.error("Failed to fetch projects", err));
	}, []);

	useEffect(() => {
		if (!open) {
			return;
		}
		if (mode === "edit" && view) {
			setName(view.name);
			setType(view.type === "latest" ? "search" : view.type);
			setEmoji(view.emoji || VIEW_TYPE_DEFAULTS[view.type].emoji);
			setColor(view.color || VIEW_TYPE_DEFAULTS[view.type].color);
			setQuery(view.query);
			setAutoQuery(view.autoQuery);
			setAutoRefreshSeconds(view.autoRefreshSeconds);
			setProjects(view.projects || []);
		} else {
			setName("");
			setType("search-threads");
			setEmoji(VIEW_TYPE_DEFAULTS["search-threads"].emoji);
			setColor(VIEW_TYPE_DEFAULTS["search-threads"].color);
			setQuery(initialQuery);
			setAutoQuery(true);
			setAutoRefreshSeconds(0);
			setProjects([]);
		}
		setConfirmDelete(false);
		setSelectedScopeIds(new Set());
		setScopeEditorMode(null);
	}, [open, mode, view, initialQuery]);

	const sortedProjectEntries = useMemo(() => {
		return availableProjects
			.flatMap((pg) => pg.projects.map((proj) => ({ harness: pg.harness, project: proj, label: `${proj} [${pg.harness}]` })))
			.sort(
				(a, b) =>
					a.project.localeCompare(b.project, undefined, { sensitivity: "base" }) ||
					a.harness.localeCompare(b.harness, undefined, { sensitivity: "base" }),
			);
	}, [availableProjects]);

	const filteredProjectEntries = useMemo(() => {
		if (!projectFilter.trim()) return sortedProjectEntries;
		const lc = projectFilter.trim().toLowerCase();
		return sortedProjectEntries.filter((e) => e.label.toLowerCase().includes(lc));
	}, [sortedProjectEntries, projectFilter]);

	const filteredScopes = useMemo(() => {
		if (!projectFilter.trim()) return scopes;
		const lc = projectFilter.trim().toLowerCase();
		return scopes.filter((scope) => scope.name.toLowerCase().includes(lc));
	}, [projectFilter, scopes]);

	const makeProjectKey = (project: SelectedProject) => `${project.harness}:::${project.project}`;
	const getScopeProjectUnion = (scopeEntries: Scope[]): SelectedProject[] => {
		const map = new Map<string, SelectedProject>();
		for (const scope of scopeEntries) {
			for (const project of scope.projectIds) {
				const key = makeProjectKey(project);
				if (!map.has(key)) {
					map.set(key, project);
				}
			}
		}
		return Array.from(map.values());
	};

	const selectedScopes = useMemo(() => scopes.filter((scope) => selectedScopeIds.has(scope.id)), [scopes, selectedScopeIds]);
	const singleSelectedScope = useMemo(() => (selectedScopes.length === 1 ? selectedScopes[0] : null), [selectedScopes]);
	const projectGridHeightPx = useMemo(() => {
		const visibleProjects = Math.max(1, filteredProjectEntries.length);
		const rowCount = Math.ceil(visibleProjects / PROJECT_GRID_COLUMNS);
		const contentHeight = rowCount * PROJECT_GRID_ROW_PX + Math.max(0, rowCount - 1) * PROJECT_GRID_ROW_GAP_PX;
		return Math.max(PROJECT_GRID_MIN_HEIGHT_PX, contentHeight);
	}, [filteredProjectEntries.length]);

	useEffect(() => {
		if (selectedScopeIds.size > 0 && selectedScopes.length !== selectedScopeIds.size) {
			console.error("[Scopes] Some selected scopes were not found", { selectedScopeIds: Array.from(selectedScopeIds) });
		}
	}, [selectedScopeIds, selectedScopes]);

	const areProjectSetsEqual = (a: SelectedProject[], b: SelectedProject[]) => {
		if (a.length !== b.length) return false;
		const bSet = new Set(b.map(makeProjectKey));
		return a.every((project) => bSet.has(makeProjectKey(project)));
	};

	const trimmedName = useMemo(() => name.trim(), [name]);
	const normalizedEmoji = useMemo(() => {
		const trimmed = emoji.trim();
		if (!trimmed) {
			return VIEW_TYPE_DEFAULTS[type].emoji;
		}
		return Array.from(trimmed).slice(0, 2).join("");
	}, [emoji, type]);
	const normalizedColor = useMemo(() => {
		return /^#([0-9a-f]{6})$/i.test(color) ? color.toLowerCase() : VIEW_TYPE_DEFAULTS[type].color;
	}, [color, type]);
	const isSearchType = type === "search" || type === "search-threads";
	const canSave = trimmedName.length > 0 && trimmedName.length <= 60;
	const canCreateScope = projects.length >= 2;
	const hasScopeProjectChanges = singleSelectedScope ? !areProjectSetsEqual(projects, singleSelectedScope.projectIds) : false;
	const canModifyScope = selectedScopeIds.size === 1;
	const canDeleteScope = selectedScopeIds.size >= 1;

	const persistScopes = (nextScopes: Scope[]) => {
		setSelectedScopeIds((prev) => {
			if (prev.size === 0) {
				return prev;
			}
			const remainingIds = new Set(nextScopes.map((scope) => scope.id));
			const nextSelectedIds = new Set(Array.from(prev).filter((id) => remainingIds.has(id)));
			return nextSelectedIds;
		});
		onScopesChange(nextScopes);
	};

	const handleScopeToggle = (scopeId: string) => {
		const nextSelectedIds = new Set(selectedScopeIds);
		if (nextSelectedIds.has(scopeId)) {
			nextSelectedIds.delete(scopeId);
		} else {
			nextSelectedIds.add(scopeId);
		}
		setSelectedScopeIds(nextSelectedIds);

		const nextSelectedScopes = scopes.filter((scope) => nextSelectedIds.has(scope.id));
		if (nextSelectedScopes.length === 1) {
			setProjects([...nextSelectedScopes[0].projectIds]);
			return;
		}
		if (nextSelectedScopes.length > 1) {
			setProjects(getScopeProjectUnion(nextSelectedScopes));
		}
	};

	if (!open) {
		return null;
	}

	return (
		<div className="edit-results-view-overlay" role="presentation" onClick={onCancel}>
			<div className="edit-results-view" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
				<h2 className="edit-results-view-title">{mode === "add" ? "New View" : "Edit View"}</h2>
				<label className="edit-results-view-label">
					<span>View Name</span>
					<input
						type="text"
						value={name}
						maxLength={60}
						onChange={(event) => setName(event.target.value)}
						className="edit-results-view-input"
					/>
				</label>

				<div className="edit-results-view-label">
					<span>Type</span>
					<div className="edit-results-view-radio-row">
						<label>
							<input
								type="radio"
								checked={type === "search-threads"}
								onChange={() => {
									setType("search-threads");
									setEmoji(VIEW_TYPE_DEFAULTS["search-threads"].emoji);
									setColor(VIEW_TYPE_DEFAULTS["search-threads"].color);
								}}
							/>
							Search Threads
						</label>
						<label>
							<input
								type="radio"
								checked={type === "search"}
								onChange={() => {
									setType("search");
									setEmoji(VIEW_TYPE_DEFAULTS.search.emoji);
									setColor(VIEW_TYPE_DEFAULTS.search.color);
								}}
							/>
							Search Messages
						</label>
						<label>
							<input
								type="radio"
								checked={type === "favorites"}
								onChange={() => {
									setType("favorites");
									setEmoji(VIEW_TYPE_DEFAULTS.favorites.emoji);
									setColor(VIEW_TYPE_DEFAULTS.favorites.color);
								}}
							/>
							Favorites
						</label>
					</div>
				</div>

				<div className="edit-results-view-row">
					<label className="edit-results-view-label edit-results-view-emoji-field">
						<span>Emoji</span>
						<input
							type="text"
							value={emoji}
							maxLength={4}
							onChange={(event) => setEmoji(event.target.value)}
							className="edit-results-view-input"
						/>
					</label>
					<label className="edit-results-view-label">
						<span>Color</span>
						<input
							type="color"
							value={normalizedColor}
							onChange={(event) => setColor(event.target.value)}
							className="edit-results-view-color"
						/>
					</label>
					{isSearchType && (
						<label className="edit-results-view-label edit-results-view-grow">
							<span>Search Query</span>
							<input
								type="text"
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								className="edit-results-view-input"
							/>
						</label>
					)}
				</div>

				{isSearchType && (
					<>
						<div className="edit-results-view-row edit-results-view-refresh-row">
							<label className="edit-results-view-check-row">
								<input type="checkbox" checked={autoQuery} onChange={(event) => setAutoQuery(event.target.checked)} />
								Auto Refresh when switched to
							</label>
							<label className="edit-results-view-refresh-inline" htmlFor="perpetual-refresh-rate">
								<span>Perpetual Refresh Rate</span>
								<input
									id="perpetual-refresh-rate"
									type="number"
									value={autoRefreshSeconds}
									min={0}
									onChange={(event) => setAutoRefreshSeconds(Number(event.target.value) || 0)}
									className="edit-results-view-input edit-results-view-refresh-input"
									placeholder="Seconds (0 = disabled)"
								/>
							</label>
						</div>

						<div className="edit-results-view-projects">
							<span className="edit-results-view-label-text">Scope/Projects</span>
							<div className="edit-results-view-project-search">
								<input
									type="text"
									value={projectFilter}
									onChange={(e) => setProjectFilter(e.target.value)}
									className="edit-results-view-input edit-results-view-project-search-input"
									placeholder="Filter scopes/projects..."
								/>
							</div>
							<div className="edit-results-view-project-actions">
								<button
									type="button"
									className="edit-results-view-project-action-btn"
									onClick={() =>
										setProjects((prev) => {
											const toAdd = filteredProjectEntries.filter(
												(e) => !prev.some((p) => p.harness === e.harness && p.project === e.project),
											);
											return [...prev, ...toAdd];
										})
									}>
									Select All
								</button>
								<button
									type="button"
									className="edit-results-view-project-action-btn"
									onClick={() =>
										setProjects((prev) =>
											prev.filter((p) => !filteredProjectEntries.some((e) => e.harness === p.harness && e.project === p.project)),
										)
									}>
									Select None
								</button>
								<span className="edit-results-view-project-actions-separator" aria-hidden="true">
									|
								</span>
								<button
									type="button"
									className="edit-results-view-project-action-btn"
									onClick={() => setScopeEditorMode("create")}
									disabled={!canCreateScope}
									title={canCreateScope ? "Create scope from selected projects" : "Select at least 2 projects"}>
									Create Scope
								</button>
								{singleSelectedScope && hasScopeProjectChanges && (
									<button
										type="button"
										className="edit-results-view-project-action-btn"
										onClick={() => {
											const nextScopes = scopes.map((scope) =>
												scope.id === singleSelectedScope.id
													? {
															...scope,
															projectIds: [...projects],
														}
													: scope,
											);
											persistScopes(nextScopes);
										}}>
										Update Scope Selection
									</button>
								)}
								<button
									type="button"
									className="edit-results-view-project-action-btn"
									onClick={() => setScopeEditorMode("modify")}
									disabled={!canModifyScope}
									title={
										selectedScopeIds.size === 0
											? "Select a scope first"
											: selectedScopeIds.size === 1
												? "Modify selected scope"
												: "Select exactly one scope to modify"
									}>
									Modify Scope
								</button>
								{canDeleteScope && (
									<button
										type="button"
										className="edit-results-view-project-action-btn edit-results-view-project-action-btn-danger"
										onClick={() => {
											const nextScopes = scopes.filter((scope) => !selectedScopeIds.has(scope.id));
											persistScopes(nextScopes);
											setSelectedScopeIds(new Set());
											setScopeEditorMode(null);
										}}>
										{selectedScopeIds.size === 1 ? "Delete Scope" : `Delete ${selectedScopeIds.size} Scopes`}
									</button>
								)}
							</div>

							{filteredScopes.length > 0 && (
								<div className="edit-results-view-scopes">
									{filteredScopes.map((scope) => (
										<label
											key={scope.id}
											className="edit-results-view-scope-btn"
											data-active={selectedScopeIds.has(scope.id) ? "true" : "false"}
											style={{ borderColor: scope.color, color: scope.color }}>
											<input
												type="checkbox"
												className="edit-results-view-scope-check"
												checked={selectedScopeIds.has(scope.id)}
												onChange={() => handleScopeToggle(scope.id)}
												style={{ accentColor: scope.color }}
											/>
											<span>
												{scope.emoji} {scope.name}
											</span>
										</label>
									))}
								</div>
							)}

							{scopeEditorMode === "create" && (
								<EditScope
									title="Create Scope"
									saveLabel="Save Scope"
									onCancel={() => setScopeEditorMode(null)}
									onSave={(payload) => {
										const newScopeId = crypto.randomUUID();
										const nextScopes = [
											...scopes,
											{
												id: newScopeId,
												name: payload.name,
												emoji: payload.emoji,
												color: payload.color,
												projectIds: projects,
											},
										];
										persistScopes(nextScopes);
										setSelectedScopeIds(new Set([newScopeId]));
										setScopeEditorMode(null);
									}}
								/>
							)}

							{scopeEditorMode === "modify" && singleSelectedScope && (
								<EditScope
									title="Modify Scope"
									saveLabel="Update Scope Selection"
									initialName={singleSelectedScope.name}
									initialEmoji={singleSelectedScope.emoji}
									initialColor={singleSelectedScope.color}
									onCancel={() => setScopeEditorMode(null)}
									onSave={(payload) => {
										const nextScopes = scopes.map((scope) =>
											scope.id === singleSelectedScope.id
												? {
														...scope,
														name: payload.name,
														emoji: payload.emoji,
														color: payload.color,
													}
												: scope,
										);
										persistScopes(nextScopes);
										setScopeEditorMode(null);
									}}
								/>
							)}

							<div className="edit-results-view-projects-grid" style={{ height: `${projectGridHeightPx}px` }}>
								{filteredProjectEntries.map((entry) => {
									const isChecked = projects.some((p) => p.harness === entry.harness && p.project === entry.project);
									return (
										<label key={`${entry.harness}:${entry.project}`} className="edit-results-view-project-row">
											<input
												type="checkbox"
												checked={isChecked}
												onChange={(e) => {
													if (e.target.checked)
														setProjects((prev) => [...prev, { harness: entry.harness, project: entry.project }]);
													else
														setProjects((prev) =>
															prev.filter((p) => !(p.harness === entry.harness && p.project === entry.project)),
														);
												}}
											/>
											{entry.project}{" "}
											<span style={{ color: getHarnessColor(entry.harness), fontWeight: 500 }}>[{entry.harness}]</span>
										</label>
									);
								})}
							</div>
						</div>
					</>
				)}

				<div className="edit-results-view-actions">
					<button type="button" className="edit-results-view-btn" onClick={onCancel}>
						Cancel
					</button>
					<button
						type="button"
						className="edit-results-view-btn edit-results-view-btn-primary"
						disabled={!canSave}
						onClick={() =>
							onSave({
								name: trimmedName,
								type,
								emoji: normalizedEmoji,
								color: normalizedColor,
								query,
								autoQuery,
								autoRefreshSeconds,
								projects,
							})
						}>
						Save
					</button>
				</div>

				{mode === "edit" && onDelete && canDelete && (
					<div className="edit-results-view-delete-wrap">
						{confirmDelete ? (
							<div className="edit-results-view-delete-confirm">
								<span>Are you sure?</span>
								<button type="button" className="edit-results-view-btn" onClick={() => setConfirmDelete(false)}>
									No
								</button>
								<button type="button" className="edit-results-view-btn edit-results-view-btn-danger" onClick={onDelete}>
									Yes, Delete
								</button>
							</div>
						) : (
							<button
								type="button"
								className="edit-results-view-btn edit-results-view-btn-danger"
								onClick={() => setConfirmDelete(true)}>
								Delete View
							</button>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
