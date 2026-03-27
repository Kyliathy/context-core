/**
 * StatusBar.tsx — Fixed bottom bar displaying live engine and search telemetry.
 *
 * Stateless — all values are forwarded from App.tsx as props.
 * Displays: result count, zoom level (k), LOD tier, search latency, loading
 * indicator, and a filter button (highlighted when active filters are set).
 *
 * Docs: zz-reach2/architecture/ui/archi-context-core-ui.md §4.6
 */
import "./StatusBar.css";

type StatusBarProps = {
	resultCount: number;
	threadCount?: number;
	zoomLevel: number;
	lodTier: string;
	latencyMs: number | null;
	isLoading: boolean;
	resultLabel?: string;
	isOnline?: boolean;
};

function lodClass(lod: string): string {
	if (lod === "minimal") {
		return "status-lod-minimal";
	}
	if (lod === "summary") {
		return "status-lod-summary";
	}
	if (lod === "medium") {
		return "status-lod-medium";
	}
	return "status-lod-full";
}

function formatResultCount(messageCount: number, threadCount: number): string {
	if (messageCount > 0 && threadCount > 0) {
		return `${messageCount} messages, ${threadCount} threads`;
	}
	if (threadCount > 0) {
		return `${threadCount} threads`;
	}
	return `${messageCount} messages`;
}

export default function StatusBar({ resultCount, threadCount = 0, zoomLevel, lodTier, latencyMs, isLoading, resultLabel, isOnline = true }: StatusBarProps) {
	return (
		<div className="status-bar">
			<span>{resultLabel ?? formatResultCount(resultCount, threadCount)}</span>
			<span>Zoom: {zoomLevel.toFixed(1)}x</span>
			<span className={`lod-pill ${lodClass(lodTier)}`}>{lodTier}</span>
			<span>{latencyMs === null ? "-" : `${latencyMs}ms`}</span>
			{!isOnline && <span className="status-offline-badge" aria-label="offline">OFFLINE</span>}
			{isLoading && <span className="status-dot" aria-label="loading" />}
		</div>
	);
}
