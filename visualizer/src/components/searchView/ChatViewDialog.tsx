/**
 * ChatViewDialog.tsx — Full-screen modal showing an entire chat session as a
 * scrollable message thread.
 *
 * Opened when the user clicks a card title in the D3 map ("title-click" event).
 * Fetches all messages for the session via fetchSessionMessages(sessionId) and
 * renders them in chronological order. The target message (messageId) is
 * scrolled into view and briefly highlighted with a blink animation on mount.
 *
 * Sub-components:
 *   - MessageBubble: one message row — role label, timestamp, body text, and
 *     zero or more ToolCallBlock children.
 *   - ToolCallBlock: a collapsible block showing a tool call's name, context
 *     lines, and result lines in <pre> sections.
 *
 * Text-selection → basket flow:
 *   A document selectionchange listener detects text selected inside the dialog.
 *   A floating 💾 button appears near the selection; clicking it calls
 *   onAddToBasket(text, messageId) and clears the selection.
 *
 * Dismissal: Escape key, overlay background click, or the × close button.
 *
 * Docs: zz-reach2/architecture/ui/archi-context-core-ui.md §4.8
 */
import { useEffect, useRef, useState } from "react";
import { fetchSessionMessages } from "../../api/search";
import type { SerializedAgentMessage, ToolCall } from "../../types";
import { GREEN_FLASH_BOX_SHADOW, GREEN_FLASH_COLOR, GREEN_FLASH_FILTER, runGreenFlash } from "../../shared/greenFlash";
import "./ChatViewDialog.css";

type ChatViewDialogProps = {
	sessionId: string;
	messageId: string;
	onClose: () => void;
	onAddToBasket?: (text: string, cardId: string) => void;
};

