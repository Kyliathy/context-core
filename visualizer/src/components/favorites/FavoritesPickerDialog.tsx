/**
 * FavoritesPickerDialog.tsx — Modal for selecting which favorites view to star a card into.
 *
 * Opened by App when the user clicks the ☆ star button on a card and there is
 * more than one favorites-type view (or no favorites view yet).
 *
 * Three states:
 *   - Empty: no favorites views exist → shows a name input and "Create" button.
 *   - Picker: one or more favorites views exist → lists them (emoji + name) with
 *     an inline "New view" row at the bottom so the user can create one on the fly.
 *   - Direct add: if exactly one favorites view exists, App bypasses this dialog
 *     entirely and calls addFavorite() directly.
 *
 * Selecting a view calls onSelect(viewId); creating a new view calls onCreate(name)
 * which returns the new id (or null on failure), then auto-selects it.
 *
 * Docs: zz-reach2/architecture/ui/archi-context-core-ui.md §4.3
 */
import { useEffect, useMemo, useState } from "react";
import type { ViewDefinition } from "../../types";
import "./FavoritesPickerDialog.css";

type FavoritesPickerDialogProps = {
	open: boolean;
	views: ViewDefinition[];
	selectedViewIds: string[];
	onClose: () => void;
	onSave: (viewIds: string[]) => void;
	onCreate: (name: string) => string | null;
};

export default function FavoritesPickerDialog({
	open,
	views,
	selectedViewIds,
	onClose,
	onSave,
	onCreate,
}: FavoritesPickerDialogProps) {
	const [newName, setNewName] = useState("Favorites");
	const [localSelected, setLocalSelected] = useState<Set<string>>(new Set());

	useEffect(() => {
		if (open) {
			setLocalSelected(new Set(selectedViewIds));
			setNewName("Favorites");
		}
	}, [open, selectedViewIds]);

	const handleToggle = (id: string) => {
		setLocalSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	};

	const sortedViews = useMemo(() => [...views].sort((left, right) => left.createdAt - right.createdAt), [views]);

	if (!open) {
		return null;
	}

	return (
		<div className="fav-picker-overlay" role="presentation" onClick={onClose}>
			<div className="fav-picker" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
				<h3 className="fav-picker-title">Add to which favorites view?</h3>
				{sortedViews.length > 0 ? (
					<div className="fav-picker-list">
						{sortedViews.map((view) => (
							<label key={view.id} className="fav-picker-item">
								<input type="checkbox" checked={localSelected.has(view.id)} onChange={() => handleToggle(view.id)} />
								<span className="fav-picker-emoji" aria-hidden>
									{view.emoji}
								</span>
								<span className="fav-picker-swatch" style={{ backgroundColor: view.color }} aria-hidden />
								<span>{view.name}</span>
							</label>
						))}
					</div>
				) : (
					<div className="fav-picker-empty">No favorites views yet. Create one below.</div>
				)}

				<div className="fav-picker-create">
					<input
						type="text"
						value={newName}
						maxLength={60}
						onChange={(event) => setNewName(event.target.value)}
						className="fav-picker-input"
						placeholder="New favorites view name"
					/>
					<button
						type="button"
						className="fav-picker-btn fav-picker-btn-primary"
						onClick={() => {
							const id = onCreate(newName);
							if (id) {
								handleToggle(id);
								setNewName("Favorites");
							}
						}}>
						Create Favorites View
					</button>
				</div>

				<div className="fav-picker-actions" style={{ gap: "8px" }}>
					<button type="button" className="fav-picker-btn" onClick={onClose}>
						Cancel
					</button>
					<button
						type="button"
						className="fav-picker-btn fav-picker-btn-primary"
						onClick={() => onSave(Array.from(localSelected))}>
						Done
					</button>
				</div>
			</div>
		</div>
	);
}
