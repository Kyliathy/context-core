/**
 * AgentBasket.tsx — Side panel for building agents from file cards.
 *
 * The user fills in agent metadata (project, name, description, hint, tools),
 * collects knowledge entries by clicking 💾 on file cards in agent-builder
 * view, optionally adds custom text entries via the bottom textarea, reorders
 * them, and submits the whole thing to POST /api/agent-builder/create.
 *
 * Follows the same panel pattern as ClipboardBasket.tsx.
 *
 * Docs: zz-reach2/upgrades/2026-03/r2uac-agent-creator.md §2.1
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentKnowledgeEntry, CreateAgentInput, CreateTemplateInput } from "../../types";
import "./AgentBuilder.css";

type Props = {
	entries: AgentKnowledgeEntry[];
	onRemoveEntry: (id: string) => void;
	onMoveUp: (id: string) => void;
	onMoveDown: (id: string) => void;
	onAddCustomEntry: (text: string) => void;
	onUpdateEntry: (id: string, newValue: string) => void;
	onClear: () => void;
	onCreateAgent: (input: Omit<CreateAgentInput, "platform">, platforms: ("github" | "claude" | "codex")[]) => void;
	sources: { name: string; fileCount: number; codexDirectories?: string[]; codexDefaultDirectory?: string }[];
	isCreating: boolean;
	createError: string | null;
	createSuccess: string | null;
	flashId?: string | null;
	editMode?: boolean;
	initialValues?: {
		projectName: string;
		agentName: string;
		description: string;
		hint: string;
		tools: string;
		codexDirectory?: string;
		platform?: "github" | "claude" | "codex";
		platforms?: import("../../types").AgentListPlatformEntry[];
		contentDiverged?: boolean;
	} | null;
	onCancelEdit?: () => void;
	mode?: "agent" | "template" | "agent-from-template";
	onCreateTemplate?: (input: CreateTemplateInput) => void;
	onAddPlaceholder?: () => void;
	activePlaceholderId?: string | null;
	onSetActivePlaceholder?: (id: string) => void;
	importedTools?: string[];
	onClearImportedTools?: () => void;
};

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PLATFORMS_KEY = "cxc-agent-platforms";
const CODEX_DIRECTORY_KEY = "cxc-agent-codex-directories";

function readCodexDirectoryMap(): Record<string, string>
{
	try
	{
		const raw = window.localStorage.getItem(CODEX_DIRECTORY_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object") return {};
		const result: Record<string, string> = {};
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>))
		{
			if (typeof value === "string" && value.trim() !== "")
			{
				result[key] = value;
			}
		}
		return result;
	} catch
	{
		return {};
	}
}

function toSlug(raw: string): string {
	return raw
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^a-z0-9-]/g, "");
}

export default function AgentBuilder({
	entries,
	onRemoveEntry,
	onMoveUp,
	onMoveDown,
	onAddCustomEntry,
	onUpdateEntry,
	onClear,
	onCreateAgent,
	sources,
	isCreating,
	createError,
	createSuccess,
	flashId,
	editMode = false,
	initialValues,
	onCancelEdit,
	mode = "agent",
	onCreateTemplate,
	onAddPlaceholder,
	activePlaceholderId,
	onSetActivePlaceholder,
	importedTools,
	onClearImportedTools,
}: Props) {
	const [projectName, setProjectName] = useState("");
	const [agentName, setAgentName] = useState("");
	const [description, setDescription] = useState("");
	const [argumentHint, setArgumentHint] = useState("");
	const [tools, setTools] = useState("");
	const [codexDirectory, setCodexDirectory] = useState("");
	const [customText, setCustomText] = useState("");
	const [showSlugHint, setShowSlugHint] = useState(false);
	const [dismissedError, setDismissedError] = useState<string | null>(null);
	const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
	const [platforms, setPlatforms] = useState<Set<"github" | "claude" | "codex">>(() => {
		try {
			const raw = window.localStorage.getItem(PLATFORMS_KEY);
			if (raw) {
				const arr = JSON.parse(raw) as string[];
				const valid = arr.filter((p): p is "github" | "claude" | "codex" => p === "github" || p === "claude" || p === "codex");
				if (valid.length > 0) return new Set(valid);
			}
		} catch {}
		return new Set(["github"]);
	});

	const listRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const prevEntryCount = useRef(entries.length);

	// Auto-scroll knowledge list when new entry added
	useEffect(() => {
		if (entries.length > prevEntryCount.current && listRef.current) {
			listRef.current.scrollTop = listRef.current.scrollHeight;
		}
		prevEntryCount.current = entries.length;
	}, [entries.length]);

	// Auto-select project when only one source
	useEffect(() => {
		if (sources.length === 1 && !projectName) {
			setProjectName(sources[0].name);
		}
	}, [sources, projectName]);

	// H4: Auto-select project when all entries come from the same source
	useEffect(() => {
		if (entries.length === 0) return;
		const fileEntries = entries.filter((e) => e.kind === "file" && e.sourceName);
		if (fileEntries.length === 0) return;
		const uniqueSources = new Set(fileEntries.map((e) => e.sourceName));
		if (uniqueSources.size === 1) {
			const src = fileEntries[0].sourceName!;
			if (sources.some((s) => s.name === src)) {
				setProjectName(src);
			}
		}
	}, [entries, sources]);

	// Populate form fields when entering edit mode
	useEffect(() => {
		if (editMode && initialValues) {
			setProjectName(initialValues.projectName);
			setAgentName(initialValues.agentName);
			setDescription(initialValues.description);
			setArgumentHint(initialValues.hint);
			setTools(initialValues.tools);
			setCodexDirectory(initialValues.codexDirectory ?? "");
			// Pre-check all platforms the agent currently exists on.
			if (initialValues.platforms && initialValues.platforms.length > 0) {
				setPlatforms(new Set(initialValues.platforms.map((p) => p.platform)));
			} else {
				setPlatforms(new Set([initialValues.platform ?? "github"]));
			}
		}
	}, [editMode, initialValues]);

	const selectedSource = sources.find((s) => s.name === projectName);
	const availableCodexDirectories = selectedSource?.codexDirectories ?? [];
	const codexNeedsDirectory = mode !== "template" && platforms.has("codex") && availableCodexDirectories.length > 1;

	useEffect(() => {
		if (!codexNeedsDirectory) return;
		if (availableCodexDirectories.includes(codexDirectory)) return;
		let fallback = "";
		if (!editMode && projectName) {
			const stored = readCodexDirectoryMap()[projectName];
			if (stored && availableCodexDirectories.includes(stored)) {
				fallback = stored;
			}
		}
		if (!fallback) {
			fallback = selectedSource?.codexDefaultDirectory ?? availableCodexDirectories[0] ?? "";
		}
		setCodexDirectory(fallback);
	}, [codexNeedsDirectory, availableCodexDirectories, codexDirectory, selectedSource, editMode, projectName]);

	useEffect(() => {
		if (editMode) return;
		if (!projectName || !codexDirectory) return;
		if (!availableCodexDirectories.includes(codexDirectory)) return;
		try {
			const next = readCodexDirectoryMap();
			next[projectName] = codexDirectory;
			window.localStorage.setItem(CODEX_DIRECTORY_KEY, JSON.stringify(next));
		} catch {}
	}, [editMode, projectName, codexDirectory, availableCodexDirectories]);

	// Persist platform selection to localStorage
	useEffect(() => {
		if (editMode) return;
		try {
			window.localStorage.setItem(PLATFORMS_KEY, JSON.stringify(Array.from(platforms)));
		} catch {}
	}, [platforms, editMode]);

	// Clear dismissed error when a new error arrives
	useEffect(() => {
		if (createError && createError !== dismissedError) {
			setDismissedError(null);
		}
	}, [createError, dismissedError]);

	// Auto-dismiss success after 5 seconds
	useEffect(() => {
		if (!createSuccess) return;
		const timer = setTimeout(() => {
			// No-op: parent owns the state; this is handled by the parent clearing it.
		}, 5000);
		return () => clearTimeout(timer);
	}, [createSuccess]);

	// Merge imported tools from agent explode
	useEffect(() => {
		if (!importedTools || importedTools.length === 0) return;
		setTools((prev) => {
			const existing = prev
				.split(",")
				.map((t) => t.trim())
				.filter(Boolean);
			const existingSet = new Set(existing);
			const merged = [...existing];
			for (const tool of importedTools) {
				if (!existingSet.has(tool)) {
					merged.push(tool);
				}
			}
			return merged.join(", ");
		});
		onClearImportedTools?.();
	}, [importedTools, onClearImportedTools]);

	// Auto-grow textarea
	const handleTextareaInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
		setCustomText(e.target.value);
		const el = e.target;
		const lineCount = Math.min(Math.max((el.value.match(/\n/g) || []).length + 1, 2), 6);
		el.rows = lineCount;
	}, []);

	const handleStartEditEntry = useCallback((entry: { id: string; value: string }) => {
		setEditingEntryId(entry.id);
		setCustomText(entry.value);
		if (textareaRef.current) {
			const lineCount = Math.min(Math.max((entry.value.match(/\n/g) || []).length + 1, 2), 6);
			textareaRef.current.rows = lineCount;
			textareaRef.current.focus();
		}
	}, []);

	const handleCommitCustom = useCallback(() => {
		const trimmed = customText.trim();
		if (!trimmed) return;
		if (editingEntryId) {
			onUpdateEntry(editingEntryId, trimmed);
			setEditingEntryId(null);
		} else {
			onAddCustomEntry(trimmed);
		}
		setCustomText("");
		if (textareaRef.current) textareaRef.current.rows = 2;
	}, [customText, editingEntryId, onUpdateEntry, onAddCustomEntry]);

	const handleTextareaKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter" && e.ctrlKey) {
				e.preventDefault();
				handleCommitCustom();
			}
			if (e.key === "Escape") {
				setCustomText("");
				setEditingEntryId(null);
				if (textareaRef.current) textareaRef.current.rows = 2;
			}
		},
		[handleCommitCustom],
	);

	const slugValid = agentName === "" || SLUG_RE.test(agentName);
	const canCreate =
		mode === "template"
			? !isCreating && agentName !== "" && slugValid && description !== ""
			: mode === "agent-from-template"
				? !isCreating &&
					agentName !== "" &&
					slugValid &&
					projectName !== "" &&
					entries.length > 0 &&
					entries.every((e) => e.kind !== "placeholder") &&
					platforms.size > 0
				: !isCreating &&
					agentName !== "" &&
					slugValid &&
					projectName !== "" &&
					entries.length > 0 &&
					platforms.size > 0 &&
					(!codexNeedsDirectory || codexDirectory !== "");

	const handleCreate = useCallback(() => {
		if (!canCreate) return;
		const toolList = tools
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		if (mode === "template" && onCreateTemplate) {
			onCreateTemplate({
				templateName: agentName,
				description,
				"argument-hint": argumentHint,
				tools: toolList.length > 0 ? toolList : undefined,
				agentKnowledge: entries.map((e) => e.value),
			});
			return;
		}
		onCreateAgent(
			{
				projectName,
				agentName,
				description,
				"argument-hint": argumentHint,
				tools: toolList.length > 0 ? toolList : undefined,
				agentKnowledge: entries.map((e) => e.value),
				codexDirectory: codexNeedsDirectory ? codexDirectory : undefined,
			},
			Array.from(platforms),
		);
	}, [
		canCreate,
		mode,
		projectName,
		agentName,
		description,
		argumentHint,
		tools,
		entries,
		platforms,
		codexNeedsDirectory,
		codexDirectory,
		onCreateAgent,
		onCreateTemplate,
	]);

	// H5: Ctrl+Enter anywhere in the form triggers Create
	const handleFormKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter" && e.ctrlKey) {
				e.preventDefault();
				handleCreate();
			}
		},
		[handleCreate],
	);

	const handleNameBlur = useCallback(() => {
		const slugified = toSlug(agentName);
		setAgentName(slugified);
		setShowSlugHint(!SLUG_RE.test(slugified) && slugified !== "");
	}, [agentName]);

	const visibleError = createError && createError !== dismissedError ? createError : null;

	return (
		<div className="agent-basket">
			{/* Header */}
			<div className="agent-basket-header">
				<span className={`agent-basket-header-title${mode === "template" ? " agent-basket-template-header" : ""}`}>
					{mode === "template"
						? "📝 Template Creator"
						: mode === "agent-from-template"
							? "🏗️ Agent Builder (from template)"
							: editMode
								? "✏️ Edit Agent"
								: "🏗️ Agent Builder"}
				</span>
				<div className="agent-basket-header-actions">
					{editMode && onCancelEdit && (
						<button type="button" className="agent-basket-cancel-btn" onClick={onCancelEdit} title="Cancel editing">
							Cancel
						</button>
					)}
					<button
						type="button"
						className={
							mode === "template" ? "agent-basket-template-btn" : editMode ? "agent-basket-save-btn" : "agent-basket-create-btn"
						}
						disabled={!canCreate}
						onClick={handleCreate}
						title={
							mode === "template"
								? "Save template"
								: mode === "agent-from-template" && entries.some((e) => e.kind === "placeholder")
									? "Replace all placeholders before saving"
									: editMode
										? "Save agent changes"
										: "Create selected agent files (.agent.md / .md / AGENTS.md)"
						}>
						{isCreating ? "Saving…" : mode === "template" ? "📝 Save Template" : editMode ? "💾 Save" : "🏗️ Create"}
					</button>
					<button type="button" className="agent-basket-clear-btn" onClick={onClear} title="Clear all">
						✕
					</button>
				</div>
			</div>

			{/* Platform selector */}
			{mode !== "template" && (
				<div className="agent-basket-platforms">
					<label>
						<input
							type="checkbox"
							checked={platforms.has("github")}
							onChange={() =>
								setPlatforms((prev) => {
									const next = new Set(prev);
									next.has("github") ? next.delete("github") : next.add("github");
									return next;
								})
							}
						/>
						GitHub Copilot
					</label>
					<label>
						<input
							type="checkbox"
							checked={platforms.has("claude")}
							onChange={() =>
								setPlatforms((prev) => {
									const next = new Set(prev);
									next.has("claude") ? next.delete("claude") : next.add("claude");
									return next;
								})
							}
						/>
						Claude Code
					</label>
					<label>
						<input
							type="checkbox"
							checked={platforms.has("codex")}
							onChange={() =>
								setPlatforms((prev) => {
									const next = new Set(prev);
									next.has("codex") ? next.delete("codex") : next.add("codex");
									return next;
								})
							}
						/>
						OpenAI Codex (VS Code)
					</label>
				</div>
			)}

			{/* Error banner */}
			{visibleError && (
				<div className="agent-basket-banner-error">
					<span>⚠ {visibleError}</span>
					<button type="button" className="agent-basket-banner-dismiss" onClick={() => setDismissedError(visibleError)}>
						✕
					</button>
				</div>
			)}

			{/* Success banner */}
			{createSuccess && <div className="agent-basket-banner-success">✓ Created: {createSuccess}</div>}

			{/* Content divergence warning (edit mode only) */}
			{editMode && initialValues?.contentDiverged && (
				<div className="agent-basket-banner-warning">
					⚠ Agent data differs between platforms. Saving may overwrite a version with different content.
				</div>
			)}

			{/* Form fields */}
			<div className="agent-basket-form" onKeyDown={handleFormKeyDown}>
				{mode !== "template" && (
					<div className="agent-basket-form-row">
						<label className="agent-basket-form-label">Source</label>
						<select value={projectName} onChange={(e) => setProjectName(e.target.value)}>
							<option value="" disabled>
								— Select source —
							</option>
							{sources.map((s) => (
								<option key={s.name} value={s.name}>
									{s.name} ({s.fileCount} files)
								</option>
							))}
						</select>
					</div>
				)}
				{codexNeedsDirectory && (
					<div className="agent-basket-form-row">
						<label className="agent-basket-form-label">Directory</label>
						<select
							value={codexDirectory}
							onChange={(e) => setCodexDirectory(e.target.value)}>
							<option value="" disabled>
								— Select directory —
							</option>
							{availableCodexDirectories.map((dir) => (
								<option key={dir} value={dir}>
									{dir}
								</option>
							))}
						</select>
					</div>
				)}
				<div className="agent-basket-form-row">
					<label className="agent-basket-form-label">Name</label>
					<input
						type="text"
						value={agentName}
						onChange={(e) => setAgentName(e.target.value)}
						onBlur={handleNameBlur}
						placeholder={mode === "template" ? "my-template-name" : "my-agent-name"}
						className={!slugValid ? "slug-invalid" : ""}
					/>
				</div>
				{showSlugHint && <div className="agent-basket-slug-hint">Lowercase letters, numbers, and hyphens only</div>}
				<div className="agent-basket-form-row">
					<label className="agent-basket-form-label">Desc</label>
					<input
						type="text"
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						placeholder="What does this agent do?"
					/>
				</div>
				<div className="agent-basket-form-row">
					<label className="agent-basket-form-label">Hint</label>
					<input
						type="text"
						value={argumentHint}
						onChange={(e) => setArgumentHint(e.target.value)}
						placeholder="e.g. A task to implement"
					/>
				</div>
				<div className="agent-basket-form-row">
					<label className="agent-basket-form-label">Tools</label>
					<input type="text" value={tools} onChange={(e) => setTools(e.target.value)} placeholder="e.g. read, edit, search" />
				</div>
			</div>

			{/* Knowledge header */}
			<div className="agent-basket-knowledge-header">
				Knowledge <span className="agent-basket-knowledge-count">({entries.length} entries)</span>
				{(() => {
					const totalBytes = entries.reduce((sum, e) => sum + (e.fileSizeBytes ?? 0), 0);
					if (totalBytes === 0) return null;
					const kib = totalBytes / 1024;
					const approxTokens = Math.round(totalBytes / 4);
					const tokensLabel = approxTokens >= 1000 ? `${(approxTokens / 1000).toFixed(1)}k` : String(approxTokens);
					return (
						<span className="agent-basket-knowledge-totals">
							{" "}— {kib.toFixed(1)} KiB ~= {tokensLabel} tokens
						</span>
					);
				})()}
			</div>

			{/* Knowledge list */}
			<div className="agent-basket-knowledge-list" ref={listRef}>
				{entries.length === 0 ? (
					<div className="agent-basket-empty">Click 💾 on card lines to add files as agent knowledge</div>
				) : (
					entries.map((entry, index) => (
						<div
							key={entry.id}
							className={`agent-basket-entry${
								entry.kind === "placeholder"
									? mode === "agent-from-template" && entry.id === activePlaceholderId
										? " agent-basket-entry-placeholder placeholder-active"
										: " agent-basket-entry-placeholder placeholder-pending"
									: entry.kind === "file"
										? " agent-basket-entry-file"
										: " agent-basket-entry-custom"
							}${flashId === entry.id ? " flash" : ""}${editingEntryId === entry.id ? " agent-basket-entry-editing" : ""}`}
							onClick={
								entry.kind === "placeholder" && mode === "agent-from-template" && onSetActivePlaceholder
									? () => onSetActivePlaceholder(entry.id)
									: undefined
							}>
							<div className="agent-basket-entry-controls">
								<button type="button" disabled={index === 0} onClick={() => onMoveUp(entry.id)} title="Move up">
									⬆
								</button>
								<button
									type="button"
									className="remove-btn"
									onClick={() => {
										if (window.confirm("Remove this knowledge entry?")) onRemoveEntry(entry.id);
									}}
									title="Remove">
									✕
								</button>
								<button
									type="button"
									disabled={index === entries.length - 1}
									onClick={() => onMoveDown(entry.id)}
									title="Move down">
									⬇
								</button>
							</div>
							{entry.kind !== "placeholder" ? (
								<button
									type="button"
									className="agent-basket-entry-icon agent-basket-edit-btn"
									title="Edit entry"
									onClick={(e) => {
										e.stopPropagation();
										handleStartEditEntry(entry);
									}}>
									{entry.kind === "file" ? "📄" : "✏️"}
								</button>
							) : (
								<span className="agent-basket-entry-icon">🔲</span>
							)}
							<span className="agent-basket-entry-value" title={entry.value}>
								{entry.kind === "placeholder"
									? mode === "agent-from-template"
										? entry.id === activePlaceholderId
											? "▶ PLACEHOLDER (active — add file/text to fill)"
											: "◻ PLACEHOLDER (click to select)"
										: "PLACEHOLDER"
									: entry.value}
								{entry.kind === "file" &&
									entry.fileSizeBytes !== undefined &&
									entry.value.toLowerCase().endsWith(".md") && (
										<span className="agent-basket-entry-size">
											[{(entry.fileSizeBytes / 1024).toFixed(1)} KiB]
										</span>
									)}
							</span>
						</div>
					))
				)}
			</div>

			{/* Custom knowledge input */}
			<div className="agent-basket-custom-input">
				<textarea
					ref={textareaRef}
					rows={2}
					value={customText}
					onChange={handleTextareaInput}
					onKeyDown={handleTextareaKeyDown}
					placeholder={editingEntryId ? "Editing entry… (Ctrl+Enter to save)" : "Custom knowledge text… (Ctrl+Enter to add)"}
				/>
				<button
					type="button"
					className="confirm-btn"
					disabled={!customText.trim()}
					onClick={handleCommitCustom}
					title="Add custom knowledge entry">
					✓
				</button>
			</div>

			{/* Add Placeholder button (template mode only) */}
			{mode === "template" && onAddPlaceholder && (
				<div className="agent-basket-add-placeholder">
					<button
						type="button"
						className="agent-basket-add-placeholder-btn"
						onClick={onAddPlaceholder}
						title="Add a placeholder entry for template users to fill">
						Add PLACEHOLDER
					</button>
				</div>
			)}
		</div>
	);
}
