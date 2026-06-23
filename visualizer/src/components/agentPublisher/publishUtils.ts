/**
 * Publisher UI path hint helpers.
 *
 * Architecture: visualizer/zz-reach2/architecture/agents/archi-agent-builder-ui.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ap-agent-publisher-2.md (Part A/C)
 */

import type {
	ArtifactKind,
	CanonicalAgentDefinition,
	CanonicalPublishedArtifact,
	DirHeatNode,
	LinkStrategy,
	PathHeatResult,
	PlacementMdSource,
	PlatformArtifactTemplate,
	PlatformCapability,
	PlatformDefaultDirs,
	PublishedTargetSummary,
	PublishPlatform,
} from "../../types";

/** localStorage key for last Publisher platform checkbox selection. */
export const PUBLISHER_PLATFORMS_STORAGE_KEY = "cxc-publisher-platforms";

/** Stable platform list order used when no prior selection is stored. */
export const PUBLISHER_PLATFORM_ORDER: PublishPlatform[] = [
	"codex",
	"claude",
	"copilot",
	"kiro",
	"cursor",
	"windsurf",
	"antigravity",
];

/** First-open default when localStorage has no prior Publisher selection. */
export const DEFAULT_PUBLISHER_PLATFORMS: PublishPlatform[] = ["copilot", "claude", "codex"];

const PUBLISHER_PLATFORM_SET = new Set<PublishPlatform>(PUBLISHER_PLATFORM_ORDER);

/**
 * Reads the last checked Publisher platforms from localStorage.
 * @returns Valid platform ids; falls back to DEFAULT_PUBLISHER_PLATFORMS.
 */
export function readLastSelectedPublisherPlatforms(): PublishPlatform[]
{
	if (typeof window === "undefined") return [...DEFAULT_PUBLISHER_PLATFORMS];
	try
	{
		const raw = window.localStorage.getItem(PUBLISHER_PLATFORMS_STORAGE_KEY);
		if (!raw) return [...DEFAULT_PUBLISHER_PLATFORMS];
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [...DEFAULT_PUBLISHER_PLATFORMS];
		const valid = parsed.filter(
			(entry): entry is PublishPlatform =>
				typeof entry === "string" && PUBLISHER_PLATFORM_SET.has(entry as PublishPlatform),
		);
		return valid.length > 0 ? valid : [...DEFAULT_PUBLISHER_PLATFORMS];
	}
	catch
	{
		return [...DEFAULT_PUBLISHER_PLATFORMS];
	}
}

/**
 * Persists the checked Publisher platforms for the next dialog open.
 * @param platforms - Currently selected platform ids (order preserved).
 */
export function saveLastSelectedPublisherPlatforms(platforms: PublishPlatform[]): void
{
	if (typeof window === "undefined") return;
	try
	{
		const seen = new Set<PublishPlatform>();
		const ordered: PublishPlatform[] = [];
		for (const platform of platforms)
		{
			if (!PUBLISHER_PLATFORM_SET.has(platform) || seen.has(platform)) continue;
			seen.add(platform);
			ordered.push(platform);
		}
		window.localStorage.setItem(PUBLISHER_PLATFORMS_STORAGE_KEY, JSON.stringify(ordered));
	}
	catch
	{
		// Business logic: Publisher still works when localStorage is unavailable.
	}
}

/**
 * Puts previously selected platforms first while keeping stable tail order.
 * @param lastSelected - Platforms from the last Publisher session.
 */
export function sortPlatformsByLastSelected(lastSelected: PublishPlatform[]): PublishPlatform[]
{
	const lastSet = new Set(lastSelected);
	const preferred = lastSelected.filter((platform) => PUBLISHER_PLATFORM_SET.has(platform));
	const rest = PUBLISHER_PLATFORM_ORDER.filter((platform) => !lastSet.has(platform));
	return [...preferred, ...rest];
}

/**
 * Collects checked platform ids from per-row Publisher state.
 * @param targets - Per-platform row state map.
 */
export function selectedPlatformsFromTargets(
	targets: Record<PublishPlatform, { selected: boolean }>,
): PublishPlatform[]
{
	return PUBLISHER_PLATFORM_ORDER.filter((platform) => targets[platform]?.selected);
}

/**
 * Resolves which platform receives Placement tree and heat-map directory picks.
 * @param targets - Per-platform row state map.
 * @param activePlatform - Currently focused platform row.
 */
