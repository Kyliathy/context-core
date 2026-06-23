/**
 * GlobalSettingsStore - synced runtime metadata for startup ingest.
 *
 * Architecture: server/zz-reach2/architecture/archi-context-core-level0.md
 * Upgrade plan: server/zz-reach2/upgrades/2026-06/r2so2-startup-optimization2.md
 * Logging: server/zz-reach2/upgrades/2026-06/r2wl-winston-logging.md
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";
import { getLogger } from "../logging/logger.js";

const logger = getLogger("GlobalSettingsStore");
const SETTINGS_SCHEMA_VERSION = 3;
const DEFAULT_MACHINE_NAME = "default";

export type CursorRowIdCheckpoint = {
	cursorDiskKVRowId: number;
	itemTableRowId: number;
};

export type IngestDbFingerprint = {
	databaseFile: string;
	messageCount: number;
	sessionCount: number;
	fileMtimeMs: number;
	fileSizeBytes: number;
	harnessCounts: Record<string, number>;
};

export type SourceIdentity = {
	path: string;
	sizeBytes: number;
	mtimeMs: number;
	machineName?: string;
	sourceKind?: string;
};

export type HarnessBookmark = {
	mode: "file-manifest" | "rowid" | "unknown";
	parserEpoch?: number;
	sourcePathHash?: string;
	lastSuccessfulIngestAt?: string | null;
	sourceIdentity?: SourceIdentity;
	rowids?: Record<string, number>;
	manifestPath?: string;
	manifestRevision?: number;
	progress?: Record<string, unknown>;
};

export type MachineRunState = {
	runId: string;
	startedAt: string;
};

export type MachineIngestState = {
	runInProgress?: MachineRunState | null;
	lastSuccessfulRunAt?: string | null;
	dbFingerprint?: IngestDbFingerprint;
	harnesses?: Record<string, HarnessBookmark>;
};

type GlobalSettingsData = {
	schemaVersion: number;
	ingest: {
		machines: Record<string, MachineIngestState>;
	};
};

const EMPTY_CURSOR_CHECKPOINT: CursorRowIdCheckpoint = {
	cursorDiskKVRowId: 0,
	itemTableRowId: 0,
};

/**
 * Stores ingest metadata in the synced `.settings/global-settings.json` file.
 *
 * The file is shared by sync, but each harness bookmark and DB fingerprint is
 * scoped under one machine. This prevents one computer's local DB or Cursor DB
 * rowids from forcing recovery reads on another computer.
 */
export class GlobalSettingsStore
{
	private readonly settingsDir: string;
	private readonly filePath: string;
	private activeMachineName: string;
	private activeRunId: string | null = null;
	private lastLoadedMtimeMs = 0;
	private data: GlobalSettingsData = GlobalSettingsStore.emptyData();

	/**
	 * Creates the store and ensures the `.settings` directory exists.
	 * @param storagePath - CXC storage root where `.settings/global-settings.json` lives.
	 * @param activeMachineName - Machine whose ingest state this instance reads and writes.
	 */
	constructor(storagePath: string, activeMachineName: string = DEFAULT_MACHINE_NAME)
	{
		this.settingsDir = join(storagePath, ".settings");
		this.filePath = join(this.settingsDir, "global-settings.json");
		this.activeMachineName = this.normalizeMachineName(activeMachineName);

		if (!existsSync(this.settingsDir))
		{
			mkdirSync(this.settingsDir, { recursive: true });
		}
	}

