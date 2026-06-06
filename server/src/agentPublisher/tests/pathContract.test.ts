import { describe, expect, test } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import {
	resolveDefaultClaudeAgentOutputDir,
	resolveDefaultCopilotAgentOutputDir,
	resolveDefaultCodexAgentOutputDir,
	resolvePlatformPathContract,
} from "../pathContract.js";
import type { DataSourceEntry } from "../../types.js";

describe("pathContract", () =>
{
	test("Copilot default resolves to .github/agents", () =>
	{
		const root = mkdtempSync(join(tmpdir(), "path-contract-copilot-"));
		try
		{
			const source: DataSourceEntry = {
				path: join(root, "repo"),
				name: "P",
				type: "Repo",
				purpose: "AgentBuilder",
			};
			mkdirSync(source.path, { recursive: true });
			const agentDir = resolveDefaultCopilotAgentOutputDir(source).replace(/\\/g, "/");
			expect(agentDir.endsWith("/.github/agents")).toBe(true);
		}
		finally
		{
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("Claude default resolves to .claude/agents", () =>
	{
		const root = mkdtempSync(join(tmpdir(), "path-contract-claude-"));
		try
		{
			const source: DataSourceEntry = {
				path: join(root, "repo"),
				name: "P",
				type: "Repo",
				purpose: "AgentBuilder",
			};
			mkdirSync(source.path, { recursive: true });
			const agentDir = resolveDefaultClaudeAgentOutputDir(source).replace(/\\/g, "/");
			expect(agentDir.endsWith("/.claude/agents")).toBe(true);
		}
		finally
		{
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("Codex default prefers codexAgentPath", () =>
	{
		const root = mkdtempSync(join(tmpdir(), "path-contract-codex-"));
		try
		{
			const codexDir = join(root, "repo", "instructions");
			const source: DataSourceEntry = {
				path: join(root, "repo"),
				codexAgentPath: codexDir,
				name: "P",
				type: "Repo",
				purpose: "AgentBuilder",
			};
			mkdirSync(codexDir, { recursive: true });
			expect(resolveDefaultCodexAgentOutputDir(source)).toBe(codexDir);
			const contract = resolvePlatformPathContract(source, "codex");
			expect(contract.agentOutputDir).toBe(codexDir);
			expect(contract.skillRootDir).toBe(join(root, "repo"));
		}
		finally
		{
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("explicit agentPath overrides inferred Copilot default", () =>
	{
		const root = mkdtempSync(join(tmpdir(), "path-contract-explicit-"));
		try
		{
			const agentPath = join(root, "custom", "agents");
			const source: DataSourceEntry = {
				path: join(root, "repo"),
				agentPath,
				name: "P",
				type: "Repo",
				purpose: "AgentBuilder",
			};
			expect(resolveDefaultCopilotAgentOutputDir(source)).toBe(agentPath);
		}
		finally
		{
			rmSync(root, { recursive: true, force: true });
		}
	});
});
