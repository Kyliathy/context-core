/**
 * ChatMap.tsx — React shell for the D3 card-map engine.
 *
 * Renders a single <div> container and passes it to useChatMap, which creates
 * and manages the imperative D3 SVG world inside it. ChatMap itself never
 * manipulates the SVG — all rendering is delegated to chatMapEngine.ts.
 *
 * Overlays:
 *   - Empty-state hint when no search has been performed yet.
 *   - Loading spinner while isLoading is true.
 *
 * Docs: zz-reach2/architecture/ui/archi-context-core-ui.md §4.7
 */
import { useRef } from "react";
import { useChatMap } from "../../hooks/useChatMap";
import type {
	CardData,
	ThreadCardData,
	MasterCardData,
	HoverEventDetail,
	ViewportChangeDetail,
	LineClickEventDetail,
	CardStarEventDetail,
	TitleClickEventDetail,
	CardAddKnowledgeEventDetail,
	CardEditAgentEventDetail,
	CardUseTemplateEventDetail,
	ViewType,
} from "../../types";
import "./ChatMap.css";

type ChatMapProps = {
	cards: CardData[];
	threadCards?: ThreadCardData[];
	masterCards?: MasterCardData[];
	resetViewportToken?: number;
	hasSearched: boolean;
	query: string;
	isLoading: boolean;
	viewType?: ViewType;
	onHover: (detail: HoverEventDetail) => void;
	onViewportChange: (detail: ViewportChangeDetail) => void;
	onLineClick?: (detail: LineClickEventDetail) => void;
	onCardStar?: (detail: CardStarEventDetail) => void;
	onTitleClick?: (detail: TitleClickEventDetail) => void;
	onCardAddKnowledge?: (detail: CardAddKnowledgeEventDetail) => void;
	onCardEditAgent?: (detail: CardEditAgentEventDetail) => void;
	onCardUseTemplate?: (detail: CardUseTemplateEventDetail) => void;
	starredCardIds?: Set<string>;
};

export default function ChatMap({
	cards,
	threadCards = [],
	masterCards = [],
	resetViewportToken,
	hasSearched,
	query,
	isLoading,
	viewType,
	onHover,
	onViewportChange,
	onLineClick,
	onCardStar,
	onTitleClick,
	onCardAddKnowledge,
	onCardEditAgent,
	onCardUseTemplate,
	starredCardIds,
}: ChatMapProps) {
	const containerRef = useRef<HTMLDivElement>(null);

	useChatMap({
		containerRef,
		cards,
		threadCards,
		masterCards,
		resetViewportToken,
		starredCardIds,
		viewType,
		onHover,
		onViewportChange,
		onLineClick,
		onCardStar,
		onTitleClick,
		onCardAddKnowledge,
		onCardEditAgent,
		onCardUseTemplate,
	});

	const showInitial = !hasSearched && !isLoading;
	const showNoResults = hasSearched && !isLoading && cards.length === 0 && threadCards.length === 0;
	const showTemplateCreate = viewType === "template-create" && !isLoading;

	return (
		<div className="chat-map-shell">
			{isLoading && <div className="loading-bar" />}
			<div ref={containerRef} className="chat-map-container" />
			{showInitial && !showTemplateCreate && <div className="map-overlay">Type a query above and press Search</div>}
			{showNoResults && !showTemplateCreate && <div className="map-overlay">No results for "{query}"</div>}
			{showTemplateCreate && <div className="map-overlay">Use the Template Creator panel to build a template</div>}
		</div>
	);
}
