/**
 * Startup bookmark validation tests.
 *
 * Architecture: server/zz-reach2/architecture/harness/archi-harness.md
 * Upgrade plan: server/zz-reach2/upgrades/2026-06/r2so2-startup-optimization2.md
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	collectSourceIdentity,
	validateHarnessBookmarkBasics,
	validateRowidRegression,
	validateSourceIdentity,
} from "../BookmarkValidation.js";
import { getHarnessParserEpoch, hashHarnessPaths } from "../IngestConfig.js";

/**
 * Provides test helper behavior for withTempFile.
 * @param fn - Callback invoked by withTempFile.
 */
function withTempFile(fn: (filePath: string) => void): void
{
	const dir = mkdtempSync(join(tmpdir(), "cc-bookmark-validation-"));
	try
	{
		const filePath = join(dir, "state.vscdb");
		writeFileSync(filePath, "cursor db", "utf-8");
		fn(filePath);
	}
	finally
	{
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("BookmarkValidation", () =>
{
	test("validates parser epoch and normalized source path hash", () =>
	{
		withTempFile((filePath) =>
		{
			const config = { paths: [filePath] };
			const bookmark = {
				mode: "rowid" as const,
				parserEpoch: getHarnessParserEpoch("Cursor"),
				sourcePathHash: hashHarnessPaths(config),
			};

			expect(validateHarnessBookmarkBasics("Cursor", config, bookmark)).toEqual({
				ok: true,
				reason: "harness bookmark valid",
			});
			expect(validateHarnessBookmarkBasics("Cursor", config, { ...bookmark, parserEpoch: -1 }).ok).toBe(false);
			expect(validateHarnessBookmarkBasics("Cursor", config, { ...bookmark, sourcePathHash: "changed" }).ok).toBe(false);
		});
	});

	test("detects source mtime changes and rowid regression", () =>
	{
		withTempFile((filePath) =>
		{
			const liveIdentity = collectSourceIdentity(filePath);
			expect(liveIdentity).not.toBeNull();

			const bookmark = {
				mode: "rowid" as const,
				sourceIdentity: liveIdentity!,
			};
			expect(validateSourceIdentity(bookmark, liveIdentity)).toEqual({
				ok: true,
				reason: "source identity valid",
			});
			expect(validateSourceIdentity(
				{
					...bookmark,
					sourceIdentity: {
						...liveIdentity!,
						mtimeMs: liveIdentity!.mtimeMs + 1,
					},
				},
				liveIdentity
			).ok).toBe(false);

			expect(validateRowidRegression({ cursorDiskKV: 10 }, { cursorDiskKV: 9 }).ok).toBe(false);
			expect(validateRowidRegression({ cursorDiskKV: 10 }, { cursorDiskKV: 10 }).ok).toBe(true);
		});
	});
});
