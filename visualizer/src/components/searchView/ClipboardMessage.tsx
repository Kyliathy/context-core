/**
 * ClipboardMessage.tsx — Single row inside the ClipboardBasket panel.
 *
 * Displays the saved text snippet with up/down reorder buttons and a remove (×)
 * button. Up/down buttons are disabled at the top/bottom of the list respectively.
 * Rendered by ClipboardBasket.tsx; has no local state.
 *
 * Docs: zz-reach2/architecture/ui/archi-context-core-ui.md §4.5
 */
import type { BasketLine } from "../../types";

type Props = {
	line: BasketLine;
	onMoveUp: (id: string) => void;
	onMoveDown: (id: string) => void;
	onRemove: (id: string) => void;
	canMoveUp: boolean;
	canMoveDown: boolean;
};

export default function ClipboardMessage({ line, onMoveUp, onMoveDown, onRemove, canMoveUp, canMoveDown }: Props) {
	return (
		<div className="basket-line">
			<div className="basket-line-controls">
				<button
					type="button"
					className="basket-control-btn"
					onClick={() => onMoveUp(line.id)}
					disabled={!canMoveUp}
					title="Move up">
					⬆
				</button>
				<button
					type="button"
					className="basket-control-btn basket-control-remove"
					onClick={() => onRemove(line.id)}
					title="Remove">
					×
				</button>
				<button
					type="button"
					className="basket-control-btn"
					onClick={() => onMoveDown(line.id)}
					disabled={!canMoveDown}
					title="Move down">
					⬇
				</button>
			</div>
			<span className="basket-line-text">{line.text}</span>
		</div>
	);
}
