import { useEffect, useRef, type RefObject } from "react";
import { createChatMapEngine, type ChatMapEngine } from "../d3/chatMapEngine";
import type { CardData, ThreadCardData, MasterCardData, HoverEventDetail, ViewportChangeDetail, LineClickEventDetail, CardStarEventDetail, TitleClickEventDetail, CardAddKnowledgeEventDetail, CardEditAgentEventDetail, CardUseTemplateEventDetail, ViewType, CardPositionChangeEventDetail } from "../types";

type UseChatMapParams = {
	containerRef: RefObject<HTMLDivElement | null>;
	cards: CardData[];
	threadCards?: ThreadCardData[];
	masterCards?: MasterCardData[];
	resetViewportToken?: number;
	starredCardIds?: Set<string>;
	viewType?: ViewType;
	/** Active favorites tab id when viewType is favorites (custom positioning drag payloads). */
	favoriteMapViewId?: string;
	onHover?: (detail: HoverEventDetail) => void;
	onViewportChange?: (detail: ViewportChangeDetail) => void;
	onLineClick?: (detail: LineClickEventDetail) => void;
	onCardStar?: (detail: CardStarEventDetail) => void;
	onTitleClick?: (detail: TitleClickEventDetail) => void;
	onCardAddKnowledge?: (detail: CardAddKnowledgeEventDetail) => void;
	onCardEditAgent?: (detail: CardEditAgentEventDetail) => void;
	onCardUseTemplate?: (detail: CardUseTemplateEventDetail) => void;
	onCardPositionChange?: (detail: CardPositionChangeEventDetail) => void;
};

