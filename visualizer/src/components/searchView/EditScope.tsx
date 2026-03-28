/**
 * EditScope.tsx - Compact editor for scope identity metadata.
 *
 * Renders the small inline form used by scope-management flows to edit a
 * scope's emoji, name, and color. The parent owns persistence and visibility;
 * this component only normalizes input and emits a validated payload on save.
 *
 * Validation:
 *   - Name is required and capped at 40 chars.
 *   - Emoji is trimmed and capped to 2 glyphs.
 *   - Color falls back to #0ea5e9 if input is invalid.
 *
 * Docs: zz-reach2/architecture/ui/archi-context-core-visualizer-ui.md
 */
import { useEffect, useMemo, useState } from "react";

type EditScopePayload = {
	name: string;
	emoji: string;
	color: string;
};

type EditScopeProps = {
	initialName?: string;
	initialEmoji?: string;
	initialColor?: string;
	title?: string;
	saveLabel?: string;
	onSave: (payload: EditScopePayload) => void;
	onCancel: () => void;
};

export default function EditScope({
	initialName = "",
	initialEmoji = "",
	initialColor = "#0ea5e9",
	title = "Scope",
	saveLabel = "Save Scope",
	onSave,
	onCancel,
}: EditScopeProps) {
	const [name, setName] = useState(initialName);
	const [emoji, setEmoji] = useState(initialEmoji);
	const [color, setColor] = useState(initialColor);

	useEffect(() => {
		setName(initialName);
		setEmoji(initialEmoji);
		setColor(initialColor);
	}, [initialName, initialEmoji, initialColor]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				onCancel();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onCancel]);

	const normalizedEmoji = useMemo(() => {
		const trimmed = emoji.trim();
		if (!trimmed) {
			return "📦";
		}
		return Array.from(trimmed).slice(0, 2).join("");
	}, [emoji]);

	const normalizedColor = useMemo(() => {
		return /^#([0-9a-f]{6})$/i.test(color) ? color.toLowerCase() : "#0ea5e9";
	}, [color]);

	const trimmedName = useMemo(() => name.trim(), [name]);
	const canSave = trimmedName.length > 0 && trimmedName.length <= 40;

	return (
		<div
			className="edit-scope-overlay"
			role="presentation"
			onClick={(event) => {
				event.stopPropagation();
				onCancel();
			}}>
			<div className="edit-scope-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
				<div className="edit-results-view-scope-editor">
					<div className="edit-results-view-scope-editor-title">{title}</div>
					<div className="edit-results-view-row edit-results-view-scope-editor-row">
						<label className="edit-results-view-label edit-results-view-scope-emoji-field">
							<span>Emoji</span>
							<input
								type="text"
								value={emoji}
								maxLength={4}
								onChange={(event) => setEmoji(event.target.value)}
								className="edit-results-view-input"
							/>
						</label>
						<label className="edit-results-view-label edit-results-view-grow">
							<span>Name</span>
							<input
								type="text"
								value={name}
								maxLength={40}
								onChange={(event) => setName(event.target.value)}
								className="edit-results-view-input"
							/>
						</label>
						<label className="edit-results-view-label">
							<span>Color</span>
							<input
								type="color"
								value={normalizedColor}
								onChange={(event) => setColor(event.target.value)}
								className="edit-results-view-color"
							/>
						</label>
					</div>
					<div className="edit-results-view-actions">
						<button type="button" className="edit-results-view-btn" onClick={onCancel}>
							Cancel
						</button>
						<button
							type="button"
							className="edit-results-view-btn edit-results-view-btn-primary"
							disabled={!canSave}
							onClick={() =>
								onSave({
									name: trimmedName,
									emoji: normalizedEmoji,
									color: normalizedColor,
								})
							}>
							{saveLabel}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
