/**
 * StartupPlanner - selects skip, delta, full, or recovery startup ingest decisions.
 *
 * Architecture: server/zz-reach2/architecture/archi-context-core-level0.md
 * Upgrade plan: server/zz-reach2/upgrades/2026-06/r2so2-startup-optimization2.md
 */

import type { IMessageStore } from "../db/IMessageStore.js";
import { getCursorRowIdCheckpoint } from "../harness/cursor.js";
import { getOpenCodeRowIdCheckpoint, resolveOpenCodeDbPath } from "../harness/opencode.js";
import type { GlobalSettingsStore, HarnessBookmark } from "../settings/GlobalSettingsStore.js";
import type { HarnessConfig } from "../types.js";
import {
	collectSourceIdentity,
	validateHarnessBookmarkBasics,
	validateRowidRegression,
	validateSourceIdentity,
	type SourceIdentity,
} from "./BookmarkValidation.js";
import {
	buildLiveFileManifestEntries,
	diffFileManifest,
	FILE_MANIFEST_HARNESSES,
	getManifestPath,
	loadFileManifest,
	type FileManifestDiff,
	type FileManifestEntry,
} from "./FileManifest.js";
import {
	getHarnessParserEpoch,
	hashHarnessPaths,
	isFullRefreshForced,
	type StartupHarnessAction,
} from "./IngestConfig.js";

export type StartupReadScope =
	| { kind: "none" }
	| { kind: "full" }
	| { kind: "cursor-rowid"; sinceRowId: number }
	| { kind: "opencode-rowid"; rowids: Record<string, number> }
	| {
		kind: "file-manifest";
		changedFiles: string[];
		liveEntries: FileManifestEntry[];
		manifestPath: string;
		diff: FileManifestDiff;
	};

export type StartupHarnessPlan = {
	harnessName: string;
	action: StartupHarnessAction;
	reason: string;
	bookmark: HarnessBookmark | null;
	readScope: StartupReadScope;
	liveSourceIdentity: SourceIdentity | null;
	liveRowids?: Record<string, number>;
	expectedReadCount: number;
};

export type StartupPlannerContext = {
	storagePath: string;
	machineName: string;
	runInProgress: boolean;
	dbFingerprintValid: boolean;
	globalSettingsStore: GlobalSettingsStore;
	messageDB: IMessageStore;
};

type CursorProgressBookmark = {
	mode: "full" | "recovery-full" | "rowid-delta" | "resume-full" | "resume-recovery";
	targetCursorDiskKVRowId: number;
	targetItemTableRowId: number;
	durableCursorDiskKVRowId: number;
	durableItemTableRowId: number;
	updatedAt: string;
};

/**
 * Normalizes a harness config to its path array.
 * @param config - Harness config from `cc.json`.
 * @returns Configured source paths.
 */
function toPaths(config: HarnessConfig): string[]
{
	return Array.isArray(config.paths) ? config.paths : [config.paths];
}

/**
 * Parses a Cursor progress object from a bookmark.
 * @param bookmark - Cursor bookmark that may contain durable page progress.
 * @returns Parsed progress, or null when the bookmark has no usable progress.
 */
function getCursorProgress(bookmark: HarnessBookmark | null): CursorProgressBookmark | null
{
	const progress = bookmark?.progress;
	if (!progress)
	{
		return null;
	}
	const durableCursorDiskKVRowId = Number(progress.durableCursorDiskKVRowId ?? 0);
	const durableItemTableRowId = Number(progress.durableItemTableRowId ?? 0);
	const targetCursorDiskKVRowId = Number(progress.targetCursorDiskKVRowId ?? 0);
	const targetItemTableRowId = Number(progress.targetItemTableRowId ?? 0);
	const mode = String(progress.mode ?? "recovery-full") as CursorProgressBookmark["mode"];
	const updatedAt = String(progress.updatedAt ?? "");
	// Business logic: zero durable rowids mean no page has safely landed yet,
	// so startup must fall back to the normal full/recovery decision.
	if (durableCursorDiskKVRowId <= 0 && durableItemTableRowId <= 0)
	{
		return null;
	}
	return {
		mode,
		targetCursorDiskKVRowId,
		targetItemTableRowId,
		durableCursorDiskKVRowId,
		durableItemTableRowId,
		updatedAt,
	};
}