export function useChatMap({
	containerRef,
	cards,
	threadCards = [],
	masterCards = [],
	resetViewportToken,
	starredCardIds,
	viewType,
	favoriteMapViewId,
	onHover,
	onViewportChange,
	onLineClick,
	onCardStar,
	onTitleClick,
	onCardAddKnowledge,
	onCardEditAgent,
	onCardUseTemplate,
	onCardPositionChange,
}: UseChatMapParams)
{
	const engineRef = useRef<ChatMapEngine | null>(null);
	const favoritesFitKeyRef = useRef("");
	const latestCardsRef = useRef<CardData[]>(cards);
	const latestThreadCardsRef = useRef<ThreadCardData[]>(threadCards);
	const latestMasterCardsRef = useRef<MasterCardData[]>(masterCards);
	const onHoverRef = useRef<typeof onHover>(onHover);
	const onViewportChangeRef = useRef<typeof onViewportChange>(onViewportChange);
	const onLineClickRef = useRef<typeof onLineClick>(onLineClick);
	const onCardStarRef = useRef<typeof onCardStar>(onCardStar);
	const onTitleClickRef = useRef<typeof onTitleClick>(onTitleClick);
	const onCardAddKnowledgeRef = useRef<typeof onCardAddKnowledge>(onCardAddKnowledge);
	const onCardEditAgentRef = useRef<typeof onCardEditAgent>(onCardEditAgent);
	const onCardUseTemplateRef = useRef<typeof onCardUseTemplate>(onCardUseTemplate);
	const onCardPositionChangeRef = useRef<typeof onCardPositionChange>(onCardPositionChange);

	useEffect(() =>
	{
		latestCardsRef.current = cards;
	}, [cards]);

	useEffect(() =>
	{
		latestThreadCardsRef.current = threadCards;
	}, [threadCards]);

	useEffect(() =>
	{
		latestMasterCardsRef.current = masterCards;
	}, [masterCards]);

	useEffect(() =>
	{
		onHoverRef.current = onHover;
	}, [onHover]);

	useEffect(() =>
	{
		onViewportChangeRef.current = onViewportChange;
	}, [onViewportChange]);

	useEffect(() =>
	{
		onLineClickRef.current = onLineClick;
	}, [onLineClick]);

	useEffect(() =>
	{
		onCardStarRef.current = onCardStar;
	}, [onCardStar]);

	useEffect(() =>
	{
		onTitleClickRef.current = onTitleClick;
	}, [onTitleClick]);

	useEffect(() =>
	{
		onCardAddKnowledgeRef.current = onCardAddKnowledge;
	}, [onCardAddKnowledge]);

	useEffect(() =>
	{
		onCardEditAgentRef.current = onCardEditAgent;
	}, [onCardEditAgent]);

	useEffect(() =>
	{
		onCardUseTemplateRef.current = onCardUseTemplate;
	}, [onCardUseTemplate]);

	useEffect(() =>
	{
		onCardPositionChangeRef.current = onCardPositionChange;
	}, [onCardPositionChange]);

	useEffect(() =>
	{
		if (!containerRef.current || engineRef.current)
		{
			return;
		}

		engineRef.current = createChatMapEngine(containerRef.current, cards, {
			onEvent: (type, detail) =>
			{
				if (type === "chat-hover" && onHoverRef.current)
				{
					onHoverRef.current(detail as HoverEventDetail);
				}
				if (type === "thread-hover" && onHoverRef.current)
				{
					// Convert thread hover to generic hover format for HoverPanel
					const threadDetail = detail as { phase: string; data: ThreadCardData; localX: number; localY: number; pageX: number; pageY: number };
					// We'll pass this as-is and let HoverPanel handle both types
					(onHoverRef.current as any)(threadDetail);
				}
				if (type === "viewport-change" && onViewportChangeRef.current)
				{
					onViewportChangeRef.current(detail as ViewportChangeDetail);
				}
				if (type === "line-click" && onLineClickRef.current)
				{
					onLineClickRef.current(detail as LineClickEventDetail);
				}
				if (type === "line-star" && onCardStarRef.current)
				{
					onCardStarRef.current(detail as CardStarEventDetail);
				}
				if (type === "thread-star" && onCardStarRef.current)
				{
					onCardStarRef.current(detail as CardStarEventDetail);
				}
				if (type === "copy-json")
				{
					const copyDetail = detail as { cardId: string; source: any };
					const json = JSON.stringify(copyDetail.source, null, 2);
					navigator.clipboard.writeText(json).catch((err) => console.error("Failed to copy JSON:", err));
				}
				if (type === "copy-msg")
				{
					const copyDetail = detail as { cardId: string; source: any };
					navigator.clipboard.writeText(copyDetail.source.message).catch((err) => console.error("Failed to copy message:", err));
				}
				if (type === "title-click" && onTitleClickRef.current)
				{
					onTitleClickRef.current(detail as TitleClickEventDetail);
				}
				if (type === "card-add-knowledge" && onCardAddKnowledgeRef.current)
				{
					onCardAddKnowledgeRef.current(detail as CardAddKnowledgeEventDetail);
				}
				if (type === "card-edit-agent" && onCardEditAgentRef.current)
				{
					onCardEditAgentRef.current(detail as CardEditAgentEventDetail);
				}
				if (type === "card-use-template" && onCardUseTemplateRef.current)
				{
					onCardUseTemplateRef.current(detail as CardUseTemplateEventDetail);
				}
				if (type === "card-position-change" && onCardPositionChangeRef.current)
				{
					onCardPositionChangeRef.current(detail as CardPositionChangeEventDetail);
				}
			},
		});

		const resizeObserver = new ResizeObserver(() =>
		{
			if (!engineRef.current)
			{
				return;
			}
			engineRef.current.update(latestCardsRef.current, latestThreadCardsRef.current, latestMasterCardsRef.current);
			requestAnimationFrame(() => engineRef.current?.zoomToFit(80));
		});

		resizeObserver.observe(containerRef.current);

		return () =>
		{
			resizeObserver.disconnect();
			engineRef.current?.destroy();
			engineRef.current = null;
		};
	}, [containerRef]);

	useEffect(() =>
	{
		engineRef.current?.update(cards, threadCards, masterCards);
	}, [cards, threadCards, masterCards]);

	useEffect(() =>
	{
		if (!engineRef.current)
		{
			return;
		}
		if (viewType === "favorites")
		{
			return;
		}
		requestAnimationFrame(() =>
		{
			engineRef.current?.resetViewportToTop(1, 24, 24);
		});
	}, [resetViewportToken, viewType]);

	//Fit favorites when switching tabs or when cards first populate (not on position-only updates — same count + id).
	useEffect(() =>
	{
		if (viewType !== "favorites")
		{
			favoritesFitKeyRef.current = "";
			return;
		}
		if (!engineRef.current)
		{
			return;
		}
		const len = cards.length + threadCards.length;
		const key = `${favoriteMapViewId ?? ""}:${len}`;
		if (len === 0)
		{
			favoritesFitKeyRef.current = key;
			return;
		}
		if (favoritesFitKeyRef.current === key)
		{
			return;
		}
		favoritesFitKeyRef.current = key;
		const id = requestAnimationFrame(() =>
		{
			engineRef.current?.zoomToFit(80);
		});
		return () => cancelAnimationFrame(id);
	}, [viewType, favoriteMapViewId, cards.length, threadCards.length]);

	useEffect(() =>
	{
		if (!engineRef.current)
		{
			return;
		}
		engineRef.current.setStarredIds(starredCardIds ?? new Set<string>());
	}, [starredCardIds]);

	useEffect(() =>
	{
		if (!engineRef.current)
		{
			return;
		}
		const mode =
			viewType === "agent-builder"
				? "agent-builder"
				: viewType === "agent-list"
					? "agent-list"
					: viewType === "template-list"
						? "template-list"
						: "default";
		const favMode = viewType === "favorites" ? "CustomCardPositioning" : "Auto";
		engineRef.current.setConfig({
			cardRenderMode: mode,
			favoritesCardPositioning: favMode,
			favoriteMapViewId: viewType === "favorites" ? (favoriteMapViewId ?? "") : "",
		});
	}, [viewType, favoriteMapViewId]);

	return engineRef;
}