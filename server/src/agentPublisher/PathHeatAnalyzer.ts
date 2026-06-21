import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, join, resolve } from "path";
import type { AgentBuilder } from "../agentBuilder/AgentBuilder.js";
import type { CanonicalAgentDefinition, DirHeatNode, PathHeatResult } from "./types.js";
import { extractPathMentions } from "./PathMentionExtractor.js";
import { ancestorsUntilRoot, resolvePathMentions } from "./PathResolver.js";
import { selectPlacementPlan, topPathsFromCounts } from "./placement.js";
import { PathPolicy } from "./pathPolicy.js";

function normalizeHeat(value: number, max: number): number
{
	if (max <= 0) return 0;
	return Math.log1p(value) / Math.log1p(max);
}

/** Builds directory tree nodes from direct/subtree hit maps. */
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

/** Analyzes knowledge file mentions to produce path heat for placement suggestions. */
export class PathHeatAnalyzer
{
	constructor(
		private readonly pathPolicy: PathPolicy,
		private readonly agentBuilder?: AgentBuilder,
	) {}

	/** Computes heat tree for a canonical definition. */
	analyze(def: CanonicalAgentDefinition): PathHeatResult
	{
		const projectRoot = this.pathPolicy.getProjectRoot(def.projectName);
		const directHits = new Map<string, number>();
		const subtreeHits = new Map<string, number>();
		const pathHitCounts = new Map<string, number>();
		const knowledgeFilePaths: string[] = [];
		let droppedPathCount = 0;

		const increment = (key: string, map: Map<string, number>): void =>
		{
			map.set(key, (map.get(key) ?? 0) + 1);
		};

		for (const item of def.knowledge)
		{
			if (item.kind !== "file") continue;
			const indexed = this.agentBuilder?.findIndexedFile(item.value, def.projectName);
			const knowledgePath = indexed?.absolutePath
				? resolve(indexed.absolutePath)
				: resolve(projectRoot, item.value);
			if (!existsSync(knowledgePath)) continue;

			knowledgeFilePaths.push(knowledgePath);

			// Business logic: always count the basket file itself so placement reflects selected knowledge, not only cross-references inside docs.
			increment(knowledgePath, pathHitCounts);
			increment(knowledgePath, directHits);
			for (const ancestor of ancestorsUntilRoot(knowledgePath, projectRoot))
			{
				increment(ancestor, subtreeHits);
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
			for (const resolvedPath of uniqueForFile)
			{
				increment(resolvedPath, pathHitCounts);
				increment(resolvedPath, directHits);
				for (const ancestor of ancestorsUntilRoot(resolvedPath, projectRoot))
				{
					increment(ancestor, subtreeHits);
				}
			}
		}

		const totalHits = [...pathHitCounts.values()].reduce((sum, n) => sum + n, 0);
		const tree = buildDirTree(projectRoot, directHits, subtreeHits);

		return {
			projectName: def.projectName,
			projectRoot,
			totalHits,
			tree,
			topPaths: topPathsFromCounts(pathHitCounts),
			suggestedOutputDir: selectPlacementPlan(tree, totalHits),
			droppedPathCount,
			knowledgeFilePaths,
		};
	}

	/** Builds a shallow directory listing tree for UI picker. */
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
