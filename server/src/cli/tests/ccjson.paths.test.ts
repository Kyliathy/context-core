import { describe, expect, test } from "bun:test";
import { join } from "path";
import {
	applyAddCandidates,
	buildMachineRowRefs,
	loadCcConfig,
} from "../../cxccli.js";

const CC_JSON_PATH = join(import.meta.dir, "..", "..", "..", "cc.json");

function normalizeDriveLetterUpper(path: string): string
{
	return path.replace(/^([a-z]):\\/i, (_match, drive: string) => `${drive.toUpperCase()}:\\`);
}

describe("real cc.json path pattern coverage", () =>
{
	test("reads /server/cc.json and builds deterministic rows for configured machine paths", () =>
	{
		const config = loadCcConfig(CC_JSON_PATH);
		expect(config.machines.length).toBeGreaterThan(0);

		for (const machine of config.machines)
		{
			const rows = buildMachineRowRefs(machine as never);

			const expectedCount = Object.entries(machine.harnesses)
				.filter(([harness]) => harness !== "genericProjectMappingRules")
				.reduce((sum, [, harnessConfig]) =>
				{
					const paths = (harnessConfig as { paths?: unknown[] }).paths;
					return sum + (Array.isArray(paths) ? paths.length : 0);
				}, 0);

			expect(rows.length).toBe(expectedCount);
			expect(rows.every((row) => row.computedProject.trim().length > 0)).toBe(true);
		}
	});

	test("covers lowercase-drive path patterns from cc.json and dedupes by canonical path", () =>
	{
		const config = loadCcConfig(CC_JSON_PATH);
		const machine = config.machines.find((entry) =>
			Object.entries(entry.harnesses).some(([, harnessConfig]) =>
			{
				const paths = (harnessConfig as { paths?: unknown[] }).paths;
				return Array.isArray(paths) && paths.some((path) => typeof path === "string" && /^[a-z]:\\/.test(path));
			})
		);
		expect(machine).toBeTruthy();

		const lowercasePath = Object.entries(machine!.harnesses)
			.flatMap(([, harnessConfig]) =>
			{
				const paths = (harnessConfig as { paths?: unknown[] }).paths;
				return Array.isArray(paths) ? paths : [];
			})
			.find((path): path is string => typeof path === "string" && /^[a-z]:\\/.test(path));
		expect(lowercasePath).toBeTruthy();

		const targetHarnessEntry = Object.entries(machine!.harnesses).find(([, harnessConfig]) =>
		{
			const paths = (harnessConfig as { paths?: unknown[] }).paths;
			return Array.isArray(paths) && paths.includes(lowercasePath);
		});
		const targetHarness = targetHarnessEntry ? targetHarnessEntry[0] : undefined;
		expect(targetHarness).toBeTruthy();

		const candidatePath = normalizeDriveLetterUpper(`${lowercasePath}`.replace(/[\\/]$/, ""));
		const applied = applyAddCandidates(
			machine as never,
			[
				{
					row: 1,
					harness: targetHarness!,
					candidatePath,
					configuredPath: candidatePath,
					computedProject: "case-variant",
					workspaceLocation: null,
					workspaceUri: null,
					workspacePath: null,
					workspaceMetaStatus: null,
					evidence: "case-variant duplicate",
					exists: true,
				},
			]
		);
		expect(applied.added).toBe(0);
		expect(applied.skippedDuplicates).toBe(1);
	});

	test("covers VSCode workspaceStorage hash-dir path pattern from cc.json", () =>
	{
		const config = loadCcConfig(CC_JSON_PATH);
		const allVSCodePaths = config.machines.flatMap((machine) =>
		{
			const vscode = machine.harnesses.VSCode as { paths?: unknown[] } | undefined;
			return Array.isArray(vscode?.paths) ? vscode.paths.filter((path): path is string => typeof path === "string") : [];
		});

		expect(allVSCodePaths.length).toBeGreaterThan(0);
		expect(
			allVSCodePaths.some((path) => /workspaceStorage\\[0-9a-f]{32}\\?$/i.test(path))
		).toBe(true);
	});
});
