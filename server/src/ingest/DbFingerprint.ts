/**
 * Local database fingerprint collection and validation.
 *
 * Architecture: server/zz-reach2/architecture/data/archi-database.md
 * Upgrade plan: server/zz-reach2/upgrades/2026-06/r2so2-startup-optimization2.md
 */

import { existsSync, statSync } from "fs";
import type { IMessageStore } from "../db/IMessageStore.js";
import type { IngestDbFingerprint } from "../settings/GlobalSettingsStore.js";

export type DbFingerprintValidation = {
	ok: boolean;
	reason: string;
};

/**
 * Handles collectDbFingerprint behavior for this CXC module.
 * @param databaseFile - Database dependency used by collectDbFingerprint.
 * @param messageDB - Message data processed by collectDbFingerprint.
 * @returns Result produced by collectDbFingerprint.
 */
export function collectDbFingerprint(
	databaseFile: string,
	messageDB: IMessageStore
): IngestDbFingerprint
{
	const stat = existsSync(databaseFile) ? statSync(databaseFile) : null;
	const harnessCounts: Record<string, number> = {};
	// Business logic: this iteration walks every relevant item so startup ingest planning and bookmark safety reflects the complete source set instead of a partial snapshot.

	for (const row of messageDB.getHarnessCounts())
	{
		harnessCounts[row.harness] = Number(row.count ?? 0);
	}

	return {
		databaseFile,
		messageCount: messageDB.getMessageCount(),
		sessionCount: messageDB.listSessions().length,
		fileMtimeMs: stat?.mtimeMs ?? 0,
		fileSizeBytes: stat?.size ?? 0,
		harnessCounts,
	};
}

/**
 * Handles validateDbFingerprint behavior for this CXC module.
 * @param stored - Value consumed by validateDbFingerprint.
 * @param live - Value consumed by validateDbFingerprint.
 * @returns Result produced by validateDbFingerprint.
 */
export function validateDbFingerprint(
	stored: IngestDbFingerprint | null,
	live: IngestDbFingerprint
): DbFingerprintValidation
{
	if (!stored)
	{
		return { ok: false, reason: "missing db fingerprint" };
	}
	if (stored.databaseFile !== live.databaseFile)
	{
		return { ok: false, reason: "database file path changed" };
	}	// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting startup ingest planning and bookmark safety from partial or invalid state.

	if (live.fileSizeBytes <= 0 && live.fileMtimeMs <= 0)
	{
		return { ok: false, reason: "database file missing" };
	}
	if (stored.messageCount > live.messageCount)
	{
		return { ok: false, reason: "database message count regressed" };
	}
	if (stored.sessionCount > live.sessionCount)
	{
		return { ok: false, reason: "database session count regressed" };
	}	// Business logic: this iteration walks every relevant item so startup ingest planning and bookmark safety reflects the complete source set instead of a partial snapshot.

	for (const [harness, count] of Object.entries(stored.harnessCounts))
	{
		const liveCount = live.harnessCounts[harness] ?? 0;
		if (count > liveCount)
		{
			return { ok: false, reason: `database harness count regressed for ${harness}` };
		}
	}
	return { ok: true, reason: "db fingerprint valid" };
}
