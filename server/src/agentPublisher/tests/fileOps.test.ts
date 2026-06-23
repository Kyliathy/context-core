import { describe, expect, test } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { backupUnmanagedFileIfNeeded, hashContent, writeFileAtomic } from "../fileOps.js";

describe("fileOps", () =>
{
	test("writeFileAtomic replaces file content", () =>
	{
		const dir = mkdtempSync(join(tmpdir(), "fileops-"));
		const target = join(dir, "out.txt");
		try
		{
			writeFileAtomic(target, "first");
			writeFileAtomic(target, "second");
			expect(readFileSync(target, "utf8")).toBe("second");
		}
		finally
		{
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("backupUnmanagedFileIfNeeded creates timestamped backup", () =>
	{
		const dir = mkdtempSync(join(tmpdir(), "fileops-bak-"));
		const target = join(dir, "AGENTS.md");
		try
		{
			writeFileSync(target, "user managed", "utf8");
			const backup = backupUnmanagedFileIfNeeded(target, "<!-- Generated -->");
			expect(backup).toBeDefined();
			expect(existsSync(backup!)).toBe(true);
			writeFileSync(target, "<!-- Generated --> content", "utf8");
			expect(backupUnmanagedFileIfNeeded(target, "<!-- Generated -->")).toBeUndefined();
		}
		finally
		{
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("hashContent is stable", () =>
	{
		expect(hashContent("abc")).toBe(hashContent("abc"));
		expect(hashContent("abc")).not.toBe(hashContent("abcd"));
	});
});
