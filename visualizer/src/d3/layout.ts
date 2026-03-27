import type { CardData, ThreadCardData, MasterCardData } from "../types";

const CARD_WIDTH = 320;
const CARD_MIN_HEIGHT = 120;
const CARD_MAX_HEIGHT = 280;
const GAP_X = 24;
const GAP_Y = 20;

function clamp(minValue: number, value: number, maxValue: number): number
{
	return Math.max(minValue, Math.min(value, maxValue));
}

function estimateHeight(card: CardData): number
{
	const base = 120;
	const symbolLines = Math.ceil(card.symbols.length / 6) * 16;
	const textLines = Math.ceil(card.excerptMedium.length / 56) * 14;
	return clamp(CARD_MIN_HEIGHT, base + symbolLines + textLines, CARD_MAX_HEIGHT);
}

function estimateThreadHeight(thread: ThreadCardData): number
{
	const base = 110;
	const firstMessage = thread.source.firstMessage || "";
	const newlinesCount = (firstMessage.match(/\n/g) || []).length;
	// Estimate lines based on typical character width (56 chars/line) + explicit newlines
	const textLines = Math.ceil((firstMessage.length / 56) + newlinesCount) * 14;
	return clamp(CARD_MIN_HEIGHT, base + textLines, CARD_MAX_HEIGHT);
}

export function computeGridLayout(cards: CardData[], containerWidth: number, forceSquare = false): CardData[]
{
	const sorted = [...cards].sort((left, right) => left.score - right.score);

	let columns = Math.max(1, Math.floor(containerWidth / (CARD_WIDTH + GAP_X)));
	if (forceSquare && cards.length > 0)
	{
		const colsForSquare = Math.ceil(Math.sqrt(cards.length));
		columns = Math.max(columns, colsForSquare);
	}

	const columnHeights = new Array<number>(columns).fill(0);

	return sorted.map((card) =>
	{
		const columnIndex = columnHeights.indexOf(Math.min(...columnHeights));
		const cardHeight = estimateHeight(card);
		const x = columnIndex * (CARD_WIDTH + GAP_X);
		const y = columnHeights[columnIndex];
		columnHeights[columnIndex] += cardHeight + GAP_Y;
		return {
			...card,
			x,
			y,
			w: CARD_WIDTH,
			h: cardHeight,
		};
	});
}

export function computeThreadGridLayout(threads: ThreadCardData[], containerWidth: number): ThreadCardData[]
{
	const sorted = [...threads].sort((left, right) => left.score - right.score);
	const columns = Math.max(1, Math.floor(containerWidth / (CARD_WIDTH + GAP_X)));
	const columnHeights = new Array<number>(columns).fill(0);

	return sorted.map((thread) =>
	{
		const columnIndex = columnHeights.indexOf(Math.min(...columnHeights));
		const x = columnIndex * (CARD_WIDTH + GAP_X);
		const y = columnHeights[columnIndex];
		const cardHeight = estimateThreadHeight(thread);
		columnHeights[columnIndex] += cardHeight + GAP_Y;
		return {
			...thread,
			x,
			y,
			w: CARD_WIDTH,
			h: cardHeight,
		};
	});
}

export function computeMixedGridLayout(
	cards: CardData[],
	threads: ThreadCardData[],
	containerWidth: number
): { cards: CardData[]; threads: ThreadCardData[] }
{
	const columns = Math.max(1, Math.floor(containerWidth / (CARD_WIDTH + GAP_X)));
	const columnHeights = new Array<number>(columns).fill(0);

	// Combine and sort all items by score
	type MixedItem =
		| { kind: "card"; data: CardData; score: number }
		| { kind: "thread"; data: ThreadCardData; score: number };

	const mixedItems: MixedItem[] = [
		...cards.map((card) => ({ kind: "card" as const, data: card, score: card.score })),
		...threads.map((thread) => ({ kind: "thread" as const, data: thread, score: thread.score })),
	].sort((left, right) => left.score - right.score);

	const resultCards: CardData[] = [];
	const resultThreads: ThreadCardData[] = [];

	for (const item of mixedItems)
	{
		const columnIndex = columnHeights.indexOf(Math.min(...columnHeights));
		const x = columnIndex * (CARD_WIDTH + GAP_X);
		const y = columnHeights[columnIndex];

		if (item.kind === "card")
		{
			const cardHeight = estimateHeight(item.data);
			columnHeights[columnIndex] += cardHeight + GAP_Y;
			resultCards.push({
				...item.data,
				x,
				y,
				w: CARD_WIDTH,
				h: cardHeight,
			});
		}
		else
		{
			const threadHeight = estimateThreadHeight(item.data);
			columnHeights[columnIndex] += threadHeight + GAP_Y;
			resultThreads.push({
				...item.data,
				x,
				y,
				w: CARD_WIDTH,
				h: threadHeight,
			});
		}
	}

	return { cards: resultCards, threads: resultThreads };
}

