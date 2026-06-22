/**
 * PublishAgentDialog — multi-platform publish preview with placement heat and ledger status.
 *
 * Architecture: visualizer/zz-reach2/architecture/agents/archi-agent-builder-ui.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ap-agent-publisher-2.md (Part A/C)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	ArtifactKind,
	CanonicalAgentDefinition,
	LinkStrategy,
	PathHeatResult,
	PlatformCapability,
	PlatformDefaultDirs,
	PublishedTargetSummary,
	PublishPlatform,
	PublishResult,
	PublishTarget,
	PreviewResult,
	PublishStatusResponse,
} from "../../types";
import {
	fetchPublisherHeat,
	fetchPublisherPlatforms,
	fetchPublisherPreview,
	fetchPublisherPublish,
	fetchPublisherStatus,
	fetchPublisherTree,
} from "../../api/agentPublisher";
import PlatformTargetRow from "./PlatformTargetRow";
import PathHeatTree from "./PathHeatTree";
import {
	buildInitialPublisherTargets,
	filterHeatByMdSources,
	formatPublishedArtifactLabel,
	formatPublishStatusLabel,
	initialSelectedMdSourcePaths,
	normalizeLinkStrategy,
	outputDirFromArtifactPath,
	PUBLISHER_PLATFORM_ORDER,
	readLastSelectedPublisherPlatforms,
	resolveDefaultOutputDir,
	resolveFilenameHint,
	resolvePlacementPlatform,
	saveLastSelectedPublisherPlatforms,
	selectedPlatformsFromTargets,
	sortPlatformsByLastSelected,
} from "./publishUtils";
import "./PublishAgentDialog.css";

type Props = {
	open: boolean;
	definition: CanonicalAgentDefinition | null;
	onClose: () => void;
	onPublished: (result: PublishResult) => void;
	/** Appends related markdown paths to the Builder basket and canonical working definition. */
	onExpandContext?: (paths: string[]) => void;
};

type TargetState = {
	selected: boolean;
	artifactKind: ArtifactKind;
	outputDir: string;
	linkStrategy: LinkStrategy;
};

const LABELS: Record<PublishPlatform, string> = {
	copilot: "GitHub Copilot",
	claude: "Claude Code",
	codex: "OpenAI Codex (VS Code)",
	kiro: "Kiro",
	cursor: "Cursor",
	windsurf: "Windsurf",
	antigravity: "Antigravity",
};

/**
 * Builds publish targets from per-platform UI state.
 * @param def - Canonical agent definition being published.
 * @param targets - Per-platform row state map.
 */
function makePublishTargetsFromState(
	def: CanonicalAgentDefinition,
	targets: Record<PublishPlatform, TargetState>,
): PublishTarget[]
{
	return PUBLISHER_PLATFORM_ORDER
		.filter((platform) => targets[platform]?.selected && targets[platform].outputDir)
		.map((platform) => ({
			platform,
			artifactKind: targets[platform].artifactKind,
			outputDir: targets[platform].outputDir,
			codexEntryId: platform === "codex" ? def.id : undefined,
			...(targets[platform].linkStrategy !== "copy"
				? { linkStrategy: targets[platform].linkStrategy }
				: {}),
		}));
}

/** Normalizes markdown absolute paths for chip selection sets. */
function pathKey(filePath: string): string
{
	return filePath.replace(/\\/g, "/").toLowerCase();
}

/**
 * Publish dialog — platform targets, placement heat, ledger status, and Expand Context.
 * @param props - Dialog props including canonical definition and lifecycle callbacks.
 */
