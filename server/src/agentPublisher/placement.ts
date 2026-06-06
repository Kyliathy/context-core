import type { DirHeatNode } from "./types.js";

/** Selects shallowest directory covering at least threshold of total hits. */
export function selectPlacementPlan(tree: DirHeatNode[], totalHits: number, threshold = 0.7): string | undefined
{
	if (totalHits <= 0) return undefined;

	const candidates: Array<{ path: string; depth: number; subtreeHits: number }> = [];

	const walk = (node: DirHeatNode, depth: number): void =>
	{
		if (node.subtreeHits / totalHits >= threshold)
		{
			candidates.push({ path: node.absolutePath, depth, subtreeHits: node.subtreeHits });
		}
		for (const child of node.children) walk(child, depth + 1);
	};

	for (const root of tree) walk(root, 0);

	candidates.sort((a, b) =>
	{
		if (a.depth !== b.depth) return a.depth - b.depth;
		if (a.subtreeHits !== b.subtreeHits) return b.subtreeHits - a.subtreeHits;
		return a.path.localeCompare(b.path);
	});

	return candidates[0]?.path;
}

/** Returns top N paths by hit count with stable tie-breaking. */
export function topPathsFromCounts(counts: Map<string, number>, limit = 10): Array<{ path: string; hits: number }>
{
	return [...counts.entries()]
		.sort((a, b) =>
		{
			if (b[1] !== a[1]) return b[1] - a[1];
			return a[0].localeCompare(b[0]);
		})
		.slice(0, limit)
		.map(([path, hits]) => ({ path, hits }));
}
