/**
 * StartupIngestCoordinator — plans and runs per-harness startup ingest with bookmark commits.
 *
 * Architecture: server/zz-reach2/architecture/archi-context-core-level0.md
 * Logging: server/zz-reach2/upgrades/2026-06/r2wl-winston-logging.md
 */

import { join } from "path";
import type { IMessageStore } from "../db/IMessageStore.js";
import { getLogger } from "../logging/logger.js";
import type { AgentMessage } from "../models/AgentMessage.js";
import { readCursorChatsBatched, type CursorBatchState, type CursorRowIdCheckpoint } from "../harness/cursor.js";
import { HarnessMatcher } from "../harness/HarnessMatcher.js";
import { hasHarnessReader, hasScopedHarnessReader, readHarnessChats, readHarnessFiles } from "../harness/index.js";
import { loadCursorProjectRuleSet } from "../harness/cursor-matcher.js";
import {
	getOpenCodeRowIdCheckpoint,
	readOpenCodeChatsBatched,
	readOpenCodeChatsIncrementalBatched,
	resolveOpenCodeDbPath,
	type OpenCodeRowIdCheckpoint,
} from "../harness/opencode.js";
import type { IngestDbFingerprint, GlobalSettingsStore, HarnessBookmark } from "../settings/GlobalSettingsStore.js";
import type { StorageWriter } from "../storage/StorageWriter.js";
import { getHarnessEntries, type HarnessConfig, type MachineConfig } from "../types.js";
import { collectSourceIdentity } from "./BookmarkValidation.js";
import { persistIngestBatch, type BatchPersistResult, type HarnessIngestBatch } from "./BatchPersistence.js";
import { createFileManifest, saveFileManifest } from "./FileManifest.js";
import { getHarnessParserEpoch, hashHarnessPaths, logStartupIngestTrace, type StartupHarnessAction } from "./IngestConfig.js";
import { buildHarnessBookmark, planStartupHarness, type StartupHarnessPlan } from "./StartupPlanner.js";

const coordinatorLogger = getLogger("StartupIngestCoordinator");
const ingestPlanLogger = getLogger("startup-ingest-plan");
const harnessFullLogger = getLogger("startup-harness-full");
const harnessSkipLogger = getLogger("startup-harness-skip");
const harnessDeltaLogger = getLogger("startup-harness-delta");
const harnessBatchLogger = getLogger("startup-harness-batch");

/**
 * Resolves the Winston namespace for a startup harness plan category line.
 * @param action - Planned startup ingest action for the harness.
 * @returns Namespaced logger matching R2SO startup log prefixes.
 */
function getHarnessCategoryLogger(action: StartupHarnessAction)
{
	if (action === "skipped")
	{
		return harnessSkipLogger;
	}
	if (action === "delta")
	{
		return harnessDeltaLogger;
	}
	return harnessFullLogger;
}

export type StartupHarnessStats = {
	harness: string;
	action: StartupHarnessAction;
	reason: string;
	sessionsScanned: number;
	messagesParsed: number;
	messagesInserted: number;
	errors: number;
	durationMs: number;
};

export class StartupIngestCoordinator
{
	/**
	 * @param messageDB - Message store receiving startup ingest inserts.
	 * @param storageWriter - Persists normalized session JSON during ingest.
	 * @param storagePath - CXC storage root for manifests and symbol maps.
	 * @param machine - Machine identity and harness configuration.
	 * @param globalSettingsStore - Bookmark and ingest run metadata store.
	 * @param recoveryRequired - True when a prior ingest run was interrupted.
	 * @param dbFingerprintValid - True when on-disk DB fingerprint matches bookmarks.
	 */
	constructor(
		private readonly messageDB: IMessageStore,
		private readonly storageWriter: StorageWriter,
		private readonly storagePath: string,
		private readonly machine: MachineConfig,
		private readonly globalSettingsStore: GlobalSettingsStore,
		private readonly recoveryRequired = false,
		private readonly dbFingerprintValid = true
	) {}