export default function PublishAgentDialog({ open, definition, onClose, onPublished, onExpandContext }: Props)
{
	const [capabilities, setCapabilities] = useState<PlatformCapability[]>([]);
	const [nativeDefaults, setNativeDefaults] = useState<Partial<Record<PublishPlatform, PlatformDefaultDirs>>>({});
	const [fullHeat, setFullHeat] = useState<PathHeatResult | null>(null);
	const [tree, setTree] = useState<PathHeatResult["tree"]>([]);
	const [publishStatus, setPublishStatus] = useState<PublishStatusResponse | null>(null);
	const [selectedMdPaths, setSelectedMdPaths] = useState<Set<string>>(new Set());
	const [preview, setPreview] = useState<PreviewResult | null>(null);
	const [publishResult, setPublishResult] = useState<PublishResult | null>(null);
	const [loading, setLoading] = useState(false);
	const [previewLoading, setPreviewLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [activePlatform, setActivePlatform] = useState<PublishPlatform>("codex");
	const [selectedPublishedArtifactKey, setSelectedPublishedArtifactKey] = useState("");
	const [knowledgeExpanded, setKnowledgeExpanded] = useState(false);
	const [targets, setTargets] = useState<Record<PublishPlatform, TargetState>>(() =>
		Object.fromEntries(PUBLISHER_PLATFORM_ORDER.map((p) => [p, { selected: false, artifactKind: "agent" as ArtifactKind, outputDir: "", linkStrategy: "copy" as LinkStrategy }])) as Record<PublishPlatform, TargetState>,
	);
	const [platformOrder, setPlatformOrder] = useState<PublishPlatform[]>(() =>
		sortPlatformsByLastSelected(readLastSelectedPublisherPlatforms()),
	);
	const previewTimer = useRef<number | null>(null);

	const supportedKinds = useMemo(() =>
	{
		const map = new Map<PublishPlatform, ArtifactKind[]>();
		for (const cap of capabilities) map.set(cap.platform, cap.supportedArtifactKinds);
		return map;
	}, [capabilities]);

	const filteredHeat = useMemo(() =>
	{
		if (!fullHeat) return null;
		return filterHeatByMdSources(fullHeat, selectedMdPaths);
	}, [fullHeat, selectedMdPaths]);

	const resetTransient = useCallback(() =>
	{
		setPreview(null);
		setPublishResult(null);
		setError(null);
		setKnowledgeExpanded(false);
	}, []);

	const loadHeat = useCallback(async (def: CanonicalAgentDefinition) =>
	{
		if (!def.knowledge.some((k) => k.kind === "file")) return null;
		const heatRes = await fetchPublisherHeat(def);
		setFullHeat(heatRes);
		setSelectedMdPaths(initialSelectedMdSourcePaths(heatRes.mdSources));
		return heatRes;
	}, []);

	const refreshStatus = useCallback(async (canonicalId: string) =>
	{
		const status = await fetchPublisherStatus(canonicalId);
		setPublishStatus(status);
		return status;
	}, []);

	useEffect(() =>
	{
		if (!open || !definition) return;
		resetTransient();
		const lastSelected = readLastSelectedPublisherPlatforms();
		setPlatformOrder(sortPlatformsByLastSelected(lastSelected));
		setLoading(true);
		Promise.all([
			fetchPublisherPlatforms(definition.projectName),
			fetchPublisherTree(definition.projectName),
			refreshStatus(definition.id),
		])
			.then(([platformsRes, treeRes, statusRes]) =>
			{
				setCapabilities(platformsRes.platforms);
				const defaults: Partial<Record<PublishPlatform, PlatformDefaultDirs>> = {};
				for (const cap of platformsRes.platforms)
				{
					if (cap.defaultDirs) defaults[cap.platform] = cap.defaultDirs;
				}
				setNativeDefaults(defaults);
				setTree(treeRes.tree);
				const initialTargets = buildInitialPublisherTargets(platformsRes.platforms, statusRes.publishedTo, lastSelected);
				setTargets(initialTargets);
				setActivePlatform(resolvePlacementPlatform(initialTargets, "codex"));
			})
			.catch((err) => setError(err instanceof Error ? err.message : String(err)))
			.finally(() => setLoading(false));
	// Business logic: re-init only when dialog opens for a different canonical id — not on Expand Context knowledge edits.
	}, [open, definition?.id, resetTransient, refreshStatus]);

	const knowledgeSignature = useMemo(
		() => JSON.stringify(definition?.knowledge ?? []),
		[definition?.knowledge],
	);

	// Business logic: Expand Context mutates parent definition knowledge — re-heat without closing Publisher.
	useEffect(() =>
	{
		if (!open || !definition) return;
		if (!definition.knowledge.some((k) => k.kind === "file")) return;
		loadHeat(definition).catch((err) => setError(err instanceof Error ? err.message : String(err)));
	}, [open, knowledgeSignature, definition, loadHeat]);

	const runPreview = useCallback((def: CanonicalAgentDefinition, nextTargets: Record<PublishPlatform, TargetState>) =>
	{
		const publishTargets = makePublishTargetsFromState(def, nextTargets);
		if (publishTargets.length === 0)
		{
			setPreview(null);
			return;
		}
		setPreviewLoading(true);
		fetchPublisherPreview({ definition: def, targets: publishTargets })
			.then((result) => setPreview(result))
			.catch((err) => setError(err instanceof Error ? err.message : String(err)))
			.finally(() => setPreviewLoading(false));
	}, []);

	useEffect(() =>
	{
		if (!open || !definition) return;
		if (previewTimer.current) window.clearTimeout(previewTimer.current);
		previewTimer.current = window.setTimeout(() => runPreview(definition, targets), 400);
		return () =>
		{
			if (previewTimer.current) window.clearTimeout(previewTimer.current);
		};
	}, [open, definition, targets, runPreview]);

	// Business logic: remember checked platforms for the next Publisher open and list ordering.
	useEffect(() =>
	{
		if (!open) return;
		saveLastSelectedPublisherPlatforms(selectedPlatformsFromTargets(targets));
	}, [open, targets]);

	const handlePublish = useCallback(async () =>
	{
		if (!definition) return;
		const publishTargets = makePublishTargetsFromState(definition, targets);
		if (publishTargets.length === 0)
		{
			setError("Select at least one platform with an output directory.");
			return;
		}
		setLoading(true);
		setError(null);
		try
		{
			const result = await fetchPublisherPublish({ definition, targets: publishTargets });
			setPublishResult(result);
			if (result.errors.length === 0)
			{
				onPublished(result);
				await refreshStatus(definition.id);
			}
			else setError(result.errors.join("; "));
		} catch (err)
		{
			setError(err instanceof Error ? err.message : String(err));
		} finally
		{
			setLoading(false);
		}
	}, [definition, targets, onPublished, refreshStatus]);

	const toggleMdSource = useCallback((absolutePath: string) =>
	{
		const key = pathKey(absolutePath);
		setSelectedMdPaths((prev) =>
		{
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);

	const relatedCheckedNotInBasket = useMemo(() =>
	{
		if (!fullHeat?.mdSources) return [];
		return fullHeat.mdSources.filter((source) =>
			source.isRelated
			&& !source.inBasket
			&& selectedMdPaths.has(pathKey(source.absolutePath)),
		);
	}, [fullHeat?.mdSources, selectedMdPaths]);

	const publishedArtifacts = useMemo(() =>
	{
		const rows = publishStatus?.publishedArtifacts ?? [];
		// Business logic: newest publishes first in the "Already published" dropdown.
		return [...rows].reverse();
	}, [publishStatus?.publishedArtifacts]);

	const handleExpandContext = useCallback(() =>
	{
		if (!onExpandContext || relatedCheckedNotInBasket.length === 0) return;
		onExpandContext(relatedCheckedNotInBasket.map((source) => source.absolutePath));
		setKnowledgeExpanded(true);
	}, [onExpandContext, relatedCheckedNotInBasket]);

	const applyOutputDirForPlatform = useCallback((platform: PublishPlatform, absolutePath: string) =>
	{
		setActivePlatform(platform);
		setTargets((prev) => ({
			...prev,
			[platform]: { ...prev[platform], outputDir: absolutePath },
		}));
	}, []);

	const handlePublishedArtifactPick = useCallback((artifactIndex: string) =>
	{
		setSelectedPublishedArtifactKey(artifactIndex);
		if (!artifactIndex) return;
		const entry = publishedArtifacts[Number(artifactIndex)];
		if (!entry) return;
		const outputDir = outputDirFromArtifactPath(entry.absolutePath);
		setActivePlatform(entry.platform);
		setTargets((prev) => ({
			...prev,
			[entry.platform]: {
				...prev[entry.platform],
				selected: true,
				artifactKind: entry.artifactKind,
				outputDir: outputDir || prev[entry.platform].outputDir,
				linkStrategy: entry.linkStrategy
					? normalizeLinkStrategy(entry.platform, entry.artifactKind, entry.linkStrategy)
					: prev[entry.platform].linkStrategy,
			},
		}));
	}, [publishedArtifacts]);

	if (!open || !definition) return null;

	const placementPlatform = resolvePlacementPlatform(targets, activePlatform);
	const selectedDir = targets[placementPlatform]?.outputDir;
	const heatSuggestedDir = filteredHeat?.suggestedOutputDir;
	const publishedTo = publishStatus?.publishedTo ?? [];
	const driftWarnings = publishStatus?.drift?.entries?.filter((entry) => entry.state !== "clean") ?? [];

	return (
		<div className="publish-agent-overlay" role="dialog" aria-modal="true" aria-label="Publish Agent">
			<div className="publish-agent-dialog">
				<div className="publish-agent-header">
					<h2>Publish to Project — {definition.name}</h2>
					<button type="button" onClick={() => { resetTransient(); onClose(); }}>Close</button>
				</div>

				{loading && <div>Loading publisher data…</div>}
				{error && <div className="publish-agent-error">{error}</div>}
				{driftWarnings.length > 0 && (
					<div className="publish-agent-warn">
						Drift detected on {driftWarnings.length} published artifact(s). Review before confirming publish.
					</div>
				)}
				{knowledgeExpanded && (
					<div className="publish-agent-warn">
						Knowledge basket was expanded in this session. Save the agent in Builder before relying on canonical storage.
					</div>
				)}

				<div className="publish-agent-grid">
					<div className="publish-agent-section">
						<h3>Platforms</h3>
						{platformOrder.map((platform) =>
						{
							const cap = capabilities.find((item) => item.platform === platform);
							const supported = (supportedKinds.get(platform)?.length ?? 0) > 0;
							const state = targets[platform];
							const defaultDirs = nativeDefaults[platform];
							const nativeAgentDir = defaultDirs?.agentOutputDir;
							const publishedRow = publishedTo.find(
								(entry) => entry.platform === platform && entry.artifactKind === state.artifactKind,
							);
							return (
								<PlatformTargetRow
									key={platform}
									platform={platform}
									label={LABELS[platform]}
									selected={state.selected}
									supported={supported}
									artifactKind={state.artifactKind}
									outputDir={state.outputDir}
									linkStrategy={state.linkStrategy}
									supportedLinkStrategies={
										cap?.supportedLinkStrategiesByKind?.[state.artifactKind]
										?? cap?.supportedLinkStrategies
									}
									platformNotes={cap?.notes}
									filenameHint={resolveFilenameHint(definition, platform, state.artifactKind, state.outputDir, cap)}
									nativeDefaultDir={
										state.artifactKind === "skill"
											? defaultDirs?.skillRootDir
											: nativeAgentDir
									}
									heatSuggestedDir={heatSuggestedDir}
									publishStatusLabel={formatPublishStatusLabel(platform, state.artifactKind, publishedTo)}
									lastPublishedPath={publishedRow?.absolutePath}
									onHeatSuggestedSelect={(absolutePath) => applyOutputDirForPlatform(platform, absolutePath)}
									onToggle={() =>
									{
										setActivePlatform(platform);
										setTargets((prev) => ({
											...prev,
											[platform]: { ...prev[platform], selected: !prev[platform].selected },
										}));
									}}
									onArtifactKindChange={(kind) =>
									{
										setActivePlatform(platform);
										setTargets((prev) => ({
											...prev,
											[platform]: {
												...prev[platform],
												artifactKind: kind,
												outputDir: resolveDefaultOutputDir(defaultDirs, kind) || prev[platform].outputDir,
												linkStrategy: normalizeLinkStrategy(platform, kind, prev[platform].linkStrategy),
											},
										}));
									}}
									onLinkStrategyChange={(strategy) =>
									{
										setActivePlatform(platform);
										setTargets((prev) => ({
											...prev,
											[platform]: { ...prev[platform], linkStrategy: strategy },
										}));
									}}
									onPickDirectory={() => setActivePlatform(platform)}
								/>
							);
						})}
					</div>

					<div className="publish-agent-section">
						<h3>Placement</h3>
						<p className="publish-agent-placement-note">
							Directory picks apply to the active platform ({LABELS[placementPlatform]}). Select markdown sources to filter directory heat.
						</p>
						{filteredHeat && filteredHeat.totalHits === 0 && (
							<div>No directory heat for the selected markdown sources. Pick a folder manually or enable more source chips.</div>
						)}
						{fullHeat?.mdSources && fullHeat.mdSources.length > 0 && (
							<div className="publish-placement-md-sources">
								<div className="publish-placement-caption">
									Markdown sources — basket docs are checked by default; related link discoveries are optional.
								</div>
								<div className="publish-md-source-chips">
									{fullHeat.mdSources.map((source) =>
									{
										const checked = selectedMdPaths.has(pathKey(source.absolutePath));
										return (
											<label key={source.absolutePath} className={`publish-md-chip${source.isRelated ? " is-related" : ""}`}>
												<input
													type="checkbox"
													checked={checked}
													onChange={() => toggleMdSource(source.absolutePath)}
												/>
												<span title={source.absolutePath}>
													{source.displayPath}
													{source.isRelated ? " (related)" : ""}
												</span>
											</label>
										);
									})}
								</div>
								{onExpandContext && relatedCheckedNotInBasket.length > 0 && (
									<button type="button" className="publish-expand-context-btn" onClick={handleExpandContext}>
										Expand Context ({relatedCheckedNotInBasket.length})
									</button>
								)}
							</div>
						)}
						<div className="publish-placement-caption publish-placement-tree-caption">
							Directory tree — warmer folders were referenced more often in the selected markdown sources. Click a folder to set the output directory for {LABELS[placementPlatform]}.
						</div>
						<PathHeatTree
							nodes={filteredHeat?.tree?.length ? filteredHeat.tree : tree}
							selectedPath={selectedDir}
							suggestedPath={heatSuggestedDir}
							onSelect={(absolutePath) =>
							{
								const platform = resolvePlacementPlatform(targets, activePlatform);
								applyOutputDirForPlatform(platform, absolutePath);
							}}
						/>
					</div>
				</div>

				<div className="publish-agent-section" style={{ marginTop: 12 }}>
					<h3>Preview {previewLoading ? "(updating…)" : ""}</h3>
					{preview?.errors?.length ? <div className="publish-agent-error">{preview.errors.join("; ")}</div> : null}
					<div className="publish-preview-list">
						{(preview?.artifacts ?? []).filter((a) => !a.absolutePath.endsWith(".json")).map((artifact) => (
							<div key={artifact.absolutePath}>
								[{artifact.previewStatus ?? "unknown"}]
								{artifact.materialization?.actualLinkStrategy
									? ` ${artifact.materialization.actualLinkStrategy}`
									: ""}{" "}
								{artifact.absolutePath}
							</div>
						))}
					</div>
				</div>

				{publishedArtifacts.length > 0 && (
					<div className="publish-agent-section publish-agent-published-history">
						<label className="publish-agent-published-label" htmlFor="publish-agent-published-select">
							Already published:
						</label>
						<select
							id="publish-agent-published-select"
							className="publish-agent-published-select"
							value={selectedPublishedArtifactKey}
							onChange={(e) => handlePublishedArtifactPick(e.target.value)}>
							<option value="">Select a previous publish…</option>
							{publishedArtifacts.map((entry, index) => (
								<option key={`${entry.publishedAt}-${entry.absolutePath}-${index}`} value={String(index)}>
									{formatPublishedArtifactLabel(entry, LABELS[entry.platform])}
								</option>
							))}
						</select>
					</div>
				)}

				{publishResult && (
					<div className="publish-agent-success">
						Published {publishResult.written.length} artifact(s).
						{publishResult.warnings.map((w) => <div key={w}>{w}</div>)}
					</div>
				)}

				<div className="publish-agent-actions">
					<button type="button" onClick={() => { resetTransient(); onClose(); }}>Close</button>
					<button
						type="button"
						className="primary"
						disabled={loading || previewLoading || (preview?.errors?.length ?? 0) > 0}
						onClick={handlePublish}>
						Confirm Publish
					</button>
				</div>
			</div>
		</div>
	);
}

export { makePublishTargetsFromState, resolveFilenameHint as filenameHint };