	/**
	 * Loads global settings from disk, resetting old schemas to an empty v3 shape.
	 */
	load(): void
	{
		if (!existsSync(this.filePath))
		{
			this.data = GlobalSettingsStore.emptyData();
			this.lastLoadedMtimeMs = 0;
			this.ensureMachineIngest();
			return;
		}

		try
		{
			const raw = readFileSync(this.filePath, "utf-8");
			const parsed = JSON.parse(raw) as unknown;
			this.data = this.parseOrReset(parsed);
			this.lastLoadedMtimeMs = statSync(this.filePath).mtimeMs;
			this.ensureMachineIngest();
		}
		catch (error)
		{
			logger.warn(
				`Failed to parse global-settings.json: ${(error as Error).message}. Starting with empty v3 settings.`
			);
			this.data = GlobalSettingsStore.emptyData();
			this.lastLoadedMtimeMs = 0;
			this.ensureMachineIngest();
		}
	}

	/**
	 * Saves the active machine's current ingest state without overwriting unrelated synced state.
	 * @param options - Save behavior for merge-safe commits or explicit active-machine replacement.
	 */
	save(options: { replaceActiveMachine?: boolean } = {}): void
	{
		const diskMtimeMs = existsSync(this.filePath) ? statSync(this.filePath).mtimeMs : 0;
		// Business logic: a changed synced settings file means another process or machine wrote
		// metadata after this store loaded, so save must reload and merge instead of overwriting.
		if (diskMtimeMs > 0 && this.lastLoadedMtimeMs > 0 && diskMtimeMs !== this.lastLoadedMtimeMs)
		{
			logger.debug(`Merging ${this.activeMachineName} ingest state into newer global-settings.json.`);
		}
		const merged = this.mergeActiveMachineIntoDisk(options);
		this.writeAtomically(merged);
		this.data = merged;
		this.lastLoadedMtimeMs = existsSync(this.filePath) ? statSync(this.filePath).mtimeMs : 0;
	}

	/**
	 * Returns the machine name this store instance currently scopes reads and writes to.
	 * @returns Active machine name used by bookmark and fingerprint accessors.
	 */
	getActiveMachineName(): string
	{
		return this.activeMachineName;
	}

	/**
	 * Changes the active machine scope for subsequent reads and writes.
	 * @param machineName - Machine name from `cc.json`.
	 */
	setActiveMachine(machineName: string): void
	{
		this.activeMachineName = this.normalizeMachineName(machineName);
		this.ensureMachineIngest();
	}

	/**
	 * Returns a shallow copy of every machine ingest state for diagnostics.
	 * @returns Machine ingest states keyed by machine name.
	 */
	getAllMachineStates(): Record<string, MachineIngestState>
	{
		return { ...this.data.ingest.machines };
	}

	/**
	 * Reads the active machine's Cursor rowid checkpoint.
	 * @returns Current Cursor checkpoint, or zeroes when no active-machine bookmark exists.
	 */
	getCursorCheckpoint(): CursorRowIdCheckpoint
	{
		const bookmark = this.getHarnessBookmark("Cursor");
		if (bookmark?.rowids)
		{
			return {
				cursorDiskKVRowId: this.toPositiveInteger(bookmark.rowids.cursorDiskKV),
				itemTableRowId: this.toPositiveInteger(bookmark.rowids.ItemTable),
			};
		}

		return EMPTY_CURSOR_CHECKPOINT;
	}

	/**
	 * Writes the active machine's Cursor checkpoint without changing `lastSuccessfulIngestAt`.
	 * @param checkpoint - Cursor rowids that should become the active-machine checkpoint.
	 */
	setCursorCheckpoint(checkpoint: CursorRowIdCheckpoint): void
	{
		this.writeCursorCheckpoint(checkpoint);
		this.save();
	}

	/**
	 * Writes the active machine's Cursor checkpoint and successful ingest time.
	 * @param checkpoint - Cursor rowids that should become the active-machine checkpoint.
	 * @param now - Timestamp recorded as the Cursor bookmark's success time.
	 */
	setCursorState(checkpoint: CursorRowIdCheckpoint, now: Date = new Date()): void
	{
		this.writeCursorCheckpoint(checkpoint, now);
		this.save();
	}