export function resolvePlacementPlatform(
	targets: Record<PublishPlatform, { selected: boolean }>,
	activePlatform: PublishPlatform,
): PublishPlatform
{
	if (targets[activePlatform]?.selected) return activePlatform;
	return PUBLISHER_PLATFORM_ORDER.find((platform) => targets[platform]?.selected) ?? activePlatform;
}

/**
 * Derives an output directory from a materialized artifact absolute path.
 * @param absolutePath - Published artifact file path.
 */
export function outputDirFromArtifactPath(absolutePath: string): string
{
	const normalized = absolutePath.replace(/\\/g, "/");
	if (!normalized.includes("/")) return absolutePath;
	return normalized.replace(/\/[^/]+$/, "");
}

/**
 * Formats one published-artifact history row for the Publisher dropdown.
 * @param entry - Historical publish record from agent-definitions.json.
 * @param platformLabel - Human-readable platform name.
 */
export function formatPublishedArtifactLabel(
	entry: CanonicalPublishedArtifact,
	platformLabel: string,
): string
{
	const when = entry.publishedAt ? new Date(entry.publishedAt).toLocaleString() : "";
	return `${platformLabel} · ${entry.artifactKind} · ${entry.absolutePath}${when ? ` · ${when}` : ""}`;
}

/**
 * Resolves link strategies for a platform row (mirrors backend linkStrategyPolicy).
 * @param platform - Publish platform identifier.
 * @param artifactKind - Agent or skill target kind.
 */
export function linkStrategiesForTarget(platform: PublishPlatform, artifactKind: ArtifactKind): LinkStrategy[]
{
	const strategies: LinkStrategy[] = ["copy"];
	// Business logic: import-shim is only meaningful for Claude agent guidance bridges to AGENTS.md.
	if (platform === "claude" && artifactKind === "agent")
	{
		strategies.push("import-shim");
	}
	return strategies;
}

/**
 * Normalizes link strategy when artifact kind changes.
 * @param platform - Publish platform.
 * @param artifactKind - Selected artifact kind.
 * @param linkStrategy - Current row strategy.
 */
export function normalizeLinkStrategy(
	platform: PublishPlatform,
	artifactKind: ArtifactKind,
	linkStrategy: LinkStrategy,
): LinkStrategy
{
	const allowed = linkStrategiesForTarget(platform, artifactKind);
	return allowed.includes(linkStrategy) ? linkStrategy : "copy";
}

/**
 * Resolves the output directory for a platform target from backend defaults.
 * @param defaultDirs - Backend-provided native directories.
 * @param artifactKind - Agent or skill target kind.
 */
export function resolveDefaultOutputDir(
	defaultDirs: PlatformDefaultDirs | undefined,
	artifactKind: ArtifactKind,
): string
{
	if (!defaultDirs) return "";
	return artifactKind === "skill" ? defaultDirs.skillRootDir : defaultDirs.agentOutputDir;
}

/**
 * Resolves a template relative path with definition placeholders.
 * @param template - Relative path template from backend capability metadata.
 * @param values - Placeholder values.
 */
export function resolveTemplatePath(template: string, values: { id: string; name: string }): string
{
	return template
		.replaceAll("{id}", values.id)
		.replaceAll("{name}", values.name);
}

/**
 * Builds the resolved artifact path hint shown in Publisher platform rows.
 * @param def - Canonical definition being published.
 * @param platform - Target platform.
 * @param kind - Agent or skill artifact kind.
 * @param outputDir - Selected output directory.
 * @param capability - Optional backend capability row with artifact templates.
 */
