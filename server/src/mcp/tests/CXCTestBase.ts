import { appendFileSync, existsSync, renameSync, writeFileSync } from "fs";
import { join } from "path";

export class CXCTestBase
{
	private readonly testName: string;
	private readonly logPath: string;
	private passed = 0;
	private failed = 0;

	constructor(testName: string)
	{
		this.testName = testName;
		this.logPath = this.prepareLogFile(testName);
		this.log(`Starting test log: ${testName}`);
	}

	private prepareLogFile(testName: string): string
	{
		const basePath = join(import.meta.dir, `${testName}.log`);
		if (!existsSync(basePath))
		{
			writeFileSync(basePath, "", "utf-8");
			return basePath;
		}

		let suffix = 1;
		while (true)
		{
			const rotatedPath = join(import.meta.dir, `${testName}_${suffix}.log`);
			if (!existsSync(rotatedPath))
			{
				renameSync(basePath, rotatedPath);
				break;
			}
			suffix += 1;
		}

		writeFileSync(basePath, "", "utf-8");
		return basePath;
	}

	log(message: string): void
	{
		const line = `[${new Date().toISOString()}] ${message}`;
		console.log(line);
		appendFileSync(this.logPath, `${line}\n`, "utf-8");
	}

	logSection(title: string): void
	{
		this.log(`\n=== ${title} ===`);
	}

	assertEqual<T>(label: string, actual: T, expected: T): boolean
	{
		if (actual === expected)
		{
			this.passed += 1;
			this.log(`PASS: ${label}`);
			return true;
		}

		this.failed += 1;
		this.log(`FAIL: ${label} | expected=${String(expected)} actual=${String(actual)}`);
		return false;
	}

	assertContains(label: string, haystack: string, needle: string): boolean
	{
		if (haystack.includes(needle))
		{
			this.passed += 1;
			this.log(`PASS: ${label}`);
			return true;
		}

		this.failed += 1;
		this.log(`FAIL: ${label} | expected to contain: ${needle}`);
		return false;
	}

	assertGreaterThan(label: string, actual: number, minimum: number): boolean
	{
		if (actual > minimum)
		{
			this.passed += 1;
			this.log(`PASS: ${label}`);
			return true;
		}

		this.failed += 1;
		this.log(`FAIL: ${label} | expected > ${minimum}, got ${actual}`);
		return false;
	}

	done(): void
	{
		this.log(`\nSummary for ${this.testName}: ${this.passed} passed, ${this.failed} failed`);
	}
}