	/**
	 * Refreshes the active machine's Cursor last-query timestamp without changing rowids.
	 * @param now - Timestamp to store as the latest Cursor ingest time.
	 */
	touchCursorLastQueriedAt(now: Date = new Date()): void
	{
		const existing = this.getCursorCheckpoint();
		this.writeCursorCheckpoint(existing, now);
		this.save();
	}

	/**
	 * Returns the active machine's latest Cursor ingest timestamp.
	 * @returns Parsed timestamp, or null when the timestamp is absent/invalid.
	 */
	getCursorLastQueriedAt(): Date | null
	{
		const value = this.getHarnessBookmark("Cursor")?.lastSuccessfulIngestAt;
		if (!value)
		{
			return null;
		}

		const parsed = new Date(value);
		if (Number.isNaN(parsed.getTime()))
		{
			return null;
		}

		return parsed;
	}

	/**
	 * Resets only the active machine's Cursor rowid checkpoint.
	 */
	resetCursorState(): void
	{
		this.writeCursorCheckpoint(EMPTY_CURSOR_CHECKPOINT);
		this.save();
	}

	/**
	 * Marks startup ingest as active for this machine.
	 * @param now - Timestamp used as the run start time.
	 * @returns Run id that should clear this exact active-machine run.
	 */
	beginIngestRun(now: Date = new Date()): string
	{
		const ingest = this.ensureMachineIngest();
		const runId = randomUUID();
		ingest.runInProgress = {
			runId,
			startedAt: now.toISOString(),
		};
		this.activeRunId = runId;
		this.save();
		return runId;
	}

	/**
	 * Ends this machine's startup ingest run and optionally stores its local DB fingerprint.
	 * @param success - Whether startup ingest completed successfully.
	 * @param dbFingerprint - Active machine's local database fingerprint.
	 * @param now - Timestamp used as the run completion time.
	 * @param runId - Run id to clear; defaults to the id created by this store instance.
	 */
	endIngestRun(
		success: boolean,
		dbFingerprint?: IngestDbFingerprint,
		now: Date = new Date(),
		runId: string | null = this.activeRunId
	): void
	{
		const ingest = this.ensureMachineIngest();
		const activeRun = ingest.runInProgress;
		// Business logic: only the process that owns a machine-scoped run marker may clear it,
		// so a stale process cannot erase another startup's recovery signal in synced settings.
		if (activeRun?.runId && runId && activeRun.runId !== runId)
		{
			logger.warn(
				`Ignoring endIngestRun for ${this.activeMachineName}; active run is ${activeRun.runId}, caller had ${runId}.`
			);
			return;
		}

		ingest.runInProgress = null;
		if (success)
		{
			ingest.lastSuccessfulRunAt = now.toISOString();
			if (dbFingerprint)
			{
				ingest.dbFingerprint = dbFingerprint;
			}
		}
		this.activeRunId = null;
		this.save();
	}

	/**
	 * Returns whether the active machine has an unfinished startup ingest marker.
	 * @returns True when the active machine's run marker is present.
	 */
	isRunInProgress(): boolean
	{
		return !!this.ensureMachineIngest().runInProgress;
	}

	/**
	 * Clears a stale active-machine `runInProgress` flag without touching bookmarks.
	 */
	clearStaleIngestRun(): void
	{
		const ingest = this.ensureMachineIngest();
		ingest.runInProgress = null;
		this.activeRunId = null;
		this.save();
	}

	/**
	 * Returns the active machine's local DB fingerprint.
	 * @returns Fingerprint for this machine's local DB, or null when absent.
	 */
	getDbFingerprint(): IngestDbFingerprint | null
	{
		return this.ensureMachineIngest().dbFingerprint ?? null;
	}

	/**
	 * Returns one active-machine harness bookmark.
	 * @param name - Harness name such as `Cursor` or `ClaudeCode`.
	 * @returns Bookmark for the active machine, or null when absent.
	 */
	getHarnessBookmark(name: string): HarnessBookmark | null
	{
		return this.ensureMachineIngest().harnesses?.[name] ?? null;
	}