/**
 * Builds a startup plan that reads a full source scope.
 * @param harnessName - Harness being planned.
 * @param reason - Operator-facing reason for the full read.
 * @param bookmark - Existing active-machine bookmark.
 * @param readScope - Read scope to attach to the plan.
 * @param action - Full-like action label.
 * @returns Startup plan.
 */
function fullPlan(
	harnessName: string,
	reason: string,
	bookmark: HarnessBookmark | null,
	readScope: StartupReadScope = { kind: "full" },
	action: StartupHarnessAction = "full"
): StartupHarnessPlan
{
	return {
		harnessName,
		action,
		reason,
		bookmark,
		readScope,
		liveSourceIdentity: null,
		expectedReadCount: readScope.kind === "file-manifest" ? readScope.changedFiles.length : 1,
	};
}

/**
 * Plans Cursor startup ingest for the active machine.
 * @param harnessName - Cursor harness name.
 * @param config - Cursor harness config from the active machine.
 * @param context - Planner context with active machine settings and DB state.
 * @param bookmark - Active machine Cursor bookmark.
 * @returns Startup plan for Cursor.
 */
function planCursor(
	harnessName: string,
	config: HarnessConfig,
	context: StartupPlannerContext,
	bookmark: HarnessBookmark | null
): StartupHarnessPlan
{
	const cursorPath = toPaths(config)[0] ?? "";
	const liveIdentity = cursorPath
		? collectSourceIdentity(cursorPath, {
			machineName: context.machineName,
			sourceKind: "cursor-state-vscdb",
		})
		: null;
	const liveCheckpoint = cursorPath ? getCursorRowIdCheckpoint(cursorPath) : { cursorDiskKVRowId: 0, itemTableRowId: 0 };
	const liveRowids = {
		cursorDiskKV: liveCheckpoint.cursorDiskKVRowId,
		ItemTable: liveCheckpoint.itemTableRowId,
	};

	if (!bookmark)
	{
		return {
			...fullPlan(harnessName, "missing Cursor bookmark", bookmark),
			liveSourceIdentity: liveIdentity,
			liveRowids,
		};
	}
	const basics = validateHarnessBookmarkBasics(harnessName, config, bookmark);
	if (!basics.ok)
	{
		return {
			...fullPlan(harnessName, basics.reason, bookmark, { kind: "full" }, "recovery-full"),
			liveSourceIdentity: liveIdentity,
			liveRowids,
		};
	}
	if (!liveIdentity)
	{
		return {
			...fullPlan(harnessName, "Cursor source database missing", bookmark, { kind: "full" }, "recovery-full"),
			liveSourceIdentity: liveIdentity,
			liveRowids,
		};
	}
	const sourceIdentity = validateSourceIdentity(bookmark, liveIdentity, { includeMutableStats: false });
	if (!sourceIdentity.ok)
	{
		return {
			...fullPlan(harnessName, `Cursor ${sourceIdentity.reason}`, bookmark, { kind: "full" }, "recovery-full"),
			liveSourceIdentity: liveIdentity,
			liveRowids,
		};
	}

	const progress = getCursorProgress(bookmark);
	// Business logic: interrupted Cursor full/recovery reads can resume from a durable
	// page boundary instead of discarding already persisted startup batches.
	if (context.runInProgress && progress)
	{
		return {
			harnessName,
			action: progress.mode === "full" || progress.mode === "resume-full" ? "resume-full" : "resume-recovery",
			reason: "previous Cursor ingest interrupted; resuming from durable page progress",
			bookmark,
			readScope: { kind: "cursor-rowid", sinceRowId: progress.durableCursorDiskKVRowId },
			liveSourceIdentity: liveIdentity,
			liveRowids,
			expectedReadCount: Math.max(0, liveCheckpoint.cursorDiskKVRowId - progress.durableCursorDiskKVRowId),
		};
	}
	if (!context.dbFingerprintValid)
	{
		return {
			...fullPlan(harnessName, "DB fingerprint missing or invalid", bookmark, { kind: "full" }, "recovery-full"),
			liveSourceIdentity: liveIdentity,
			liveRowids,
		};
	}
	const rowids = validateRowidRegression(bookmark.rowids, liveRowids);
	if (!rowids.ok)
	{
		return {
			...fullPlan(harnessName, rowids.reason, bookmark, { kind: "full" }, "recovery-full"),
			liveSourceIdentity: liveIdentity,
			liveRowids,
		};
	}

	const storedCursorRowId = bookmark.rowids?.cursorDiskKV ?? 0;
	const storedItemRowId = bookmark.rowids?.ItemTable ?? 0;
	// Business logic: Cursor can skip all parsing only when both tracked rowid families
	// match the active machine bookmark, because either table can contribute messages.
	if (liveCheckpoint.cursorDiskKVRowId === storedCursorRowId && liveCheckpoint.itemTableRowId === storedItemRowId)
	{
		return {
			harnessName,
			action: "skipped",
			reason: "Cursor rowids unchanged",
			bookmark,
			readScope: { kind: "none" },
			liveSourceIdentity: liveIdentity,
			liveRowids,
			expectedReadCount: 0,
		};
	}

	return {
		harnessName,
		action: "delta",
		reason: "Cursor rowids advanced",
		bookmark,
		readScope: { kind: "cursor-rowid", sinceRowId: storedCursorRowId },
		liveSourceIdentity: liveIdentity,
		liveRowids,
		expectedReadCount: Math.max(0, liveCheckpoint.cursorDiskKVRowId - storedCursorRowId),
	};
}

