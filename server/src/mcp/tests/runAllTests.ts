import { readdirSync } from "fs";
import { join } from "path";

type TestRun = {
	file: string;
	exitCode: number;
	output: string;
};

function discoverTestFiles(): string[]
{
	const dir = import.meta.dir;
	return readdirSync(dir)
		.filter((name) => name.endsWith(".test.ts") || /^test_.*\.ts$/.test(name))
		.sort()
		.map((name) => join(dir, name));
}

function runOne(testFile: string): TestRun
{
	const proc = Bun.spawnSync(["bun", "test", testFile], {
		stdout: "pipe",
		stderr: "pipe",
	});

	const out = `${proc.stdout.toString()}${proc.stderr.toString()}`;
	const exitCode = proc.exitCode ?? 1;
	return { file: testFile, exitCode, output: out };
}

function printHeader(): void
{
	console.log("=== ContextCore MCP Test Runner ===");
	console.log(`Started: ${new Date().toISOString()}`);
}

function printSummary(runs: TestRun[]): void
{
	const passed = runs.filter((r) => r.exitCode === 0).length;
	const failed = runs.length - passed;

	console.log("\n=== Summary ===");
	for (const run of runs)
	{
		const status = run.exitCode === 0 ? "PASS" : "FAIL";
		console.log(`${status}: ${run.file}`);
	}
	console.log(`\nTotal: ${runs.length}, Passed: ${passed}, Failed: ${failed}`);

	if (failed > 0)
	{
		process.exit(1);
	}
}

function main(): void
{
	printHeader();

	const testFiles = discoverTestFiles();
	if (testFiles.length === 0)
	{
		console.log("No *.test.ts files found in src/mcp/tests.");
		return;
	}

	const runs: TestRun[] = [];
	for (const file of testFiles)
	{
		console.log(`\n--- Running: ${file} ---`);
		const run = runOne(file);
		runs.push(run);
		console.log(run.output);
	}

	printSummary(runs);
}

main();
