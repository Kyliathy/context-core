import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	ArtifactKind,
	CanonicalAgentDefinition,
	PathHeatResult,
	PlatformCapability,
	PlatformDefaultDirs,
	PublishPlatform,
	PublishResult,
	PublishTarget,
	PreviewResult,
} from "../../types";
import {
	fetchPublisherHeat,
	fetchPublisherPlatforms,
	fetchPublisherPreview,
	fetchPublisherPublish,
	fetchPublisherTree,
} from "../../api/agentPublisher";
import PlatformTargetRow from "./PlatformTargetRow";
import PathHeatTree, { findNearestDirectoryForTopPath } from "./PathHeatTree";
import { resolveDefaultOutputDir, resolveFilenameHint } from "./publishUtils";
import "./PublishAgentDialog.css";

type Props = {
	open: boolean;
	definition: CanonicalAgentDefinition | null;
	onClose: () => void;
	onPublished: (result: PublishResult) => void;
};

type TargetState = {
	selected: boolean;
	artifactKind: ArtifactKind;
	outputDir: string;
};

const PLATFORM_ORDER: PublishPlatform[] = ["codex", "claude", "copilot", "kiro", "cursor", "windsurf", "antigravity"];

const LABELS: Record<PublishPlatform, string> = {
	copilot: "GitHub Copilot",
	claude: "Claude Code",
	codex: "OpenAI Codex (VS Code)",
	kiro: "Kiro",
	cursor: "Cursor",
	windsurf: "Windsurf",
	antigravity: "Antigravity",
};

function makePublishTargetsFromState(
	def: CanonicalAgentDefinition,
	targets: Record<PublishPlatform, TargetState>,
): PublishTarget[]
{
	return PLATFORM_ORDER
		.filter((platform) => targets[platform]?.selected && targets[platform].outputDir)
		.map((platform) => ({
			platform,
			artifactKind: targets[platform].artifactKind,
			outputDir: targets[platform].outputDir,
			codexEntryId: platform === "codex" ? def.id : undefined,
		}));
}

function buildInitialTargets(
	platforms: PlatformCapability[],
): Record<PublishPlatform, TargetState>
{
	const next = Object.fromEntries(
		PLATFORM_ORDER.map((p) => [p, { selected: false, artifactKind: "agent" as ArtifactKind, outputDir: "" }]),
	) as Record<PublishPlatform, TargetState>;

	for (const platform of PLATFORM_ORDER)
	{
		const cap = platforms.find((item) => item.platform === platform);
		const outputDir = resolveDefaultOutputDir(cap?.defaultDirs, "agent");
		next[platform] = {
			selected: platform === "copilot" || platform === "claude" || platform === "codex",
			artifactKind: "agent",
			outputDir,
		};
	}
	return next;
}

