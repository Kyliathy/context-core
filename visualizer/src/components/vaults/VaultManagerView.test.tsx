/**
 * Vault Manager host view tests — inventory list and row click edit entry.
 *
 * Architecture: visualizer/zz-reach2/architecture/agents/archi-agent-builder-ui.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ve-vault-explorer.md (§18, §30)
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import VaultManagerView from "./VaultManagerView";
import type { VaultInventoryRow } from "./vaultSaveIntegration";

const sampleVaults: VaultInventoryRow[] = [
	{
		name: "Context Core Server",
		path: "D:/Codez/Nexus/Reach2/context-core/server/zz-reach2",
		type: "Reach2 Architectural Repo",
		fileCount: 42,
	},
];

describe("VaultManagerView", () =>
{
	test("renders vault names in populated inventory", () =>
	{
		const html = renderToStaticMarkup(
			<VaultManagerView
				explorerOpen={false}
				vaults={sampleVaults}
				onOpenExplorer={() => {}}
				onOpenExplorerForPath={() => {}}
			/>,
		);
		expect(html).toContain("Context Core Server");
		expect(html).toContain("1 vault on this machine");
	});

	test("empty state shows Open Vault Explorer", () =>
	{
		const html = renderToStaticMarkup(
			<VaultManagerView
				explorerOpen={false}
				vaults={[]}
				onOpenExplorer={() => {}}
				onOpenExplorerForPath={() => {}}
			/>,
		);
		expect(html).toContain("No vaults yet");
		expect(html).toContain("Open Vault Explorer");
	});

	test("row button exposes edit aria-label for keyboard users", () =>
	{
		const html = renderToStaticMarkup(
			<VaultManagerView
				explorerOpen={false}
				vaults={sampleVaults}
				onOpenExplorer={() => {}}
				onOpenExplorerForPath={() => {}}
			/>,
		);
		expect(html).toContain('aria-label="Edit vault Context Core Server"');
		expect(html).toContain("Select a vault to edit it");
	});
});
