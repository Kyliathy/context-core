/**
 * Winston logger configuration smoke tests.
 *
 * Upgrade plan: server/zz-reach2/upgrades/2026-06/r2wl-winston-logging.md (T7)
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
	getEffectiveConsoleLevelForTests,
	getLogger,
	getStderrLogger,
	resetLoggerCacheForTests,
} from "../logger.js";

describe("logger configuration", () =>
{
	const originalLogLevel = process.env.LOG_LEVEL;
	const originalNamespaceLevels = process.env.LOG_NAMESPACE_LEVELS;

	beforeEach(() =>
	{
		resetLoggerCacheForTests();
		delete process.env.LOG_LEVEL;
		delete process.env.LOG_NAMESPACE_LEVELS;
	});

	afterEach(() =>
	{
		resetLoggerCacheForTests();
		if (originalLogLevel === undefined)
		{
			delete process.env.LOG_LEVEL;
		}
		else
		{
			process.env.LOG_LEVEL = originalLogLevel;
		}
		if (originalNamespaceLevels === undefined)
		{
			delete process.env.LOG_NAMESPACE_LEVELS;
		}
		else
		{
			process.env.LOG_NAMESPACE_LEVELS = originalNamespaceLevels;
		}
	});

	test("defaults non-startup namespaces to warn console level", () =>
	{
		expect(getEffectiveConsoleLevelForTests("harness:codex")).toBe("warn");
	});

	test("elevates startup namespaces to info console level", () =>
	{
		expect(getEffectiveConsoleLevelForTests("ContextCore")).toBe("info");
		expect(getEffectiveConsoleLevelForTests("startup-db-load")).toBe("info");
		expect(getEffectiveConsoleLevelForTests("harness:cursor")).toBe("info");
	});

	test("honors LOG_LEVEL global override", () =>
	{
		process.env.LOG_LEVEL = "debug";
		resetLoggerCacheForTests();
		expect(getEffectiveConsoleLevelForTests("server:api")).toBe("debug");
	});

	test("honors LOG_NAMESPACE_LEVELS per-namespace override", () =>
	{
		process.env.LOG_NAMESPACE_LEVELS = "harness:codex:debug,ContextCore:error";
		resetLoggerCacheForTests();
		expect(getEffectiveConsoleLevelForTests("harness:codex")).toBe("debug");
		expect(getEffectiveConsoleLevelForTests("ContextCore")).toBe("error");
	});

	test("creates distinct cached logger instances per namespace", () =>
	{
		const first = getLogger("cache:test-a");
		const second = getLogger("cache:test-b");
		const firstAgain = getLogger("cache:test-a");
		expect(first).toBe(firstAgain);
		expect(first).not.toBe(second);
	});

	test("creates stderr loggers separately from stdout console loggers", () =>
	{
		const stdoutLogger = getLogger("mcp:test");
		const stderrLogger = getStderrLogger("mcp:test");
		expect(stdoutLogger).not.toBe(stderrLogger);
	});
});
