import * as d3 from "d3";
import { getHarnessColor, getProjectColor, getProjectTextColor } from "./colors";
import { computeGridLayout, computeWorldBounds, computeThreadGridLayout, computeMixedGridLayout, computeMixedWorldBounds, computeMasterCardLayout, computeMasterCardWorldBounds } from "./layout";
import { formatDateTime, formatDateTimeRange } from "./dateFormat";
import { GREEN_FLASH_COLOR, GREEN_FLASH_FILTER, runGreenFlash } from "../shared/greenFlash";
import type { CardData, ThreadCardData, MasterCardData, HoverEventDetail, ViewportChangeDetail, LineClickEventDetail, CardStarEventDetail, FavoriteSource, CardAddKnowledgeEventDetail, CardEditAgentEventDetail, CardUseTemplateEventDetail } from "../types";

type ThreadHoverEventDetail = {
	phase: "enter" | "move" | "leave";
	data: ThreadCardData;
	localX: number;
	localY: number;
	pageX: number;
	pageY: number;
};

type CardRenderMode = "default" | "agent-builder" | "agent-list" | "template-list";

export type EngineConfig = {
	cardRenderMode: CardRenderMode;
};

const DEFAULT_CONFIG: EngineConfig = {
	cardRenderMode: "default",
};

const ZOOM_REFLOW_STEP = 0.3;
const MIN_ZOOM_FOR_LAYOUT = 0.15;
const MAX_LAYOUT_WIDTH_MULTIPLIER = 4;
const REFLOW_LOCK_ZOOM = 1.0;
const LOCKED_REFLOW_BUCKET = -1;
const DOUBLE_CLICK_TARGET_ZOOM = 1.1;

function getReflowBucket(k: number): number
{
	if (k >= REFLOW_LOCK_ZOOM)
	{
		return LOCKED_REFLOW_BUCKET;
	}
	return Math.floor(Math.max(k, MIN_ZOOM_FOR_LAYOUT) / ZOOM_REFLOW_STEP);
}

function getBucketRepresentativeZoom(bucket: number): number
{
	return Math.max(MIN_ZOOM_FOR_LAYOUT, (bucket + 0.5) * ZOOM_REFLOW_STEP);
}

function computeLayoutWidth(baseWidth: number, bucket: number): number
{
	if (bucket === LOCKED_REFLOW_BUCKET)
	{
		return Math.max(320, baseWidth);
	}
	const representativeZoom = getBucketRepresentativeZoom(bucket);
	const zoomMultiplier = Math.min(MAX_LAYOUT_WIDTH_MULTIPLIER, 1 / representativeZoom);
	return Math.max(320, Math.round(baseWidth * zoomMultiplier));
}

type EngineEventMap = {
	"chat-hover": HoverEventDetail;
	"chat-click": { data: CardData };
	"thread-hover": ThreadHoverEventDetail;
	"thread-click": { data: ThreadCardData };
	"viewport-change": ViewportChangeDetail;
	"line-click": LineClickEventDetail;
	"card-star": CardStarEventDetail;
	"card-add-knowledge": CardAddKnowledgeEventDetail;
	"card-edit-agent": CardEditAgentEventDetail;
	"card-use-template": CardUseTemplateEventDetail;
	"thread-star": CardStarEventDetail;
	"line-star": { cardId: string; source: any };
	"copy-json": { cardId: string; source: any };
	"copy-msg": { cardId: string; source: any };
	"title-click": { sessionId: string; messageId: string };
};

export type ChatMapEngineOptions = {
	onEvent?: <T extends keyof EngineEventMap>(type: T, detail: EngineEventMap[T]) => void;
	worldWidth?: number;
	worldHeight?: number;
};

export type ChatMapEngine = {
	update(cards: CardData[], threadCards?: ThreadCardData[], masterCards?: MasterCardData[]): void;
	setStarredIds(starredIds: Set<string>): void;
	setConfig(config: Partial<EngineConfig>): void;
	setTransform(transform: d3.ZoomTransform): void;
	resetViewportToTop(scale?: number, topPadding?: number, leftPadding?: number): void;
	zoomToFit(padding?: number): void;
	destroy(): void;
};

type LOD = "minimal" | "summary" | "detail-1" | "detail-2" | "detail-3" | "detail-4" | "detail-5";

function getLod(k: number): LOD
{
	if (k < 0.7)
	{
		return "minimal";
	}
	if (k < 1.2)
	{
		return "summary";
	}
	if (k < 1.8)
	{
		return "detail-1";
	}
	if (k < 2.7)
	{
		return "detail-2";
	}
	if (k < 4.0)
	{
		return "detail-3";
	}
	if (k < 6.0)
	{
		return "detail-4";
	}
	return "detail-5";
}