/**
 * Plans OpenCode startup ingest for the active machine.
 * @param harnessName - OpenCode harness name.
 * @param config - OpenCode harness config from the active machine.
 * @param context - Planner context with active machine settings and DB state.
 * @param bookmark - Active machine OpenCode bookmark.
 * @returns Startup plan for OpenCode.
 */
function planOpenCode(
	harnessName: string,
	config: HarnessConfig,
	context: StartupPlannerContext,
	bookmark: HarnessBookmark | null
): StartupHarnessPlan
{
	const configuredPath = toPaths(config)[0] ?? "";
	const dbPath = configuredPath ? resolveOpenCodeDbPath(configuredPath) : "";
	const liveIdentity = dbPath
		? collectSourceIdentity(dbPath, {
			machineName: context.machineName,
			sourceKind: "opencode-db",
		})
		: null;
	const liveCheckpoint = configuredPath ? getOpenCodeRowIdCheckpoint(configuredPath) : { sessionRowId: 0, messageRowId: 0, partRowId: 0 };
	const liveRowids = {
		session: liveCheckpoint.sessionRowId,
		message: liveCheckpoint.messageRowId,
		part: liveCheckpoint.partRowId,
	};

	if (!bookmark)
	{
		return {
			...fullPlan(harnessName, "missing OpenCode bookmark", bookmark),
			liveSourceIdentity: liveIdentity,
			liveRowids,
		};
	}
	if (!context.dbFingerprintValid)
	{
		return {
			...fullPlan(harnessName, "DB fingerprint missing or invalid", bookmark, { kind: "full" }, "recovery-full"),
			liveSourceIdentity: liveIdentity,
			liveRowids,
		};
	}
	const basics = validateHarnessBookmarkBasics(harnessName, config, bookmark);
	if (!basics.ok)
	{
		return {
			...fullPlan(harnessName, basics.reason, bookmark, { kind: "full" }, "recovery-full"),
			liveSourceIdentity: liveIdentity,
			liveRowids,
		};
	}
	if (!liveIdentity)
	{
		return {
			...fullPlan(harnessName, "OpenCode source database missing", bookmark, { kind: "full" }, "recovery-full"),
			liveSourceIdentity: liveIdentity,
			liveRowids,
		};
	}
	const sourceIdentity = validateSourceIdentity(bookmark, liveIdentity, { includeMutableStats: false });
	if (!sourceIdentity.ok)
	{
		return {
			...fullPlan(harnessName, `OpenCode ${sourceIdentity.reason}`, bookmark, { kind: "full" }, "recovery-full"),
			liveSourceIdentity: liveIdentity,
			liveRowids,
		};
	}
	const rowids = validateRowidRegression(bookmark.rowids, liveRowids);
	if (!rowids.ok)
	{
		return {
			...fullPlan(harnessName, rowids.reason, bookmark, { kind: "full" }, "recovery-full"),
			liveSourceIdentity: liveIdentity,
			liveRowids,
		};
	}

	// Business logic: OpenCode skip requires all three source tables to be unchanged
	// because session, message, and part rows can each make sessions newly affected.
	if (
		liveRowids.session === (bookmark.rowids?.session ?? 0) &&
		liveRowids.message === (bookmark.rowids?.message ?? 0) &&
		liveRowids.part === (bookmark.rowids?.part ?? 0)
	)
	{
		return {
			harnessName,
			action: "skipped",
			reason: "OpenCode rowids unchanged",
			bookmark,
			readScope: { kind: "none" },
			liveSourceIdentity: liveIdentity,
			liveRowids,
			expectedReadCount: 0,
		};
	}

	return {
		harnessName,
		action: "delta",
		reason: "OpenCode rowids advanced",
		bookmark,
		readScope: { kind: "opencode-rowid", rowids: bookmark.rowids ?? {} },
		liveSourceIdentity: liveIdentity,
		liveRowids,
		expectedReadCount: Math.max(0, liveRowids.message - (bookmark.rowids?.message ?? 0)),
	};
}

