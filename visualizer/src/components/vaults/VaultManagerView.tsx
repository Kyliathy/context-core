/**
 * Vault Manager host view — configured vault inventory; Vault Explorer runs as a modal in App.
 *
 * Architecture: visualizer/zz-reach2/architecture/agents/archi-agent-builder-ui.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ve-vault-explorer.md (§17–18, §28)
 */

import type { VaultInventoryRow } from "./vaultSaveIntegration";
import "./VaultManagerView.css";

type Props = {
	/** Whether VaultExplorerDialog is currently open. */
	explorerOpen: boolean;
	/** Configured AgentBuilder vault rows for this machine. */
	vaults: VaultInventoryRow[];
	/** Opens Vault Explorer in add mode. */
	onOpenExplorer: () => void;
	/** Opens Vault Explorer in edit mode for the clicked vault row. */
	onOpenExplorerForPath: (vault: VaultInventoryRow) => void;
};

/**
 * Vault inventory host when the user picks Manage Vaults — explorer UX is the modal in App.tsx.
 * @param props - Vault rows, explorer open state, and open callbacks.
 */
export default function VaultManagerView({
	explorerOpen,
	vaults,
	onOpenExplorer,
	onOpenExplorerForPath,
}: Props)
{
	const vaultCountLabel = vaults.length === 1 ? "1 vault on this machine" : `${vaults.length} vaults on this machine`;

	return (
		<div className="vault-manager-host">
			<div className="vault-manager-host-header">
				<h2>Vault Manager</h2>
				<p className="vault-manager-host-subtitle">{vaultCountLabel}</p>
				{explorerOpen ? (
					<p className="vault-manager-host-note">Vault Explorer is open — browse or edit, then Save.</p>
				) : vaults.length > 0 ? (
					<p className="vault-manager-host-note">Select a vault to edit it.</p>
				) : null}
			</div>

			<div className="vault-manager-host-actions">
				<button type="button" className="vault-manager-host-add" onClick={onOpenExplorer}>
					Add vault
				</button>
			</div>

			{vaults.length === 0 ? (
				<div className="vault-manager-empty">
					<p>No vaults yet.</p>
					<button type="button" className="vault-manager-host-open" onClick={onOpenExplorer}>
						Open Vault Explorer
					</button>
				</div>
			) : (
				<ul className="vault-manager-list" aria-label="Configured vaults">
					{vaults.map((vault) => (
						<li key={vault.path}>
							<button
								type="button"
								className="vault-manager-row"
								onClick={() => onOpenExplorerForPath(vault)}
								aria-label={`Edit vault ${vault.name}`}>
								<span className="vault-manager-row-name">{vault.name}</span>
								<span className="vault-manager-row-meta">
									{vault.type} · {vault.fileCount} file{vault.fileCount === 1 ? "" : "s"}
								</span>
								<span className="vault-manager-row-path" title={vault.path}>{vault.path}</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
