/**
 * ContentFileDialog.tsx — Read-only viewer for a file indexed by AgentBuilder.
 *
 * Opens when the user clicks a card title in agent-builder view. Fetches the
 * full content of the file from the server and displays it in a monospace panel.
 * Provides a 💾 "Add to Agent" button to add the file to the knowledge basket.
 *
 * Keyboard: Escape to close. Click overlay to close.
 */
import { useEffect, useState } from "react";
import type { CardAddKnowledgeEventDetail, FileContentResponse } from "../../types";
import { fetchAgentBuilderGetFileContent } from "../../api/search";
import "./ContentFileDialog.css";

type ContentFileDialogProps = {
	absolutePath: string;
	relativePath: string;
	sourceName: string;
	onClose: () => void;
	onAddToAgent?: (detail: CardAddKnowledgeEventDetail) => void;
};

function formatSize(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${bytes} B`;
}

export default function ContentFileDialog({
	absolutePath,
	relativePath,
	sourceName,
	onClose,
	onAddToAgent,
}: ContentFileDialogProps) {
	const [data, setData] = useState<FileContentResponse | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		fetchAgentBuilderGetFileContent(absolutePath)
			.then((result) => {
				if (!cancelled) setData(result);
			})
			.catch((err: unknown) => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			cancelled = true;
		};
	}, [absolutePath]);

	// Escape to close
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	const handleAdd = () => {
		onAddToAgent?.({
			cardId: absolutePath,
			relativePath,
			sourceName,
			harness: data?.sourceType ?? "ContentFile",
			fileSizeBytes: data?.size,
		});
	};

	return (
		<div className="cf-overlay" onClick={onClose}>
			<div className="cf-dialog" onClick={(e) => e.stopPropagation()}>
				<div className="cf-header">
					<div className="cf-header-left">
						<span className="cf-title">{relativePath}</span>
						<div className="cf-meta">
							<span className="cf-meta-item">{sourceName}</span>
							{data && (
								<>
									<span className="cf-meta-sep">·</span>
									<span className="cf-meta-item">{data.sourceType}</span>
									<span className="cf-meta-sep">·</span>
									<span className="cf-meta-item">{formatSize(data.size)}</span>
								</>
							)}
						</div>
					</div>
					<div className="cf-header-right">
						{onAddToAgent && (
							<button type="button" className="cf-add-btn" title="Add to agent knowledge" onClick={handleAdd}>
								💾 Add to Agent
							</button>
						)}
						<button type="button" className="cf-close-btn" title="Close" onClick={onClose}>
							✕
						</button>
					</div>
				</div>
				<div className="cf-body">
					{error && <div className="cf-error">{error}</div>}
					{!data && !error && <div className="cf-loading">Loading…</div>}
					{data && <pre className="cf-content">{data.content}</pre>}
				</div>
			</div>
		</div>
	);
}
