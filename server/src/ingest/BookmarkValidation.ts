/**
 * BookmarkValidation - startup ingest bookmark validation helpers.
 *
 * Architecture: server/zz-reach2/architecture/archi-context-core-level0.md
 * Upgrade plan: server/zz-reach2/upgrades/2026-06/r2so2-startup-optimization2.md
 */

import { existsSync, statSync } from "fs";
import { normalize, resolve } from "path";
import type { HarnessConfig } from "../types.js";
import type { HarnessBookmark, SourceIdentity } from "../settings/GlobalSettingsStore.js";
import { getHarnessParserEpoch, hashHarnessPaths } from "./IngestConfig.js";

export type { SourceIdentity } from "../settings/GlobalSettingsStore.js";

export type ValidationResult = {
	ok: boolean;
	reason: string;
};

export type SourceIdentityValidationOptions = {
	includeMutableStats?: boolean;
};

/**
 * Collects stable identity metadata for a source file or directory.
 * @param pathValue - Source path from a harness config.
 * @param metadata - Optional machine/source annotations for cross-machine validation.
 * @returns Source identity, or null when the source path does not exist locally.
 */
export function collectSourceIdentity(
	pathValue: string,
	metadata: Pick<SourceIdentity, "machineName" | "sourceKind"> = {}
): SourceIdentity | null
{
	const normalized = normalize(resolve(pathValue));
	if (!existsSync(normalized))
	{
		return null;
	}
	const stat = statSync(normalized);
	return {
		path: normalized,
		sizeBytes: stat.size,
		mtimeMs: stat.mtimeMs,
		...metadata,
	};
}

/**
 * Validates parser epoch and configured source path hash for a harness bookmark.
 * @param harnessName - Harness name being planned.
 * @param config - Current harness config from the active machine.
 * @param bookmark - Active machine bookmark to validate.
 * @returns Validation result with an operator-facing reason.
 */
export function validateHarnessBookmarkBasics(
	harnessName: string,
	config: HarnessConfig,
	bookmark: HarnessBookmark | null
): ValidationResult
{
	if (!bookmark)
	{
		return { ok: false, reason: "missing harness bookmark" };
	}
	const expectedEpoch = getHarnessParserEpoch(harnessName);
	// Business logic: parser epoch changes mean old bookmarks were produced by different
	// extraction semantics, so startup must not trust them for skip/delta decisions.
	if (bookmark.parserEpoch !== undefined && bookmark.parserEpoch !== expectedEpoch)
	{
		return { ok: false, reason: `parser epoch changed for ${harnessName}` };
	}
	const currentPathHash = hashHarnessPaths(config);
	// Business logic: source path drift means this machine is now reading a different
	// harness scope, so its old manifest or rowid bookmark may skip required data.
	if (bookmark.sourcePathHash && bookmark.sourcePathHash !== currentPathHash)
	{
		return { ok: false, reason: `source path config changed for ${harnessName}` };
	}
	return { ok: true, reason: "harness bookmark valid" };
}

/**
 * Validates that a bookmark still points at the same local source identity.
 * @param bookmark - Active machine bookmark to validate.
 * @param liveIdentity - Current local source identity.
 * @param options - Validation options for mutable source metadata.
 * @returns Validation result with a reason for recovery decisions.
 */
export function validateSourceIdentity(
	bookmark: HarnessBookmark | null,
	liveIdentity: SourceIdentity | null,
	options: SourceIdentityValidationOptions = {}
): ValidationResult
{
	if (!bookmark?.sourceIdentity)
	{
		return { ok: false, reason: "missing source identity" };
	}
	if (!liveIdentity)
	{
		return { ok: false, reason: "source missing" };
	}
	if (bookmark.sourceIdentity.machineName !== liveIdentity.machineName)
	{
		return { ok: false, reason: "source machine changed" };
	}
	if (bookmark.sourceIdentity.sourceKind !== liveIdentity.sourceKind)
	{
		return { ok: false, reason: "source kind changed" };
	}
	if (bookmark.sourceIdentity.path !== liveIdentity.path)
	{
		return { ok: false, reason: "source path changed" };
	}
	if (options.includeMutableStats === false)
	{
		return { ok: true, reason: "source identity valid" };
	}
	if (bookmark.sourceIdentity.sizeBytes !== liveIdentity.sizeBytes)
	{
		return { ok: false, reason: "source size changed" };
	}
	if (bookmark.sourceIdentity.mtimeMs !== liveIdentity.mtimeMs)
	{
		return { ok: false, reason: "source mtime changed" };
	}
	return { ok: true, reason: "source identity valid" };
}

/**
 * Validates that live rowids have not moved backwards for the active source.
 * @param storedRowids - Rowids from the active machine bookmark.
 * @param liveRowids - Rowids from the active machine's live source DB.
 * @returns Validation result for rowid delta planning.
 */
export function validateRowidRegression(
	storedRowids: Record<string, number> | undefined,
	liveRowids: Record<string, number>
): ValidationResult
{
	if (!storedRowids)
	{
		return { ok: false, reason: "missing rowid bookmark" };
	}

	// Business logic: every DB-backed harness table has its own monotonic rowid.
	// If any active-machine table moves backwards, the local source DB was likely replaced.
	for (const [table, liveValue] of Object.entries(liveRowids))
	{
		const storedValue = storedRowids[table] ?? 0;
		if (liveValue < storedValue)
		{
			return { ok: false, reason: `rowid regressed for ${table}` };
		}
	}
	return { ok: true, reason: "rowids valid" };
}
