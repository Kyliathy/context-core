/**
 * Vault browser unit tests — read-only directory listing and validation metadata.
 *
 * Architecture: server/zz-reach2/architecture/agents/archi-agent-builder.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ve-vault-explorer.md
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
	buildVaultBreadcrumbs,
	inspectVaultPath,
	listVaultChildren,
	listVaultRoots,
} from "../vaultBrowser.js";

describe("vaultBrowser", () =>
{
	test("listVaultRoots returns at least server cwd root", () =>
	{
		const { roots } = listVaultRoots();
		expect(roots.length).toBeGreaterThan(0);
		expect(roots.some((root) => root.label === "Server cwd")).toBe(true);
	});

	test("listVaultChildren returns directories only", () =>
	{
		const base = mkdtempSync(join(tmpdir(), "cxc-vault-"));
		const child = join(base, "child-dir");
		const filePath = join(base, "notes.md");
		mkdirSync(child);
		writeFileSync(filePath, "# test");

		try
		{
			const result = listVaultChildren(base);
			expect(result.directories).toHaveLength(1);
			expect(result.directories[0]?.name).toBe("child-dir");
			expect(result.directories.some((entry) => entry.name.endsWith(".md"))).toBe(false);
		}
		finally
		{
			rmSync(base, { recursive: true, force: true });
		}
	});

	test("buildVaultBreadcrumbs includes leaf directory name", () =>
	{
		const base = mkdtempSync(join(tmpdir(), "cxc-vault-crumb-"));
		const nested = join(base, "a", "b");
		mkdirSync(nested, { recursive: true });

		try
		{
			const crumbs = buildVaultBreadcrumbs(nested);
			expect(crumbs[crumbs.length - 1]?.name).toBe("b");
		}
		finally
		{
			rmSync(base, { recursive: true, force: true });
		}
	});

	test("inspectVaultPath flags duplicate configured paths", () =>
	{
		const base = mkdtempSync(join(tmpdir(), "cxc-vault-info-"));
		try
		{
			const configured = new Set([
				process.platform === "win32" ? base.toLowerCase() : base,
			]);
			const info = inspectVaultPath(base, configured);
			expect(info.exists).toBe(true);
			expect(info.isDirectory).toBe(true);
			expect(info.alreadyConfigured).toBe(true);
		}
		finally
		{
			rmSync(base, { recursive: true, force: true });
		}
	});

	test("inspectVaultPath warns on broad drive-like roots on Windows", () =>
	{
		if (process.platform !== "win32") return;

		const info = inspectVaultPath("C:\\", new Set());
		expect(info.warnings.some((warning) => warning.includes("broad"))).toBe(true);
	});

	test("inspectVaultPath does not warn on deep Windows project paths", () =>
	{
		if (process.platform !== "win32") return;

		const base = mkdtempSync(join(tmpdir(), "cxc-vault-deep-"));
		const nested = join(base, "Nexus", "AIUL2", "zz-reach2");
		mkdirSync(nested, { recursive: true });

		try
		{
			const info = inspectVaultPath(nested, new Set());
			expect(info.warnings.some((warning) => warning.includes("broad"))).toBe(false);
		}
		finally
		{
			rmSync(base, { recursive: true, force: true });
		}
	});
});
