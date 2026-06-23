/**
 * Path heat analyzer — directory-only placement tree and markdown source chips.
 *
 * Architecture: server/zz-reach2/architecture/agents/archi-agent-builder.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ap-agent-publisher-2.md (Part C)
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, join, resolve } from "path";
import type { AgentBuilder } from "../agentBuilder/AgentBuilder.js";
import type { CanonicalAgentDefinition, DirHeatNode, PathHeatResult, PlacementMdSource } from "./types.js";
import { extractPathMentions } from "./PathMentionExtractor.js";
import { ancestorsUntilRoot, resolvePathMentions } from "./PathResolver.js";
import { selectPlacementPlan, topPathsFromCounts } from "./placement.js";
import {
	filterRelatedMarkdown,
	isMarkdownLikePath,
	makePlacementMdSource,
	toPlacementDirectory,
} from "./placementMd.js";
import { PathPolicy } from "./pathPolicy.js";

function normalizeHeat(value: number, max: number): number
{
	if (max <= 0) return 0;
	return Math.log1p(value) / Math.log1p(max);
}

/**
 * Builds directory tree nodes from direct/subtree hit maps (directories only).
 * @param projectRoot - Project root for tree anchoring.
 * @param directHits - Direct directory hit counts.
 * @param subtreeHits - Subtree directory hit counts.
 */
function buildDirTree(projectRoot: string, directHits: Map<string, number>, subtreeHits: Map<string, number>): DirHeatNode[]
{
	const maxSubtree = Math.max(0, ...subtreeHits.values());
	const nodeByPath = new Map<string, DirHeatNode>();

	const ensureNode = (absolutePath: string): DirHeatNode =>
	{
		const resolved = resolve(absolutePath);
		const existing = nodeByPath.get(resolved);
		if (existing) return existing;
		const node: DirHeatNode = {
			name: basename(resolved) || resolved,
			absolutePath: resolved,
			directHits: directHits.get(resolved) ?? 0,
			subtreeHits: subtreeHits.get(resolved) ?? 0,
			heat: normalizeHeat(subtreeHits.get(resolved) ?? 0, maxSubtree),
			children: [],
		};
		nodeByPath.set(resolved, node);
		return node;
	};

	// Business logic: heat tree leaves must be directories only — file paths become parent directory hits upstream.
	for (const path of new Set([...directHits.keys(), ...subtreeHits.keys()]))
	{
		for (const ancestor of ancestorsUntilRoot(path, projectRoot))
		{
			ensureNode(ancestor);
		}
	}

	for (const path of nodeByPath.keys())
	{
		if (normalizePath(path) === normalizePath(projectRoot)) continue;
		const parent = resolve(path, "..");
		if (nodeByPath.has(parent))
		{
			nodeByPath.get(parent)!.children.push(nodeByPath.get(path)!);
		}
	}

	for (const node of nodeByPath.values())
	{
		node.children.sort((a, b) => a.name.localeCompare(b.name));
	}

	return [ensureNode(projectRoot)];
}

function normalizePath(p: string): string
{
	return resolve(p).replace(/\\/g, "/").toLowerCase();
}

/**
 * Records one placement hit against directory maps and optional per-source attribution.
 * @param placementDir - Directory receiving the hit.
 * @param projectRoot - Project root for ancestor walks.
 * @param directHits - Mutable direct directory hit map.
 * @param subtreeHits - Mutable subtree directory hit map.
 * @param directoryHitCounts - Mutable flat directory counts for topPaths compatibility.
 * @param sourceDirHits - Optional per-source directory hit map for mdSources.
 */
function recordDirectoryHit(
	placementDir: string,
	projectRoot: string,
	directHits: Map<string, number>,
	subtreeHits: Map<string, number>,
	directoryHitCounts: Map<string, number>,
	sourceDirHits?: Map<string, number>,
): void
{
	const increment = (key: string, map: Map<string, number>): void =>
	{
		map.set(key, (map.get(key) ?? 0) + 1);
	};

	increment(placementDir, directoryHitCounts);
	increment(placementDir, directHits);
	if (sourceDirHits) increment(placementDir, sourceDirHits);

	for (const ancestor of ancestorsUntilRoot(placementDir, projectRoot))
	{
		increment(ancestor, subtreeHits);
	}
}

/** Analyzes knowledge file mentions to produce directory heat and markdown source chips. */
export class PathHeatAnalyzer
{
	/**
	 * @param pathPolicy - Bound data source path policy for the active project.
	 * @param agentBuilder - Optional index lookup for knowledge file refs.
	 */
	constructor(
		private readonly pathPolicy: PathPolicy,
		private readonly agentBuilder?: AgentBuilder,
	) {}