	/**
	 * Commits one active-machine harness bookmark.
	 * @param name - Harness name such as `Cursor` or `ClaudeCode`.
	 * @param state - Bookmark state produced after persistence succeeds.
	 */
	commitHarnessBookmark(name: string, state: HarnessBookmark): void
	{
		const ingest = this.ensureMachineIngest();
		ingest.harnesses![name] = state;
		this.save();
	}

	/**
	 * Resets one active-machine harness bookmark.
	 * @param name - Harness name to remove from the active machine.
	 */
	resetHarnessBookmark(name: string): void
	{
		const ingest = this.ensureMachineIngest();
		delete ingest.harnesses![name];
		this.save({ replaceActiveMachine: true });
	}

	/**
	 * Resets all active-machine ingest bookmarks and run state.
	 */
	resetAllIngestBookmarks(): void
	{
		const ingest = this.ensureMachineIngest();
		ingest.harnesses = {};
		ingest.runInProgress = null;
		this.activeRunId = null;
		this.save({ replaceActiveMachine: true });
	}

	/**
	 * Resets ingest state for every machine in the synced settings file.
	 */
	resetEveryMachineIngestBookmarks(): void
	{
		this.data.ingest.machines = {};
		this.activeRunId = null;
		this.writeAtomically(this.data);
		this.lastLoadedMtimeMs = existsSync(this.filePath) ? statSync(this.filePath).mtimeMs : 0;
	}

	/**
	 * Returns an empty v3 settings object.
	 * @returns Empty settings data with no machine state.
	 */
	private static emptyData(): GlobalSettingsData
	{
		return {
			schemaVersion: SETTINGS_SCHEMA_VERSION,
			ingest: {
				machines: {},
			},
		};
	}

	/**
	 * Parses persisted JSON into the v3 shape or discards obsolete schemas.
	 * @param parsed - JSON value read from disk.
	 * @returns Valid v3 settings data.
	 */
	private parseOrReset(parsed: unknown): GlobalSettingsData
	{
		// Business logic: R2SO2 intentionally drops v1/v2 global ingest state because
		// those schemas are the source of cross-machine bookmark contamination.
		if (!this.isGlobalSettingsData(parsed))
		{
			return GlobalSettingsStore.emptyData();
		}
		return parsed;
	}

	/**
	 * Checks whether a parsed value already has the v3 settings shape.
	 * @param value - Parsed JSON candidate.
	 * @returns True when value can be used as GlobalSettingsData.
	 */
	private isGlobalSettingsData(value: unknown): value is GlobalSettingsData
	{
		// Business logic: both object shape and schema version must match before trusting synced settings,
		// because older schemas store global bookmarks that can force false Cursor recovery.
		if (!value || typeof value !== "object")
		{
			return false;
		}
		const candidate = value as Partial<GlobalSettingsData>;
		return (
			candidate.schemaVersion === SETTINGS_SCHEMA_VERSION &&
			!!candidate.ingest &&
			typeof candidate.ingest === "object" &&
			!!candidate.ingest.machines &&
			typeof candidate.ingest.machines === "object"
		);
	}

	/**
	 * Returns the active machine ingest object, creating it when missing.
	 * @returns Mutable active-machine ingest state.
	 */
	private ensureMachineIngest(): MachineIngestState
	{
		this.data.schemaVersion = SETTINGS_SCHEMA_VERSION;
		if (!this.data.ingest)
		{
			this.data.ingest = { machines: {} };
		}
		if (!this.data.ingest.machines)
		{
			this.data.ingest.machines = {};
		}
		const existing = this.data.ingest.machines[this.activeMachineName];
		if (existing)
		{
			if (!existing.harnesses)
			{
				existing.harnesses = {};
			}
			return existing;
		}

		const created: MachineIngestState = {
			runInProgress: null,
			lastSuccessfulRunAt: null,
			harnesses: {},
		};
		this.data.ingest.machines[this.activeMachineName] = created;
		return created;
	}

