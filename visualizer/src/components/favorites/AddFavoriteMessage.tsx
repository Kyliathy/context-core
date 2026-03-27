/**
 * AddFavoriteMessage.tsx - Modal for adding/editing custom text in a favorites view.
 *
 * Reuses the EditResultsView dialog styling to collect a title, message body,
 * emoji and color, then emits a trimmed payload through onSave. App turns that
 * payload into a synthetic favorites message with harness: "custom".
 *
 * Visibility:
 *   - Only used while the active view type is "favorites".
 *   - Returns null when open is false.
 *
 * Docs: zz-reach2/architecture/ui/archi-context-core-visualizer-ui.md Sec 4.12
 */
import { useEffect, useState } from "react";
import "../searchView/EditResultsView.css";

export type CustomTextInitial = {
	title: string;
	text: string;
	emoji: string;
	color: string;
};

type AddFavoriteMessageProps = {
	open: boolean;
	initial?: CustomTextInitial | null;
	onSave: (title: string, messageText: string, emoji: string, color: string) => void;
	onCancel: () => void;
};

const DEFAULT_COLOR = "#6b7280";

export default function AddFavoriteMessage({ open, initial, onSave, onCancel }: AddFavoriteMessageProps) {
	const [title, setTitle] = useState("");
	const [text, setText] = useState("");
	const [emoji, setEmoji] = useState("");
	const [color, setColor] = useState(DEFAULT_COLOR);

	useEffect(() => {
		if (open) {
			setTitle(initial?.title ?? "");
			setText(initial?.text ?? "");
			setEmoji(initial?.emoji ?? "");
			setColor(initial?.color ?? DEFAULT_COLOR);
		}
	}, [open, initial]);

	if (!open) {
		return null;
	}

	const isEditMode = !!initial;
	const canSave = text.trim().length > 0 && title.trim().length > 0;

	return (
		<div className="edit-results-view-overlay" role="presentation" onClick={onCancel}>
			<div className="edit-results-view" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
				<h2 className="edit-results-view-title">{isEditMode ? "Edit Custom Text" : "Add Custom Text"}</h2>

				<div className="edit-results-view-row">
					<label className="edit-results-view-label edit-results-view-grow">
						<span>Title</span>
						<input
							type="text"
							value={title}
							onChange={(event) => setTitle(event.target.value)}
							className="edit-results-view-input"
							placeholder="Title for your custom message"
						/>
					</label>

					<label className="edit-results-view-label edit-results-view-emoji-field">
						<span>Emoji</span>
						<input
							type="text"
							value={emoji}
							onChange={(event) => setEmoji(event.target.value)}
							className="edit-results-view-input"
						/>
					</label>

					<label className="edit-results-view-label">
						<span>Color</span>
						<input
							type="color"
							value={color}
							onChange={(event) => setColor(event.target.value)}
							className="edit-results-view-color"
						/>
					</label>
				</div>

				<label className="edit-results-view-label">
					<span>Message</span>
					<textarea
						value={text}
						onChange={(event) => setText(event.target.value)}
						className="edit-results-view-input"
						style={{ height: "120px", resize: "vertical", fontFamily: "inherit" }}
						placeholder="Type your custom favorite message here..."
					/>
				</label>

				<div className="edit-results-view-actions">
					<button type="button" className="edit-results-view-btn" onClick={onCancel}>
						Cancel
					</button>
					<button
						type="button"
						className="edit-results-view-btn edit-results-view-btn-primary"
						disabled={!canSave}
						onClick={() => onSave(title.trim(), text.trim(), emoji.trim(), color)}>
						{isEditMode ? "Save" : "OK"}
					</button>
				</div>
			</div>
		</div>
	);
}