	/**
	 * Runs startup ingest for every configured harness and returns per-harness stats.
	 * @returns Array of harness ingest statistics in configuration order.
	 */
	run(): Array<StartupHarnessStats>
	{
		const stats: Array<StartupHarnessStats> = [];
		// Business logic: this iteration walks every relevant item so startup ingest planning and bookmark safety reflects the complete source set instead of a partial snapshot.

		for (const [harnessName, harnessConfig] of getHarnessEntries(this.machine.harnesses))
		{
			const startMs = Date.now();
			if (!this.isHarnessIngestSupported(harnessName))
			{
				const unsupportedStat: StartupHarnessStats = {
					harness: harnessName,
					action: "skipped",
					reason: "unsupported harness reader",
					sessionsScanned: 0,
					messagesParsed: 0,
					messagesInserted: 0,
					errors: 0,
					durationMs: Date.now() - startMs,
				};
				stats.push(unsupportedStat);
				harnessSkipLogger.info(`${harnessName}: action=skipped, reason=unsupported harness reader, scope=none`);
				coordinatorLogger.info(
					`${unsupportedStat.harness}: action=${unsupportedStat.action}, sessions=0, ` +
					`messagesParsed=0, messagesInserted=0, errors=0, duration=${unsupportedStat.durationMs}ms`
				);
				continue;
			}
			const plan = planStartupHarness(harnessName, harnessConfig, {
				storagePath: this.storagePath,
				machineName: this.machine.machine,
				runInProgress: this.recoveryRequired,
				dbFingerprintValid: this.dbFingerprintValid,
				globalSettingsStore: this.globalSettingsStore,
				messageDB: this.messageDB,
			});
			const rawBase = join(this.storagePath, `${this.machine.machine}-RAW`, harnessName);
			logStartupIngestTrace(`${harnessName}: action=${plan.action}, reason=${plan.reason}`);
			this.logHarnessPlan(plan);

			const harnessStat: StartupHarnessStats = {
				harness: harnessName,
				action: plan.action,
				reason: plan.reason,
				sessionsScanned: 0,
				messagesParsed: 0,
				messagesInserted: 0,
				errors: 0,
				durationMs: 0,
			};

			try
			{
				if (plan.action === "skipped")
				{
					this.commitSkipHeartbeat(harnessName, harnessConfig, plan);
				}
				else if (harnessName === "Cursor")
				{
					this.runCursorPlan(plan, harnessConfig, rawBase, harnessStat);
				}
				else if (harnessName === "OpenCode")
				{
					this.runOpenCodePlan(plan, harnessConfig, rawBase, harnessStat);
				}
				else if (plan.readScope.kind === "file-manifest")
				{
					this.runFileManifestPlan(plan, harnessConfig, rawBase, harnessStat);
				}
				else
				{
					this.runFullArrayPlan(harnessName, harnessConfig, rawBase, harnessStat);
				}
			}
			catch (error)
			{
				harnessStat.errors += 1;
				coordinatorLogger.warn(`Harness "${harnessName}" failed: ${(error as Error).message}`);
			}
			finally
			{
				harnessStat.durationMs = Date.now() - startMs;
				stats.push(harnessStat);
				coordinatorLogger.info(
					`${harnessStat.harness}: action=${harnessStat.action}, ` +
					`sessions=${harnessStat.sessionsScanned}, messagesParsed=${harnessStat.messagesParsed}, ` +
					`messagesInserted=${harnessStat.messagesInserted}, errors=${harnessStat.errors}, ` +
					`duration=${harnessStat.durationMs}ms`
				);
			}
		}

		const summary = stats
			.map((item) => `${item.harness}:${item.action}/${item.messagesInserted}`)
			.join(", ");
		ingestPlanLogger.info(`summary ${summary || "(no harnesses)"}`);
		return stats;
	}

	/**
	 * Returns whether startup has any reader capable of ingesting this harness.
	 * @param harnessName - Harness name from the active machine config.
	 * @returns True when a full or scoped reader is registered.
	 */
	private isHarnessIngestSupported(harnessName: string): boolean
	{
		return hasHarnessReader(harnessName) || hasScopedHarnessReader(harnessName);
	}

