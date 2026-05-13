/**
 * FavoritesSyncConflictDialog — modal when localStorage favorites differ from the server copy.
 */
import {
	favoritePerViewRowHasDelta,
	type FavoritePerViewConflictRow,
	type FavoriteSyncConflict,
} from "../../hooks/favoriteSync";
import "./FavoritesSyncConflictDialog.css";

type FavoritesSyncConflictDialogProps = {
	open: boolean;
	conflict: FavoriteSyncConflict | null;
	isSaving: boolean;
	error: string | null;
	onAcceptServer: () => void;
	onKeepLocal: () => void;
	onClose: () => void;
};

function formatMeta(row: FavoritePerViewConflictRow): string | null
{
	if (!row.viewMetaChanged && !row.viewMetaLocal && !row.viewMetaServer) return null;
	const left = row.viewMetaLocal ? `${row.viewMetaLocal.emoji} ${row.viewMetaLocal.name}` : "—";
	const right = row.viewMetaServer ? `${row.viewMetaServer.emoji} ${row.viewMetaServer.name}` : "—";
	if (row.viewMetaChanged || left !== right) return `Tab: ${left} → ${right}`;
	return null;
}

export default function FavoritesSyncConflictDialog({
	open,
	conflict,
	isSaving,
	error,
	onAcceptServer,
	onKeepLocal,
	onClose,
}: FavoritesSyncConflictDialogProps) {
	if (!open || !conflict) {
		return null;
	}

	const { summary, perView } = conflict;
	const warnRemovals = summary.removedByServerCount > 0;
	const deltaRows = perView.filter(favoritePerViewRowHasDelta);

	return (
		<div className="fav-sync-overlay" role="presentation" onClick={onClose}>
			<div
				className="fav-sync-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="fav-sync-title"
				onClick={(e) => e.stopPropagation()}
			>
				<h3 id="fav-sync-title" className="fav-sync-title">
					Favorites out of sync
				</h3>
				<p className="fav-sync-lead">
					The server has a different favorites bundle than this browser&apos;s offline cache (<code>ccv:favorites</code>). Choose which copy should win.
				</p>
				<dl className="fav-sync-stats">
					<div className="fav-sync-stat-row">
						<dt>Local entries</dt>
						<dd>{summary.localTotal}</dd>
					</div>
					<div className="fav-sync-stat-row">
						<dt>Server entries</dt>
						<dd>{summary.serverTotal}</dd>
					</div>
					<div className="fav-sync-stat-row">
						<dt>Only on server</dt>
						<dd>{summary.serverOnlyCount}</dd>
					</div>
					<div className="fav-sync-stat-row">
						<dt>Only locally</dt>
						<dd>{summary.localOnlyCount}</dd>
					</div>
					<div className="fav-sync-stat-row">
						<dt>Same card, different snapshot</dt>
						<dd>{summary.changedCount}</dd>
					</div>
				</dl>
				{deltaRows.length > 0 && (
					<div className="fav-sync-per-view-wrap">
						<p className="fav-sync-per-view-heading">Per view</p>
						<div className="fav-sync-per-view-scroll">
							{deltaRows.map((row) => {
								const metaLine = formatMeta(row);
								return (
								<div key={row.viewId} className="fav-sync-per-view-card">
									<div className="fav-sync-per-view-title">
										<span className="fav-sync-per-view-emoji">
											{row.viewMetaServer?.emoji ?? row.viewMetaLocal?.emoji ?? "⭐"}
										</span>
										<span className="fav-sync-per-view-name">{row.displayName}</span>
										<code className="fav-sync-per-view-id">{row.viewId.slice(0, 8)}…</code>
									</div>
									<dl className="fav-sync-per-view-stats">
										<div className="fav-sync-per-view-stat-row">
											<dt>Local rows</dt>
											<dd>{row.localEntryCount}</dd>
										</div>
										<div className="fav-sync-per-view-stat-row">
											<dt>Server rows</dt>
											<dd>{row.serverEntryCount}</dd>
										</div>
										<div className="fav-sync-per-view-stat-row">
											<dt>Only on server</dt>
											<dd>{row.serverOnlyCount}</dd>
										</div>
										<div className="fav-sync-per-view-stat-row">
											<dt>Only locally</dt>
											<dd>{row.localOnlyCount}</dd>
										</div>
										<div className="fav-sync-per-view-stat-row">
											<dt>Snapshot changed</dt>
											<dd>{row.changedCount}</dd>
										</div>
									</dl>
									{metaLine && <p className="fav-sync-per-view-meta">{metaLine}</p>}
								</div>
							);
							})}
						</div>
					</div>
				)}
				{warnRemovals && (
					<p className="fav-sync-warning">
						Accepting the server version will remove {summary.removedByServerCount} favorite
						{summary.removedByServerCount === 1 ? "" : "s"} that exist only in local storage.
					</p>
				)}
				{error && <p className="fav-sync-error">{error}</p>}
				<div className="fav-sync-actions">
					<button type="button" className="fav-sync-btn" onClick={onClose} disabled={isSaving}>
						Not now
					</button>
					<button type="button" className="fav-sync-btn fav-sync-btn-secondary" onClick={onKeepLocal} disabled={isSaving}>
						Keep local and upload
					</button>
					<button type="button" className="fav-sync-btn fav-sync-btn-primary" onClick={onAcceptServer} disabled={isSaving}>
						Accept server version
					</button>
				</div>
			</div>
		</div>
	);
}
