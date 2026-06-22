/**
 * Placement markdown helper tests.
 *
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ap-agent-publisher-2.md (Part C)
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
	filterRelatedMarkdown,
	isMarkdownLikePath,
	makePlacementMdSource,
	toDisplayPath,
	toPlacementDirectory,
} from "../placementMd.js";

describe("placementMd", () =>
{
	test("isMarkdownLikePath accepts md and markdown extensions", () =>
	{
		expect(isMarkdownLikePath("docs/readme.md")).toBe(true);
		expect(isMarkdownLikePath("docs/readme.MARKDOWN")).toBe(true);
		expect(isMarkdownLikePath("docs/readme.txt")).toBe(false);
	});

	test("toPlacementDirectory maps files to parent directory", () =>
	{
		const root = join(tmpdir(), `placement-md-${Date.now()}`);
		mkdirSync(root, { recursive: true });
		const filePath = join(root, "child.md");
		writeFileSync(filePath, "# test");
		try
		{
			expect(toPlacementDirectory(filePath)).toBe(root);
		}
		finally
		{
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("toDisplayPath prefers project-relative paths", () =>
	{
		const display = toDisplayPath("D:/repo/server/docs/a.md", "D:/repo");
		expect(display).toBe("server/docs/a.md");
	});

	test("filterRelatedMarkdown drops basket duplicates and keeps new markdown files", () =>
	{
		const root = join(tmpdir(), `placement-filter-${Date.now()}`);
		mkdirSync(join(root, "docs"), { recursive: true });
		const linked = join(root, "docs", "linked.md");
		const existing = join(root, "docs", "existing.md");
		writeFileSync(linked, "# linked");
		writeFileSync(existing, "# existing");
		try
		{
			const filtered = filterRelatedMarkdown([linked, existing], new Set([existing]));
			expect(filtered).toEqual([linked]);
		}
		finally
		{
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("makePlacementMdSource marks related vs basket rows", () =>
	{
		const row = makePlacementMdSource("D:/repo/a.md", "D:/repo", false, true, []);
		expect(row.inBasket).toBe(false);
		expect(row.isRelated).toBe(true);
		expect(row.displayPath).toBe("a.md");
	});
});
