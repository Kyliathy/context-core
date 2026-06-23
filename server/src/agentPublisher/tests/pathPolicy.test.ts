import { describe, expect, test } from "bun:test";
import { join } from "path";
import { assertOutputDirAllowed, isInside, resolveAllowedPublishRoots } from "../pathPolicy.js";
import type { DataSourceEntry } from "../../types.js";

const repo = process.platform === "win32" ? "D:\\repo" : "/repo";

function source(overrides?: Partial<DataSourceEntry>): DataSourceEntry
{
	return {
		path: join(repo, "server"),
		agentPath: join(repo, ".github", "agents"),
		name: "Test",
		type: "Repo",
		purpose: "AgentBuilder",
		...overrides,
	};
}

describe("pathPolicy", () =>
{
	test("isInside handles Windows case normalization", () =>
	{
		if (process.platform === "win32")
		{
			expect(isInside("D:\\repo", "D:\\REPO\\server")).toBe(true);
		}
	});

	test("resolveAllowedPublishRoots falls back to project root", () =>
	{
		const roots = resolveAllowedPublishRoots(source(), "codex");
		expect(roots.some((r) => r.replace(/\\/g, "/").endsWith("/repo"))).toBe(true);
	});

	test("assertOutputDirAllowed rejects escape paths", () =>
	{
		expect(() => assertOutputDirAllowed(source(), "copilot", join(repo, "..", "escape"))).toThrow();
	});

	test("publishRoots override is honored", () =>
	{
		const custom = join(repo, "apps", "a");
		const roots = resolveAllowedPublishRoots(source({ publishRoots: { codex: [custom] } }), "codex");
		expect(roots[0]).toBe(custom);
		expect(() => assertOutputDirAllowed(source({ publishRoots: { codex: [custom] } }), "codex", custom)).not.toThrow();
	});
});