	/**
	 * Merges this instance's active-machine state into the latest on-disk data.
	 * @param options - Merge behavior for normal commits or explicit active-machine reset.
	 * @returns Settings data preserving other machines from disk.
	 */
	private mergeActiveMachineIntoDisk(options: { replaceActiveMachine?: boolean } = {}): GlobalSettingsData
	{
		const diskData = this.readDiskDataIfCurrentShape();
		const merged = diskData ?? GlobalSettingsStore.emptyData();
		const localMachine = this.ensureMachineIngest();
		const diskMachine = merged.ingest.machines[this.activeMachineName];
		// Business logic: explicit reset commands replace this machine wholesale, while first
		// writes create the machine state without needing to merge older harness entries.
		if (options.replaceActiveMachine || !diskMachine)
		{
			merged.ingest.machines[this.activeMachineName] = localMachine;
			return merged;
		}

		merged.ingest.machines[this.activeMachineName] = {
			...diskMachine,
			...localMachine,
			harnesses: {
				...(diskMachine.harnesses ?? {}),
				...(localMachine.harnesses ?? {}),
			},
		};
		return merged;
	}

	/**
	 * Reads the current disk file only when it already has the v3 shape.
	 * @returns Current v3 disk data, or null when absent/invalid/old.
	 */
	private readDiskDataIfCurrentShape(): GlobalSettingsData | null
	{
		if (!existsSync(this.filePath))
		{
			return null;
		}
		try
		{
			const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as unknown;
			return this.isGlobalSettingsData(parsed) ? parsed : null;
		}
		catch
		{
			return null;
		}
	}

	/**
	 * Writes settings through a temporary file before replacing the synced target.
	 * @param data - Complete settings payload to persist.
	 */
	private writeAtomically(data: GlobalSettingsData): void
	{
		const tempPath = join(this.settingsDir, `global-settings.${process.pid}.${Date.now()}.tmp`);
		writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf-8");
		renameSync(tempPath, this.filePath);
	}

	/**
	 * Updates the active machine's Cursor bookmark rowids.
	 * @param checkpoint - Cursor rowids to store.
	 * @param now - Optional success timestamp.
	 */
	private writeCursorCheckpoint(checkpoint: CursorRowIdCheckpoint, now?: Date): void
	{
		const ingest = this.ensureMachineIngest();
		const existing = ingest.harnesses!.Cursor ?? { mode: "rowid" as const };
		ingest.harnesses!.Cursor = {
			...existing,
			mode: "rowid",
			lastSuccessfulIngestAt: now ? now.toISOString() : existing.lastSuccessfulIngestAt ?? null,
			rowids: {
				...(existing.rowids ?? {}),
				cursorDiskKV: this.toPositiveInteger(checkpoint.cursorDiskKVRowId),
				ItemTable: this.toPositiveInteger(checkpoint.itemTableRowId),
			},
		};
	}

	/**
	 * Normalizes machine names for settings keys.
	 * @param machineName - Machine name from config or a caller.
	 * @returns Non-empty key used under `ingest.machines`.
	 */
	private normalizeMachineName(machineName: string): string
	{
		const trimmed = machineName.trim();
		return trimmed || DEFAULT_MACHINE_NAME;
	}

	/**
	 * Converts unknown values into non-negative integer rowids/counts.
	 * @param value - Candidate numeric value.
	 * @returns Positive integer or zero.
	 */
	private toPositiveInteger(value: unknown): number
	{
		// Business logic: rowid bookmarks must be positive integers because zero means
		// "no durable checkpoint" for startup and watcher delta decisions.
		if (typeof value === "number" && value > 0)
		{
			return Math.floor(value);
		}
		return 0;
	}
}