export function computeWorldBounds(cards: CardData[]): { width: number; height: number }
{
	const maxX = cards.reduce((acc, card) => Math.max(acc, card.x + card.w), 0);
	const maxY = cards.reduce((acc, card) => Math.max(acc, card.y + card.h), 0);
	return {
		width: maxX + 200,
		height: maxY + 200,
	};
}

const MASTER_PADDING = 6;
const MASTER_HEADER_HEIGHT = 48;
const MASTER_GAP_Y = 24;

/**
 * Lays out MasterCards vertically: each MasterCard spans full container width.
 * Child cards/threads are packed using the same masonry algorithm inside each master.
 * Child positions are ABSOLUTE (include the MasterCard's x/y offset) so they can be
 * rendered as flat siblings in the SVG world without SVG nesting.
 */
export function computeMasterCardLayout(masterCards: MasterCardData[], containerWidth: number): MasterCardData[]
{
	let currentY = 0;

	return masterCards.map((master) =>
	{
		const masterX = 0;
		const masterY = currentY;
		const innerWidth = containerWidth - 2 * MASTER_PADDING;
		const columns = Math.max(1, Math.floor(innerWidth / (CARD_WIDTH + GAP_X)));
		const columnHeights = new Array<number>(columns).fill(0);

		// Layout child cards — positions are absolute (masterY + local offset)
		const laidOutCards: CardData[] = master.cards.map((card) =>
		{
			const columnIndex = columnHeights.indexOf(Math.min(...columnHeights));
			const cardHeight = estimateHeight(card);
			const x = masterX + MASTER_PADDING + columnIndex * (CARD_WIDTH + GAP_X);
			const y = masterY + MASTER_HEADER_HEIGHT + MASTER_PADDING + columnHeights[columnIndex];
			columnHeights[columnIndex] += cardHeight + GAP_Y;
			return { ...card, x, y, w: CARD_WIDTH, h: cardHeight };
		});

		// Layout child thread cards — positions are absolute
		const laidOutThreads: ThreadCardData[] = master.threads.map((thread) =>
		{
			const columnIndex = columnHeights.indexOf(Math.min(...columnHeights));
			const threadHeight = estimateThreadHeight(thread);
			const x = masterX + MASTER_PADDING + columnIndex * (CARD_WIDTH + GAP_X);
			const y = masterY + MASTER_HEADER_HEIGHT + MASTER_PADDING + columnHeights[columnIndex];
			columnHeights[columnIndex] += threadHeight + GAP_Y;
			return { ...thread, x, y, w: CARD_WIDTH, h: threadHeight };
		});

		const innerContentHeight = Math.max(0, ...columnHeights);
		const masterHeight = MASTER_HEADER_HEIGHT + innerContentHeight + MASTER_PADDING;

		const laid: MasterCardData = {
			...master,
			cards: laidOutCards,
			threads: laidOutThreads,
			x: masterX,
			y: masterY,
			w: containerWidth,
			h: masterHeight,
		};

		currentY += masterHeight + MASTER_GAP_Y;
		return laid;
	});
}

/**
 * Computes world bounds from a laid-out MasterCard array (for zoom-to-fit).
 */
export function computeMasterCardWorldBounds(masterCards: MasterCardData[]): { width: number; height: number }
{
	let maxX = 0;
	let maxY = 0;
	for (const master of masterCards)
	{
		maxX = Math.max(maxX, master.x + master.w);
		maxY = Math.max(maxY, master.y + master.h);
	}
	return { width: maxX + 200, height: maxY + 200 };
}

export function computeMixedWorldBounds(cards: CardData[], threads: ThreadCardData[]): { width: number; height: number }
{
	let maxX = 0;
	let maxY = 0;

	for (const card of cards)
	{
		maxX = Math.max(maxX, card.x + card.w);
		maxY = Math.max(maxY, card.y + card.h);
	}
	for (const thread of threads)
	{
		maxX = Math.max(maxX, thread.x + thread.w);
		maxY = Math.max(maxY, thread.y + thread.h);
	}

	return {
		width: maxX + 200,
		height: maxY + 200,
	};
}