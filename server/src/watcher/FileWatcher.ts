/**
 * FileWatcher – watches configured harness source paths AND remote machine storage
 * directories for changes, triggering incremental re-ingestion via IncrementalPipeline.
 *
 * Two watch modes:
 *   harness        – local IDE source files (ClaudeCode, Cursor, Kiro, VSCode, Codex, OpenCode).
 *                    Full pipeline: harness reader → StorageWriter → MessageDB → AI/Vector.
 *   remote-storage – already-processed .json session files synced from another machine.
 *                    Short pipeline: parse JSON → MessageDB → AI/Vector (no harness reader).
 *
 * Key behaviours:
 * - One fs.watch() watcher per configured path (recursive for directories).
 * - Debounced per path: rapid successive events collapse into one ingest call.
 * - Sequential processing queue: concurrent ingests are serialized to avoid
 *   racing writes to MessageDB and the AI/vector APIs.
 * - Cursor uses a longer debounce (5s) because its single SQLite DB receives
 *   many rapid flushes during an active session.
 * - Remote storage dirs use a 3s debounce and accumulate all changed file paths
 *   during the window so one ingest call handles the whole sync burst.
 */

import { watch, existsSync, readdirSync } from "fs";
import type { FSWatcher } from "fs";
import { extname, basename, join as joinPath } from "path";
import chalk from "chalk";
import type { CCSettings } from "../settings/CCSettings.js";
import type { MachineConfig } from "../types.js";
import { getHarnessEntries } from "../types.js";
import type { IncrementalPipeline } from "./IncrementalPipeline.js";

/** Relevant file extensions per harness type. */
const HARNESS_EXTENSIONS: Record<string, string[]> = {
	ClaudeCode: [".jsonl"],
	Cursor: [".vscdb"],
	Kiro: [".chat"],
	VSCode: [".json", ".jsonl"],
	Codex: [".jsonl"],
	OpenCode: [".db", ".json"],
};

/** Debounce delay (ms) per harness. Cursor is longer due to frequent DB flushes. */
const HARNESS_DEBOUNCE_MS: Record<string, number> = {
	ClaudeCode: 1000,
	Cursor: 5000,
	Kiro: 1000,
	VSCode: 1000,
	Codex: 1000,
	OpenCode: 5000,
};

const DEFAULT_DEBOUNCE_MS = 2000;

/** Debounce for remote storage dirs — file sync tools deliver files in bursts. */
const REMOTE_STORAGE_DEBOUNCE_MS = 3000;

interface WatchedPath
{
	type: "harness" | "remote-storage";
	/** For harness: harness name. For remote-storage: machine dir name (e.g. "SUSAN2"). */
	harnessName: string;
	/** The configured source path (file or directory). */
	path: string;
	watcher: FSWatcher;
}

type QueueItem =
	| { type: "harness"; harnessName: string; path: string }
	| { type: "remote-storage"; source: string; filePaths: string[] };

/** Accumulated state for a remote-storage debounce window. */
interface RemoteDebounceState
{
	timer: ReturnType<typeof setTimeout>;
	filePaths: Set<string>;
}

type FilterDecision =
	| { accept: true; normalizedFile: string }
	| { accept: false; reason: string; normalizedFile: string };

/**
 * Watches all configured harness paths and remote machine storage dirs,
 * triggering incremental ingestion on change.
 */
export class FileWatcher
{
	private readonly settings: CCSettings;
	private readonly machine: MachineConfig;
	private readonly pipeline: IncrementalPipeline;

	private watchers: Array<WatchedPath> = [];
	private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private remoteDebounceState = new Map<string, RemoteDebounceState>();
	private ingestQueue: Array<QueueItem> = [];
	private isProcessingQueue = false;
	private ignoredEventCounts = new Map<string, number>();

	constructor(settings: CCSettings, machine: MachineConfig, pipeline: IncrementalPipeline)
	{
		this.settings = settings;
		this.machine = machine;
		this.pipeline = pipeline;
	}

