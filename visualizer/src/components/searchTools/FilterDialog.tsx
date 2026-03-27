/**
 * FilterDialog.tsx — Modal for filtering the visible card set by role and minimum score.
 *
 * Opened via the filter button in StatusBar. Filters are applied in App.tsx as a
 * useMemo-derived filteredCards array; the D3 engine receives filteredCards instead
 * of the raw search results.
 *
 * Local state is initialised from the currentFilters prop each time the dialog opens,
 * making Cancel non-destructive (in-progress changes are discarded on close).
 *
 * Fields:
 *   - Role checkboxes: one per role present in the current result set (user,
 *     assistant, tool, system). availableRoles is computed in App.tsx.
 *   - Minimum Score slider: 0–1 range, step 0.01. Cards below this threshold
 *     are excluded from filteredCards.
 *
 * Actions: Cancel (discard), Reset Filters (all roles + score 0), Filter (apply).
 *
 * Docs: zz-reach2/architecture/ui/archi-context-core-ui.md §4.9
 */
import { useEffect, useState } from "react";
import type { AgentRole, FilterState } from "../../types";
import "./FilterDialog.css";

type FilterDialogProps = {
	open: boolean;
	availableRoles: AgentRole[];
	currentFilters: FilterState;
	onApply: (filters: FilterState) => void;
	onCancel: () => void;
	onReset: () => void;
};

const ROLE_LABELS: Record<AgentRole, string> = {
	user: "User",
	assistant: "Assistant",
	tool: "Tool",
	system: "System",
};

export default function FilterDialog({ open, availableRoles, currentFilters, onApply, onCancel, onReset }: FilterDialogProps) {
	const [selectedRoles, setSelectedRoles] = useState<Set<AgentRole>>(new Set());
	const [minScore, setMinScore] = useState(0);

	// Initialize local state when dialog opens
	useEffect(() => {
		if (!open) {
			return;
		}
		setSelectedRoles(new Set(currentFilters.roles));
		setMinScore(currentFilters.minScore);
	}, [open, currentFilters]);

	const handleRoleToggle = (role: AgentRole) => {
		const newRoles = new Set(selectedRoles);
		if (newRoles.has(role)) {
			newRoles.delete(role);
		} else {
			newRoles.add(role);
		}
		setSelectedRoles(newRoles);
	};

	const handleApply = () => {
		onApply({ roles: selectedRoles, minScore });
	};

	const handleReset = () => {
		setSelectedRoles(new Set(["user", "assistant", "tool", "system"]));
		setMinScore(0);
	};

	if (!open) {
		return null;
	}

	return (
		<div className="filter-dialog-overlay" role="presentation" onClick={onCancel}>
			<div
				className="filter-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="filter-dialog-title"
				onClick={(event) => event.stopPropagation()}>
				<h2 className="filter-dialog-title" id="filter-dialog-title">
					Filter Messages
				</h2>

				<div className="filter-section">
					<span className="filter-section-label">Role:</span>
					<div className="filter-checkboxes">
						{availableRoles.map((role) => (
							<label key={role} className="filter-checkbox-row">
								<input type="checkbox" checked={selectedRoles.has(role)} onChange={() => handleRoleToggle(role)} />
								<span>{ROLE_LABELS[role]}</span>
							</label>
						))}
					</div>
				</div>

				<div className="filter-section">
					<label className="filter-slider-label">
						<span>Minimum Score: {minScore.toFixed(2)}</span>
						<input
							type="range"
							min="0"
							max="1"
							step="0.01"
							value={minScore}
							onChange={(event) => setMinScore(Number(event.target.value))}
							className="filter-slider"
						/>
					</label>
				</div>

				<div className="filter-dialog-actions">
					<button type="button" className="filter-dialog-btn" onClick={onCancel}>
						Cancel
					</button>
					<button type="button" className="filter-dialog-btn" onClick={handleReset}>
						Reset Filters
					</button>
					<button type="button" className="filter-dialog-btn filter-dialog-btn-primary" onClick={handleApply}>
						Filter
					</button>
				</div>
			</div>
		</div>
	);
}