function ToolCallBlock({ tool }: { tool: ToolCall }) {
	const [expanded, setExpanded] = useState(false);

	return (
		<div className="cv-toolcall">
			<button type="button" className="cv-toolcall-toggle" onClick={() => setExpanded((prev) => !prev)} aria-expanded={expanded}>
				<span className="cv-toolcall-chevron">{expanded ? "▾" : "▸"}</span>
				<span className="cv-toolcall-name">{tool.name}</span>
			</button>
			{expanded && (
				<div className="cv-toolcall-body">
					{tool.context.length > 0 && (
						<div className="cv-toolcall-section">
							<div className="cv-toolcall-section-label">Context</div>
							<pre className="cv-toolcall-pre">{tool.context.join("\n")}</pre>
						</div>
					)}
					{tool.results.length > 0 && (
						<div className="cv-toolcall-section">
							<div className="cv-toolcall-section-label">Results</div>
							<pre className="cv-toolcall-pre">{tool.results.join("\n")}</pre>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

function MessageBubble({ message, isTarget }: { message: SerializedAgentMessage; isTarget: boolean }) {
	const bubbleRef = useRef<HTMLDivElement>(null);
	const flashCleanupRef = useRef<(() => void) | null>(null);
	const triggerGreenFlash = (element: HTMLDivElement): (() => void) => {
		const baseBorderLeftColor = getComputedStyle(element).borderLeftColor;
		const baseFilter = "none";
		const baseBoxShadow = "none";

		return runGreenFlash((step) => {
			element.style.transition = `border-left-color ${step.durationMs}ms ease-in-out, filter ${step.durationMs}ms ease-in-out, box-shadow ${step.durationMs}ms ease-in-out`;
			if (step.phase === "glow") {
				element.style.borderLeftColor = GREEN_FLASH_COLOR;
				element.style.filter = GREEN_FLASH_FILTER;
				element.style.boxShadow = GREEN_FLASH_BOX_SHADOW;
				return;
			}

			element.style.borderLeftColor = baseBorderLeftColor;
			element.style.filter = baseFilter;
			element.style.boxShadow = baseBoxShadow;
		});
	};
	const roleLabel =
		message.role === "assistant"
			? `Assistant (${message.model ?? "unknown"})`
			: message.role && message.role.length > 0
				? message.role.charAt(0).toUpperCase() + message.role.slice(1)
				: "Unknown";

	useEffect(() => {
		if (isTarget && bubbleRef.current) {
			bubbleRef.current.scrollIntoView({ behavior: "instant", block: "center" });
			flashCleanupRef.current?.();
			flashCleanupRef.current = triggerGreenFlash(bubbleRef.current);
			return () => {
				flashCleanupRef.current?.();
				flashCleanupRef.current = null;
			};
		}
	}, [isTarget]);

	const validToolCalls = (message.toolCalls || []).filter(
		(tool) =>
			!(
				tool.name === "unknownTool" &&
				(!tool.context || tool.context.length === 0) &&
				(!tool.results || tool.results.length === 0)
			),
	);

	return (
		<div ref={bubbleRef} className={`cv-message cv-message-${message.role}`} data-message-id={message.id}>
			<div className="cv-message-header">
				<span className="cv-message-role">{roleLabel}</span>
				<span className="cv-message-time">{message.dateTime ? new Date(message.dateTime).toLocaleString() : ""}</span>
			</div>
			{message.message && <div className="cv-message-body">{message.message}</div>}
			{validToolCalls.length > 0 && (
				<div className="cv-toolcalls">
					{validToolCalls.map((tool, index) => (
						<ToolCallBlock key={`${message.id}-tool-${index}`} tool={tool} />
					))}
				</div>
			)}
		</div>
	);
}

export default function ChatViewDialog({ sessionId, messageId, onClose, onAddToBasket }: ChatViewDialogProps) {
	const [messages, setMessages] = useState<SerializedAgentMessage[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	const [selectionState, setSelectionState] = useState<{ text: string; top: number; left: number; cardId: string } | null>(null);

	const [isEditingTopic, setIsEditingTopic] = useState(false);
	const [editedTopic, setEditedTopic] = useState("");
	const currentTopic = messages.length > 0 ? messages.find((m) => m.subject)?.subject || "Chat Session" : "Chat Session";

	const handleTopicClick = () => {
		setEditedTopic(currentTopic);
		setIsEditingTopic(true);
	};

	const saveTopic = async () => {
		try {
			await fetch("http://localhost:3210/api/topics", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sessionId, customTopic: editedTopic }),
			});
			if (messages.length > 0) {
				const newMessages = [...messages];
				const firstWithSubject = newMessages.findIndex((m) => m.subject);
				if (firstWithSubject !== -1) {
					newMessages[firstWithSubject] = { ...newMessages[firstWithSubject], subject: editedTopic };
				} else {
					newMessages[0] = { ...newMessages[0], subject: editedTopic };
				}
				setMessages(newMessages);
			}
		} catch (err) {
			console.error("Failed to save topic", err);
		} finally {
			setIsEditingTopic(false);
		}
	};

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);

		fetchSessionMessages(sessionId)
			.then((data) => {
				if (!cancelled) {
					setMessages(data);
					setLoading(false);
				}
			})
			.catch((err) => {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : "Failed to load session");
					setLoading(false);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [sessionId]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				onClose();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	useEffect(() => {
		const handleSelectionChange = () => {
			const sel = window.getSelection();
			if (!sel || sel.isCollapsed) {
				setSelectionState(null);
				return;
			}

			if (!dialogRef.current?.contains(sel.anchorNode)) {
				setSelectionState(null);
				return;
			}

			const text = sel.toString().trim();
			if (!text) {
				setSelectionState(null);
				return;
			}

			try {
				const range = sel.getRangeAt(0);
				const rect = range.getBoundingClientRect();
				const dialogRect = dialogRef.current.getBoundingClientRect();

				// Find message ID
				let node = sel.anchorNode;
				let cardId = sessionId;
				while (node && node !== dialogRef.current) {
					if (node instanceof HTMLElement && node.dataset.messageId) {
						cardId = node.dataset.messageId;
						break;
					}
					node = node.parentNode;
				}

				setSelectionState({
					text,
					top: rect.top + rect.height / 2,
					left: dialogRect.left + 16,
					cardId,
				});
			} catch (err) {
				setSelectionState(null);
			}
		};

		document.addEventListener("selectionchange", handleSelectionChange);
		return () => document.removeEventListener("selectionchange", handleSelectionChange);
	}, [sessionId]);

	return (
		<div className="cv-overlay" role="presentation" onClick={onClose}>
			{selectionState && onAddToBasket && (
				<button
					type="button"
					className="cv-selection-save-btn"
					style={{
						top: selectionState.top,
						left: selectionState.left,
					}}
					onClick={(e) => {
						e.stopPropagation();
						onAddToBasket(selectionState.text, selectionState.cardId);
						window.getSelection()?.removeAllRanges();
						setSelectionState(null);
					}}
					title="Save selection to basket">
					💾
				</button>
			)}
			<div ref={dialogRef} className="cv-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
				<div className="cv-header">
					{isEditingTopic ? (
						<div className="cv-title-edit">
							<button type="button" className="cv-title-save-btn" onClick={saveTopic} aria-label="Save Title">
								✔️
							</button>
							<textarea
								className="cv-title-textarea"
								value={editedTopic}
								onChange={(e) => setEditedTopic(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
										e.preventDefault();
										saveTopic();
									}
									if (e.key === "Escape") {
										e.preventDefault();
										e.stopPropagation();
										setIsEditingTopic(false);
									}
								}}
								autoFocus
							/>
						</div>
					) : (
						<h2 className="cv-title" onClick={handleTopicClick} title="Click to edit topic">
							{currentTopic}
						</h2>
					)}
					<div className="cv-header-actions">
						<span
							className="cv-envelope-btn"
							title="Copy thread JSON"
							onClick={() => navigator.clipboard.writeText(JSON.stringify(messages, null, 2))}>
							📧
						</span>
						<button type="button" className="cv-close-btn" onClick={onClose} aria-label="Close">
							&times;
						</button>
					</div>
				</div>
				<div className="cv-body" onScroll={() => setSelectionState(null)}>
					{loading && <div className="cv-loading">Loading session...</div>}
					{error && <div className="cv-error">{error}</div>}
					{!loading && !error && messages.length === 0 && <div className="cv-empty">No messages in this session.</div>}
					{!loading &&
						!error &&
						messages.map((msg, idx) => (
							<MessageBubble key={msg.id || `msg-${idx}`} message={msg} isTarget={msg.id === messageId} />
						))}
				</div>
			</div>
		</div>
	);
}