	/**
	 * Starts watching all configured harness paths and remote storage machine dirs.
	 * Logs which paths were successfully registered and which failed.
	 */
	start(): void
	{
		// ── Local harness source paths ─────────────────────────────────────────
		for (const [harnessName, harnessConfig] of getHarnessEntries(this.machine.harnesses))
		{
			const paths = Array.isArray(harnessConfig.paths) ? harnessConfig.paths : [harnessConfig.paths];

			const extensions = HARNESS_EXTENSIONS[harnessName] ?? [];
			const debounceMs = HARNESS_DEBOUNCE_MS[harnessName] ?? DEFAULT_DEBOUNCE_MS;
			// Cursor watches a single file; all others watch directories recursively.
			const isSingleFile = harnessName === "Cursor";

			for (const p of paths)
			{
				this.watchHarnessPath(harnessName, p, extensions, debounceMs, isSingleFile);
			}
		}

		// ── Remote machine storage dirs ────────────────────────────────────────
		this.startRemoteStorageWatching();

		const harnessPaths = this.watchers.filter((w) => w.type === "harness").length;
		const remotePaths = this.watchers.filter((w) => w.type === "remote-storage").length;
		console.log(
			chalk.blue(
				`[FileWatcher] Active: ${harnessPaths} harness watcher(s), ${remotePaths} remote storage watcher(s)`
			)
		);
	}

	/**
	 * Stops all watchers and clears pending timers.
	 */
	stop(): void
	{
		for (const { watcher } of this.watchers)
		{
			try
			{
				watcher.close();
			}
			catch
			{
				// Ignore close errors during shutdown.
			}
		}

		for (const timer of this.debounceTimers.values())
		{
			clearTimeout(timer);
		}

		for (const state of this.remoteDebounceState.values())
		{
			clearTimeout(state.timer);
		}

		this.watchers = [];
		this.debounceTimers.clear();
		this.remoteDebounceState.clear();
		console.log(chalk.blue("[FileWatcher] Stopped."));
	}

	/**
	 * Returns the list of actively watched paths (for status/diagnostics).
	 */
	getWatchedPaths(): Array<{ type: "harness" | "remote-storage"; harnessName: string; path: string }>
	{
		return this.watchers.map(({ type, harnessName, path }) => ({ type, harnessName, path }));
	}

	// ─── Remote storage ─────────────────────────────────────────────────────────

	/**
	 * Discovers all top-level dirs in storage that belong to other machines and
	 * registers a recursive watcher for each. Also watches the storage root itself
	 * so that newly-appearing machine dirs (from a machine that starts syncing later)
	 * are picked up at runtime.
	 */
	private startRemoteStorageWatching(): void
	{
		const storagePath = this.settings.storage;
		if (!existsSync(storagePath))
		{
			return;
		}

		// Watch existing remote machine dirs.
		for (const machineDirName of this.discoverRemoteMachineDirs())
		{
			this.watchRemoteMachineDir(machineDirName);
		}

		// Watch the storage root for new machine dirs appearing at runtime.
		try
		{
			const rootWatcher = watch(storagePath, { recursive: false }, (_, filename) =>
			{
				if (!filename)
				{
					return;
				}

				const name = typeof filename === "string" ? filename : String(filename);
				if (!this.isRemoteMachineDir(name))
				{
					return;
				}

				// Only add a watcher if we haven't already registered one for this dir.
				const alreadyWatched = this.watchers.some(
					(w) => w.type === "remote-storage" && w.harnessName === name
				);
				if (!alreadyWatched)
				{
					console.log(chalk.blue(`[FileWatcher] New remote machine dir detected: ${name}`));
					this.watchRemoteMachineDir(name);
				}
			});

			// Root watcher is tracked without a meaningful harnessName.
			this.watchers.push({
				type: "remote-storage",
				harnessName: "__storage-root__",
				path: storagePath,
				watcher: rootWatcher,
			});
		}
		catch (err)
		{
			console.warn(
				chalk.yellow(
					`[FileWatcher] Cannot watch storage root @ ${storagePath}: ${(err as Error).message}`
				)
			);
		}
	}

	/**
	 * Returns the names of top-level dirs in storage that belong to other machines.
	 * Excludes: the current machine, dirs ending in "-RAW", dirs starting with "zzz" or ".".
	 */
	private discoverRemoteMachineDirs(): string[]
	{
		const storagePath = this.settings.storage;
		try
		{
			return readdirSync(storagePath, { withFileTypes: true })
				.filter((entry) => entry.isDirectory() && this.isRemoteMachineDir(entry.name))
				.map((entry) => entry.name);
		}
		catch
		{
			return [];
		}
	}

	/**
	 * Returns true if a storage root entry name qualifies as a remote machine directory.
	 */
	private isRemoteMachineDir(name: string): boolean
	{
		const lower = name.toLowerCase();
		if (lower === this.machine.machine.toLowerCase())
		{
			return false; // current machine — handled by harness watcher
		}
		if (lower.endsWith("-raw"))
		{
			return false; // raw archive dirs
		}
		if (lower.startsWith("zzz") || lower.startsWith("."))
		{
			return false; // internal cache/settings dirs
		}
		return true;
	}