/**
 * Plans a file-manifest harness startup ingest for the active machine.
 * @param harnessName - File harness name.
 * @param config - Harness config from the active machine.
 * @param context - Planner context with storage and machine metadata.
 * @param bookmark - Active machine file-manifest bookmark.
 * @returns Startup plan for a file harness.
 */
function planFileHarness(
	harnessName: string,
	config: HarnessConfig,
	context: StartupPlannerContext,
	bookmark: HarnessBookmark | null
): StartupHarnessPlan
{
	const manifestPath = getManifestPath(context.storagePath, context.machineName, harnessName);
	const loaded = loadFileManifest(manifestPath);
	const liveEntries = buildLiveFileManifestEntries(harnessName, config);
	const diff = diffFileManifest(loaded.manifest, liveEntries);
	const readScope: StartupReadScope = {
		kind: "file-manifest",
		changedFiles: [...diff.newFiles, ...diff.changedFiles].map((entry) => entry.fullPath),
		liveEntries,
		manifestPath,
		diff,
	};

	if (!bookmark)
	{
		return fullPlan(harnessName, "missing file manifest bookmark", bookmark, readScope);
	}
	if (!context.dbFingerprintValid)
	{
		return planFileHarnessFullScope(harnessName, config, context, bookmark, "recovery-full", "DB fingerprint missing or invalid");
	}
	const basics = validateHarnessBookmarkBasics(harnessName, config, bookmark);
	if (!basics.ok)
	{
		return planFileHarnessFullScope(harnessName, config, context, bookmark, "recovery-full", basics.reason);
	}
	if (loaded.invalid)
	{
		return planFileHarnessFullScope(harnessName, config, context, bookmark, "recovery-full", `manifest invalid: ${loaded.reason}`);
	}
	if (!loaded.manifest)
	{
		return fullPlan(harnessName, "manifest missing", bookmark, readScope);
	}
	// Business logic: only a completely unchanged manifest can skip source parsing,
	// while deleted files still update the manifest so future restarts stay stable.
	if (diff.newFiles.length === 0 && diff.changedFiles.length === 0 && diff.deletedFiles.length === 0)
	{
		return {
			harnessName,
			action: "skipped",
			reason: "file manifest unchanged",
			bookmark,
			readScope: { kind: "none" },
			liveSourceIdentity: null,
			expectedReadCount: 0,
		};
	}

	return {
		harnessName,
		action: "delta",
		reason: `file manifest changed: new=${diff.newFiles.length}, changed=${diff.changedFiles.length}, deleted=${diff.deletedFiles.length}`,
		bookmark,
		readScope,
		liveSourceIdentity: null,
		expectedReadCount: readScope.changedFiles.length,
	};
}

