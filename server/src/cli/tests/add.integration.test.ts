import { describe, expect, test } from "bun:test";
import { join } from "path";
import {
	applyAddCandidates,
	buildCandidateRows,
	parseSelectionSpec,
} from "../../cxccli.js";
import {
	scanHarnessCandidates,
	type HarnessScanner,
	type HarnessScannerContext,
} from "../discovery.js";

const mockContext: HarnessScannerContext = {
	username: "tester",
	platform: "win32",
};

describe("cxccli add integration", () =>
{
	test("merges multi-harness candidates with mocked scanners and deduplicates against existing paths", () =>
	{
		const scanners: HarnessScanner[] = [
			{
				harness: "ClaudeCode",
				getCandidates: () => ["c:\\mock\\claude\\"],
				scan: () => [
					{ harness: "ClaudeCode", path: "C:\\mock\\claude\\proj-a\\", evidence: "2 sessions", exists: true },
					{ harness: "ClaudeCode", path: "C:\\mock\\claude\\proj-b\\", evidence: "5 sessions", exists: true },
				],
				describe: (candidate) => candidate.evidence,
			},
			{
				harness: "VSCode",
				getCandidates: () => ["c:\\mock\\vscode\\"],
				scan: () => [
					{ harness: "VSCode", path: "C:\\mock\\vscode\\hash-1\\", evidence: "chatSessions/", exists: true },
					{ harness: "VSCode", path: "C:\\mock\\vscode\\hash-1\\", evidence: "chatSessions/", exists: true }, // duplicate candidate
				],
				describe: (candidate) => candidate.evidence,
			},
			{
				harness: "Codex",
				getCandidates: () => ["c:\\mock\\codex\\sessions\\"],
				scan: () => [
					{ harness: "Codex", path: "C:\\mock\\codex\\sessions\\", evidence: "10 rollout files", exists: true },
				],
				describe: (candidate) => candidate.evidence,
			},
		];

		const candidates = scanHarnessCandidates(mockContext, scanners);
		const rows = buildCandidateRows(candidates, scanners);
		expect(rows.map((row) => `${row.harness}:${row.candidatePath}`)).toEqual([
			"ClaudeCode:C:\\mock\\claude\\proj-a\\",
			"ClaudeCode:C:\\mock\\claude\\proj-b\\",
			"VSCode:C:\\mock\\vscode\\hash-1\\",
			"VSCode:C:\\mock\\vscode\\hash-1\\",
			"Codex:C:\\mock\\codex\\sessions\\",
		]);

		const machine = {
			machine: "HOST",
			harnesses: {
				ClaudeCode: { paths: ["C:\\mock\\claude\\proj-a\\"] }, // duplicate with candidate
				genericProjectMappingRules: [{ paths: "Codez", rule: "byFirstDir" }],
			},
		};

		const applied = applyAddCandidates(machine, rows);
		expect(applied.added).toBe(3);
		expect(applied.skippedDuplicates).toBe(2);
		expect((applied.machine.harnesses.ClaudeCode as { paths: string[] }).paths).toEqual([
			"C:\\mock\\claude\\proj-a\\",
			"C:\\mock\\claude\\proj-b\\",
		]);
		expect((applied.machine.harnesses.VSCode as { paths: string[] }).paths).toEqual([
			"C:\\mock\\vscode\\hash-1\\",
		]);
		expect((applied.machine.harnesses.Codex as { paths: string[] }).paths).toEqual([
			"C:\\mock\\codex\\sessions\\",
		]);
		expect(applied.machine.harnesses.genericProjectMappingRules).toEqual(
			machine.harnesses.genericProjectMappingRules
		);
	});

	test("parses non-interactive selection specs with single, comma and range values", () =>
	{
		expect(parseSelectionSpec("1", 8)).toEqual([1]);
		expect(parseSelectionSpec("1,3,5", 8)).toEqual([1, 3, 5]);
		expect(parseSelectionSpec("2-4,7", 8)).toEqual([2, 3, 4, 7]);
		expect(() => parseSelectionSpec("0", 8)).toThrow(/out of range/);
		expect(() => parseSelectionSpec("9", 8)).toThrow(/out of range/);
		expect(() => parseSelectionSpec("a,2", 8)).toThrow(/Invalid selection token/);
	});

	test("enriches VSCode add candidates with workspace metadata used in list-style table", () =>
	{
		const fixturePath = join(import.meta.dir, "fixtures", "vscode-workspace", "valid");
		const scanners: HarnessScanner[] = [
			{
				harness: "VSCode",
				getCandidates: () => [fixturePath],
				scan: () => [
					{ harness: "VSCode", path: fixturePath, evidence: "chatSessions/", exists: true },
				],
				describe: (candidate) => candidate.evidence,
			},
		];

		const candidates = scanHarnessCandidates(mockContext, scanners);
		const rows = buildCandidateRows(candidates, scanners);
		expect(rows.length).toBe(1);

		const row = rows[0];
		expect(row.harness).toBe("VSCode");
		expect(row.configuredPath).toBe(fixturePath);
		expect(row.workspaceMetaStatus).toBe("ok");
		expect(row.workspaceLocation).toBe("C:/Codez/Nexus/Reach2/context-core/");
		expect(row.computedProject).toBe("context-core");
	});
});