	/**
	 * Creates a recursive fs.watch() for a remote machine dir and registers it.
	 * Events are debounced per machine dir with accumulated file paths.
	 */
	private watchRemoteMachineDir(machineDirName: string): void
	{
		const dirPath = joinPath(this.settings.storage, machineDirName);
		if (!existsSync(dirPath))
		{
			return;
		}

		try
		{
			const watcher = watch(dirPath, { recursive: true }, (_, filename) =>
			{
				if (!filename)
				{
					return;
				}

				const nameStr = typeof filename === "string" ? filename : String(filename);
				const normalized = nameStr.replace(/\\/g, "/");
				const ext = extname(basename(normalized)).toLowerCase();

				// Only react to .json session files.
				if (ext !== ".json")
				{
					return;
				}

				const absolutePath = joinPath(dirPath, nameStr);
				this.scheduleRemoteIngest(machineDirName, absolutePath);
			});

			this.watchers.push({
				type: "remote-storage",
				harnessName: machineDirName,
				path: dirPath,
				watcher,
			});

			console.log(chalk.blue(`[FileWatcher] Watching remote storage: ${machineDirName} @ ${dirPath}`));
		}
		catch (err)
		{
			console.warn(
				chalk.yellow(
					`[FileWatcher] Cannot watch remote machine dir ${machineDirName} @ ${dirPath}: ${(err as Error).message}`
				)
			);
		}
	}

	/**
	 * Debounces a remote-storage ingest for a specific machine dir, accumulating all
	 * changed file paths during the window into a single ingest call.
	 */
	private scheduleRemoteIngest(source: string, absoluteFilePath: string): void
	{
		let state = this.remoteDebounceState.get(source);

		if (state)
		{
			clearTimeout(state.timer);
			state.filePaths.add(absoluteFilePath);
		}
		else
		{
			state = { timer: undefined as unknown as ReturnType<typeof setTimeout>, filePaths: new Set([absoluteFilePath]) };
			this.remoteDebounceState.set(source, state);
		}

		state.timer = setTimeout(() =>
		{
			const currentState = this.remoteDebounceState.get(source);
			this.remoteDebounceState.delete(source);

			if (!currentState || currentState.filePaths.size === 0)
			{
				return;
			}

			const filePaths = [...currentState.filePaths];

			// Replace stale pending entry for this source — only the accumulated latest set matters.
			const existingIdx = this.ingestQueue.findIndex(
				(item) => item.type === "remote-storage" && item.source === source
			);
			if (existingIdx >= 0)
			{
				const existing = this.ingestQueue[existingIdx] as { type: "remote-storage"; source: string; filePaths: string[] };
				// Merge file paths from the pending entry.
				this.ingestQueue[existingIdx] = {
					type: "remote-storage",
					source,
					filePaths: [...new Set([...existing.filePaths, ...filePaths])],
				};
			}
			else
			{
				this.ingestQueue.push({ type: "remote-storage", source, filePaths });
			}

			this.processQueue();
		}, REMOTE_STORAGE_DEBOUNCE_MS);
	}

	// ─── Harness watching ────────────────────────────────────────────────────────

	/**
	 * Creates one fs.watch() watcher for a configured harness path and registers it.
	 */
	private watchHarnessPath(
		harnessName: string,
		p: string,
		extensions: string[],
		debounceMs: number,
		isSingleFile: boolean
	): void
	{
		try
		{
			const watcher = watch(
				p,
				{ recursive: !isSingleFile },
				(event, filename) =>
				{
					if (!filename)
					{
						this.recordIgnoredEvent(harnessName, p, "missing-filename", "");
						return;
					}

					const nameStr = typeof filename === "string" ? filename : String(filename);
					const decision = this.filterEvent(harnessName, nameStr, isSingleFile, extensions);
					if (!decision.accept)
					{
						this.recordIgnoredEvent(harnessName, p, decision.reason, decision.normalizedFile);
						return;
					}

					console.log(
						chalk.gray(
							`[FileWatcher] Trigger: ${harnessName} ${event} ${decision.normalizedFile}`
						)
					);

					this.scheduleHarnessIngest(harnessName, p, debounceMs);
				}
			);

			this.watchers.push({ type: "harness", harnessName, path: p, watcher });
			console.log(chalk.blue(`[FileWatcher] Watching ${harnessName} @ ${p}`));
		}
		catch (err)
		{
			console.warn(
				chalk.yellow(
					`[FileWatcher] Cannot watch ${harnessName} @ ${p}: ${(err as Error).message}`
				)
			);
		}
	}