export function resolveFilenameHint(
	def: CanonicalAgentDefinition,
	platform: PublishPlatform,
	kind: ArtifactKind,
	outputDir: string,
	capability?: PlatformCapability,
): string
{
	const normalized = outputDir.replace(/\\/g, "/").replace(/\/+$/, "");
	const template = capability?.artifactTemplates?.find((row) => row.artifactKind === kind);
	if (template)
	{
		const relative = resolveTemplatePath(template.relativePathTemplate, { id: def.id, name: def.name });
		return `${normalized}/${relative}`;
	}

	// Fallback for older backend responses without artifactTemplates.
	if (kind === "skill")
	{
		if (platform === "copilot") return `${normalized}/.github/skills/${def.id}/SKILL.md`;
		if (platform === "claude") return `${normalized}/.claude/skills/${def.id}/SKILL.md`;
		if (platform === "codex" || platform === "cursor" || platform === "antigravity") return `${normalized}/.agents/skills/${def.id}/SKILL.md`;
		if (platform === "windsurf") return `${normalized}/.windsurf/skills/${def.id}/SKILL.md`;
		if (platform === "kiro") return `${normalized}/.kiro/skills/${def.id}/SKILL.md`;
		return `${normalized}/skills/${def.id}/SKILL.md`;
	}
	if (platform === "copilot") return `${normalized}/${def.name}.agent.md`;
	if (platform === "claude") return `${normalized}/${def.name}.md`;
	if (platform === "codex" || platform === "cursor" || platform === "windsurf" || platform === "kiro" || platform === "antigravity")
	{
		return `${normalized}/AGENTS.md`;
	}
	return `${normalized}/${def.name}`;
}

/**
 * Returns true when heat-suggested placement differs from the native default directory.
 * @param heatSuggestedDir - Heat analyzer suggestion.
 * @param nativeDefaultDir - Platform-native default directory.
 */