	/**
	 * Executes a planned Cursor startup ingest using the bounded batched reader.
	 * @param plan - Startup decision and read scope for Cursor.
	 * @param harnessConfig - Cursor harness config from the active machine.
	 * @param rawBase - Raw archive root for Cursor source pages.
	 * @param stats - Mutable startup stats for this harness.
	 */
	private runCursorPlan(
		plan: StartupHarnessPlan,
		harnessConfig: HarnessConfig,
		rawBase: string,
		stats: StartupHarnessStats
	): void
	{
		const cursorPath = harnessConfig.paths[0];
		if (!cursorPath)
		{
			return;
		}
		if (plan.action !== "delta")
		{
			harnessFullLogger.warn(`Cursor full/recovery read will run in <=5000-message batches.`);
		}

		let successfulCheckpoint: CursorRowIdCheckpoint | null = null;
		const insertedMessages: AgentMessage[] = [];
		const sourceIdentity = collectSourceIdentity(cursorPath, {
			machineName: this.machine.machine,
			sourceKind: "cursor-state-vscdb",
		}) ?? undefined;
		const state = this.isCursorResumeAction(plan.action) ? this.buildCursorBatchStateFromDb() : undefined;
		const sinceCheckpoint = this.getCursorSinceCheckpoint(plan);
		const result = readCursorChatsBatched(cursorPath, rawBase, {
			mode: plan.action === "delta" || this.isCursorResumeAction(plan.action)
				? "rowid-delta"
				: plan.action === "recovery-full"
					? "recovery-full"
					: "full",
			sinceCheckpoint,
			state,
			/**
			 * Handles onBatch behavior for this CXC module.
			 * @param batch - Value consumed by onBatch.
			 * @returns Result produced by onBatch.
			 */

			onBatch: (batch) =>
			{
				const persistResult = this.persistAndAccumulate(batch, stats, insertedMessages);
				this.throwIfPersistenceFailed("Cursor", persistResult);
				this.commitCursorProgress(plan, harnessConfig, sourceIdentity, batch);
				successfulCheckpoint = (batch.checkpointCandidate as CursorRowIdCheckpoint | undefined) ?? successfulCheckpoint;
			},
		});
		successfulCheckpoint = successfulCheckpoint ?? result.checkpoint;

		if (successfulCheckpoint)
		{
			const bookmark = buildHarnessBookmark("Cursor", harnessConfig, "rowid", {
				sourceIdentity,
				rowids: {
					cursorDiskKV: successfulCheckpoint.cursorDiskKVRowId,
					ItemTable: successfulCheckpoint.itemTableRowId,
				},
			});
			this.globalSettingsStore.commitHarnessBookmark("Cursor", bookmark);
			this.globalSettingsStore.setCursorState(successfulCheckpoint);
		}
		if (insertedMessages.length > 0)
		{
			this.writeCursorSymbolMaps(insertedMessages, "Cursor");
		}
	}

	/**
	 * Returns whether a Cursor action resumes durable page progress.
	 * @param action - Startup action selected by the planner.
	 * @returns True for Cursor resume actions.
	 */
	private isCursorResumeAction(action: StartupHarnessAction): boolean
	{
		return action === "resume-full" || action === "resume-recovery";
	}

	/**
	 * Computes the Cursor checkpoint to pass into the batched reader.
	 * @param plan - Cursor startup plan with bookmark and optional progress.
	 * @returns Checkpoint for full, delta, or resume reads.
	 */
	private getCursorSinceCheckpoint(plan: StartupHarnessPlan): CursorRowIdCheckpoint
	{
		const progress = plan.bookmark?.progress;
		// Business logic: resume actions continue from durable page progress, while
		// normal full/delta actions use the final committed rowid bookmark.
		if (this.isCursorResumeAction(plan.action) && progress)
		{
			return {
				cursorDiskKVRowId: Number(progress.durableCursorDiskKVRowId ?? 0),
				itemTableRowId: Number(progress.durableItemTableRowId ?? 0),
			};
		}
		return {
			cursorDiskKVRowId: plan.bookmark?.rowids?.cursorDiskKV ?? 0,
			itemTableRowId: plan.bookmark?.rowids?.ItemTable ?? 0,
		};
	}

	/**
	 * Stores durable Cursor page progress after a batch has safely persisted.
	 * @param plan - Cursor startup plan being executed.
	 * @param harnessConfig - Cursor harness config from the active machine.
	 * @param sourceIdentity - Active machine Cursor DB identity.
	 * @param batch - Batch that just persisted successfully.
	 */
	private commitCursorProgress(
		plan: StartupHarnessPlan,
		harnessConfig: HarnessConfig,
		sourceIdentity: HarnessBookmark["sourceIdentity"],
		batch: HarnessIngestBatch
	): void
	{
		// Business logic: normal deltas commit their final rowid directly, and final
		// empty batches are followed by the real checkpoint commit that clears progress.
		if (plan.action === "delta" || batch.isFinalBatch)
		{
			return;
		}
		const checkpoint = batch.checkpointCandidate as CursorRowIdCheckpoint | undefined;
		if (!checkpoint)
		{
			return;
		}
		const targetCursorDiskKVRowId = Number(plan.liveRowids?.cursorDiskKV ?? checkpoint.cursorDiskKVRowId);
		const targetItemTableRowId = Number(plan.liveRowids?.ItemTable ?? checkpoint.itemTableRowId);
		this.globalSettingsStore.commitHarnessBookmark("Cursor", buildHarnessBookmark("Cursor", harnessConfig, "rowid", {
			sourceIdentity,
			rowids: {
				cursorDiskKV: plan.bookmark?.rowids?.cursorDiskKV ?? 0,
				ItemTable: plan.bookmark?.rowids?.ItemTable ?? 0,
			},
			progress: {
				mode: plan.action,
				targetCursorDiskKVRowId,
				targetItemTableRowId,
				durableCursorDiskKVRowId: checkpoint.cursorDiskKVRowId,
				durableItemTableRowId: checkpoint.itemTableRowId,
				updatedAt: new Date().toISOString(),
			},
		}));
	}