/**
 * Builds a file-harness plan that covers every live source file.
 * @param harnessName - File harness name.
 * @param config - Harness config from the active machine.
 * @param context - Planner context with storage and machine metadata.
 * @param bookmark - Existing active-machine bookmark.
 * @param action - Full-like action label.
 * @param reason - Operator-facing reason for the full scope.
 * @returns Startup plan with all live files in scope.
 */
function planFileHarnessFullScope(
	harnessName: string,
	config: HarnessConfig,
	context: StartupPlannerContext,
	bookmark: HarnessBookmark | null,
	action: StartupHarnessAction,
	reason: string
): StartupHarnessPlan
{
	const manifestPath = getManifestPath(context.storagePath, context.machineName, harnessName);
	const liveEntries = buildLiveFileManifestEntries(harnessName, config);
	const diff = diffFileManifest(null, liveEntries);
	return {
		harnessName,
		action,
		reason,
		bookmark,
		readScope: {
			kind: "file-manifest",
			changedFiles: liveEntries.map((entry) => entry.fullPath),
			liveEntries,
			manifestPath,
			diff,
		},
		liveSourceIdentity: null,
		expectedReadCount: liveEntries.length,
	};
}

/**
 * Selects the startup ingest action for one harness on the active machine.
 * @param harnessName - Harness name from the active machine config.
 * @param harnessConfig - Harness config from the active machine.
 * @param context - Planner context with settings, local DB, and storage metadata.
 * @returns Startup plan describing action, reason, and read scope.
 */
export function planStartupHarness(
	harnessName: string,
	harnessConfig: HarnessConfig,
	context: StartupPlannerContext
): StartupHarnessPlan
{
	const bookmark = context.globalSettingsStore.getHarnessBookmark(harnessName);

	if (isFullRefreshForced(harnessName))
	{
		if (FILE_MANIFEST_HARNESSES.has(harnessName))
		{
			return planFileHarnessFullScope(harnessName, harnessConfig, context, bookmark, "forced-full", "FORCE_FULL_HARNESS_REFRESH");
		}
		return fullPlan(harnessName, "FORCE_FULL_HARNESS_REFRESH", bookmark, { kind: "full" }, "forced-full");
	}
	// Business logic: Cursor may have durable page progress that allows a safe resume,
	// while other harnesses still use conservative recovery on interrupted startup.
	if (context.runInProgress && harnessName !== "Cursor")
	{
		if (FILE_MANIFEST_HARNESSES.has(harnessName))
		{
			return planFileHarnessFullScope(harnessName, harnessConfig, context, bookmark, "recovery-full", "previous ingest run was interrupted");
		}
		return fullPlan(harnessName, "previous ingest run was interrupted", bookmark, { kind: "full" }, "recovery-full");
	}
	if (harnessName === "Cursor")
	{
		return planCursor(harnessName, harnessConfig, context, bookmark);
	}
	if (harnessName === "OpenCode")
	{
		return planOpenCode(harnessName, harnessConfig, context, bookmark);
	}
	if (FILE_MANIFEST_HARNESSES.has(harnessName))
	{
		return planFileHarness(harnessName, harnessConfig, context, bookmark);
	}

	return fullPlan(harnessName, "no startup planner for harness", bookmark);
}

/**
 * Builds a normalized harness bookmark with current parser/path metadata.
 * @param harnessName - Harness name.
 * @param config - Harness config used to compute path hash.
 * @param mode - Bookmark mode for the harness.
 * @param overrides - Additional bookmark fields from the reader/planner.
 * @returns Harness bookmark ready to commit for the active machine.
 */
export function buildHarnessBookmark(
	harnessName: string,
	config: HarnessConfig,
	mode: HarnessBookmark["mode"],
	overrides: Partial<HarnessBookmark> = {}
): HarnessBookmark
{
	return {
		mode,
		parserEpoch: getHarnessParserEpoch(harnessName),
		sourcePathHash: hashHarnessPaths(config),
		lastSuccessfulIngestAt: new Date().toISOString(),
		...overrides,
	};
}