export function heatDiffersFromNative(
	heatSuggestedDir: string | undefined,
	nativeDefaultDir: string,
): boolean
{
	if (!heatSuggestedDir || !nativeDefaultDir) return false;
	return heatSuggestedDir.replace(/\\/g, "/").replace(/\/+$/, "")
		!== nativeDefaultDir.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Normalizes paths for Set comparisons across Windows separators. */
function normalizePathKey(filePath: string): string
{
	return filePath.replace(/\\/g, "/").toLowerCase();
}

/**
 * Builds the default checked markdown source set — basket docs on, related docs off.
 * @param mdSources - Placement markdown sources from heat analysis.
 */
export function initialSelectedMdSourcePaths(mdSources: PlacementMdSource[] | undefined): Set<string>
{
	const selected = new Set<string>();
	if (!mdSources) return selected;
	for (const source of mdSources)
	{
		// Business logic: basket markdown drives placement by default; related link discoveries stay opt-in.
		if (source.inBasket && !source.isRelated)
		{
			selected.add(normalizePathKey(source.absolutePath));
		}
	}
	return selected;
}

/**
 * Re-aggregates directory heat from selected markdown sources for filtered placement trees.
 * @param heat - Full heat response from the server.
 * @param selectedAbsolutePaths - Normalized absolute paths of checked markdown chips.
 */
export function filterHeatByMdSources(heat: PathHeatResult, selectedAbsolutePaths: Set<string>): PathHeatResult
{
	if (!heat.mdSources?.length || selectedAbsolutePaths.size === 0)
	{
		return {
			...heat,
			totalHits: 0,
			tree: heat.tree.map((node) => zeroHeatNode(node)),
			topPaths: [],
			suggestedOutputDir: undefined,
		};
	}

	const selectedSources = heat.mdSources.filter((source) =>
		selectedAbsolutePaths.has(normalizePathKey(source.absolutePath)),
	);
	const directHits = new Map<string, number>();
	for (const source of selectedSources)
	{
		for (const row of source.directoryPaths)
		{
			const key = normalizePathKey(row.absolutePath);
			directHits.set(key, (directHits.get(key) ?? 0) + row.hits);
		}
	}

	const totalHits = [...directHits.values()].reduce((sum, hits) => sum + hits, 0);
	const maxSubtree = Math.max(0, ...directHits.values());

	/**
	 * Recursively remaps tree nodes so only directories referenced by selected sources retain heat.
	 * @param node - Directory node from the full heat tree.
	 */
	function remapNode(node: DirHeatNode): DirHeatNode | null
	{
		const direct = directHits.get(normalizePathKey(node.absolutePath)) ?? 0;
		const children = node.children
			.map((child) => remapNode(child))
			.filter((child): child is DirHeatNode => child !== null);
		const subtreeFromChildren = children.reduce((sum, child) => sum + child.subtreeHits, 0);
		const subtreeHits = direct + subtreeFromChildren;
		// Business logic: hide placement folders with zero attribution from the active markdown selection.
		if (subtreeHits <= 0 && children.length === 0) return null;
		const heatValue = maxSubtree > 0 ? Math.log1p(subtreeHits) / Math.log1p(maxSubtree) : 0;
		return {
			...node,
			directHits: direct,
			subtreeHits,
			heat: heatValue,
			children,
		};
	}

	const tree = heat.tree
		.map((node) => remapNode(node))
		.filter((node): node is DirHeatNode => node !== null);

	const topPaths = [...directHits.entries()]
		.map(([path, hits]) => ({ path, hits }))
		.sort((left, right) => right.hits - left.hits || left.path.localeCompare(right.path))
		.slice(0, 12);

	let suggestedOutputDir: string | undefined;
	if (topPaths.length > 0)
	{
		suggestedOutputDir = topPaths[0].path;
	}

	return {
		...heat,
		totalHits,
		tree,
		topPaths,
		suggestedOutputDir,
	};
}

/** Zeros heat on a directory node for empty filtered views. */
function zeroHeatNode(node: DirHeatNode): DirHeatNode
{
	return {
		...node,
		directHits: 0,
		subtreeHits: 0,
		heat: 0,
		children: node.children.map((child) => zeroHeatNode(child)),
	};
}

/**
 * Seeds per-platform Publisher rows from capabilities, last selection, and ledger prefill.
 * @param platforms - Backend capability rows.
 * @param publishedTo - Optional published target summaries for output-dir prefill.
 * @param lastSelected - Platforms checked in the previous Publisher session.
 */
export function buildInitialPublisherTargets(
	platforms: PlatformCapability[],
	publishedTo: PublishedTargetSummary[] = [],
	lastSelected: PublishPlatform[] = readLastSelectedPublisherPlatforms(),
): Record<PublishPlatform, { selected: boolean; artifactKind: ArtifactKind; outputDir: string; linkStrategy: LinkStrategy }>
{
	const lastSet = new Set(lastSelected);
	const next = Object.fromEntries(
		PUBLISHER_PLATFORM_ORDER.map((platform) => [
			platform,
			{ selected: false, artifactKind: "agent" as ArtifactKind, outputDir: "", linkStrategy: "copy" as LinkStrategy },
		]),
	) as Record<PublishPlatform, { selected: boolean; artifactKind: ArtifactKind; outputDir: string; linkStrategy: LinkStrategy }>;

	for (const platform of PUBLISHER_PLATFORM_ORDER)
	{
		const cap = platforms.find((item) => item.platform === platform);
		const outputDir = resolveDefaultOutputDir(cap?.defaultDirs, "agent");
		next[platform] = {
			selected: lastSet.has(platform),
			artifactKind: "agent",
			outputDir,
			linkStrategy: "copy",
		};
	}
	return applyPublishPrefillToTargets(next, publishedTo);
}

/**
 * Applies last-published output directories onto platform target rows.
 * @param targets - Current per-platform target state map.
 * @param publishedTo - Publish ledger summaries from status endpoint.
 */
export function applyPublishPrefillToTargets<T extends { selected: boolean; artifactKind: ArtifactKind; outputDir: string }>(
	targets: Record<PublishPlatform, T>,
	publishedTo: PublishedTargetSummary[],
): Record<PublishPlatform, T>
{
	const next = { ...targets };
	for (const row of publishedTo)
	{
		const state = next[row.platform];
		// Business logic: only prefill when artifact kind matches the row the user is configuring.
		if (!state || state.artifactKind !== row.artifactKind || !row.absolutePath) continue;
		const normalized = row.absolutePath.replace(/\\/g, "/");
		const outputDir = normalized.includes("/")
			? normalized.replace(/\/[^/]+$/, "")
			: row.absolutePath;
		next[row.platform] = {
			...state,
			selected: true,
			outputDir,
		};
	}
	return next;
}

/**
 * Formats publish status for a platform row from ledger + drift data.
 * @param platform - Target platform.
 * @param artifactKind - Active artifact kind on the row.
 * @param publishedTo - Published target summaries.
 */
export function formatPublishStatusLabel(
	platform: PublishPlatform,
	artifactKind: ArtifactKind,
	publishedTo: PublishedTargetSummary[],
): string | undefined
{
	const row = publishedTo.find((entry) => entry.platform === platform && entry.artifactKind === artifactKind);
	if (!row) return undefined;
	const when = row.publishedAt ? new Date(row.publishedAt).toLocaleString() : "";
	const state = row.state ?? "unknown";
	return `${state}${when ? ` · ${when}` : ""}`;
}

export type { PlatformArtifactTemplate };
