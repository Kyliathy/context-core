/**
 * HoverPanel.tsx — Floating metadata panel shown while hovering over a card or thread.
 *
 * Positioned near the cursor using page coordinates from the D3 engine's
 * "chat-hover" or "thread-hover" event. Clamped to stay within the viewport via useLayoutEffect.
 *
 * LOD-aware layout:
 *   - k < 1.2  (minimal/summary zoom): full content — harness badge, title,
 *               excerpt, symbol chips, project, model.
 *   - k ≥ 1.2  (medium/full zoom): metadata-only rows — Harness, Project, Model,
 *               Date, Score, Role, Session, Tools, Symbols. Avoids duplicating
 *               content already legible on the card face at this zoom level.
 *
 * Score is displayed as the raw combinedScore float, not a fabricated percentage.
 *
 * Docs: zz-reach2/architecture/ui/archi-context-core-ui.md §4.4
 */
import { useLayoutEffect, useRef, useState } from "react";
import type { CardData, ThreadCardData, ViewType } from "../../types";
import { getProjectColor, getProjectTextColor } from "../../d3/colors";
import { formatDateTime, formatDateTimeRange } from "../../d3/dateFormat";
import "./HoverPanel.css";

type HoverPanelProps = {
	data: CardData | ThreadCardData | null;
	x: number;
	y: number;
	visible: boolean;
	zoomLevel: number;
	viewType?: ViewType;
};

function getLodTier(k: number): "minimal" | "summary" | "medium" | "full" {
	if (k < 0.7) return "minimal";
	if (k < 1.2) return "summary";
	if (k < 2.5) return "medium";
	return "full";
}

function isThreadCard(data: CardData | ThreadCardData): data is ThreadCardData {
	return "messageCount" in data;
}

function formatCharCount(count: number): string {
	if (count >= 1000) {
		return `${(count / 1000).toFixed(1)}k`;
	}
	return String(count);
}

function formatTitle(title: string, maxSentences: number): string {
	if (maxSentences >= 3 && title.length <= 300) {
		return title;
	}
	const sentences = title.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g)?.map((sentence) => sentence.trim()) ?? [title];
	if (sentences.length <= maxSentences) {
		return title;
	}
	return sentences.slice(0, maxSentences).join(" ");
}

