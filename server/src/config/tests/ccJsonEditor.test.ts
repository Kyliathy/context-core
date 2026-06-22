/**
 * cc.json editor helper tests.
 *
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ap-agent-publisher-2.md (Part B)
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadCcJson, updateMachineConfig, writeCcJson } from "../ccJsonEditor.js";
import { makeTestContextCoreConfig } from "../testFixtures.js";
import type { ContextCoreConfig } from "../../types.js";

function makeConfig(): ContextCoreConfig
{
	return makeTestContextCoreConfig();
}

describe("ccJsonEditor", () =>
{
	test("round-trips cc.json and preserves unknown machine fields", () =>
	{
		const dir = join(tmpdir(), `cc-json-editor-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		const configPath = join(dir, "cc.json");
		const original = makeConfig();
		(original.machines[0] as Record<string, unknown>).customFlag = true;
		writeFileSync(configPath, JSON.stringify(original, null, "\t"));
		try
		{
			const loaded = loadCcJson(configPath);
			const updated = updateMachineConfig(loaded, "host-a", (machine) => ({
				...machine,
				dataSources: {
					...machine.dataSources,
					vaults: [...(machine.dataSources?.vaults ?? []), {
						path: "D:/two",
						name: "two",
						type: "Vault",
						purpose: "AgentBuilder",
					}],
				},
			}));
			writeCcJson(configPath, updated);
			const reread = JSON.parse(readFileSync(configPath, "utf-8")) as ContextCoreConfig;
			expect((reread.machines[0] as Record<string, unknown>).customFlag).toBe(true);
			expect(reread.machines[0].dataSources?.vaults).toHaveLength(2);
			expect(reread.machines[1].dataSources?.vaults).toHaveLength(0);
		}
		finally
		{
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
