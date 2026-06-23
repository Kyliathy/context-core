/**
 * Shared cc.json test fixtures with valid MachineConfig shape.
 *
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ap-agent-publisher-2.md (Review §32)
 */

import type { ContextCoreConfig, DataSources, MachineConfig } from "../types.js";

/**
 * Builds a minimal valid machine row for cc.json editor tests.
 * @param machine - Machine hostname key from cc.json.
 * @param dataSources - Optional AgentBuilder data source groups.
 */
export function makeTestMachineConfig(machine: string, dataSources?: DataSources): MachineConfig
{
	return {
		machine,
		harnesses: {
			ClaudeCode: { paths: ["D:/storage/chats"] },
		},
		...(dataSources ? { dataSources } : {}),
	};
}

/**
 * Builds a minimal valid ContextCoreConfig for round-trip editor tests.
 */
export function makeTestContextCoreConfig(): ContextCoreConfig
{
	return {
		storage: "D:/storage",
		machines: [
			makeTestMachineConfig("host-a", {
				vaults: [{ path: "D:/one", name: "one", type: "Vault", purpose: "AgentBuilder" }],
			}),
			makeTestMachineConfig("host-b", { vaults: [] }),
		],
	};
}
