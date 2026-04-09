import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
	applyDeletePathByRow,
	applyEditPathByRow,
	buildMachineRowRefs,
	resolveRowTarget,
	updateMachineConfig,
	writeCcConfig,
} from "../../cxccli.js";

type TestMachine = {
	machine: string;
	harnesses: Record<string, unknown>;
};

type TestConfig = {
	storage: string;
	machines: TestMachine[];
};

function makeMachineA(): TestMachine
{
	return {
		machine: "A",
		harnesses: {
			ClaudeCode: {
				paths: ["C:\\claude\\one\\", "C:\\claude\\two\\"],
				keep: "value",
			},
			Cursor: {
				paths: ["C:\\cursor\\state.vscdb"],
				projectMappingRules: [{ path: "x", newProjectName: "X" }],
			},
			genericProjectMappingRules: [{ paths: "Codez", rule: "byFirstDir" }],
		},
	};
}

describe("cxccli mutation helpers", () =>
{
	test("edit updates targeted row path and preserves non-path fields", () =>
	{
		const machine = makeMachineA();
		const targetRow = buildMachineRowRefs(machine).find(
			(row) => row.harness === "ClaudeCode" && row.configuredPath.includes("\\two\\")
		);
		expect(targetRow).toBeTruthy();

		const edited = applyEditPathByRow(machine, targetRow!.row, "D:\\new\\claude\\two\\");
		const claude = edited.harnesses.ClaudeCode as { paths: string[]; keep?: string };
		const cursor = edited.harnesses.Cursor as { projectMappingRules?: unknown[] };

		expect(claude.paths).toEqual(["C:\\claude\\one\\", "D:\\new\\claude\\two\\"]);
		expect(claude.keep).toBe("value");
		expect(cursor.projectMappingRules).toEqual([{ path: "x", newProjectName: "X" }]);
		expect(edited.harnesses.genericProjectMappingRules).toEqual(
			machine.harnesses.genericProjectMappingRules
		);
	});

	test("delete supports keeping or removing empty harness blocks", () =>
	{
		const machine: TestMachine = {
			machine: "A",
			harnesses: {
				OpenCode: { paths: ["C:\\opencode\\"] },
				ClaudeCode: { paths: ["C:\\claude\\"] },
			},
		};
		const openCodeRow = buildMachineRowRefs(machine).find((row) => row.harness === "OpenCode");
		expect(openCodeRow).toBeTruthy();

		const keepEmpty = applyDeletePathByRow(machine, openCodeRow!.row, { removeEmptyHarnessBlock: false });
		expect((keepEmpty.machine.harnesses.OpenCode as { paths: string[] }).paths).toEqual([]);
		expect(keepEmpty.removedEmptyHarnessBlock).toBe(false);

		const removeEmpty = applyDeletePathByRow(machine, openCodeRow!.row, { removeEmptyHarnessBlock: true });
		expect("OpenCode" in removeEmpty.machine.harnesses).toBe(false);
		expect(removeEmpty.removedEmptyHarnessBlock).toBe(true);
	});

	test("reserved keys are never treated as row targets", () =>
	{
		const machine: TestMachine = {
			machine: "A",
			harnesses: {
				ClaudeCode: { paths: ["C:\\claude\\"] },
				genericProjectMappingRules: [{ paths: "Codez", rule: "byFirstDir" }],
			},
		};

		const rows = buildMachineRowRefs(machine);
		expect(rows.length).toBe(1);
		expect(rows[0].harness).toBe("ClaudeCode");
		expect(() => resolveRowTarget(machine, 2)).toThrow(/Row 2 not found/);

		const deleted = applyDeletePathByRow(machine, 1, { removeEmptyHarnessBlock: false });
		expect(deleted.machine.harnesses.genericProjectMappingRules).toEqual(
			machine.harnesses.genericProjectMappingRules
		);
	});

	test("updateMachineConfig mutates only selected machine", () =>
	{
		const config: TestConfig = {
			storage: "C:\\storage",
			machines: [
				makeMachineA(),
				{
					machine: "B",
					harnesses: {
						VSCode: { paths: ["C:\\vscode\\hash\\"] },
					},
				},
			],
		};

		const updated = updateMachineConfig(config as never, "A", (machine) =>
			applyEditPathByRow(machine as never, 1, "E:\\edited\\one\\") as never
		) as unknown as TestConfig;
		expect(((updated.machines[0].harnesses.ClaudeCode as { paths: string[] }).paths)[0]).toBe("E:\\edited\\one\\");
		expect(((updated.machines[1].harnesses.VSCode as { paths: string[] }).paths)[0]).toBe("C:\\vscode\\hash\\");
	});
});

describe("cxccli writeCcConfig", () =>
{
	test("writes config atomically and creates backup when requested", () =>
	{
		const tempRoot = mkdtempSync(join(tmpdir(), "cxccli-write-"));
		try
		{
			const ccPath = join(tempRoot, "cc.json");
			const initial = {
				storage: "C:\\old",
				machines: [{ machine: "A", harnesses: { ClaudeCode: { paths: ["C:\\a\\"] } } }],
			};
			writeFileSync(ccPath, JSON.stringify(initial, null, "\t"), "utf-8");

			const next = {
				storage: "C:\\new",
				machines: [{ machine: "A", harnesses: { ClaudeCode: { paths: ["C:\\b\\"] } } }],
			};
			writeCcConfig(ccPath, next as never, { backup: true });

			const parsed = JSON.parse(readFileSync(ccPath, "utf-8"));
			expect(parsed.storage).toBe("C:\\new");
			expect(parsed.machines[0].harnesses.ClaudeCode.paths[0]).toBe("C:\\b\\");

			const backupPath = `${ccPath}.bak`;
			expect(existsSync(backupPath)).toBe(true);
			const backupParsed = JSON.parse(readFileSync(backupPath, "utf-8"));
			expect(backupParsed.storage).toBe("C:\\old");

			const leftovers = readdirSync(tempRoot).filter((name) => name.startsWith(".cc.json."));
			expect(leftovers.length).toBe(0);
		}
		finally
		{
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});
});

