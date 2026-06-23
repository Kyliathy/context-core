/**
 * IngestConfig — startup ingest tuning constants and harness path helpers.
 *
 * Architecture: server/zz-reach2/architecture/archi-context-core-level0.md
 * Upgrade plan: server/zz-reach2/upgrades/2026-06/r2so2-startup-optimization2.md
 * Logging: server/zz-reach2/upgrades/2026-06/r2wl-winston-logging.md
 */

import { createHash } from "crypto";
import { normalize, resolve } from "path";
import { getLogger } from "../logging/logger.js";
import type { HarnessConfig } from "../types.js";

const ingestPlanLogger = getLogger("startup-ingest-plan");

export const MAX_CURSOR_INGEST_BATCH_SIZE = 5000;

export const HARNESS_PARSER_EPOCHS: Record<string, number> = {
	ClaudeCode: 1,
	Cursor: 1,
	Kiro: 1,
	VSCode: 1,
	OpenCode: 1,
	Codex: 1,
};

export type StartupHarnessAction =
	| "skipped"
	| "delta"
	| "full"
	| "forced-full"
	| "recovery-full"
	| "resume-full"
	| "resume-recovery";

/**
 * Resolves the Cursor batched ingest size from env or the platform default.
 * @returns Batch size capped at MAX_CURSOR_INGEST_BATCH_SIZE.
 */
export function getCursorIngestBatchSize(): number
{
	const raw = Number.parseInt(process.env.CURSOR_INGEST_BATCH_SIZE ?? "", 10);
	// Business logic: invalid or disabled operator input falls back to the hard cap,
	// preserving the memory ceiling promised by the startup optimization plan.
	if (!Number.isFinite(raw) || raw <= 0)
	{
		return MAX_CURSOR_INGEST_BATCH_SIZE;
	}
	return Math.min(Math.max(1, raw), MAX_CURSOR_INGEST_BATCH_SIZE);
}

/**
 * Returns whether startup should force a full harness refresh for one or all harnesses.
 * @param harnessName - Optional harness name to test against FORCE_FULL_HARNESS_REFRESH.
 * @returns True when a full refresh is required.
 */
export function isFullRefreshForced(harnessName?: string): boolean
{
	const value = (process.env.FORCE_FULL_HARNESS_REFRESH ?? "").trim();
	if (!value)
	{
		return false;
	}
	if (["1", "true", "yes", "all"].includes(value.toLowerCase()))
	{
		return true;
	}
	if (!harnessName)
	{
		return false;
	}
	const targets = value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
	return targets.includes(harnessName.toLowerCase());
}

/**
 * Returns the parser epoch for a harness bookmark invalidation check.
 * @param harnessName - Harness identifier such as Cursor or ClaudeCode.
 * @returns Parser epoch number (defaults to 1).
 */
export function getHarnessParserEpoch(harnessName: string): number
{
	return HARNESS_PARSER_EPOCHS[harnessName] ?? 1;
}

/**
 * Normalizes and sorts configured harness source paths for stable hashing.
 * @param config - Harness configuration with one or more source paths.
 * @returns Sorted absolute normalized paths.
 */
export function normalizedHarnessPaths(config: HarnessConfig): string[]
{
	return config.paths
		.map((pathValue) => normalize(resolve(pathValue)))
		.sort((a, b) => a.localeCompare(b));
}

/**
 * Hashes normalized harness paths for bookmark source identity checks.
 * @param config - Harness configuration with source paths.
 * @returns Short hex digest of the path set.
 */
export function hashHarnessPaths(config: HarnessConfig): string
{
	const hash = createHash("sha256");
	// Business logic: every configured source root participates in the path hash so
	// per-machine bookmarks invalidate when the operator changes that harness scope.
	for (const pathValue of normalizedHarnessPaths(config))
	{
		hash.update(pathValue);
		hash.update("\n");
	}
	return hash.digest("hex").slice(0, 16);
}

/**
 * Emits optional startup ingest trace lines when STARTUP_INGEST_TRACE=true.
 * @param message - Trace detail without the namespace prefix.
 */
export function logStartupIngestTrace(message: string): void
{
	if ((process.env.STARTUP_INGEST_TRACE ?? "").trim().toLowerCase() === "true")
	{
		ingestPlanLogger.info(message);
	}
}