	/**
	 * Computes heat tree and mdSources for a canonical definition.
	 * @param def - Canonical agent definition with knowledge refs.
	 */
	analyze(def: CanonicalAgentDefinition): PathHeatResult
	{
		const projectRoot = this.pathPolicy.getProjectRoot(def.projectName);
		const directHits = new Map<string, number>();
		const subtreeHits = new Map<string, number>();
		const directoryHitCounts = new Map<string, number>();
		const knowledgeFilePaths: string[] = [];
		const basketPaths = new Set<string>();
		const mdSources: PlacementMdSource[] = [];
		const relatedCandidates: string[] = [];
		let droppedPathCount = 0;

		for (const item of def.knowledge)
		{
			if (item.kind !== "file") continue;
			const indexed = this.agentBuilder?.findIndexedFile(item.value, def.projectName);
			const knowledgePath = indexed?.absolutePath
				? resolve(indexed.absolutePath)
				: resolve(projectRoot, item.value);
			if (!existsSync(knowledgePath)) continue;

			knowledgeFilePaths.push(knowledgePath);
			basketPaths.add(knowledgePath);

			const sourceDirHits = new Map<string, number>();

			// Business logic: basket markdown files count against their parent directory, not as tree leaves.
			const basketPlacementDir = toPlacementDirectory(knowledgePath);
			if (basketPlacementDir)
			{
				recordDirectoryHit(
					basketPlacementDir,
					projectRoot,
					directHits,
					subtreeHits,
					directoryHitCounts,
					sourceDirHits,
				);
			}

			let content = "";
			try { content = readFileSync(knowledgePath, "utf8"); } catch { continue; }

			const mentions = extractPathMentions(content);
			const { resolved, dropped } = resolvePathMentions(mentions, {
				knowledgeFileDir: resolve(knowledgePath, ".."),
				projectRoots: [projectRoot],
			});
			droppedPathCount += dropped.length;

			const uniqueForFile = new Set(resolved.map((r) => resolve(r.absolutePath)));
			// Business logic: de-dupe mentions per knowledge file before aggregating directory placement hits.
			for (const resolvedPath of uniqueForFile)
			{
				if (isMarkdownLikePath(resolvedPath))
				{
					relatedCandidates.push(resolvedPath);
				}

				const placementDir = toPlacementDirectory(resolvedPath);
				if (!placementDir) continue;

				recordDirectoryHit(
					placementDir,
					projectRoot,
					directHits,
					subtreeHits,
					directoryHitCounts,
					sourceDirHits,
				);
			}

			if (isMarkdownLikePath(knowledgePath))
			{
				mdSources.push(makePlacementMdSource(
					knowledgePath,
					projectRoot,
					true,
					false,
					[...sourceDirHits.entries()].map(([absolutePath, hits]) => ({ absolutePath, hits })),
				));
			}
		}

		const relatedPaths = filterRelatedMarkdown(relatedCandidates, basketPaths);
		for (const relatedPath of relatedPaths)
		{
			const sourceDirHits = new Map<string, number>();
			const placementDir = toPlacementDirectory(relatedPath);
			if (placementDir)
			{
				recordDirectoryHit(
					placementDir,
					projectRoot,
					directHits,
					subtreeHits,
					directoryHitCounts,
					sourceDirHits,
				);
			}

			mdSources.push(makePlacementMdSource(
				relatedPath,
				projectRoot,
				false,
				true,
				[...sourceDirHits.entries()].map(([absolutePath, hits]) => ({ absolutePath, hits })),
			));
		}

		const totalHits = [...directoryHitCounts.values()].reduce((sum, n) => sum + n, 0);
		const tree = buildDirTree(projectRoot, directHits, subtreeHits);

		return {
			projectName: def.projectName,
			projectRoot,
			totalHits,
			tree,
			topPaths: topPathsFromCounts(directoryHitCounts),
			suggestedOutputDir: selectPlacementPlan(tree, totalHits),
			droppedPathCount,
			knowledgeFilePaths,
			mdSources,
		};
	}

	/**
	 * Builds a shallow directory listing tree for UI picker (directories only).
	 * @param projectName - AgentBuilder source name / project label.
	 * @param maxDepth - Maximum recursion depth from project root.
	 */
	buildDirectoryTree(projectName: string, maxDepth = 4): DirHeatNode[]
	{
		const root = this.pathPolicy.getProjectRoot(projectName);
		const walk = (dir: string, depth: number): DirHeatNode =>
		{
			const children: DirHeatNode[] = [];
			if (depth < maxDepth && existsSync(dir))
			{
				try
				{
					for (const entry of readdirSync(dir))
					{
						if (entry.startsWith(".") && entry !== ".github" && entry !== ".claude") continue;
						const full = join(dir, entry);
						try
						{
							if (statSync(full).isDirectory())
							{
								children.push(walk(full, depth + 1));
							}
						} catch { /* skip */ }
					}
				} catch { /* skip */ }
			}
			children.sort((a, b) => a.name.localeCompare(b.name));
			return {
				name: basename(dir) || dir,
				absolutePath: resolve(dir),
				directHits: 0,
				subtreeHits: 0,
				heat: 0,
				children,
			};
		};
		return [walk(root, 0)];
	}
}