export default function HoverPanel({ data, x, y, visible, zoomLevel, viewType }: HoverPanelProps) {
	const panelRef = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState({ left: x + 16, top: y + 16 });
	const [titleSentenceLimit, setTitleSentenceLimit] = useState(3);
	const dataKey = data ? `${isThreadCard(data) ? "thread" : "card"}:${data.id}` : null;

	useLayoutEffect(() => {
		setTitleSentenceLimit(3);
	}, [dataKey]);

	useLayoutEffect(() => {
		if (!visible || !panelRef.current) {
			return;
		}
		const panel = panelRef.current;
		const rect = panel.getBoundingClientRect();
		let left = x + 16;
		let top = y + 16;
		if (left + rect.width > window.innerWidth - 8) {
			left = x - rect.width - 16;
		}
		if (top + rect.height > window.innerHeight - 8) {
			top = y - rect.height - 16;
		}
		setPosition({
			left: Math.max(8, left),
			top: Math.max(8, top),
		});

		const checkOverflow = () => {
			if (!panelRef.current) {
				return;
			}
			const hasOverflow = panelRef.current.scrollHeight > panelRef.current.clientHeight + 1;
			if (hasOverflow && titleSentenceLimit > 2) {
				setTitleSentenceLimit(2);
			}
		};
		checkOverflow();
		const rafId = window.requestAnimationFrame(checkOverflow);
		return () => window.cancelAnimationFrame(rafId);
	}, [visible, x, y, data, titleSentenceLimit]);

	if (!visible || !data) {
		return null;
	}

	// Thread card rendering
	if (isThreadCard(data)) {
		const dateRange = formatDateTimeRange(data.firstDateTime, data.lastDateTime);
		const scoreLabel = data.score.toFixed(2);

		return (
			<div ref={panelRef} className="hover-panel hover-panel-thread" style={{ left: position.left, top: position.top }}>
				<div className="hover-title">{formatTitle(data.title, titleSentenceLimit)}</div>
				<div className="hover-meta">
					<span className="hover-badge">{data.harness}</span>
					<span>🧵 Thread</span>
				</div>
				<hr className="hover-divider" />
				<div className="hover-meta-row">
					<span className="hover-meta-label">Messages</span>
					<span>{data.messageCount}</span>
				</div>
				<div className="hover-meta-row">
					<span className="hover-meta-label">Total Length</span>
					<span>{formatCharCount(data.totalLength)} chars</span>
				</div>
				<div className="hover-meta-row">
					<span className="hover-meta-label">Date Range</span>
					<span>{dateRange}</span>
				</div>
				<div className="hover-meta-row">
					<span className="hover-meta-label">Matches</span>
					<span className="hover-matches">{data.matchCount}</span>
				</div>
				<div className="hover-meta-row">
					<span className="hover-meta-label">Score</span>
					<span>{scoreLabel}</span>
				</div>
				<div className="hover-meta-row">
					<span className="hover-meta-label">Session</span>
					<span className="hover-session-id">{data.sessionId.slice(0, 12)}...</span>
				</div>
				{data.source.firstMessage && (
					<>
						<hr className="hover-divider" />
						<div className="hover-excerpt">{data.source.firstMessage.slice(0, 300)}</div>
					</>
				)}
			</div>
		);
	}

	// Message card rendering (original behavior)
	const lod = getLodTier(zoomLevel);
	const dateLabel = data.dateTime ? formatDateTime(data.dateTime) : "-";
	const scoreLabel = data.score.toFixed(2);
	const toolNames = data.source.toolCalls.map((call) => call.name);
	const isFileCard = data.harness === "AgentFile" || data.harness === "ContentFile";
	const isAgentCard = data.harness === "AgentCard";
	const isAgentBuilderView = viewType === "agent-builder";
	const isTemplateCard = data.harness === "TemplateCard";

	if (isTemplateCard) {
		let templateData: { tools?: string[]; agentKnowledge?: string[] } | null = null;
		try {
			templateData = JSON.parse(data.source.message);
		} catch {
			/* ignore */
		}
		const hint =
			data.excerptMedium && data.excerptMedium !== data.excerptShort
				? data.excerptMedium.replace(data.excerptShort, "").replace(/^\nhint: /, "")
				: null;
		const knowledgeCount = templateData?.agentKnowledge?.length ?? 0;
		const tools = templateData?.tools ?? [];
		return (
			<div ref={panelRef} className="hover-panel hover-panel-meta" style={{ left: position.left, top: position.top }}>
				<div className="hover-meta-row">
					<span className="hover-meta-label">Harness</span>
					<span className="hover-badge">{data.harness}</span>
				</div>
				<div className="hover-meta-row">
					<span className="hover-meta-label">Template</span>
					<span>{data.title}</span>
				</div>
				<div className="hover-meta-row">
					<span className="hover-meta-label">Description</span>
					<span>{data.excerptShort}</span>
				</div>
				{hint && (
					<div className="hover-meta-row">
						<span className="hover-meta-label">Hint</span>
						<span>{hint}</span>
					</div>
				)}
				{tools.length > 0 && (
					<div className="hover-meta-row">
						<span className="hover-meta-label">Tools</span>
						<span>{tools.join(", ")}</span>
					</div>
				)}
				<div className="hover-meta-row">
					<span className="hover-meta-label">Knowledge</span>
					<span>
						{knowledgeCount} {knowledgeCount === 1 ? "entry" : "entries"}
					</span>
				</div>
			</div>
		);
	}

	if (isAgentCard) {
		return (
			<div ref={panelRef} className="hover-panel hover-panel-meta" style={{ left: position.left, top: position.top }}>
				<div className="hover-meta-row">
					<span className="hover-meta-label">Harness</span>
					<span className="hover-badge">{data.harness}</span>
				</div>
				<div className="hover-meta-row">
					<span className="hover-meta-label">Agent</span>
					<span>{data.title}</span>
				</div>
				<div className="hover-meta-row">
					<span className="hover-meta-label">Description</span>
					<span>{data.excerptShort}</span>
				</div>
				{data.excerptMedium && data.excerptMedium !== data.excerptShort && (
					<div className="hover-meta-row">
						<span className="hover-meta-label">Hint</span>
						<span>{data.excerptMedium.replace(data.excerptShort, "").replace(/^\nhint: /, "")}</span>
					</div>
				)}
			</div>
		);
	}

	if (lod === "medium" || lod === "full") {
		const fileTypeLabel = data.harness === "AgentFile" ? "Agent" : data.harness === "ContentFile" ? "Content" : data.harness;
		return (
			<div ref={panelRef} className="hover-panel hover-panel-meta" style={{ left: position.left, top: position.top }}>
				{isAgentBuilderView && data.project && (
					<div className="hover-meta-row">
						<span className="hover-meta-label">Project</span>
						<span
							className="hover-badge"
							style={{ backgroundColor: getProjectColor(data.project), color: getProjectTextColor(data.project) }}
						>
							{data.project}
						</span>
					</div>
				)}
				<div className="hover-meta-row">
					<span className="hover-meta-label">{isAgentBuilderView ? "File Type" : "Harness"}</span>
					<span className="hover-badge">{isAgentBuilderView ? fileTypeLabel : data.harness}</span>
				</div>
				{!isAgentBuilderView && (
					<div className="hover-meta-row">
						<span className="hover-meta-label">Project</span>
						<span>{data.project || "MISC"}</span>
					</div>
				)}
				<div className="hover-meta-row">
					<span className="hover-meta-label">Model</span>
					<span>{data.model ?? "—"}</span>
				</div>
				<div className="hover-meta-row">
					<span className="hover-meta-label">Date</span>
					<span>{dateLabel}</span>
				</div>
				{isFileCard ? (
					<>
						<div className="hover-meta-row">
							<span className="hover-meta-label">Origin</span>
							<span>{data.harness === "AgentFile" ? "agent" : "content"}</span>
						</div>
						<div className="hover-meta-row">
							<span className="hover-meta-label">Path</span>
							<span className="hover-session-id">{data.excerptShort}</span>
						</div>
					</>
				) : (
					<>
						<div className="hover-meta-row">
							<span className="hover-meta-label">Score</span>
							<span>{scoreLabel}</span>
						</div>
						<div className="hover-meta-row">
							<span className="hover-meta-label">Role</span>
							<span>{data.role}</span>
						</div>
						<div className="hover-meta-row">
							<span className="hover-meta-label">Session</span>
							<span className="hover-session-id">{data.sessionId.slice(0, 12)}...</span>
						</div>
						{toolNames.length > 0 && (
							<div className="hover-meta-row">
								<span className="hover-meta-label">Tools</span>
								<span>
									{toolNames.length} calls: {toolNames.join(", ")}
								</span>
							</div>
						)}
						<div className="hover-meta-row">
							<span className="hover-meta-label">Symbols</span>
							<span>{data.symbols.length}</span>
						</div>
					</>
				)}
			</div>
		);
	}

	return (
		<div ref={panelRef} className="hover-panel" style={{ left: position.left, top: position.top }}>
			<div className="hover-title">{formatTitle(data.title, titleSentenceLimit)}</div>
			<div className="hover-meta">
				<span className="hover-badge">{data.harness}</span>
				<span>{data.project || "MISC"}</span>
				<span>{data.model ?? "—"}</span>
			</div>
			<div className="hover-meta">
				<span>{dateLabel}</span>
				<span>Score: {scoreLabel}</span>
			</div>
			<hr className="hover-divider" />
			<div className="hover-symbols">
				{data.symbols.length === 0 ? (
					<span className="hover-muted">No symbols</span>
				) : (
					data.symbols.map((symbol) => (
						<span key={`${data.id}-${symbol.label}`} className="hover-symbol" style={{ color: symbol.color }}>
							{symbol.label}
						</span>
					))
				)}
			</div>
			<div className="hover-excerpt">{data.excerptLong.slice(0, 500)}</div>
			{toolNames.length > 0 && (
				<div className="hover-tools">
					{toolNames.length} tool calls: {toolNames.join(", ")}
				</div>
			)}
		</div>
	);
}
