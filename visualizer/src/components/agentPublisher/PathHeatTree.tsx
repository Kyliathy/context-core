import type { DirHeatNode } from "../../types";

type Props = {
	nodes: DirHeatNode[];
	selectedPath?: string;
	suggestedPath?: string;
	onSelect: (absolutePath: string) => void;
};

function heatColor(heat: number): string
{
	if (heat <= 0) return "#64748b";
	if (heat < 0.25) return "#06b6d4";
	if (heat < 0.5) return "#22c55e";
	if (heat < 0.75) return "#f59e0b";
	return "#ef4444";
}

function PathNode({
	node,
	depth,
	selectedPath,
	suggestedPath,
	onSelect,
}: {
	node: DirHeatNode;
	depth: number;
	selectedPath?: string;
	suggestedPath?: string;
	onSelect: (absolutePath: string) => void;
})
{
	const selected = selectedPath === node.absolutePath;
	const suggested = suggestedPath === node.absolutePath;
	return (
		<div className="path-heat-node-wrap">
			<button
				type="button"
				className={`path-node${selected ? " path-node-selected" : ""}${suggested ? " path-node-suggested" : ""}`}
				style={{ paddingLeft: `${depth * 14 + 8}px` }}
				title={node.absolutePath}
				onClick={() => onSelect(node.absolutePath)}
				onKeyDown={(e) =>
				{
					if (e.key === "Enter") onSelect(node.absolutePath);
				}}>
				<span className="path-node-heat" style={{ backgroundColor: heatColor(node.heat) }} />
				<span className="path-node-name">{node.name}</span>
				{node.subtreeHits > 0 && <span className="path-node-badge">[{node.subtreeHits}]</span>}
			</button>
			{node.children.map((child) => (
				<PathNode
					key={child.absolutePath}
					node={child}
					depth={depth + 1}
					selectedPath={selectedPath}
					suggestedPath={suggestedPath}
					onSelect={onSelect}
				/>
			))}
		</div>
	);
}

export default function PathHeatTree({ nodes, selectedPath, suggestedPath, onSelect }: Props)
{
	return (
		<div className="path-heat-tree" role="tree">
			{nodes.map((node) => (
				<PathNode
					key={node.absolutePath}
					node={node}
					depth={0}
					selectedPath={selectedPath}
					suggestedPath={suggestedPath}
					onSelect={onSelect}
				/>
			))}
		</div>
	);
}

/** Finds nearest directory node path for a top file path. */
export function findNearestDirectoryForTopPath(topPath: string, tree: DirHeatNode[]): string | undefined
{
	const normalized = topPath.replace(/\\/g, "/").toLowerCase();
	const dirs: string[] = [];
	const walk = (node: DirHeatNode): void =>
	{
		dirs.push(node.absolutePath);
		node.children.forEach(walk);
	};
	tree.forEach(walk);
	return dirs
		.filter((d) => normalized.startsWith(d.replace(/\\/g, "/").toLowerCase()))
		.sort((a, b) => b.length - a.length)[0];
}