	/**
	 * Seeds Cursor parent-chain state from already loaded DB messages for resume runs.
	 * @returns Cursor batch state with last known message id by session.
	 */
	private buildCursorBatchStateFromDb(): CursorBatchState
	{
		const state: CursorBatchState = { lastMessageIdBySession: new Map<string, string>() };
		const cursorMessages = this.messageDB
			.getAllMessages()
			.filter((message) => message.harness === "Cursor")
			.sort((a, b) => a.dateTime.toMillis() - b.dateTime.toMillis());
		// Business logic: resume mode must continue parent chains for sessions already
		// persisted before the interruption, so each session records its latest DB message.
		for (const message of cursorMessages)
		{
			state.lastMessageIdBySession.set(message.sessionId, message.id);
		}
		return state;
	}

	/**
	 * Executes a planned OpenCode startup ingest using full or rowid-delta batches.
	 * @param plan - Startup decision and read scope for OpenCode.
	 * @param harnessConfig - OpenCode harness config from the active machine.
	 * @param rawBase - Raw archive root for OpenCode raw session dumps.
	 * @param stats - Mutable startup stats for this harness.
	 */
	private runOpenCodePlan(
		plan: StartupHarnessPlan,
		harnessConfig: HarnessConfig,
		rawBase: string,
		stats: StartupHarnessStats
	): void
	{
		const configuredPath = harnessConfig.paths[0];
		if (!configuredPath)
		{
			return;
		}

		let checkpoint: OpenCodeRowIdCheckpoint | null = null;

		/**
		 * Handles onBatch behavior for this CXC module.
		 * @param batch - Value consumed by onBatch.
		 */
		const onBatch = (batch: HarnessIngestBatch): void =>
		{
			const persistResult = this.persistAndAccumulate(batch, stats);
			this.throwIfPersistenceFailed("OpenCode", persistResult);
			checkpoint = (batch.checkpointCandidate as OpenCodeRowIdCheckpoint | undefined) ?? checkpoint;
		};

		if (plan.action === "delta")
		{
			const rowids = plan.bookmark?.rowids ?? {};
			const result = readOpenCodeChatsIncrementalBatched(
				configuredPath,
				rawBase,
				{
					sessionRowId: Number(rowids.session ?? 0),
					messageRowId: Number(rowids.message ?? 0),
					partRowId: Number(rowids.part ?? 0),
				},
				onBatch
			);
			checkpoint = checkpoint ?? result.checkpoint;
		}
		else
		{
			const result = readOpenCodeChatsBatched(configuredPath, rawBase, onBatch);
			checkpoint = checkpoint ?? result.checkpoint;
		}

		if (!checkpoint)
		{
			checkpoint = getOpenCodeRowIdCheckpoint(configuredPath);
		}
		this.globalSettingsStore.commitHarnessBookmark("OpenCode", buildHarnessBookmark("OpenCode", harnessConfig, "rowid", {
			sourceIdentity: collectSourceIdentity(resolveOpenCodeDbPath(configuredPath), {
				machineName: this.machine.machine,
				sourceKind: "opencode-db",
			}) ?? undefined,
			rowids: {
				session: checkpoint.sessionRowId,
				message: checkpoint.messageRowId,
				part: checkpoint.partRowId,
			},
		}));
	}

