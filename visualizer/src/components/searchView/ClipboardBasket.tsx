/**
 * ClipboardBasket.tsx — Side panel for collecting and reordering saved text snippets.
 *
 * Lines are added when the user clicks the 💾 icon on an excerpt line inside a D3
 * card (LOD ≥ medium) or selects text inside ChatViewDialog. Each BasketLine can
 * be moved up/down or removed individually. "Copy All" writes all line texts
 * joined by newlines to the system clipboard.
 *
 * Renders each entry via ClipboardMessage.tsx.
 * Empty-state text: "Click 💾 on card lines to collect them here".
 *
 * Docs: zz-reach2/architecture/ui/archi-context-core-ui.md §4.5
 */
import { useCallback, useEffect, useRef } from "react";
import ClipboardMessage from "./ClipboardMessage";
import type { BasketLine } from "../../types";

type Props = {
	lines: BasketLine[];
	isThreadMode?: boolean;
	onRemove: (id: string) => void;
	onClear: () => void;
	onSendToBuilder: () => void;
	onMoveUp: (id: string) => void;
	onMoveDown: (id: string) => void;
};

export default function ClipboardBasket({ lines, isThreadMode = false, onRemove, onClear, onSendToBuilder, onMoveUp, onMoveDown }: Props) {
	const contentRef = useRef<HTMLDivElement>(null);
	const baseWidth = 320;
	const itemCount = lines.length;
	const basketWidth = itemCount >= 2 ? baseWidth + 100 : itemCount >= 1 ? baseWidth + 50 : baseWidth;
	const basketHeight = itemCount >= 3 ? 500 : itemCount >= 2 ? 400 : itemCount >= 1 ? 200 : 100;
	const emptyText = isThreadMode
		? "Open a Thread and select text, click 💾 to collect"
		: "Click 💾 on card lines to collect them here";

	const handleCopyAll = useCallback(async () => {
		const text = lines.map((l) => l.text).join("\n");
		await navigator.clipboard.writeText(text);
	}, [lines]);

	useEffect(() => {
		if (contentRef.current) {
			contentRef.current.scrollTop = contentRef.current.scrollHeight;
		}
	}, [lines.length]);

	return (
		<div className="clipboard-basket" style={{ width: `${basketWidth}px`, height: `${basketHeight}px` }}>
			<div className="basket-header">
				<span className="basket-title">Clipboard Basket</span>
				<div className="basket-actions">
					<button
						type="button"
						className="basket-btn"
						onClick={onSendToBuilder}
						title="Send to Agent Builder"
						disabled={lines.length === 0}
						style={{ marginRight: "20px" }}
					>
						🏗️
					</button>
					<button type="button" className="basket-btn" onClick={handleCopyAll} title="Copy all to clipboard">
						📋
					</button>
					<button type="button" className="basket-btn" onClick={onClear} title="Clear basket">
						🗑️
					</button>
				</div>
			</div>
			<div className="basket-content" ref={contentRef}>
				{lines.length === 0 ? (
					<div className="basket-empty">{emptyText}</div>
				) : (
					lines.map((line, index) => (
						<ClipboardMessage
							key={line.id}
							line={line}
							onMoveUp={onMoveUp}
							onMoveDown={onMoveDown}
							onRemove={onRemove}
							canMoveUp={index > 0}
							canMoveDown={index < lines.length - 1}
						/>
					))
				)}
			</div>
		</div>
	);
}
