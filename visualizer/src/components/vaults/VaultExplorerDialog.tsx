/**
 * Vault Explorer modal — read-only server directory browse with Save-only cc.json mutation.
 *
 * Architecture: visualizer/zz-reach2/architecture/agents/archi-agent-builder-ui.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ve-vault-explorer.md (§19–22, §28–29)
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
	createVault,
	fetchVaultChildren,
	fetchVaultInfo,
	fetchVaultRoots,
	updateVault,
	type CreateVaultResponse,
	type UpdateVaultResponse,
	type VaultChildrenResponse,
	type VaultInfoResponse,
	type VaultRoot,
} from "../../api/vaults";
import {
	applyUseVaultNameSuggestion,
	applyVaultNameOnPathChange,
} from "./vaultFormUtils";
import {
	buildVaultExplorerSubtitle,
	computeCanSaveVault,
	onDirectoryRowKeyDown,
	shouldShowAlreadyConfiguredError,
	type VaultExplorerMode,
} from "./vaultNavigationUtils";
import "./VaultExplorerDialog.css";

/** Existing vault row opened from Vault Manager for metadata edit. */
export type VaultEditEntry = {
	path: string;
	name: string;
	type: string;
	agentPath?: string;
};

type Props = {
	/** When false the dialog is not mounted — browse state resets on next open. */
	open: boolean;
	/** Add creates a new cc.json row; edit PATCHes metadata for {@link editEntry}. */
	mode: VaultExplorerMode;
	/** Populated when mode is edit — cc.json lookup key and initial field values. */
	editEntry?: VaultEditEntry;
	/** Closes without mutating cc.json or refreshing AgentBuilder sources. */
	onClose: () => void;
	/** Called after successful Save Vault with prepare payload for source refresh. */
	onSaved: (result: CreateVaultResponse) => void;
	/** Called after successful Save changes (PATCH) with prepare payload. */
	onUpdated: (result: UpdateVaultResponse) => void;
};

/** Empty dialog state used when opening a fresh explorer session. */
function createInitialDialogState(): {
	roots: VaultRoot[];
	children: VaultChildrenResponse | null;
	selectedPath: string;
	manualPath: string;
	vaultInfo: VaultInfoResponse | null;
	vaultName: string;
	vaultType: string;
	vaultNameTouched: boolean;
	suggestionBasename: string | null;
	loading: boolean;
	saving: boolean;
	error: string | null;
	success: string | null;
}
{
	return {
		roots: [],
		children: null,
		selectedPath: "",
		manualPath: "",
		vaultInfo: null,
		vaultName: "",
		vaultType: "Vault",
		vaultNameTouched: false,
		suggestionBasename: null,
		loading: false,
		saving: false,
		error: null,
		success: null,
	};
}

/**
 * Polished Vault Explorer overlay — Publisher dialog visual language, Save-only persistence.
 * @param props - Open/close lifecycle, add/edit mode, and post-save callbacks.
 */