	/**
	 * Executes a planned file-manifest harness ingest.
	 * @param plan - Startup decision including changed files and live manifest entries.
	 * @param harnessConfig - Harness config from the active machine.
	 * @param rawBase - Raw archive root for this harness.
	 * @param stats - Mutable startup stats for this harness.
	 */
	private runFileManifestPlan(
		plan: StartupHarnessPlan,
		harnessConfig: HarnessConfig,
		rawBase: string,
		stats: StartupHarnessStats
	): void
	{
		if (plan.readScope.kind !== "file-manifest")
		{
			return;
		}

		const messages = plan.action === "delta"
			? readHarnessFiles(plan.harnessName, plan.readScope.changedFiles, rawBase)
			: readHarnessChats(plan.harnessName, harnessConfig, rawBase);
		stats.messagesParsed += messages.length;
		const persistResult = this.persistAndAccumulate({
			harnessName: plan.harnessName,
			messages,
			isFinalBatch: true,
		}, stats);
		this.throwIfPersistenceFailed(plan.harnessName, persistResult);

		const manifest = createFileManifest(
			plan.harnessName,
			this.machine.machine,
			plan.readScope.liveEntries
		);
		saveFileManifest(plan.readScope.manifestPath, manifest);
		this.globalSettingsStore.commitHarnessBookmark(plan.harnessName, buildHarnessBookmark(plan.harnessName, harnessConfig, "file-manifest", {
			manifestPath: plan.readScope.manifestPath,
			manifestRevision: Date.now(),
		}));
	}

	/**
	 * Executes a compatibility full-array reader for harnesses without a specialized planner.
	 * @param harnessName - Harness being ingested.
	 * @param harnessConfig - Harness config from the active machine.
	 * @param rawBase - Raw archive root for this harness.
	 * @param stats - Mutable startup stats for this harness.
	 */
	private runFullArrayPlan(
		harnessName: string,
		harnessConfig: HarnessConfig,
		rawBase: string,
		stats: StartupHarnessStats
	): void
	{
		const messages = readHarnessChats(harnessName, harnessConfig, rawBase);
		stats.messagesParsed += messages.length;
		const persistResult = this.persistAndAccumulate({
			harnessName,
			messages,
			isFinalBatch: true,
		}, stats);
		this.throwIfPersistenceFailed(harnessName, persistResult);
		this.commitCompatibilityBookmark(harnessName, harnessConfig, persistResult.messagesAdded);
	}

	/**
	 * Persists one emitted startup ingest batch and folds the result into harness stats.
	 * @param batch - Reader-emitted batch to stamp, store, and insert into the DB.
	 * @param stats - Mutable startup stats for the active harness.
	 * @param insertedMessages - Optional collector for newly inserted Cursor messages.
	 * @returns Batch persistence result including inserted counts and session errors.
	 */
	private persistAndAccumulate(
		batch: HarnessIngestBatch,
		stats: StartupHarnessStats,
		insertedMessages?: AgentMessage[]
	): BatchPersistResult
	{
		const persistResult = persistIngestBatch(batch, {
			messageDB: this.messageDB,
			storageWriter: this.storageWriter,
			machineName: this.machine.machine,
			storagePath: this.storagePath,
			preferExistingCursorProject: true,
		});
		stats.messagesParsed += batch.messages.length;
		stats.sessionsScanned += persistResult.sessionsScanned;
		stats.messagesInserted += persistResult.messagesAdded;
		stats.errors += persistResult.sessionErrors.length + (persistResult.fatalError ? 1 : 0);
		// Business logic: Cursor symbol maps should be rebuilt only when this startup
		// inserted new messages, keeping skipped/deduped restarts cheap.
		if (insertedMessages && persistResult.messagesAdded > 0)
		{
			insertedMessages.push(...persistResult.allNewMessages);
		}
		harnessBatchLogger.info(
			`${batch.harnessName}: messagesParsed=${batch.messages.length}, ` +
			`sessions=${persistResult.sessionsScanned}, inserted=${persistResult.messagesAdded}, ` +
			`errors=${persistResult.sessionErrors.length + (persistResult.fatalError ? 1 : 0)}, duration=${persistResult.durationMs}ms`
		);
		return persistResult;
	}

	/**
	 * Throws when a batch cannot safely advance the harness bookmark.
	 * @param harnessName - Harness associated with the batch.
	 * @param persistResult - Result returned by shared batch persistence.
	 */
	private throwIfPersistenceFailed(harnessName: string, persistResult: BatchPersistResult): void
	{
		// Business logic: bookmarks advance only after every session in the batch is trusted,
		// so a partial storage/DB failure causes the next startup to retry conservatively.
		if (persistResult.fatalError || persistResult.sessionErrors.length > 0)
		{
			throw new Error(`${harnessName} persistence failed; bookmark was not advanced.`);
		}
	}