export default function PublishAgentDialog({ open, definition, onClose, onPublished }: Props)
{
	const [capabilities, setCapabilities] = useState<PlatformCapability[]>([]);
	const [nativeDefaults, setNativeDefaults] = useState<Partial<Record<PublishPlatform, PlatformDefaultDirs>>>({});
	const [heat, setHeat] = useState<PathHeatResult | null>(null);
	const [tree, setTree] = useState<PathHeatResult["tree"]>([]);
	const [preview, setPreview] = useState<PreviewResult | null>(null);
	const [publishResult, setPublishResult] = useState<PublishResult | null>(null);
	const [loading, setLoading] = useState(false);
	const [previewLoading, setPreviewLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [activePlatform, setActivePlatform] = useState<PublishPlatform>("codex");
	const [targets, setTargets] = useState<Record<PublishPlatform, TargetState>>(() =>
		Object.fromEntries(PLATFORM_ORDER.map((p) => [p, { selected: false, artifactKind: "agent" as ArtifactKind, outputDir: "" }])) as Record<PublishPlatform, TargetState>,
	);
	const previewTimer = useRef<number | null>(null);

	const supportedKinds = useMemo(() =>
	{
		const map = new Map<PublishPlatform, ArtifactKind[]>();
		for (const cap of capabilities) map.set(cap.platform, cap.supportedArtifactKinds);
		return map;
	}, [capabilities]);

	const resetTransient = useCallback(() =>
	{
		setPreview(null);
		setPublishResult(null);
		setError(null);
	}, []);

	useEffect(() =>
	{
		if (!open || !definition) return;
		resetTransient();
		setLoading(true);
		Promise.all([
			fetchPublisherPlatforms(definition.projectName),
			fetchPublisherTree(definition.projectName),
			definition.knowledge.some((k) => k.kind === "file")
				? fetchPublisherHeat(definition)
				: Promise.resolve(null),
		])
			.then(([platformsRes, treeRes, heatRes]) =>
			{
				setCapabilities(platformsRes.platforms);
				const defaults: Partial<Record<PublishPlatform, PlatformDefaultDirs>> = {};
				for (const cap of platformsRes.platforms)
				{
					if (cap.defaultDirs) defaults[cap.platform] = cap.defaultDirs;
				}
				setNativeDefaults(defaults);
				setTree(treeRes.tree);
				setHeat(heatRes);
				setTargets(buildInitialTargets(platformsRes.platforms));
			})
			.catch((err) => setError(err instanceof Error ? err.message : String(err)))
			.finally(() => setLoading(false));
	}, [open, definition, resetTransient]);

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
			if (result.errors.length === 0) onPublished(result);
			else setError(result.errors.join("; "));
		} catch (err)
		{
			setError(err instanceof Error ? err.message : String(err));
		} finally
		{
			setLoading(false);
		}
	}, [definition, targets, onPublished]);

	if (!open || !definition) return null;

	const selectedDir = targets[activePlatform]?.outputDir;
	const heatSuggestedDir = heat?.suggestedOutputDir;

	return (
		<div className="publish-agent-overlay" role="dialog" aria-modal="true" aria-label="Publish Agent">
			<div className="publish-agent-dialog">
				<div className="publish-agent-header">
					<h2>Publish to Project — {definition.name}</h2>
					<button type="button" onClick={() => { resetTransient(); onClose(); }}>Close</button>
				</div>

				{loading && <div>Loading publisher data…</div>}
				{error && <div className="publish-agent-error">{error}</div>}

				<div className="publish-agent-grid">
					<div className="publish-agent-section">
						<h3>Platforms</h3>
						{PLATFORM_ORDER.map((platform) =>
						{
							const supported = (supportedKinds.get(platform)?.length ?? 0) > 0;
							const state = targets[platform];
							const defaultDirs = nativeDefaults[platform];
							const nativeAgentDir = defaultDirs?.agentOutputDir;
							return (
								<PlatformTargetRow
									key={platform}
									platform={platform}
									label={LABELS[platform]}
									selected={state.selected}
									supported={supported}
									artifactKind={state.artifactKind}
									outputDir={state.outputDir}
									filenameHint={resolveFilenameHint(definition, platform, state.artifactKind, state.outputDir)}
									nativeDefaultDir={
										state.artifactKind === "skill"
											? defaultDirs?.skillRootDir
											: nativeAgentDir
									}
									heatSuggestedDir={heatSuggestedDir}
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
											},
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
							Directory picks apply to the active platform ({LABELS[activePlatform]}). Native defaults are used unless you choose a different folder.
						</p>
						{heat && heat.totalHits === 0 && (
							<div>No file-path heat (custom text knowledge only). Pick a directory manually.</div>
						)}
						{heat && heat.topPaths.length > 0 && (
							<div className="top-paths-panel">
								{heat.topPaths.map((item) => (
									<button
										key={item.path}
										type="button"
										className="top-path-chip"
										aria-label={`${item.path} (${item.hits} hits)`}
										onClick={() =>
										{
											const nearest = findNearestDirectoryForTopPath(item.path, tree) ?? heat.suggestedOutputDir;
											if (!nearest) return;
											setTargets((prev) => ({
												...prev,
												[activePlatform]: { ...prev[activePlatform], outputDir: nearest },
											}));
										}}>
										{item.path.split(/[/\\]/).pop()} ({item.hits})
									</button>
								))}
							</div>
						)}
						<PathHeatTree
							nodes={heat?.tree?.length ? heat.tree : tree}
							selectedPath={selectedDir}
							suggestedPath={heatSuggestedDir}
							onSelect={(absolutePath) =>
							{
								setTargets((prev) => ({
									...prev,
									[activePlatform]: { ...prev[activePlatform], outputDir: absolutePath },
								}));
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
								[{artifact.previewStatus ?? "unknown"}] {artifact.absolutePath}
							</div>
						))}
					</div>
				</div>

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
