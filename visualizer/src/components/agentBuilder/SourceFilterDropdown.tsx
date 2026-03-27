/**
 * SourceFilterDropdown.tsx - Source picker for the Agent Builder view.
 *
 * Renders the "Sources (selected/total)" trigger and popup used to filter the
 * indexed file cards shown in agent-builder mode. Supports in-list search,
 * per-source toggles, and quick Select All / Select None actions.
 *
 * Behavior:
 *   - Closes on outside pointer down.
 *   - Emits a new Set<string> through onChange for each selection update.
 *
 * Docs: zz-reach2/architecture/ui/archi-context-core-visualizer-ui.md Sec 4.11
 */
import { useEffect, useRef, useState } from "react";
import "./SourceFilterDropdown.css";

type SourceFilterDropdownProps = {
	sources: string[];
	selected: Set<string>;
	onChange: (selected: Set<string>) => void;
};

export default function SourceFilterDropdown({ sources, selected, onChange }: SourceFilterDropdownProps) {
	const [isOpen, setIsOpen] = useState(false);
	const [filterText, setFilterText] = useState("");
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const onPointerDown = (event: PointerEvent) => {
			if (!containerRef.current?.contains(event.target as Node)) {
				setIsOpen(false);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, []);

	const selectedCount = selected.size;
	const label = `📁 Sources (${selectedCount}/${sources.length})`;

	const toggleSource = (name: string) => {
		const next = new Set(selected);
		if (next.has(name)) {
			next.delete(name);
		} else {
			next.add(name);
		}
		onChange(next);
	};

	const selectAll = () => onChange(new Set(sources));
	const selectNone = () => onChange(new Set());

	const isChecked = (name: string) => selected.has(name);

	const visibleSources = filterText
		? sources.filter((s) => s.toLowerCase().includes(filterText.toLowerCase()))
		: sources;

	return (
		<div className="source-filter-dropdown" ref={containerRef}>
			<button
				type="button"
				className={`source-filter-btn ${selectedCount < sources.length ? "has-filter" : ""}`}
				onClick={() => setIsOpen((open) => !open)}
				title="Filter by data source">
				{label}
			</button>
			{isOpen && (
				<div className="source-filter-popup">
					<input
						className="source-filter-search"
						type="text"
						placeholder="Filter sources…"
						value={filterText}
						onChange={(e) => setFilterText(e.target.value)}
					/>
					<div className="source-filter-header">
						<span className="source-filter-label">Sources</span>
						<div style={{ display: "flex", gap: "4px" }}>
							<button type="button" className="source-filter-select-all" onClick={selectAll}>
								Select All
							</button>
							<button type="button" className="source-filter-select-none" onClick={selectNone}>
								Select None
							</button>
						</div>
					</div>
					{visibleSources.length === 0 ? (
						<div className="source-filter-empty">{sources.length === 0 ? "No sources available" : "No matches"}</div>
					) : (
						visibleSources.map((name) => (
							<label key={name} className="source-filter-item">
								<input
									type="checkbox"
									checked={isChecked(name)}
									onChange={() => toggleSource(name)}
									className="source-filter-checkbox"
								/>
								<span className="source-filter-name">{name}</span>
							</label>
						))
					)}
				</div>
			)}
		</div>
	);
}