	/**
	 * Refreshes bookmark metadata for a skipped harness without parsing source files.
	 * @param harnessName - Harness whose skip decision was accepted.
	 * @param harnessConfig - Harness config used to refresh parser/path metadata.
	 * @param plan - Startup plan containing the existing bookmark.
	 */
	private commitSkipHeartbeat(
		harnessName: string,
		harnessConfig: HarnessConfig,
		plan: StartupHarnessPlan
	): void
	{
		if (!plan.bookmark)
		{
			return;
		}
		this.globalSettingsStore.commitHarnessBookmark(harnessName, {
			...plan.bookmark,
			parserEpoch: getHarnessParserEpoch(harnessName),
			sourcePathHash: hashHarnessPaths(harnessConfig),
			lastSuccessfulIngestAt: plan.bookmark.lastSuccessfulIngestAt ?? new Date().toISOString(),
		});
	}

	/**
	 * Writes categorized startup plan lines for operator diagnostics.
	 * @param plan - Startup plan selected for one harness.
	 */
	private logHarnessPlan(plan: StartupHarnessPlan): void
	{
		const scope =
			plan.readScope.kind === "file-manifest"
				? `files=${plan.readScope.changedFiles.length}`
				: plan.readScope.kind === "cursor-rowid"
					? `sinceCursorRowId=${plan.readScope.sinceRowId}`
					: plan.readScope.kind === "opencode-rowid"
						? `rowids=${JSON.stringify(plan.readScope.rowids)}`
						: plan.readScope.kind;
		getHarnessCategoryLogger(plan.action).info(
			`${plan.harnessName}: action=${plan.action}, reason=${plan.reason}, scope=${scope}`
		);
		ingestPlanLogger.info(
			`${plan.harnessName}: bookmark=${plan.bookmark ? "yes" : "no"}, ` +
			`liveRowids=${plan.liveRowids ? JSON.stringify(plan.liveRowids) : "{}"}, expectedRead=${plan.expectedReadCount}`
		);
	}

	/**
	 * Rebuilds Cursor symbol-map artifacts for projects with explicit mapping rules.
	 * @param messages - Newly inserted Cursor messages from startup.
	 * @param harnessName - Harness name used in symbol output paths.
	 */
	private writeCursorSymbolMaps(messages: Array<AgentMessage>, harnessName: string): void
	{
		const ruleSet = loadCursorProjectRuleSet();
		const ruleMatchedProjects = ruleSet.projectMappingRules.map((r) => r.newProjectName);
		if (ruleMatchedProjects.length === 0)
		{
			return;
		}
		const matcher = new HarnessMatcher(messages, ruleMatchedProjects);
		matcher.buildSessionSymbolMaps();
		matcher.buildProjectSymbolMaps();
		matcher.logDiagnostics();
		const sessionFiles = matcher.writeSessionSymbolFiles(this.storagePath, this.machine.machine, harnessName);
		const projectFiles = matcher.writeProjectSymbolFiles(this.storagePath, this.machine.machine, harnessName);
		coordinatorLogger.info(`Cursor symbol maps: ${sessionFiles} session files, ${projectFiles} project files written`);
	}

	/**
	 * Stores minimal bookmark metadata for harnesses that still use the generic reader path.
	 * @param harnessName - Harness whose generic ingest completed.
	 * @param config - Harness config used to compute source metadata.
	 * @param inserted - Number of messages inserted by the generic ingest.
	 */
	private commitCompatibilityBookmark(harnessName: string, config: HarnessConfig, inserted: number): void
	{
		const existing = this.globalSettingsStore.getHarnessBookmark(harnessName) ?? { mode: "unknown" as const };
		const firstPath = config.paths[0];
		const bookmark: HarnessBookmark = {
			...existing,
			parserEpoch: getHarnessParserEpoch(harnessName),
			sourcePathHash: hashHarnessPaths(config),
			lastSuccessfulIngestAt: new Date().toISOString(),
		};

		if (firstPath)
		{
			const identity = collectSourceIdentity(firstPath);
			if (identity)
			{
				bookmark.sourceIdentity = identity;
			}
		}

		// Business logic: compatibility bookmarks are created for first successful runs
		// and refreshed when a legacy harness actually contributes new messages.
		if (inserted > 0 || !this.globalSettingsStore.getHarnessBookmark(harnessName))
		{
			this.globalSettingsStore.commitHarnessBookmark(harnessName, bookmark);
		}
	}
}