	/**
	 * Returns whether a file-system event should trigger ingestion.
	 * VSCode is intentionally strict: only chatSessions/*.json(.l) changes matter.
	 */
	private filterEvent(
		harnessName: string,
		filename: string,
		isSingleFile: boolean,
		extensions: string[]
	): FilterDecision
	{
		const normalizedFile = filename.replace(/\\/g, "/").toLowerCase();

		if (isSingleFile)
		{
			return { accept: true, normalizedFile };
		}

		const ext = extname(basename(normalizedFile)).toLowerCase();
		if (extensions.length > 0 && !extensions.includes(ext))
		{
			return { accept: false, reason: "extension-mismatch", normalizedFile };
		}

		if (harnessName === "VSCode")
		{
			if (!normalizedFile.startsWith("chatsessions/"))
			{
				return { accept: false, reason: "outside-chatsessions", normalizedFile };
			}

			if (normalizedFile.endsWith(".tmp") || normalizedFile.endsWith(".lock"))
			{
				return { accept: false, reason: "temporary-file", normalizedFile };
			}
		}

		return { accept: true, normalizedFile };
	}

	/**
	 * Throttled diagnostics for ignored events so we can trace noise sources
	 * without spamming logs on every single event.
	 */
	private recordIgnoredEvent(
		harnessName: string,
		watchPath: string,
		reason: string,
		_filename: string
	): void
	{
		const key = `${harnessName}::${watchPath}::${reason}`;
		const count = (this.ignoredEventCounts.get(key) ?? 0) + 1;
		this.ignoredEventCounts.set(key, count);

		// if (count === 1 || count % 25 === 0)
		// {
		// 	const detail = filename ? ` (${filename})` : "";
		// 	console.log(
		// 		chalk.gray(
		// 			`[FileWatcher] Ignored ${harnessName} event: reason=${reason}, count=${count}${detail}`
		// 		)
		// 	);
		// }
	}

	/**
	 * Debounces an ingest trigger for a specific (harnessName, path) pair.
	 * Resets the timer on every event so only one ingest fires after activity stops.
	 */
	private scheduleHarnessIngest(harnessName: string, path: string, debounceMs: number): void
	{
		const key = `${harnessName}::${path}`;
		const existing = this.debounceTimers.get(key);
		if (existing)
		{
			clearTimeout(existing);
		}

		const timer = setTimeout(() =>
		{
			this.debounceTimers.delete(key);
			this.enqueueHarnessIngest(harnessName, path);
		}, debounceMs);

		this.debounceTimers.set(key, timer);
	}

	/**
	 * Adds a harness ingest job to the queue, replacing any existing pending job for
	 * the same path (only the most-recent state matters between debounce fires).
	 */
	private enqueueHarnessIngest(harnessName: string, path: string): void
	{
		// Replace stale pending entry for this path — only the latest trigger matters.
		const existingIdx = this.ingestQueue.findIndex(
			(item) => item.type === "harness" && item.harnessName === harnessName && item.path === path
		);
		if (existingIdx >= 0)
		{
			this.ingestQueue.splice(existingIdx, 1);
		}

		this.ingestQueue.push({ type: "harness", harnessName, path });
		this.processQueue();
	}

	// ─── Queue ───────────────────────────────────────────────────────────────────

	/**
	 * Drains the ingest queue sequentially.
	 * Re-entrancy guard ensures only one processQueue loop runs at a time.
	 */
	private processQueue(): void
	{
		if (this.isProcessingQueue)
		{
			return;
		}

		this.isProcessingQueue = true;

		// Use an async IIFE so the loop can await each ingest without blocking the event loop.
		(async () =>
		{
			while (this.ingestQueue.length > 0)
			{
				const item = this.ingestQueue.shift()!;

				try
				{
					if (item.type === "harness")
					{
						const rawBase = joinPath(
							this.settings.storage,
							`${this.machine.machine}-RAW`,
							item.harnessName
						);
						await this.pipeline.ingest(item.harnessName, { paths: [item.path] }, rawBase);
					}
					else
					{
						await this.pipeline.ingestFromStorage(item.source, item.filePaths);
					}
				}
				catch (err)
				{
					const label = item.type === "harness" ? item.harnessName : `remote:${item.source}`;
					console.warn(
						chalk.yellow(
							`[FileWatcher] Ingest error for ${label}: ${(err as Error).message}`
						)
					);
				}
			}

			this.isProcessingQueue = false;
		})();
	}
}