function escapeHtml(input: string): string
{
	return input
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function renderExcerptLines(text: string, cardId: string, isStarred: boolean, mode: CardRenderMode = "default"): string
{
	const lines = text.split(/\r\n|\n|\r/);
	let visibleIdx = 0;
	return lines
		.map((line, idx) =>
		{
			if (!line.trim())
			{
				return "";
			}
			const escaped = escapeHtml(line);
			const showButtons = visibleIdx % 10 === 0;
			visibleIdx++;
			let btnHtml: string;
			if (mode === "agent-list" || mode === "template-list")
			{
				// List card modes: no per-line buttons
				btnHtml = `<div class="line-actions spacer"></div>`;
			}
			else if (mode === "agent-builder")
			{
				// Agent builder: only the save/add-to-knowledge button
				btnHtml = showButtons
					? `<div class="line-actions"><span class="line-add-btn" title="Add to knowledge">💾</span></div>`
					: `<div class="line-actions spacer"></div>`;
			}
			else
			{
				// Default: save, star, copy
				const starIcon = isStarred ? "★" : "☆";
				btnHtml = showButtons
					? `<div class="line-actions"><span class="line-add-btn" title="Add to basket">💾</span><span class="line-star-btn" title="Add to favorites">${starIcon}</span><span class="line-copy-msg-btn" title="Copy message">📋</span></div>`
					: `<div class="line-actions spacer"></div>`;
			}
			return `<div class="excerpt-line" data-card-id="${cardId}" data-line-idx="${idx}">${btnHtml}<span class="line-text">${escaped}</span></div>`;
		})
		.filter(Boolean)
		.join("");
}

function renderSymbols(card: CardData, maxCount: number): string
{
	return card.symbols
		.slice(0, maxCount)
		.map((symbol) => `<span class="sym" style="color:${symbol.color}">${escapeHtml(symbol.label)}</span>`)
		.join(" ");
}

function formatCharCount(count: number): string
{
	if (count >= 1000)
	{
		return `${(count / 1000).toFixed(1)}k chars`;
	}
	return `${count} chars`;
}

function renderThreadCardHtml(thread: ThreadCardData, lod: LOD, starredIds: Set<string>): string
{
	const harnessBadge = `<span class="harness-badge" style="background-color:${getHarnessColor(thread.harness)}">${escapeHtml(thread.harness)}</span>`;
	const projectLabel = thread.project || "MISC";
	const projectBadge = `<span class="project-badge" style="background-color:${getProjectColor(projectLabel)};color:${getProjectTextColor(projectLabel)}">${escapeHtml(projectLabel)}</span>`;
	const badges = `<div class="card-badges">${harnessBadge}${projectBadge}</div>`;
	const isStarred = starredIds.has(thread.id);
	const starIcon = isStarred ? "★" : "☆";
	const renderThreadExcerpt = (excerptText: string): string =>
	{
		if (!excerptText)
		{
			return "";
		}
		return `<div class="thread-excerpt"><div class="thread-excerpt-line"><div class="line-actions thread-line-actions"><span class="line-star-btn thread-star-btn" title="Add to favorites">${starIcon}</span></div><span class="thread-line-text">${escapeHtml(excerptText)}</span></div></div>`;
	};

	if (lod === "minimal")
	{
		return `<div class="thread-body lod-minimal"><div class="thread-stats">${thread.messageCount} msgs</div></div>`;
	}

	const dateRange = formatDateTimeRange(thread.firstDateTime, thread.lastDateTime);
	const charCount = formatCharCount(thread.totalLength);
	const firstMessage = thread.source.firstMessage || "";

	if (lod === "summary")
	{
		const excerpt = firstMessage.slice(0, 150);
		return `<div class="thread-body lod-summary">${badges}<div class="thread-title">${escapeHtml(thread.title)}</div><div class="thread-meta"><span class="thread-stat">📨 ${thread.messageCount}</span><span class="thread-stat">📝 ${charCount}</span></div><div class="thread-meta"><span class="thread-stat">📅 ${dateRange}</span><span class="thread-stat ${thread.matchCount > 0 ? "thread-matches" : ""}">🎯 ${thread.matchCount}</span></div>${renderThreadExcerpt(excerpt)}</div>`;
	}

	if (lod === "detail-1")
	{
		const excerpt = firstMessage.slice(0, 300);
		return `<div class="thread-body lod-detail-1">${badges}<div class="thread-title">${escapeHtml(thread.title)}</div><div class="thread-meta"><span class="thread-stat">📨 ${thread.messageCount} messages</span><span class="thread-stat">📝 ${charCount}</span></div><div class="thread-meta"><span class="thread-stat">📅 ${dateRange}</span><span class="thread-stat ${thread.matchCount > 0 ? "thread-matches" : ""}">🎯 ${thread.matchCount} matches</span></div>${renderThreadExcerpt(excerpt)}</div>`;
	}

	if (lod === "detail-2")
	{
		const excerpt = firstMessage.slice(0, 500);
		return `<div class="thread-body lod-detail-2">${badges}<div class="thread-title">${escapeHtml(thread.title)}</div><div class="thread-meta"><span class="thread-stat">📨 ${thread.messageCount} messages</span><span class="thread-stat">📝 ${charCount}</span></div><div class="thread-meta"><span class="thread-stat">📅 ${dateRange}</span><span class="thread-stat ${thread.matchCount > 0 ? "thread-matches" : ""}">🎯 ${thread.matchCount} matches</span></div>${renderThreadExcerpt(excerpt)}</div>`;
	}

	if (lod === "detail-3")
	{
		const excerpt = firstMessage.slice(0, 1000);
		return `<div class="thread-body lod-detail-3">${badges}<div class="thread-title">${escapeHtml(thread.title)}</div><div class="thread-meta"><span class="thread-stat">📨 ${thread.messageCount} messages</span><span class="thread-stat">📝 ${charCount}</span></div><div class="thread-meta"><span class="thread-stat">📅 ${dateRange}</span><span class="thread-stat ${thread.matchCount > 0 ? "thread-matches" : ""}">🎯 ${thread.matchCount} matches</span></div>${renderThreadExcerpt(excerpt)}</div>`;
	}

	if (lod === "detail-4")
	{
		const excerpt = firstMessage.slice(0, 2000);
		return `<div class="thread-body lod-detail-4">${badges}<div class="thread-title">${escapeHtml(thread.title)}</div><div class="thread-meta"><span class="thread-stat">📨 ${thread.messageCount} messages</span><span class="thread-stat">📝 ${charCount}</span></div><div class="thread-meta"><span class="thread-stat">📅 ${dateRange}</span><span class="thread-stat ${thread.matchCount > 0 ? "thread-matches" : ""}">🎯 ${thread.matchCount} matches</span></div>${renderThreadExcerpt(excerpt)}</div>`;
	}

	return `<div class="thread-body lod-detail-5">${badges}<div class="thread-title">${escapeHtml(thread.title)}</div><div class="thread-meta"><span class="thread-stat">📨 ${thread.messageCount} messages</span><span class="thread-stat">📝 ${charCount}</span></div><div class="thread-meta"><span class="thread-stat">📅 ${dateRange}</span><span class="thread-stat ${thread.matchCount > 0 ? "thread-matches" : ""}">🎯 ${thread.matchCount} matches</span></div>${renderThreadExcerpt(firstMessage)}</div>`;
}

function renderCardHtml(card: CardData, lod: LOD, starredIds: Set<string>, mode: CardRenderMode = "default"): string
{
	const date = card.dateTime ? formatDateTime(card.dateTime) : "";
	const isAgentBuilderMode = mode === "agent-builder";
	const harnessDisplay = isAgentBuilderMode
		? (card.harness === "AgentFile" ? "Agent" : card.harness === "ContentFile" ? "Content" : card.harness)
		: card.harness;
	const badgeColor = card.customColor || getHarnessColor(card.harness);
	const harnessBadge = `<span class="harness-badge" style="background-color:${badgeColor}">${escapeHtml(harnessDisplay)}</span>`;
	const projectLabel = card.project || "MISC";
	const projectBadge = `<span class="project-badge" style="background-color:${getProjectColor(projectLabel)};color:${getProjectTextColor(projectLabel)}">${escapeHtml(projectLabel)}</span>`;
	const badges = `<div class="card-badges">${harnessBadge}${projectBadge}</div>`;
	// List card modes use header actions instead of envelope.
	const customEditBtn = card.harness === "custom" ? `<span class="card-edit-btn" title="Edit custom text">✏️</span>` : "";
	const headerBtn = mode === "agent-list"
		? `<span class="card-edit-btn" title="Edit agent">✏️</span>`
		: mode === "template-list"
			? `<span class="card-use-template-btn" title="Create agent from template">🎓</span><span class="card-edit-btn" title="Edit template">✏️</span>`
			: `${customEditBtn}<span class="card-envelope-btn" title="Copy message JSON">📧</span>`;
	const isStarred = starredIds.has(card.id);

	if (lod === "minimal")
	{
		return `<div class="chat-body lod-minimal"><div class="chat-project">${escapeHtml(card.project || "MISC")}</div></div>`;
	}

	if (lod === "summary")
	{
		return `<div class="chat-body lod-summary">${badges}${headerBtn}<div class="chat-title">${escapeHtml(card.title)}</div><div class="chat-project">${escapeHtml(date)}</div><div class="chat-excerpt">${renderExcerptLines(card.excerptMedium, card.id, isStarred, mode)}</div></div>`;
	}

	if (lod === "detail-1")
	{
		return `<div class="chat-body lod-detail-1">${badges}${headerBtn}<div class="chat-title">${escapeHtml(card.title)}</div><div class="chat-symbols">${renderSymbols(card, 8)}</div><div class="chat-project">${escapeHtml(date)}</div><div class="chat-excerpt">${renderExcerptLines(card.excerptLong, card.id, isStarred, mode)}</div></div>`;
	}

	if (lod === "detail-2")
	{
		return `<div class="chat-body lod-detail-2">${badges}${headerBtn}<div class="chat-title">${escapeHtml(card.title)}</div><div class="chat-symbols">${renderSymbols(card, 16)}</div><div class="chat-project">${escapeHtml(card.model ?? "unknown-model")} · ${escapeHtml(date)}</div><div class="chat-excerpt">${renderExcerptLines(card.excerptLong, card.id, isStarred, mode)}</div></div>`;
	}

	if (lod === "detail-3")
	{
		return `<div class="chat-body lod-detail-3">${badges}${headerBtn}<div class="chat-title">${escapeHtml(card.title)}</div><div class="chat-symbols">${renderSymbols(card, 24)}</div><div class="chat-project">${escapeHtml(card.model ?? "unknown-model")} · ${escapeHtml(date)}</div><div class="chat-excerpt">${renderExcerptLines(card.source.message, card.id, isStarred, mode)}</div></div>`;
	}

	if (lod === "detail-4")
	{
		return `<div class="chat-body lod-detail-4">${badges}${headerBtn}<div class="chat-title">${escapeHtml(card.title)}</div><div class="chat-symbols">${renderSymbols(card, 32)}</div><div class="chat-project">${escapeHtml(card.model ?? "unknown-model")} · ${escapeHtml(date)}</div><div class="chat-excerpt">${renderExcerptLines(card.source.message, card.id, isStarred, mode)}</div></div>`;
	}

	return `<div class="chat-body lod-detail-5">${badges}${headerBtn}<div class="chat-title">${escapeHtml(card.title)}</div><div class="chat-symbols">${renderSymbols(card, 48)}</div><div class="chat-project">${escapeHtml(card.model ?? "unknown-model")} · ${escapeHtml(date)}</div><div class="chat-excerpt">${renderExcerptLines(card.source.message, card.id, isStarred, mode)}</div></div>`;
}

export function createChatMapEngine(
	container: HTMLElement,
	initialCards: CardData[],
	options: ChatMapEngineOptions = {}
): ChatMapEngine
{
	container.innerHTML = "";

	const root = d3.select(container).style("position", "relative").style("overflow", "hidden");
	const svg = root.append("svg").attr("width", "100%").attr("height", "100%").style("display", "block");
	svg.append("defs");
	const world = svg.append("g").attr("class", "world");

	let worldWidth = options.worldWidth ?? 5000;
	let worldHeight = options.worldHeight ?? 3000;
	let currentCards: CardData[] = [];
	let currentThreads: ThreadCardData[] = [];
	let currentMasterCards: MasterCardData[] = [];
	let sourceCards: CardData[] = [];
	let sourceThreads: ThreadCardData[] = [];
	let sourceMasterCards: MasterCardData[] = [];
	let currentTransform = d3.zoomIdentity;
	let currentLod: LOD = getLod(currentTransform.k);
	let currentMastercardTier: 0 | 1 | 2 = 0;
	let currentReflowBucket = getReflowBucket(currentTransform.k);
	let isApplyingRelayoutTransform = false;
	let suspendBucketRelayout = false;
	let starredIds = new Set<string>();
	let config: EngineConfig = { ...DEFAULT_CONFIG };

	function applyLayout(cards: CardData[], threadCards: ThreadCardData[], masterCards: MasterCardData[]): void
	{
		const baseWidth = Math.max(container.clientWidth - 24, 320);
		const width = computeLayoutWidth(baseWidth, currentReflowBucket);

		// MasterCard grouping path: layout children inside master containers
		if (masterCards.length > 0)
		{
			const laidOut = computeMasterCardLayout(masterCards, width);
			currentMasterCards = laidOut;
			// Extract children with absolute positions for flat rendering
			currentCards = laidOut.flatMap((mc) => mc.cards);
			currentThreads = laidOut.flatMap((mc) => mc.threads);
			const bounds = computeMasterCardWorldBounds(laidOut);
			worldWidth = bounds.width;
			worldHeight = bounds.height;
		}
		// Check if we have mixed content (both cards and threads)
		else if (cards.length > 0 && threadCards.length > 0)
		{
			currentMasterCards = [];
			// Mixed layout for favorites view
			const layout = computeMixedGridLayout(cards, threadCards, width);
			currentCards = layout.cards;
			currentThreads = layout.threads;
			const bounds = computeMixedWorldBounds(currentCards, currentThreads);
			worldWidth = bounds.width;
			worldHeight = bounds.height;
		}
		else if (threadCards.length > 0)
		{
			currentMasterCards = [];
			// Thread-only layout
			currentCards = [];
			currentThreads = computeThreadGridLayout(threadCards, width);
			const bounds = computeMixedWorldBounds([], currentThreads);
			worldWidth = bounds.width;
			worldHeight = bounds.height;
		}
		else
		{
			currentMasterCards = [];
			// Card-only layout (original behavior)
			const forceSquare = config.cardRenderMode === "agent-builder";
			currentCards = computeGridLayout(cards, width, forceSquare);
			currentThreads = [];
			const bounds = computeWorldBounds(currentCards);
			worldWidth = bounds.width;
			worldHeight = bounds.height;
		}

		renderMasterCards();
		renderCards();
		renderThreadCards();
	}

	function relayoutForBucketChange(nextBucket: number): void
	{
		if (nextBucket === currentReflowBucket)
		{
			return;
		}

		const viewportWidth = Math.max(container.clientWidth, 1);
		const viewportHeight = Math.max(container.clientHeight, 1);
		const centerWorldX = (viewportWidth / 2 - currentTransform.x) / currentTransform.k;
		const centerWorldY = (viewportHeight / 2 - currentTransform.y) / currentTransform.k;

		currentReflowBucket = nextBucket;
		applyLayout(sourceCards, sourceThreads, sourceMasterCards);

		const nextTransform = d3.zoomIdentity
			.translate(viewportWidth / 2 - centerWorldX * currentTransform.k, viewportHeight / 2 - centerWorldY * currentTransform.k)
			.scale(currentTransform.k);

		isApplyingRelayoutTransform = true;
		svg.call(zoom.transform, nextTransform);
	}

	const emit = <T extends keyof EngineEventMap>(type: T, detail: EngineEventMap[T]) =>
	{
		options.onEvent?.(type, detail);
		container.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
	};

	const zoom = d3
		.zoom<SVGSVGElement, unknown>()
		.scaleExtent([0.15, 8])
		.clickDistance(5)
		.wheelDelta((event: WheelEvent) => -event.deltaY * (event.deltaMode === 1 ? 0.04 : event.deltaMode ? 1 : 0.002))
		.on("zoom", (event) =>
		{
			currentTransform = event.transform;
			world.attr("transform", event.transform.toString());
			updateLod(event.transform.k);
			if (!isApplyingRelayoutTransform && !suspendBucketRelayout)
			{
				const nextBucket = getReflowBucket(event.transform.k);
				relayoutForBucketChange(nextBucket);
			}
			else
			{
				isApplyingRelayoutTransform = false;
			}
			emit("viewport-change", {
				x: event.transform.x,
				y: event.transform.y,
				k: event.transform.k,
			});
		});

	svg.call(zoom);

	function getMastercardTier(k: number): 0 | 1 | 2
	{
		if (k >= 1.5) return 2;
		if (k >= 0.8) return 1;
		return 0;
	}

	function buildMastercardHeaderHtml(mc: MasterCardData, tier: 0 | 1 | 2): string
	{
		const labelSize = [26, 18, 13][tier];
		const countSize = [22, 15, 11][tier];
		const padding = ["8px 24px", "6px 17px", "4px 12px"][tier];
		const gap = ["12px", "8px", "6px"][tier];
		const childCount = mc.cards.length + mc.threads.length;
		const emojiPart = mc.emoji ? `${escapeHtml(mc.emoji)} ` : "";
		return `<div class="mastercard-header" style="padding:${padding};gap:${gap}"><span class="mastercard-label" style="font-size:${labelSize}px">${emojiPart}${escapeHtml(mc.label)}</span><span class="mastercard-count" style="font-size:${countSize}px">${childCount}</span></div>`;
	}

	function updateLod(k: number, force = false): void
	{
		const tier = getMastercardTier(k);
		if (tier !== currentMastercardTier)
		{
			currentMastercardTier = tier;
			world
				.selectAll<SVGGElement, MasterCardData>("g.mastercard")
				.select<HTMLElement>(".mastercard-header-wrap")
				.html((mc) => buildMastercardHeaderHtml(mc, tier));
		}

		const lod = getLod(k);
		if (!force && lod === currentLod)
		{
			return;
		}
		currentLod = lod;
		world
			.selectAll<SVGGElement, CardData>("g.chat")
			.select<HTMLElement>(".chat-html")
			.html((card) => renderCardHtml(card, lod, starredIds, config.cardRenderMode));
		world
			.selectAll<SVGGElement, ThreadCardData>("g.thread")
			.select<HTMLElement>(".thread-html")
			.html((thread) => renderThreadCardHtml(thread, lod, starredIds));
	}

	function renderCards(): void
	{
		const minScore = d3.min(currentCards, (card) => card.score) ?? 0;
		const maxScore = d3.max(currentCards, (card) => card.score) ?? 1;
		const opacityScale = d3.scaleLinear().domain([minScore, maxScore]).range([1, 0.85]).clamp(true);
		const maxHits = d3.max(currentCards, (card) => card.hits) ?? 0;

		const cards = world
			.selectAll<SVGGElement, CardData>("g.chat")
			.data(currentCards, (card) => card.id)
			.join(
				(enter) =>
				{
					const group = enter.append("g").attr("class", "chat");
					group.append("rect").attr("class", "chat-bg").attr("rx", 12).attr("ry", 12);
					group.append("rect").attr("class", "harness-stripe");
					group.append("rect").attr("class", "hits-bar");
					group
						.append("foreignObject")
						.attr("class", "chat-fo")
						.append("xhtml:div")
						.attr("class", "chat-html");
					group
						.append("text")
						.attr("class", "card-emoji-text");
					return group;
				},
				(update) => update,
				(exit) => exit.remove()
			);

		cards
			.attr("transform", (card) => `translate(${card.x},${card.y})`)
			.attr("opacity", (card) => opacityScale(card.score));

		cards
			.select<SVGRectElement>("rect.chat-bg")
			.attr("width", (card) => card.w)
			.attr("height", (card) => card.h)
			.attr("fill", "#111827")
			.attr("stroke", (card) => card.customColor || "#374151")
			.attr("stroke-width", (card) => card.customColor ? 1.5 : 1.25);

		cards
			.select<SVGRectElement>("rect.harness-stripe")
			.attr("x", 0)
			.attr("y", 0)
			.attr("width", 4)
			.attr("height", (card) => card.h)
			.attr("fill", (card) => card.customColor
				|| (config.cardRenderMode === "agent-builder" && card.project
					? getProjectColor(card.project)
					: getHarnessColor(card.harness)));

		cards
			.select<SVGRectElement>("rect.hits-bar")
			.attr("x", (card) => card.w - 4)
			.attr("y", (card) =>
			{
				if (maxHits === 0) return card.h;
				return card.h * (1 - card.hits / maxHits);
			})
			.attr("width", 4)
			.attr("height", (card) =>
			{
				if (maxHits === 0) return 0;
				return card.h * (card.hits / maxHits);
			})
			.attr("rx", 0)
			.attr("fill", (card) =>
			{
				if (maxHits === 0) return "transparent";
				return d3.interpolateRgb("#ef4444", "#22c55e")(card.hits / maxHits);
			})
			.attr("opacity", (card) => (card.hits > 0 ? 0.85 : 0));

		cards
			.select<SVGForeignObjectElement>("foreignObject.chat-fo")
			.attr("x", 12)
			.attr("y", 8)
			.attr("width", (card) => Math.max(0, card.w - 20))
			.attr("height", (card) => Math.max(0, card.h - 16));

		cards
			.select<SVGTextElement>("text.card-emoji-text")
			.attr("x", (card) => card.w - 18)
			.attr("y", 26)
			.attr("text-anchor", "middle")
			.style("font-size", "22px")
			.style("pointer-events", "none")
			.text((card) => card.customEmoji || "");

		cards
			.on("pointerenter", function (event, card)
			{
				d3.select(this).select<SVGRectElement>("rect.chat-bg").attr("fill", "#1f2937");
				const [localX, localY] = d3.pointer(event, container);
				emit("chat-hover", {
					phase: "enter",
					data: card,
					localX,
					localY,
					pageX: event.pageX,
					pageY: event.pageY,
				});
			})
			.on("pointermove", (event, card) =>
			{
				const [localX, localY] = d3.pointer(event, container);
				emit("chat-hover", {
					phase: "move",
					data: card,
					localX,
					localY,
					pageX: event.pageX,
					pageY: event.pageY,
				});
			})
			.on("pointerleave", function (event, card)
			{
				d3.select(this).select<SVGRectElement>("rect.chat-bg").attr("fill", "#111827");
				emit("chat-hover", {
					phase: "leave",
					data: card,
					localX: 0,
					localY: 0,
					pageX: event.pageX,
					pageY: event.pageY,
				});
			})
			.on("click", (event, card) =>
			{
				const target = event.target as HTMLElement;
				if (target.classList.contains("card-use-template-btn"))
				{
					event.stopPropagation();
					emit("card-use-template", { cardId: card.id, templateName: card.title });
					return;
				}
				if (target.classList.contains("card-edit-btn"))
				{
					event.stopPropagation();
					emit("card-edit-agent", { cardId: card.id, agentPath: card.id });
					return;
				}
				if (target.classList.contains("card-envelope-btn"))
				{
					event.stopPropagation();
					emit("copy-json", { cardId: card.id, source: card.source });
					return;
				}
				if (target.classList.contains("line-star-btn"))
				{
					event.stopPropagation();
					const source: FavoriteSource = { type: "message", data: card.source };
					emit("line-star", { cardId: card.id, source });
					return;
				}
				if (target.classList.contains("line-copy-msg-btn"))
				{
					event.stopPropagation();
					emit("copy-msg", { cardId: card.id, source: card.source });
					return;
				}
				if (target.classList.contains("line-add-btn"))
				{
					event.stopPropagation();
					if (config.cardRenderMode === "agent-builder")
					{
						emit("card-add-knowledge", {
							cardId: card.id,
							relativePath: card.excerptShort,
							sourceName: card.project,
							harness: card.harness,
						});
					}
					else
					{
						const lineDiv = target.closest(".excerpt-line") as HTMLElement;
						if (lineDiv)
						{
							const cardId = lineDiv.dataset.cardId ?? "";
							const lineIdx = parseInt(lineDiv.dataset.lineIdx ?? "0", 10);
							const textSpan = lineDiv.querySelector(".line-text");
							const text = textSpan?.textContent ?? "";
							emit("line-click", { text, cardId, lineIndex: lineIdx });
						}
					}
				}
				else if (target.classList.contains("chat-title"))
				{
					event.stopPropagation();
					emit("title-click", { sessionId: card.sessionId, messageId: card.id });
				}
				else
				{
					emit("chat-click", { data: card });
				}
			})
			.on("dblclick", (event, card) =>
			{
				event.stopPropagation();
				zoomToItem(card.id, "card");
			});

		updateLod(currentTransform.k, true);
	}

	function renderThreadCards(): void
	{
		const minScore = d3.min(currentThreads, (thread) => thread.score) ?? 0;
		const maxScore = d3.max(currentThreads, (thread) => thread.score) ?? 1;
		const opacityScale = d3.scaleLinear().domain([minScore, maxScore]).range([1, 0.85]).clamp(true);
		const maxHits = d3.max(currentThreads, (thread) => thread.hits) ?? 0;

		const threads = world
			.selectAll<SVGGElement, ThreadCardData>("g.thread")
			.data(currentThreads, (thread) => thread.id)
			.join(
				(enter) =>
				{
					const group = enter.append("g").attr("class", "thread");
					group.append("rect").attr("class", "thread-bg").attr("rx", 12).attr("ry", 12);
					group.append("rect").attr("class", "harness-stripe");
					group.append("rect").attr("class", "hits-bar");
					group
						.append("foreignObject")
						.attr("class", "thread-fo")
						.append("xhtml:div")
						.attr("class", "thread-html");
					return group;
				},
				(update) => update,
				(exit) => exit.remove()
			);

		threads
			.attr("transform", (thread) => `translate(${thread.x},${thread.y})`)
			.attr("opacity", (thread) => opacityScale(thread.score));

		threads
			.select<SVGRectElement>("rect.thread-bg")
			.attr("width", (thread) => thread.w)
			.attr("height", (thread) => thread.h)
			.attr("fill", "#1a1625")
			.attr("stroke", "#4c1d95")
			.attr("stroke-width", 1.5);

		threads
			.select<SVGRectElement>("rect.harness-stripe")
			.attr("x", 0)
			.attr("y", 0)
			.attr("width", 4)
			.attr("height", (thread) => thread.h)
			.attr("fill", (thread) => getHarnessColor(thread.harness));

		threads
			.select<SVGRectElement>("rect.hits-bar")
			.attr("x", (thread) => thread.w - 4)
			.attr("y", (thread) =>
			{
				if (maxHits === 0) return thread.h;
				return thread.h * (1 - thread.hits / maxHits);
			})
			.attr("width", 4)
			.attr("height", (thread) =>
			{
				if (maxHits === 0) return 0;
				return thread.h * (thread.hits / maxHits);
			})
			.attr("rx", 0)
			.attr("fill", (thread) =>
			{
				if (maxHits === 0) return "transparent";
				return d3.interpolateRgb("#ef4444", "#22c55e")(thread.hits / maxHits);
			})
			.attr("opacity", (thread) => (thread.hits > 0 ? 0.85 : 0));

		threads
			.select<SVGForeignObjectElement>("foreignObject.thread-fo")
			.attr("x", 12)
			.attr("y", 8)
			.attr("width", (thread) => Math.max(0, thread.w - 20))
			.attr("height", (thread) => Math.max(0, thread.h - 16));

		threads
			.on("pointerenter", function (event, thread)
			{
				d3.select(this).select<SVGRectElement>("rect.thread-bg").attr("fill", "#2d1f4e");
				const [localX, localY] = d3.pointer(event, container);
				emit("thread-hover", {
					phase: "enter",
					data: thread,
					localX,
					localY,
					pageX: event.pageX,
					pageY: event.pageY,
				});
			})
			.on("pointermove", (event, thread) =>
			{
				const [localX, localY] = d3.pointer(event, container);
				emit("thread-hover", {
					phase: "move",
					data: thread,
					localX,
					localY,
					pageX: event.pageX,
					pageY: event.pageY,
				});
			})
			.on("pointerleave", function (event, thread)
			{
				d3.select(this).select<SVGRectElement>("rect.thread-bg").attr("fill", "#1a1625");
				emit("thread-hover", {
					phase: "leave",
					data: thread,
					localX: 0,
					localY: 0,
					pageX: event.pageX,
					pageY: event.pageY,
				});
			})
			.on("click", (event, thread) =>
			{
				const target = event.target as HTMLElement;
				if (target.classList.contains("thread-star-btn"))
				{
					event.stopPropagation();
					const source: FavoriteSource = { type: "thread", data: thread.source };
					emit("thread-star", { cardId: thread.id, source });
					return;
				}
				if (target.classList.contains("thread-title"))
				{
					event.stopPropagation();
					const firstMatchId = thread.matchingMessageIds[0] ?? thread.sessionId;
					emit("title-click", { sessionId: thread.sessionId, messageId: firstMatchId });
					return;
				}
				emit("thread-click", { data: thread });
			})
			.on("dblclick", (event, thread) =>
			{
				event.stopPropagation();
				zoomToItem(thread.id, "thread");
			});

		world
			.selectAll<SVGGElement, ThreadCardData>("g.thread")
			.select<HTMLElement>(".thread-html")
			.html((thread) => renderThreadCardHtml(thread, currentLod, starredIds));
	}

	function renderMasterCards(): void
	{
		const masters = world
			.selectAll<SVGGElement, MasterCardData>("g.mastercard")
			.data(currentMasterCards, (mc) => mc.id)
			.join(
				(enter) =>
				{
					const group = enter.append("g").attr("class", "mastercard");
					group.append("rect").attr("class", "mastercard-bg").attr("rx", 16).attr("ry", 16);
					const fo = group
						.append("foreignObject")
						.attr("class", "mastercard-fo");
					fo.append("xhtml:div").attr("class", "mastercard-header-wrap");
					return group;
				},
				(update) => update,
				(exit) => exit.remove()
			);

		masters.attr("transform", (mc) => `translate(${mc.x},${mc.y})`);

		masters
			.select<SVGRectElement>("rect.mastercard-bg")
			.attr("width", (mc) => mc.w)
			.attr("height", (mc) => mc.h)
			.attr("fill", "#0d1117")
			.attr("stroke", (mc) => mc.color)
			.attr("stroke-width", 2);

		masters
			.select<SVGForeignObjectElement>("foreignObject.mastercard-fo")
			.attr("x", 8)
			.attr("y", 4)
			.attr("width", (mc) => Math.max(0, mc.w - 16))
			.attr("height", 42)
			.style("display", "block");

		masters
			.select<HTMLElement>(".mastercard-header-wrap")
			.html((mc) => buildMastercardHeaderHtml(mc, currentMastercardTier));
	}

	function zoomToFit(padding = 60): void
	{
		if (currentCards.length === 0 && currentThreads.length === 0)
		{
			return;
		}

		// Calculate bounds from both cards and threads
		const allItems = [
			...currentCards.map((card) => ({ x: card.x, y: card.y, w: card.w, h: card.h })),
			...currentThreads.map((thread) => ({ x: thread.x, y: thread.y, w: thread.w, h: thread.h })),
		];

		const minX = d3.min(allItems, (item) => item.x) ?? 0;
		const minY = d3.min(allItems, (item) => item.y) ?? 0;
		const maxX = d3.max(allItems, (item) => item.x + item.w) ?? 0;
		const maxY = d3.max(allItems, (item) => item.y + item.h) ?? 0;

		const boundsWidth = maxX - minX + padding * 2;
		const boundsHeight = maxY - minY + padding * 2;
		const viewportWidth = Math.max(container.clientWidth, 1);
		const viewportHeight = Math.max(container.clientHeight, 1);

		const scale = Math.max(0.15, Math.min(8, Math.min(viewportWidth / boundsWidth, viewportHeight / boundsHeight)));
		const tx = (viewportWidth - (minX + maxX) * scale) / 2;
		const ty = (viewportHeight - (minY + maxY) * scale) / 2;

		svg
			.transition()
			.duration(350)
			.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
	}

	function resetViewportToTop(scale = 1, topPadding = 24, leftPadding = 24): void
	{
		const allItems = [
			...currentCards.map((card) => ({ x: card.x, y: card.y })),
			...currentThreads.map((thread) => ({ x: thread.x, y: thread.y })),
			...currentMasterCards.map((masterCard) => ({ x: masterCard.x, y: masterCard.y })),
		];

		if (allItems.length === 0)
		{
			return;
		}

		const firstX = d3.min(allItems, (item) => item.x) ?? 0;
		const firstY = d3.min(allItems, (item) => item.y) ?? 0;
		const clampedScale = Math.max(0.15, Math.min(8, scale));
		const tx = leftPadding - firstX * clampedScale;
		const ty = topPadding - firstY * clampedScale;

		svg
			.transition()
			.duration(280)
			.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(clampedScale));
	}

	function zoomToItem(itemId: string, kind: "card" | "thread"): void
	{
		const targetScale = Math.max(0.15, Math.min(8, DOUBLE_CLICK_TARGET_ZOOM));
		currentReflowBucket = getReflowBucket(targetScale);
		// Force a fresh layout at the target zoom regime before centering.
		applyLayout(sourceCards, sourceThreads, sourceMasterCards);

		const target = kind === "thread"
			? currentThreads.find((thread) => thread.id === itemId)
			: currentCards.find((card) => card.id === itemId);

		if (!target)
		{
			return;
		}

		const viewportWidth = Math.max(container.clientWidth, 1);
		const viewportHeight = Math.max(container.clientHeight, 1);
		const cx = target.x + target.w / 2;
		const cy = target.y + target.h / 2;
		const tx = viewportWidth / 2 - cx * targetScale;
		const ty = viewportHeight / 2 - cy * targetScale;
		suspendBucketRelayout = true;
		svg
			.transition()
			.duration(350)
			.on("interrupt", () =>
			{
				suspendBucketRelayout = false;
				currentReflowBucket = getReflowBucket(currentTransform.k);
			})
			.on("end", () =>
			{
				suspendBucketRelayout = false;
				currentReflowBucket = getReflowBucket(currentTransform.k);
				flashCard(itemId, kind);
			})
			.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(targetScale));
	}

	function flashCard(itemId: string, kind: "card" | "thread"): void
	{
		const rect = kind === "thread"
			? world
				.selectAll<SVGGElement, ThreadCardData>("g.thread")
				.filter((thread) => thread.id === itemId)
				.select<SVGRectElement>("rect.thread-bg")
			: world
				.selectAll<SVGGElement, CardData>("g.chat")
				.filter((card) => card.id === itemId)
				.select<SVGRectElement>("rect.chat-bg");

		if (rect.empty())
		{
			return;
		}

		const baseStroke = rect.attr("stroke") || (kind === "thread" ? "#4c1d95" : "#374151");
		const baseStrokeWidth = rect.attr("stroke-width") || (kind === "thread" ? "1.5" : "1.25");
		const baseFilter = rect.style("filter") || "none";

		rect.interrupt();
		runGreenFlash((step) =>
		{
			const isGlow = step.phase === "glow";
			rect
				.transition()
				.duration(step.durationMs)
				.attr("stroke", isGlow ? GREEN_FLASH_COLOR : baseStroke)
				.attr("stroke-width", isGlow ? 2.75 : baseStrokeWidth)
				.style("filter", isGlow ? GREEN_FLASH_FILTER : baseFilter);
		});
	}

	function update(cards: CardData[], threadCards: ThreadCardData[] = [], masterCards: MasterCardData[] = []): void
	{
		sourceCards = cards;
		sourceThreads = threadCards;
		sourceMasterCards = masterCards;
		applyLayout(cards, threadCards, masterCards);
	}

	function setStarredIds(nextStarredIds: Set<string>): void
	{
		starredIds = nextStarredIds;
		// Re-render both cards and threads to update star icons
		world
			.selectAll<SVGGElement, CardData>("g.chat")
			.select<HTMLElement>(".chat-html")
			.html((card) => renderCardHtml(card, currentLod, starredIds, config.cardRenderMode));
		world
			.selectAll<SVGGElement, ThreadCardData>("g.thread")
			.select<HTMLElement>(".thread-html")
			.html((thread) => renderThreadCardHtml(thread, currentLod, starredIds));
	}

	function setConfig(partial: Partial<EngineConfig>): void
	{
		const prevMode = config.cardRenderMode;
		config = { ...config, ...partial };

		if (config.cardRenderMode !== prevMode)
		{
			world
				.selectAll<SVGGElement, CardData>("g.chat")
				.select<HTMLElement>(".chat-html")
				.html((card) => renderCardHtml(card, currentLod, starredIds, config.cardRenderMode));
		}
	}

	function setTransform(transform: d3.ZoomTransform): void
	{
		svg.call(zoom.transform, transform);
	}

	function destroy(): void
	{
		svg.on(".zoom", null);
		svg.remove();
		container.innerHTML = "";
	}

	update(initialCards);

	return {
		update,
		setStarredIds,
		setConfig,
		setTransform,
		resetViewportToTop,
		zoomToFit,
		destroy,
	};
}