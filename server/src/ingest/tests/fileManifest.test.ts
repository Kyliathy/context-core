/**
 * File manifest delta planning tests.
 *
 * Architecture: server/zz-reach2/architecture/harness/archi-harness.md
 * Upgrade plan: server/zz-reach2/upgrades/2026-06/r2so2-startup-optimization2.md
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	buildLiveFileManifestEntries,
	createFileManifest,
	diffFileManifest,
	loadFileManifest,
	saveFileManifest,
} from "../FileManifest.js";

describe("FileManifest", () =>
{
	test("diffs new, changed, unchanged, deleted, and invalid manifest states", () =>
	{
		const dir = mkdtempSync(join(tmpdir(), "cc-file-manifest-"));
		try
		{
			const fileA = join(dir, "a.jsonl");
			const fileB = join(dir, "b.jsonl");
			writeFileSync(fileA, "a", "utf-8");
			writeFileSync(fileB, "b", "utf-8");

			const live = buildLiveFileManifestEntries("ClaudeCode", { paths: [dir] });
			const manifest = createFileManifest("ClaudeCode", "M", live);
			const unchanged = diffFileManifest(manifest, live);
			expect(unchanged.unchangedFiles.length).toBe(2);

			writeFileSync(fileA, "changed-size", "utf-8");
			unlinkSync(fileB);
			const fileC = join(dir, "c.jsonl");
			writeFileSync(fileC, "c", "utf-8");
			const nextLive = buildLiveFileManifestEntries("ClaudeCode", { paths: [dir] });
			const diff = diffFileManifest(manifest, nextLive);
			expect(diff.changedFiles.map((entry) => entry.fullPath)).toContain(fileA);
			expect(diff.newFiles.map((entry) => entry.fullPath)).toContain(fileC);
			expect(diff.deletedFiles.map((entry) => entry.fullPath)).toContain(fileB);

			const manifestPath = join(dir, "manifest.json");
			saveFileManifest(manifestPath, manifest);
			expect(loadFileManifest(manifestPath).manifest?.harnessName).toBe("ClaudeCode");
			writeFileSync(manifestPath, "{bad", "utf-8");
			expect(loadFileManifest(manifestPath).invalid).toBe(true);
		}
		finally
		{
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