export default function VaultExplorerDialog({
	open,
	mode,
	editEntry,
	onClose,
	onSaved,
	onUpdated,
}: Props)
{
	const [roots, setRoots] = useState<VaultRoot[]>([]);
	const [children, setChildren] = useState<VaultChildrenResponse | null>(null);
	const [selectedPath, setSelectedPath] = useState("");
	const [manualPath, setManualPath] = useState("");
	const [vaultInfo, setVaultInfo] = useState<VaultInfoResponse | null>(null);
	const [vaultName, setVaultName] = useState("");
	const [vaultType, setVaultType] = useState("Vault");
	const [vaultNameTouched, setVaultNameTouched] = useState(false);
	const [suggestionBasename, setSuggestionBasename] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState<string | null>(null);
	const overlayRef = useRef<HTMLDivElement>(null);
	const vaultNameRef = useRef(vaultName);
	const vaultNameTouchedRef = useRef(vaultNameTouched);

	useEffect(() => { vaultNameRef.current = vaultName; }, [vaultName]);
	useEffect(() => { vaultNameTouchedRef.current = vaultNameTouched; }, [vaultNameTouched]);

	/**
	 * Clears stale browse/save feedback when the user opens a new explorer session.
	 */
	const resetDialogState = useCallback(() =>
	{
		const initial = createInitialDialogState();
		setRoots(initial.roots);
		setChildren(initial.children);
		setSelectedPath(initial.selectedPath);
		setManualPath(initial.manualPath);
		setVaultInfo(initial.vaultInfo);
		setVaultName(initial.vaultName);
		setVaultType(initial.vaultType);
		setVaultNameTouched(initial.vaultNameTouched);
		setSuggestionBasename(initial.suggestionBasename);
		setLoading(initial.loading);
		setSaving(initial.saving);
		setError(initial.error);
		setSuccess(initial.success);
	}, []);

	/**
	 * Applies vault name suggestion rules after path validation.
	 * @param info - Server vault-info response for the selected path.
	 * @param currentName - Current Vault name field value.
	 * @param nameTouched - Whether the user has edited the Vault name field.
	 */
	const applyNameSuggestionFromInfo = useCallback((
		info: VaultInfoResponse,
		currentName: string,
		nameTouched: boolean,
	) =>
	{
		const result = applyVaultNameOnPathChange({
			currentName,
			suggestedBasename: info.name,
			nameTouched,
		});
		setVaultName(result.nextName);
		setSuggestionBasename(result.showSuggestionHint ? result.suggestionBasename : null);
	}, []);

	/**
	 * Validates a directory path and updates details — does not list children or mutate config.
	 * @param path - Absolute directory path to inspect.
	 * @param applySuggestion - When true, runs vault name suggestion for the new path.
	 */
	const selectDirectory = useCallback(async (path: string, applySuggestion: boolean) =>
	{
		if (!path.trim())
		{
			setVaultInfo(null);
			setSelectedPath("");
			return;
		}

		setSelectedPath(path);
		setError(null);
		try
		{
			const info = await fetchVaultInfo(path);
			setVaultInfo(info);
			if (applySuggestion)
			{
				const result = applyVaultNameOnPathChange({
					currentName: vaultNameRef.current,
					suggestedBasename: info.name,
					nameTouched: vaultNameTouchedRef.current,
				});
				setVaultName(result.nextName);
				setSuggestionBasename(result.showSuggestionHint ? result.suggestionBasename : null);
			}
		}
		catch (err)
		{
			setVaultInfo(null);
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	/**
	 * Navigates into a directory — read-only children listing; never calls Save or prepare.
	 * @param path - Directory to open in the explorer list.
	 */
	const openDirectory = useCallback(async (path: string) =>
	{
		if (!path.trim()) return;

		setLoading(true);
		setError(null);
		try
		{
			const result = await fetchVaultChildren(path);
			setChildren(result);
			setManualPath(result.path);
			await selectDirectory(result.path, true);
		}
		catch (err)
		{
			setError(err instanceof Error ? err.message : String(err));
		}
		finally
		{
			setLoading(false);
		}
	}, [selectDirectory]);

	// Business logic: initial roots load runs once per open — cancellation prevents stale updates after close.
	useEffect(() =>
	{
		if (!open) return;

		resetDialogState();
		let cancelled = false;

		(async () =>
		{
			// Business logic: edit mode opens at the configured vault path — skip generic first-root browse.
			if (mode === "edit" && editEntry)
			{
				setVaultName(editEntry.name);
				setVaultType(editEntry.type);
				setVaultNameTouched(true);
				setLoading(true);
				try
				{
					await openDirectory(editEntry.path);
				}
				catch (err)
				{
					if (!cancelled) setError(err instanceof Error ? err.message : String(err));
				}
				finally
				{
					if (!cancelled) setLoading(false);
				}
				return;
			}

			setLoading(true);
			setError(null);
			try
			{
				const { roots: loaded } = await fetchVaultRoots();
				if (cancelled) return;
				setRoots(loaded);
				if (!loaded[0]) return;

				const result = await fetchVaultChildren(loaded[0].path);
				if (cancelled) return;
				setChildren(result);
				setSelectedPath(result.path);
				setManualPath(result.path);

				const info = await fetchVaultInfo(result.path);
				if (cancelled) return;
				setVaultInfo(info);
				applyNameSuggestionFromInfo(info, "", false);
			}
			catch (err)
			{
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			}
			finally
			{
				if (!cancelled) setLoading(false);
			}
		})();

		return () => { cancelled = true; };
	}, [open, mode, editEntry?.path, editEntry?.name, editEntry?.type, resetDialogState, openDirectory, applyNameSuggestionFromInfo]);

	/**
	 * Persists the selected vault — the only code path that mutates cc.json from this dialog.
	 */
	const handleSave = useCallback(async () =>
	{
		const canSave = computeCanSaveVault({
			mode,
			selectedPath,
			editPath: editEntry?.path,
			vaultName,
			vaultInfo,
			loading,
			saving,
		});
		if (!canSave) return;

		setSaving(true);
		setError(null);
		setSuccess(null);
		try
		{
			if (mode === "edit" && editEntry)
			{
				const result = await updateVault({
					path: editEntry.path,
					name: vaultName.trim(),
					type: vaultType.trim() || "Vault",
					agentPath: editEntry.agentPath,
				});
				setSuccess(`Updated vault "${result.entry.name}"`);
				onUpdated(result);
				onClose();
				return;
			}

			const result = await createVault({
				path: selectedPath,
				name: vaultName.trim(),
				type: vaultType.trim() || "Vault",
			});
			setSuccess(`Saved vault "${result.entry.name}"`);
			onSaved(result);
			onClose();
		}
		catch (err)
		{
			setError(err instanceof Error ? err.message : String(err));
		}
		finally
		{
			setSaving(false);
		}
	}, [
		mode,
		editEntry,
		selectedPath,
		vaultName,
		vaultType,
		vaultInfo,
		loading,
		saving,
		onSaved,
		onUpdated,
		onClose,
	]);

	/**
	 * Applies the basename suggestion from the hint row below Vault name.
	 */
	const handleUseSuggestion = useCallback(() =>
	{
		if (!suggestionBasename) return;
		const applied = applyUseVaultNameSuggestion(suggestionBasename);
		setVaultName(applied.nextName);
		setVaultNameTouched(applied.nameTouched);
		setSuggestionBasename(null);
	}, [suggestionBasename]);

	/**
	 * Overlay keyboard shortcuts — Escape closes; Ctrl/Meta+Enter saves when allowed.
	 * @param event - Key event on the modal overlay.
	 */
	const handleOverlayKeyDown = useCallback((event: KeyboardEvent) =>
	{
		if (event.key === "Escape")
		{
			event.preventDefault();
			onClose();
			return;
		}

		const canSave = computeCanSaveVault({
			mode,
			selectedPath,
			editPath: editEntry?.path,
			vaultName,
			vaultInfo,
			loading,
			saving,
		});
		// Business logic: power users expect a confirm shortcut matching Publisher dialog patterns.
		if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && canSave)
		{
			event.preventDefault();
			void handleSave();
		}
	}, [mode, editEntry?.path, selectedPath, vaultName, vaultInfo, loading, saving, onClose, handleSave]);

	const canSave = computeCanSaveVault({
		mode,
		selectedPath,
		editPath: editEntry?.path,
		vaultName,
		vaultInfo,
		loading,
		saving,
	});

	const subtitle = buildVaultExplorerSubtitle(
		mode,
		mode === "edit" && editEntry ? editEntry.path : selectedPath,
		editEntry?.name,
	);

	const showDuplicateError = vaultInfo
		? shouldShowAlreadyConfiguredError(mode, editEntry?.path, selectedPath, vaultInfo.alreadyConfigured)
		: false;

	if (!open) return null;

	return (
		<div
			ref={overlayRef}
			className="vault-explorer-overlay"
			role="dialog"
			aria-modal="true"
			aria-label="Vault Explorer"
			onKeyDown={handleOverlayKeyDown}
			onClick={(event) =>
			{
				if (event.target === overlayRef.current) onClose();
			}}>
			<div className="vault-explorer-dialog">
				<div className="vault-explorer-header">
					<div>
						<h2>Vault Explorer</h2>
						<p className="vault-explorer-subtitle">{subtitle}</p>
					</div>
					<button type="button" className="vault-explorer-close" onClick={onClose}>Close</button>
				</div>

				{loading && <div className="vault-explorer-status">Loading directories…</div>}
				{error && <div className="vault-explorer-error">{error}</div>}
				{success && <div className="vault-explorer-success">{success}</div>}

				<div className="vault-explorer-grid">
					<div className="vault-explorer-section vault-explorer-browse">
						<h3>Browse</h3>

						<div className="vault-explorer-roots" role="group" aria-label="Browse roots">
							{roots.map((root) => (
								<button
									key={root.path}
									type="button"
									className={`vault-explorer-root-chip${children?.path.startsWith(root.path) ? " active" : ""}`}
									onClick={() => void openDirectory(root.path)}
									disabled={loading || saving}
									title={root.path}>
									{root.label}
								</button>
							))}
						</div>

						{children?.parentPath && (
							<button
								type="button"
								className="vault-explorer-up"
								onClick={() => void openDirectory(children.parentPath!)}
								disabled={loading || saving}>
								↑ Up
							</button>
						)}

						{children && (
							<nav className="vault-explorer-breadcrumbs" aria-label="Breadcrumbs">
								{children.breadcrumbs.map((crumb, index) => (
									<span key={crumb.path} className="vault-explorer-crumb-wrap">
										{index > 0 && <span className="vault-explorer-crumb-sep">/</span>}
										<button
											type="button"
											className="vault-explorer-breadcrumb"
											onClick={() => void openDirectory(crumb.path)}
											disabled={loading || saving}
											title={crumb.path}>
											{crumb.name}
										</button>
									</span>
								))}
							</nav>
						)}

						<div className="vault-explorer-dir-list" role="listbox" aria-label="Child directories">
							{children?.directories.map((entry) => (
								<div
									key={entry.path}
									role="option"
									tabIndex={0}
									aria-selected={selectedPath === entry.path}
									className={`vault-dir-row${selectedPath === entry.path ? " is-selected" : ""}${!entry.readable ? " is-unreadable" : ""}`}
									title={entry.path}
									onClick={() => void selectDirectory(entry.path, true)}
									onDoubleClick={() => void openDirectory(entry.path)}
									onKeyDown={(event) =>
										onDirectoryRowKeyDown(event, entry.path, {
											selectDirectory: (path) => void selectDirectory(path, true),
											openDirectory: (path) => void openDirectory(path),
										})}>
									<span className="vault-dir-icon" aria-hidden="true">📁</span>
									<span className="vault-dir-name">{entry.name}</span>
									<span className="vault-dir-path-hint">{entry.path}</span>
									{!entry.readable && <span className="vault-dir-badge">unreadable</span>}
									<button
										type="button"
										className="vault-dir-open-btn"
										onClick={(event) =>
										{
											event.stopPropagation();
											void openDirectory(entry.path);
										}}
										disabled={loading || saving}
										title="Open directory"
										aria-label={`Open ${entry.name}`}>
										→
									</button>
								</div>
							))}
							{children && children.directories.length === 0 && (
								<div className="vault-explorer-empty">No subdirectories in this folder.</div>
							)}
						</div>

						<div className="vault-explorer-manual">
							<input
								type="text"
								value={manualPath}
								onChange={(e) => setManualPath(e.target.value)}
								onKeyDown={(event) =>
								{
									if (event.key === "Enter" && manualPath.trim() && !loading && !saving)
									{
										event.preventDefault();
										void openDirectory(manualPath);
									}
								}}
								placeholder="Paste absolute path"
								aria-label="Manual absolute path"
								disabled={saving}
							/>
							<button
								type="button"
								onClick={() => void openDirectory(manualPath)}
								disabled={!manualPath.trim() || loading || saving}
								title="Navigate to this folder">
								Go
							</button>
						</div>
					</div>

					<div className="vault-explorer-section vault-explorer-details">
						<h3>Vault details</h3>

						<label className="vault-explorer-field vault-explorer-field-primary">
							<span className="vault-explorer-label">Vault name</span>
							<input
								type="text"
								value={vaultName}
								onChange={(e) =>
								{
									setVaultNameTouched(true);
									setVaultName(e.target.value);
								}}
								disabled={saving}
								aria-label="Vault name"
							/>
							<span className="vault-explorer-field-hint">
								Shown in the source filter; stored as <code>name</code> in cc.json.
							</span>
						</label>

						{suggestionBasename && (
							<div className="vault-explorer-name-hint">
								Suggested name for this folder: <strong>{suggestionBasename}</strong>
								<button type="button" onClick={handleUseSuggestion}>Use suggestion</button>
							</div>
						)}

						<label className="vault-explorer-field">
							<span className="vault-explorer-label">Vault type</span>
							<input
								type="text"
								value={vaultType}
								onChange={(e) => setVaultType(e.target.value)}
								disabled={saving}
								aria-label="Vault type"
							/>
						</label>

						{vaultInfo ? (
							<div className="vault-explorer-info">
								<div className="vault-explorer-info-row">
									<span className="vault-explorer-label">{mode === "edit" ? "Vault path" : "Path"}</span>
									<span className="vault-explorer-value">
										{mode === "edit" && editEntry ? editEntry.path : vaultInfo.path}
									</span>
								</div>
								{mode === "add" && (
									<div className="vault-explorer-info-row">
										<span className="vault-explorer-label">Defaults</span>
										<span className="vault-explorer-value">
											category <code>vaults</code>, projectRoot = selected path
										</span>
									</div>
								)}
								{!vaultInfo.readable && (
									<div className="vault-explorer-warn">Directory is not readable by the server — Save is blocked.</div>
								)}
								{showDuplicateError && (
									<div className="vault-explorer-error-inline">Already an AgentBuilder source.</div>
								)}
								{vaultInfo.warnings.length > 0 && (
									<ul className="vault-explorer-warnings">
										{vaultInfo.warnings.map((warning) => <li key={warning}>{warning}</li>)}
									</ul>
								)}
							</div>
						) : (
							<div className="vault-explorer-empty">Select a directory to see validation details.</div>
						)}
					</div>
				</div>

				<div className="vault-explorer-actions">
					<button type="button" onClick={onClose} disabled={saving}>Cancel</button>
					<button
						type="button"
						className="vault-explorer-primary"
						disabled={!canSave}
						onClick={() => void handleSave()}>
						{saving ? "Saving…" : mode === "edit" ? "Save changes" : "Save Vault"}
					</button>
				</div>
			</div>
		</div>
	);
}
