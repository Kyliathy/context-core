#!/usr/bin/env bun
/**
 * ContextCore CLI (`cxccli`)
 *
 * Logging: server/zz-reach2/upgrades/2026-06/r2wl-winston-logging.md (T59-T60)
 * Startup ingest follow-up: server/zz-reach2/upgrades/2026-06/r2so2-startup-optimization2.md
 * Intentional console exception: all table/JSON/prompt/validation output stays on console
 * because it is user-facing command UI consumed by humans or --json callers.
 *
 * Implemented in this phase:
 * - Commander command surface + clack interactive prompts
 * - VS Code workspace metadata resolution in list rows
 * - Columnar table + JSON list output
 * - Row-indexed edit/delete mutation flows
 * - Atomic cc.json writes with optional backup
 */

import {
	copyFileSync,
	existsSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { hostname as osHostname } from "os";
import { emitKeypressEvents } from "readline";
import { Command, CommanderError } from "commander";
import { cancel, confirm, intro, isCancel, outro, select, text } from "@clack/prompts";
import chalk, { type ChalkInstance } from "chalk";
import { deriveProjectName } from "./utils/pathHelpers.js";
import {
	resolveVSCodeWorkspaceMetadata,
	type VSCodeWorkspaceMetaStatus,
} from "./utils/vscodeWorkspace.js";
import {
	DEFAULT_HARNESS_SCANNERS,
	detectPlatform,
	detectUsername,
	scanHarnessCandidates,
	type HarnessScanner,
	type HarnessScannerCandidate,
} from "./cli/discovery.js";
import { GlobalSettingsStore } from "./settings/GlobalSettingsStore.js";
import { hashHarnessPaths } from "./ingest/IngestConfig.js";

type CliFlags = {
	machine?: string;
	json: boolean;
	yes: boolean;
	backup: boolean;
	allMachines: boolean;
	global: boolean;
};

type CliListRow = {
	row: number;
	machine: string;
	harness: string;
	configuredPath: string;
	computedProject: string;
	workspaceLocation: string | null;
	workspaceUri: string | null;
	workspacePath: string | null;
	workspaceMetaStatus: VSCodeWorkspaceMetaStatus | null;
	exists: boolean;
};

type CliCandidateRow = {
	row: number;
	harness: string;
	candidatePath: string;
	configuredPath: string;
	computedProject: string;
	workspaceLocation: string | null;
	workspaceUri: string | null;
	workspacePath: string | null;
	workspaceMetaStatus: VSCodeWorkspaceMetaStatus | null;
	evidence: string;
	exists: boolean;
};

type CliRowRef = CliListRow & {
	harnessPathIndex: number;
};

type CcMachine = Record<string, unknown> & {
	machine: string;
	harnesses: Record<string, unknown>;
};

type CcConfig = Record<string, unknown> & {
	storage: string;
	machines: CcMachine[];
};

type WriteOptions = {
	backup?: boolean;
};

type DeleteResult = {
	machine: CcMachine;
	target: CliRowRef;
	removedEmptyHarnessBlock: boolean;
};

type InteractiveAction = "list" | "add" | "edit" | "delete" | "quit";

type RunAddOptions = {
	renderUpdatedList?: boolean;
};

type SelectMachineOptions = {
	forcePrompt?: boolean;
	promptMessage?: string;
};

type ListRenderOptions = {
	selectedRow?: number;
};

type CandidateRenderOptions = {
	selectedRow?: number;
	selectedRows?: ReadonlySet<number>;
	showSelectionColumn?: boolean;
};

type AddCandidateRowsResult = {
	rows: CliCandidateRow[];
	skippedScannerDuplicates: number;
	skippedAlreadyConfigured: number;
};

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const EXIT_VALIDATION = 2;

const RESERVED_HARNESS_KEYS = new Set(["genericProjectMappingRules"]);

const HARNESS_ORDER = ["ClaudeCode", "Cursor", "VSCode", "Kiro", "OpenCode", "Codex"] as const;

const HARNESS_COLORS: Record<string, ChalkInstance> = {
	ClaudeCode: chalk.green,
	Cursor: chalk.blue,
	VSCode: chalk.cyan,
	Kiro: chalk.yellow,
	OpenCode: chalk.magenta,
	Codex: chalk.red,
	unknown: chalk.gray,
};

/**
 * Handles isRecord behavior for this CXC module.
 * @param value - Value consumed by isRecord.
 * @returns Result produced by isRecord.
 */
function isRecord(value: unknown): value is Record<string, unknown>
{
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Detects host state used by detectMachineName.
 * @returns Result produced by detectMachineName.
 */
function detectMachineName(): string
{
	// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.

	if (process.platform === "win32" && process.env.COMPUTERNAME)
	{
		return process.env.COMPUTERNAME;
	}
	return osHostname();
}

/**
 * Returns the value managed by getHarnessSortIndex.
 * @param harnessName - Harness name or harness data used by getHarnessSortIndex.
 * @returns Result produced by getHarnessSortIndex.
 */
function getHarnessSortIndex(harnessName: string): number
{
	const idx = HARNESS_ORDER.indexOf(harnessName as (typeof HARNESS_ORDER)[number]);
	return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

/**
 * Returns the value managed by getHarnessColor.
 * @param harnessName - Harness name or harness data used by getHarnessColor.
 * @returns Result produced by getHarnessColor.
 */
function getHarnessColor(harnessName: string): ChalkInstance
{
	return HARNESS_COLORS[harnessName] ?? HARNESS_COLORS.unknown;
}

/**
 * Parses input into the shape expected by parseRowNumber.
 * @param row - Value consumed by parseRowNumber.
 * @returns Result produced by parseRowNumber.
 */
function parseRowNumber(row: string): number
{
	const parsed = Number.parseInt(row, 10);
	// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.

	if (!Number.isInteger(parsed) || parsed < 1)
	{
		throw new Error(`Invalid row number "${row}".`);
	}
	return parsed;
}

/**
 * Loads data needed by loadCcConfig from the configured CXC source.
 * @param ccJsonPath - Path used by loadCcConfig to locate the relevant CXC resource.
 * @returns Result produced by loadCcConfig.
 */
function loadCcConfig(ccJsonPath: string): CcConfig
{
	if (!existsSync(ccJsonPath))
	{
		throw new Error(`cc.json not found at: ${ccJsonPath}`);
	}

	let parsed: unknown;
	try
	{
		parsed = JSON.parse(readFileSync(ccJsonPath, "utf-8"));
	}
	catch (err: unknown)
	{
		throw new Error(`Failed to parse cc.json: ${err instanceof Error ? err.message : String(err)}`);
	}

	if (!isRecord(parsed))
	{
		throw new Error("Invalid cc.json: expected top-level JSON object.");
	}	// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.

	if (typeof parsed.storage !== "string" || parsed.storage.trim() === "")
	{
		throw new Error("Invalid cc.json: `storage` must be a non-empty string.");
	}
	if (!Array.isArray(parsed.machines))
	{
		throw new Error("Invalid cc.json: `machines` must be an array.");
	}

	const machines: CcMachine[] = parsed.machines.map((machine, idx) =>
	{
		if (!isRecord(machine))
		{
			throw new Error(`Invalid cc.json: machines[${idx}] must be an object.`);
		}		// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.

		if (typeof machine.machine !== "string" || machine.machine.trim() === "")
		{
			throw new Error(`Invalid cc.json: machines[${idx}].machine must be a non-empty string.`);
		}
		if (!isRecord(machine.harnesses))
		{
			throw new Error(`Invalid cc.json: machines[${idx}].harnesses must be an object.`);
		}
		return machine as CcMachine;
	});

	return {
		...parsed,
		storage: parsed.storage,
		machines,
	};
}

/**
 * Handles promptMachinePick behavior for this CXC module.
 * @param machines - Value consumed by promptMachinePick.
 * @param options - Options that control promptMachinePick.
 * @returns Result produced by promptMachinePick.
 */
async function promptMachinePick(
	machines: CcMachine[],
	options?: {
		message?: string;
		preferredMachine?: string;
	}
): Promise<CcMachine | null>
{
	if (!process.stdin.isTTY)
	{
		return null;
	}

	const preferredMachine = options?.preferredMachine?.toLowerCase();
	const picked = await select({
		message: options?.message ?? "No hostname match found. Select a machine:",
		options: machines.map((machine, idx) => ({
			value: String(idx),
			label: machine.machine,
			hint: preferredMachine && machine.machine.toLowerCase() === preferredMachine ? "host" : undefined,
		})),
	});
	if (isCancel(picked))
	{
		cancel("Machine selection cancelled.");
		return null;
	}

	const idx = Number.parseInt(String(picked), 10);
	// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.

	if (!Number.isInteger(idx) || idx < 0 || idx >= machines.length)
	{
		return null;
	}
	return machines[idx];
}

/**
 * Handles selectMachine behavior for this CXC module.
 * @param config - Configuration object used by selectMachine.
 * @param machineName - Value consumed by selectMachine.
 * @param options - Options that control selectMachine.
 * @returns Result produced by selectMachine.
 */
async function selectMachine(config: CcConfig, machineName?: string, options?: SelectMachineOptions): Promise<CcMachine>
{
	if (config.machines.length === 0)
	{
		throw new Error("cc.json has no machine entries.");
	}

	if (machineName)
	{
		const exact = config.machines.find((entry) => entry.machine.toLowerCase() === machineName.toLowerCase());
		if (!exact)
		{
			const available = config.machines.map((entry) => entry.machine).join(", ");
			throw new Error(`Machine "${machineName}" not found. Available: ${available}`);
		}
		return exact;
	}

	if (options?.forcePrompt)
	{
		if (config.machines.length === 1)
		{
			return config.machines[0];
		}

		const picked = await promptMachinePick(config.machines, {
			message: options.promptMessage ?? "Select a machine:",
			preferredMachine: detectMachineName(),
		});
		if (!picked)
		{
			throw new Error("Machine selection required. Re-run with --machine <name>.");
		}
		return picked;
	}

	const host = detectMachineName().toLowerCase();
	const match = config.machines.find((entry) => entry.machine.toLowerCase() === host);
	if (match)
	{
		return match;
	}

	if (config.machines.length === 1)
	{
		return config.machines[0];
	}

	const picked = await promptMachinePick(config.machines, {
		message: "No hostname match found. Select a machine:",
		preferredMachine: detectMachineName(),
	});
	if (!picked)
	{
		throw new Error("Machine selection required. Re-run with --machine <name>.");
	}
	return picked;
}

/**
 * Reads data for readHarnessPaths without changing unrelated CXC state.
 * @param harnessConfig - Configuration object used by readHarnessPaths.
 * @returns Result produced by readHarnessPaths.
 */
function readHarnessPaths(harnessConfig: unknown): string[]
{
	if (!isRecord(harnessConfig)) return [];
	if (!Array.isArray(harnessConfig.paths)) return [];
	return harnessConfig.paths.filter((value): value is string => typeof value === "string" && value.trim() !== "");
}

/**
 * Handles computeRowFields behavior for this CXC module.
 * @param harness - Harness name or harness data used by computeRowFields.
 * @param configuredPath - Path used by computeRowFields to locate the relevant CXC resource.
 * @returns Result produced by computeRowFields.
 */
function computeRowFields(harness: string, configuredPath: string): Omit<CliListRow, "row" | "machine" | "harness">
{
	const exists = existsSync(configuredPath);

	if (harness === "VSCode")
	{
		const meta = resolveVSCodeWorkspaceMetadata(configuredPath);
		const computedProject = meta.workspacePath
			? deriveProjectName("VSCode", meta.workspacePath)
			: deriveProjectName("VSCode", configuredPath);

		return {
			configuredPath,
			computedProject,
			workspaceLocation: meta.workspacePath,
			workspaceUri: meta.workspaceUri,
			workspacePath: meta.workspacePath,
			workspaceMetaStatus: meta.workspaceMetaStatus,
			exists,
		};
	}

	return {
		configuredPath,
		computedProject: deriveProjectName(harness, configuredPath),
		workspaceLocation: null,
		workspaceUri: null,
		workspacePath: null,
		workspaceMetaStatus: null,
		exists,
	};
}

/**
 * Builds the value produced by buildMachineRowRefs.
 * @param machine - Value consumed by buildMachineRowRefs.
 * @returns Result produced by buildMachineRowRefs.
 */
function buildMachineRowRefs(machine: CcMachine): CliRowRef[]
{
	const refs: Array<Omit<CliRowRef, "row">> = [];
	// Business logic: this iteration walks every relevant item so operator configuration flows reflects the complete source set instead of a partial snapshot.


	for (const [harness, harnessConfig] of Object.entries(machine.harnesses))
	{
		if (RESERVED_HARNESS_KEYS.has(harness))
		{
			continue;
		}
		const paths = readHarnessPaths(harnessConfig);
		// Business logic: this iteration walks every relevant item so operator configuration flows reflects the complete source set instead of a partial snapshot.

		for (let idx = 0; idx < paths.length; idx += 1)
		{
			refs.push({
				machine: machine.machine,
				harness,
				harnessPathIndex: idx,
				...computeRowFields(harness, paths[idx]),
			});
		}
	}

	refs.sort((a, b) =>
	{
		const orderDelta = getHarnessSortIndex(a.harness) - getHarnessSortIndex(b.harness);
		if (orderDelta !== 0) return orderDelta;
		if (a.harness !== b.harness) return a.harness.localeCompare(b.harness);
		return a.configuredPath.localeCompare(b.configuredPath);
	});

	return refs.map((ref, idx) => ({ ...ref, row: idx + 1 }));
}

/**
 * Handles flattenMachineRows behavior for this CXC module.
 * @param machine - Value consumed by flattenMachineRows.
 * @returns Result produced by flattenMachineRows.
 */
function flattenMachineRows(machine: CcMachine): CliListRow[]
{
	return buildMachineRowRefs(machine).map(({ harnessPathIndex: _discard, ...row }) => row);
}

/**
 * Resolves the value needed by resolveRowTarget.
 * @param machine - Value consumed by resolveRowTarget.
 * @param rowNumber - Value consumed by resolveRowTarget.
 * @returns Result produced by resolveRowTarget.
 */
function resolveRowTarget(machine: CcMachine, rowNumber: number): CliRowRef
{
	const rows = buildMachineRowRefs(machine);
	const target = rows.find((row) => row.row === rowNumber);
	if (!target)
	{
		throw new Error(`Row ${rowNumber} not found.`);
	}
	return target;
}

/**
 * Handles updateMachineConfig behavior for this CXC module.
 * @param config - Configuration object used by updateMachineConfig.
 * @param machineName - Value consumed by updateMachineConfig.
 * @param updateFn - Value consumed by updateMachineConfig.
 * @returns Result produced by updateMachineConfig.
 */
function updateMachineConfig(
	config: CcConfig,
	machineName: string,
	updateFn: (machine: CcMachine) => CcMachine
): CcConfig
{
	const machines = config.machines.map((machine) =>
		machine.machine === machineName ? updateFn(machine) : machine
	);
	return { ...config, machines };
}

/**
 * Handles applyEditPathByRow behavior for this CXC module.
 * @param machine - Value consumed by applyEditPathByRow.
 * @param rowNumber - Value consumed by applyEditPathByRow.
 * @param newPath - Path used by applyEditPathByRow to locate the relevant CXC resource.
 * @returns Result produced by applyEditPathByRow.
 */
function applyEditPathByRow(machine: CcMachine, rowNumber: number, newPath: string): CcMachine
{
	const target = resolveRowTarget(machine, rowNumber);
	const harnessConfig = machine.harnesses[target.harness];
	if (!isRecord(harnessConfig))
	{
		throw new Error(`Harness "${target.harness}" is not editable.`);
	}

	const currentPaths = readHarnessPaths(harnessConfig);
	// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.

	if (target.harnessPathIndex < 0 || target.harnessPathIndex >= currentPaths.length)
	{
		throw new Error("Resolved row path index is out of range.");
	}

	const nextPaths = [...currentPaths];
	nextPaths[target.harnessPathIndex] = newPath;

	return {
		...machine,
		harnesses: {
			...machine.harnesses,
			[target.harness]: {
				...harnessConfig,
				paths: nextPaths,
			},
		},
	};
}

/**
 * Handles applyDeletePathByRow behavior for this CXC module.
 * @param machine - Value consumed by applyDeletePathByRow.
 * @param rowNumber - Value consumed by applyDeletePathByRow.
 * @param options - Options that control applyDeletePathByRow.
 * @returns Result produced by applyDeletePathByRow.
 */
function applyDeletePathByRow(
	machine: CcMachine,
	rowNumber: number,
	options: { removeEmptyHarnessBlock: boolean }
): DeleteResult
{
	const target = resolveRowTarget(machine, rowNumber);
	const harnessConfig = machine.harnesses[target.harness];
	if (!isRecord(harnessConfig))
	{
		throw new Error(`Harness "${target.harness}" is not deletable.`);
	}

	const currentPaths = readHarnessPaths(harnessConfig);
	// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.

	if (target.harnessPathIndex < 0 || target.harnessPathIndex >= currentPaths.length)
	{
		throw new Error("Resolved row path index is out of range.");
	}

	const nextPaths = currentPaths.filter((_path, idx) => idx !== target.harnessPathIndex);
	const nextHarnesses = { ...machine.harnesses };

	let removedEmptyHarnessBlock = false;
	// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.

	if (nextPaths.length === 0 && options.removeEmptyHarnessBlock)
	{
		delete nextHarnesses[target.harness];
		removedEmptyHarnessBlock = true;
	}
	else
	{
		nextHarnesses[target.harness] = {
			...harnessConfig,
			paths: nextPaths,
		};
	}

	return {
		machine: {
			...machine,
			harnesses: nextHarnesses,
		},
		target,
		removedEmptyHarnessBlock,
	};
}

/**
 * Creates the value or resource produced by createBackupIfNeeded.
 * @param ccJsonPath - Path used by createBackupIfNeeded to locate the relevant CXC resource.
 * @param backupEnabled - Value consumed by createBackupIfNeeded.
 */
function createBackupIfNeeded(ccJsonPath: string, backupEnabled: boolean): void
{
	// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.

	if (!backupEnabled || !existsSync(ccJsonPath))
	{
		return;
	}
	copyFileSync(ccJsonPath, `${ccJsonPath}.bak`);
}

/**
 * Writes data for writeCcConfig using the existing CXC storage contract.
 * @param ccJsonPath - Path used by writeCcConfig to locate the relevant CXC resource.
 * @param config - Configuration object used by writeCcConfig.
 * @param options - Options that control writeCcConfig.
 */
function writeCcConfig(ccJsonPath: string, config: CcConfig, options?: WriteOptions): void
{
	const output = `${JSON.stringify(config, null, "\t")}\n`;
	const dir = dirname(ccJsonPath);
	const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	const tempPath = join(dir, `.cc.json.write-${token}.tmp`);
	const swapPath = join(dir, `.cc.json.swap-${token}.tmp`);

	writeFileSync(tempPath, output, "utf-8");
	createBackupIfNeeded(ccJsonPath, options?.backup === true);

	try
	{
		try
		{
			renameSync(tempPath, ccJsonPath);
			return;
		}
		catch
		{
			if (!existsSync(ccJsonPath))
			{
				throw new Error("Atomic write failed and target file is missing.");
			}
		}

		renameSync(ccJsonPath, swapPath);
		try
		{
			renameSync(tempPath, ccJsonPath);
			if (existsSync(swapPath))
			{
				unlinkSync(swapPath);
			}
		}
		catch (err: unknown)
		{
			if (existsSync(swapPath))
			{
				renameSync(swapPath, ccJsonPath);
			}
			throw err;
		}
	}
	finally
	{
		if (existsSync(tempPath))
		{
			unlinkSync(tempPath);
		}
	}
}

/**
 * Handles clampWidth behavior for this CXC module.
 * @param value - Value consumed by clampWidth.
 * @param min - Value consumed by clampWidth.
 * @param max - Value consumed by clampWidth.
 * @returns Result produced by clampWidth.
 */
function clampWidth(value: number, min: number, max: number): number
{
	return Math.max(min, Math.min(max, value));
}

/**
 * Handles truncate behavior for this CXC module.
 * @param value - Value consumed by truncate.
 * @param width - Value consumed by truncate.
 * @returns Result produced by truncate.
 */
function truncate(value: string, width: number): string
{
	if (value.length <= width) return value.padEnd(width, " ");
	if (width <= 3) return value.slice(0, width);
	return `${value.slice(0, width - 3)}...`;
}

/**
 * Handles renderListRows behavior for this CXC module.
 * @param rows - Value consumed by renderListRows.
 * @param options - Options that control renderListRows.
 */
function renderListRows(rows: CliListRow[], options?: ListRenderOptions): void
{
	if (rows.length === 0)
	{
		console.log(chalk.yellow("No harness paths configured for the selected machine."));
		return;
	}

	const rowWidth = Math.max(1, String(rows.length).length);
	const harnessWidth = clampWidth(
		Math.max("Harness".length, ...rows.map((row) => row.harness.length)),
		7,
		12
	);
	const configuredPathWidth = clampWidth(
		Math.max("Configured Path".length, ...rows.map((row) => row.configuredPath.length)),
		15,
		70
	);
	const computedProjectWidth = clampWidth(
		Math.max("Computed Project".length, ...rows.map((row) => row.computedProject.length)),
		16,
		32
	);
	const workspaceLocationWidth = clampWidth(
		Math.max(
			"Workspace Location".length,
			...rows.map((row) => (row.workspaceLocation ?? "-").length)
		),
		18,
		70
	);

	const header =
		`${"#".padStart(rowWidth, " ")}  ` +
		`${"Harness".padEnd(harnessWidth, " ")}  ` +
		`${"Configured Path".padEnd(configuredPathWidth, " ")}  ` +
		`${"Computed Project".padEnd(computedProjectWidth, " ")}  ` +
		`${"Workspace Location".padEnd(workspaceLocationWidth, " ")}  ` +
		"Exists";
	console.log(chalk.bold(header));
	console.log(chalk.dim("-".repeat(header.length)));
	// Business logic: this iteration walks every relevant item so operator configuration flows reflects the complete source set instead of a partial snapshot.


	for (const row of rows)
	{
		const harnessCell = getHarnessColor(row.harness)(truncate(row.harness, harnessWidth).padEnd(harnessWidth, " "));
		const existsCell = row.exists ? chalk.green("yes") : chalk.red("no");
		const workspaceCellRaw = row.workspaceLocation ?? "-";
		const workspaceCell = row.workspaceLocation
			? truncate(workspaceCellRaw, workspaceLocationWidth)
			: chalk.dim(truncate(workspaceCellRaw, workspaceLocationWidth));

		const line =
			`${String(row.row).padStart(rowWidth, " ")}  ` +
			`${harnessCell}  ` +
			`${truncate(row.configuredPath, configuredPathWidth)}  ` +
			`${truncate(row.computedProject, computedProjectWidth)}  ` +
			`${workspaceCell}  ` +
			`${existsCell}`;

		if (options?.selectedRow === row.row)
		{
			console.log(chalk.bgBlue.white(line));
		}
		else
		{
			console.log(line);
		}
	}
}

/**
 * Handles canonicalizePath behavior for this CXC module.
 * @param path - Path used by canonicalizePath to locate the relevant CXC resource.
 * @returns Result produced by canonicalizePath.
 */
function canonicalizePath(path: string): string
{
	return path.trim().replace(/[\\/]+$/, "").toLowerCase();
}

/**
 * Builds the value produced by buildCandidateRows.
 * @param candidates - Value consumed by buildCandidateRows.
 * @param scanners - Value consumed by buildCandidateRows.
 * @returns Result produced by buildCandidateRows.
 */
function buildCandidateRows(
	candidates: HarnessScannerCandidate[],
	scanners: HarnessScanner[] = DEFAULT_HARNESS_SCANNERS
): CliCandidateRow[]
{
	const scannerOrder = new Map<string, number>();
	scanners.forEach((scanner, idx) => scannerOrder.set(scanner.harness, idx));

	const sorted = [...candidates].sort((a, b) =>
	{
		const aOrder = scannerOrder.get(a.harness) ?? Number.MAX_SAFE_INTEGER;
		const bOrder = scannerOrder.get(b.harness) ?? Number.MAX_SAFE_INTEGER;
		if (aOrder !== bOrder) return aOrder - bOrder;
		if (a.harness !== b.harness) return a.harness.localeCompare(b.harness);
		return a.path.localeCompare(b.path);
	});

	return sorted.map((candidate, idx) =>
	{
		const derived = computeRowFields(candidate.harness, candidate.path);
		return {
			row: idx + 1,
			harness: candidate.harness,
			candidatePath: candidate.path,
			...derived,
			evidence: candidate.evidence,
		};
	});
}

/**
 * Handles collectConfiguredPathKeys behavior for this CXC module.
 * @param machine - Value consumed by collectConfiguredPathKeys.
 * @returns Result produced by collectConfiguredPathKeys.
 */
function collectConfiguredPathKeys(machine: CcMachine): Set<string>
{
	const configured = new Set<string>();
	// Business logic: this iteration walks every relevant item so operator configuration flows reflects the complete source set instead of a partial snapshot.

	for (const [harness, harnessConfig] of Object.entries(machine.harnesses))
	{
		if (RESERVED_HARNESS_KEYS.has(harness))
		{
			continue;
		}
		const paths = readHarnessPaths(harnessConfig);
		// Business logic: this iteration walks every relevant item so operator configuration flows reflects the complete source set instead of a partial snapshot.

		for (const path of paths)
		{
			configured.add(`${harness}::${canonicalizePath(path)}`);
		}
	}
	return configured;
}

/**
 * Builds the value produced by buildAddCandidateRows.
 * @param machine - Value consumed by buildAddCandidateRows.
 * @param candidates - Value consumed by buildAddCandidateRows.
 * @param scanners - Value consumed by buildAddCandidateRows.
 * @returns Result produced by buildAddCandidateRows.
 */
function buildAddCandidateRows(
	machine: CcMachine,
	candidates: HarnessScannerCandidate[],
	scanners: HarnessScanner[] = DEFAULT_HARNESS_SCANNERS
): AddCandidateRowsResult
{
	const rawRows = buildCandidateRows(candidates, scanners);
	const existingKeys = collectConfiguredPathKeys(machine);
	const uniqueCandidates = new Map<string, CliCandidateRow>();

	let skippedScannerDuplicates = 0;
	// Business logic: this iteration walks every relevant item so operator configuration flows reflects the complete source set instead of a partial snapshot.

	for (const row of rawRows)
	{
		const key = `${row.harness}::${canonicalizePath(row.candidatePath)}`;
		if (uniqueCandidates.has(key))
		{
			skippedScannerDuplicates += 1;
			continue;
		}
		uniqueCandidates.set(key, row);
	}

	let skippedAlreadyConfigured = 0;
	const filteredRows: CliCandidateRow[] = [];
	// Business logic: this iteration walks every relevant item so operator configuration flows reflects the complete source set instead of a partial snapshot.

	for (const [key, row] of uniqueCandidates.entries())
	{
		if (existingKeys.has(key))
		{
			skippedAlreadyConfigured += 1;
			continue;
		}
		filteredRows.push(row);
	}

	return {
		rows: filteredRows.map((row, idx) => ({
			...row,
			row: idx + 1,
		})),
		skippedScannerDuplicates,
		skippedAlreadyConfigured,
	};
}

/**
 * Handles renderCandidateRows behavior for this CXC module.
 * @param rows - Value consumed by renderCandidateRows.
 * @param options - Options that control renderCandidateRows.
 */
function renderCandidateRows(rows: CliCandidateRow[], options?: CandidateRenderOptions): void
{
	if (rows.length === 0)
	{
		console.log(chalk.yellow("No candidates discovered."));
		return;
	}

	const rowWidth = Math.max(1, String(rows.length).length);
	const harnessWidth = clampWidth(
		Math.max("Harness".length, ...rows.map((row) => row.harness.length)),
		7,
		12
	);
	const configuredPathWidth = clampWidth(
		Math.max("Configured Path".length, ...rows.map((row) => row.configuredPath.length)),
		15,
		70
	);
	const computedProjectWidth = clampWidth(
		Math.max("Computed Project".length, ...rows.map((row) => row.computedProject.length)),
		16,
		32
	);
	const workspaceLocationWidth = clampWidth(
		Math.max(
			"Workspace Location".length,
			...rows.map((row) => (row.workspaceLocation ?? "-").length)
		),
		18,
		70
	);
	const selectionWidth = 3;
	const showSelectionColumn = options?.showSelectionColumn === true;
	const selectedRows = options?.selectedRows;

	const header =
		`${showSelectionColumn ? `${"Sel".padEnd(selectionWidth, " ")}  ` : ""}` +
		`${"#".padStart(rowWidth, " ")}  ` +
		`${"Harness".padEnd(harnessWidth, " ")}  ` +
		`${"Configured Path".padEnd(configuredPathWidth, " ")}  ` +
		`${"Computed Project".padEnd(computedProjectWidth, " ")}  ` +
		`${"Workspace Location".padEnd(workspaceLocationWidth, " ")}  ` +
		"Exists";
	console.log(chalk.bold(header));
	console.log(chalk.dim("-".repeat(header.length)));
	// Business logic: this iteration walks every relevant item so operator configuration flows reflects the complete source set instead of a partial snapshot.


	for (const row of rows)
	{
		const harnessCell = getHarnessColor(row.harness)(truncate(row.harness, harnessWidth).padEnd(harnessWidth, " "));
		const existsCell = row.exists ? chalk.green("yes") : chalk.red("no");
		const workspaceCellRaw = row.workspaceLocation ?? "-";
		const workspaceCell = row.workspaceLocation
			? truncate(workspaceCellRaw, workspaceLocationWidth)
			: chalk.dim(truncate(workspaceCellRaw, workspaceLocationWidth));
		const selectCell = showSelectionColumn
			? `${selectedRows?.has(row.row) ? "[x]" : "[ ]"}  `
			: "";

		const line =
			`${selectCell}` +
			`${String(row.row).padStart(rowWidth, " ")}  ` +
			`${harnessCell}  ` +
			`${truncate(row.configuredPath, configuredPathWidth)}  ` +
			`${truncate(row.computedProject, computedProjectWidth)}  ` +
			`${workspaceCell}  ` +
			`${existsCell}`;

		if (options?.selectedRow === row.row)
		{
			console.log(chalk.bgBlue.white(line));
		}
		else
		{
			console.log(line);
		}
	}
}

/**
 * Parses input into the shape expected by parseSelectionSpec.
 * @param spec - Value consumed by parseSelectionSpec.
 * @param maxRow - Value consumed by parseSelectionSpec.
 * @returns Result produced by parseSelectionSpec.
 */
function parseSelectionSpec(spec: string, maxRow: number): number[]
{
	const chosen = new Set<number>();
	const tokens = spec.split(",").map((token) => token.trim()).filter(Boolean);

	if (tokens.length === 0)
	{
		throw new Error("Selection is empty.");
	}	// Business logic: this iteration walks every relevant item so operator configuration flows reflects the complete source set instead of a partial snapshot.


	for (const token of tokens)
	{
		const rangeMatch = token.match(/^(\d+)\s*-\s*(\d+)$/);
		if (rangeMatch)
		{
			const start = Number.parseInt(rangeMatch[1], 10);
			const end = Number.parseInt(rangeMatch[2], 10);
			// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.

			if (!Number.isInteger(start) || !Number.isInteger(end))
			{
				throw new Error(`Invalid range token "${token}".`);
			}
			const low = Math.min(start, end);
			const high = Math.max(start, end);
			// Business logic: this iteration walks every relevant item so operator configuration flows reflects the complete source set instead of a partial snapshot.

			for (let value = low; value <= high; value += 1)
			{
				// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.

				if (value < 1 || value > maxRow)
				{
					throw new Error(`Selection row ${value} is out of range (1-${maxRow}).`);
				}
				chosen.add(value);
			}
			continue;
		}

		const value = Number.parseInt(token, 10);
		if (!Number.isInteger(value))
		{
			throw new Error(`Invalid selection token "${token}".`);
		}		// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.

		if (value < 1 || value > maxRow)
		{
			throw new Error(`Selection row ${value} is out of range (1-${maxRow}).`);
		}
		chosen.add(value);
	}

	return [...chosen].sort((a, b) => a - b);
}

/**
 * Handles promptCandidateSelection behavior for this CXC module.
 * @param rows - Value consumed by promptCandidateSelection.
 * @returns Result produced by promptCandidateSelection.
 */
async function promptCandidateSelection(rows: CliCandidateRow[]): Promise<number[] | null>
{
	if (!process.stdin.isTTY)
	{
		return null;
	}

	if (rows.length === 0)
	{
		return [];
	}

	const stdout = process.stdout;
	const stdin = process.stdin;
	const ttyStdin = stdin as NodeJS.ReadStream & {
		setRawMode?: (mode: boolean) => void;
		isRaw?: boolean;
	};
	const previousRawMode = ttyStdin.isRaw === true;
	const canSetRawMode = typeof ttyStdin.setRawMode === "function";
	let selectedIndex = 0;
	const selectedRows = new Set<number>();
	let warning: string | null = null;

	/**
	 * Handles renderSelectionFrame behavior for this CXC module.
	 */
	const renderSelectionFrame = (): void =>
	{
		stdout.write("\x1b[2J\x1b[H");
		console.log(chalk.bold("Select candidate rows to add"));
		console.log(chalk.dim("Up/Down: move  Space: toggle  A: all/none  Enter: confirm  Esc/Q: cancel"));
		console.log(chalk.dim(`Selected: ${selectedRows.size}/${rows.length}`));
		if (warning)
		{
			console.log(chalk.yellow(warning));
		}
		else
		{
			console.log();
		}
		renderCandidateRows(rows, {
			showSelectionColumn: true,
			selectedRows,
			selectedRow: rows[selectedIndex].row,
		});
	};

	return await new Promise<number[] | null>((resolve) =>
	{
		let settled = false;

		/**
		 * Handles finish behavior for this CXC module.
		 * @param value - Value consumed by finish.
		 */
		const finish = (value: number[] | null): void =>
		{
			if (settled)
			{
				return;
			}
			settled = true;
			stdin.off("keypress", onKeypress);
			if (canSetRawMode)
			{
				ttyStdin.setRawMode?.(previousRawMode);
			}
			stdout.write("\n");
			if (value === null)
			{
				cancel("Add cancelled.");
			}
			resolve(value);
		};

		/**
		 * Handles onKeypress behavior for this CXC module.
		 * @param input - Value consumed by onKeypress.
		 * @param key - Value consumed by onKeypress.
		 */
		const onKeypress = (input: string, key: KeypressLike): void =>
		{
			// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.

			if (key?.ctrl && key.name === "c")
			{
				finish(null);
				return;
			}

			if (key?.name === "up")
			{
				selectedIndex = (selectedIndex - 1 + rows.length) % rows.length;
				warning = null;
				renderSelectionFrame();
				return;
			}

			if (key?.name === "down")
			{
				selectedIndex = (selectedIndex + 1) % rows.length;
				warning = null;
				renderSelectionFrame();
				return;
			}

			if (key?.name === "space")
			{
				const row = rows[selectedIndex].row;
				if (selectedRows.has(row))
				{
					selectedRows.delete(row);
				}
				else
				{
					selectedRows.add(row);
				}
				warning = null;
				renderSelectionFrame();
				return;
			}

			const token = input.trim().toLowerCase();
			if (token === "a")
			{
				if (selectedRows.size === rows.length)
				{
					selectedRows.clear();
				}
				else
				{
					// Business logic: this iteration walks every relevant item so operator configuration flows reflects the complete source set instead of a partial snapshot.

					for (const row of rows)
					{
						selectedRows.add(row.row);
					}
				}
				warning = null;
				renderSelectionFrame();
				return;
			}			// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.


			if (key?.name === "return" || key?.name === "enter")
			{
				if (selectedRows.size === 0)
				{
					warning = "Pick at least one row first.";
					renderSelectionFrame();
					return;
				}

				finish([...selectedRows].sort((a, b) => a - b));
				return;
			}			// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.


			if (key?.name === "escape" || token === "q" || token === "x")
			{
				finish(null);
				return;
			}
		};

		renderSelectionFrame();
		emitKeypressEvents(stdin);
		stdin.on("keypress", onKeypress);
		stdin.resume();
		if (canSetRawMode)
		{
			ttyStdin.setRawMode?.(true);
		}
	});
}

/**
 * Handles applyAddCandidates behavior for this CXC module.
 * @param machine - Value consumed by applyAddCandidates.
 * @param candidates - Value consumed by applyAddCandidates.
 * @returns Result produced by applyAddCandidates.
 */
function applyAddCandidates(machine: CcMachine, candidates: CliCandidateRow[]): {
	machine: CcMachine;
	added: number;
	skippedDuplicates: number;
}
{
	const nextHarnesses = { ...machine.harnesses };
	let added = 0;
	let skippedDuplicates = 0;
	// Business logic: this iteration walks every relevant item so operator configuration flows reflects the complete source set instead of a partial snapshot.


	for (const candidate of candidates)
	{
		const currentHarnessConfig = nextHarnesses[candidate.harness];
		const harnessConfig = isRecord(currentHarnessConfig) ? currentHarnessConfig : {};
		const existingPaths = readHarnessPaths(harnessConfig);
		const existingCanonical = new Set(existingPaths.map(canonicalizePath));
		const candidateCanonical = canonicalizePath(candidate.candidatePath);

		if (existingCanonical.has(candidateCanonical))
		{
			skippedDuplicates += 1;
			continue;
		}

		const nextPaths = [...existingPaths, candidate.candidatePath];
		nextHarnesses[candidate.harness] = {
			...harnessConfig,
			paths: nextPaths,
		};
		added += 1;
	}

	return {
		machine: {
			...machine,
			harnesses: nextHarnesses,
		},
		added,
		skippedDuplicates,
	};
}

/**
 * Handles printValidation behavior for this CXC module.
 * @param message - Message data processed by printValidation.
 * @returns Result produced by printValidation.
 */
function printValidation(message: string): number
{
	console.error(chalk.red(`Validation error: ${message}`));
	console.error(chalk.dim("Use `bun run cxccli --help` for usage."));
	return EXIT_VALIDATION;
}

/**
 * Reads global and subcommand options into a normalized flags object.
 * @param command - Commander command instance handling the current invocation.
 * @returns Normalized CLI flags used by command handlers.
 */
function flagsFromCommand(command: Command): CliFlags
{
	const withGlobals = (command as Command & { optsWithGlobals?: () => unknown }).optsWithGlobals?.();
	const raw = isRecord(withGlobals) ? withGlobals : command.opts();
	return {
		// Business logic: blank machine values must fall back to hostname selection so
		// ingest status/reset commands do not accidentally target a made-up machine key.
		machine: typeof raw.machine === "string" && raw.machine.trim() !== "" ? raw.machine : undefined,
		json: raw.json === true,
		yes: raw.yes === true,
		backup: raw.backup === true || process.env.CXCCLI_BACKUP === "1",
		allMachines: raw.allMachines === true,
		global: raw.global === true,
	};
}

/**
 * Handles promptTextValue behavior for this CXC module.
 * @param message - Message data processed by promptTextValue.
 * @param initialValue - Value consumed by promptTextValue.
 * @returns Result produced by promptTextValue.
 */
async function promptTextValue(message: string, initialValue: string): Promise<string | null>
{
	if (!process.stdin.isTTY)
	{
		return null;
	}

	const value = await text({
		message,
		initialValue,
		defaultValue: initialValue,
		/**
		 * Handles validate behavior for this CXC module.
		 * @param input - Value consumed by validate.
		 * @returns Result produced by validate.
		 */

		validate: (input) =>
		{
			// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.

			if (!input || !input.trim())
			{
				return "Path cannot be empty.";
			}
			return undefined;
		},
	});
	if (isCancel(value))
	{
		cancel("Edit cancelled.");
		return null;
	}
	return String(value).trim();
}

/**
 * Handles promptConfirm behavior for this CXC module.
 * @param message - Message data processed by promptConfirm.
 * @param initialValue - Value consumed by promptConfirm.
 * @returns Result produced by promptConfirm.
 */
async function promptConfirm(message: string, initialValue = false): Promise<boolean | null>
{
	if (!process.stdin.isTTY)
	{
		return null;
	}

	const accepted = await confirm({
		message,
		initialValue,
	});
	if (isCancel(accepted))
	{
		cancel("Operation cancelled.");
		return null;
	}
	return accepted;
}

/**
 * Resolves the value needed by resolveInteractiveActionToken.
 * @param input - Value consumed by resolveInteractiveActionToken.
 * @returns Result produced by resolveInteractiveActionToken.
 */
function resolveInteractiveActionToken(input: string): InteractiveAction | "menu" | null
{
	const token = input.trim().toLowerCase();
	if (!token)
	{
		return "menu";
	}

	const first = token[0];
	if (first === "l") return "list";
	if (first === "a") return "add";
	if (first === "e") return "edit";
	// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.

	if (first === "d" || first === "r") return "delete";
	// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.

	if (first === "q" || first === "x") return "quit";
	if (first === "m") return "menu";
	return null;
}

type KeypressLike = {
	name?: string;
	ctrl?: boolean;
};

/**
 * Reads data for readImmediateInteractiveAction without changing unrelated CXC state.
 * @returns Result produced by readImmediateInteractiveAction.
 */
async function readImmediateInteractiveAction(): Promise<InteractiveAction | "menu" | "quit">
{
	if (!process.stdin.isTTY)
	{
		return "menu";
	}

	return new Promise((resolve) =>
	{
		const stdin = process.stdin;
		const ttyStdin = stdin as NodeJS.ReadStream & {
			setRawMode?: (mode: boolean) => void;
			isRaw?: boolean;
		};
		const previousRawMode = ttyStdin.isRaw === true;
		const canSetRawMode = typeof ttyStdin.setRawMode === "function";
		let settled = false;

		/**
		 * Handles finish behavior for this CXC module.
		 * @param result - Value consumed by finish.
		 */
		const finish = (result: InteractiveAction | "menu" | "quit"): void =>
		{
			if (settled)
			{
				return;
			}
			settled = true;
			stdin.off("keypress", onKeypress);
			if (canSetRawMode)
			{
				ttyStdin.setRawMode?.(previousRawMode);
			}
			resolve(result);
		};

		/**
		 * Handles onKeypress behavior for this CXC module.
		 * @param input - Value consumed by onKeypress.
		 * @param key - Value consumed by onKeypress.
		 */
		const onKeypress = (input: string, key: KeypressLike): void =>
		{
			// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.

			if (key?.ctrl && key.name === "c")
			{
				finish("quit");
				return;
			}			// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.

			if (
				key?.name === "return" ||
				key?.name === "enter" ||
				key?.name === "up" ||
				key?.name === "down"
			)
			{
				finish("menu");
				return;
			}

			const mapped = resolveInteractiveActionToken(input);
			if (!mapped)
			{
				return;
			}
			if (mapped === "menu")
			{
				finish("menu");
				return;
			}
			finish(mapped);
		};

		emitKeypressEvents(stdin);
		stdin.on("keypress", onKeypress);
		stdin.resume();
		if (canSetRawMode)
		{
			ttyStdin.setRawMode?.(true);
		}
	});
}

/**
 * Handles promptInteractiveAction behavior for this CXC module.
 * @returns Result produced by promptInteractiveAction.
 */
async function promptInteractiveAction(): Promise<InteractiveAction | null>
{
	if (!process.stdin.isTTY)
	{
		return null;
	}

	console.log(chalk.dim("Hotkeys: L list, A add, E edit, R remove, Q quit. Enter/arrow opens menu."));
	const immediate = await readImmediateInteractiveAction();
	if (immediate === "quit")
	{
		return "quit";
	}
	if (immediate !== "menu")
	{
		return immediate;
	}

	const action = await select<InteractiveAction>({
		message: "Action menu (use up/down arrows + Enter). Hotkeys: L/A/E/R/Q",
		options: [
			{ value: "list", label: "[L] List paths", hint: "Show configured rows" },
			{ value: "add", label: "[A] Add paths", hint: "Scan and add candidates" },
			{ value: "edit", label: "[E] Edit path", hint: "Edit one row by number" },
			{ value: "delete", label: "[R] Remove path", hint: "Delete one row by number" },
			{ value: "quit", label: "[Q] Quit", hint: "Exit interactive mode" },
		],
	});
	if (isCancel(action))
	{
		cancel("Interactive mode cancelled.");
		return "quit";
	}
	return action;
}

/**
 * Handles promptRowForAction behavior for this CXC module.
 * @param action - Value consumed by promptRowForAction.
 * @returns Result produced by promptRowForAction.
 */
async function promptRowForAction(action: "edit" | "delete"): Promise<string | null>
{
	if (!process.stdin.isTTY)
	{
		return null;
	}

	const rowValue = await text({
		message: `Row number to ${action}`,
		placeholder: "e.g. 12",
		/**
		 * Handles validate behavior for this CXC module.
		 * @param value - Value consumed by validate.
		 * @returns Result produced by validate.
		 */

		validate: (value) =>
		{
			// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.

			if (!value || !value.trim())
			{
				return "Row number is required.";
			}
			try
			{
				parseRowNumber(value.trim());
				return undefined;
			}
			catch (err: unknown)
			{
				return err instanceof Error ? err.message : String(err);
			}
		},
	});
	if (isCancel(rowValue))
	{
		cancel(`${action} cancelled.`);
		return null;
	}
	return String(rowValue).trim();
}

/**
 * Handles promptRowSelectForDelete behavior for this CXC module.
 * @param flags - Value consumed by promptRowSelectForDelete.
 * @returns Result produced by promptRowSelectForDelete.
 */
async function promptRowSelectForDelete(flags: CliFlags): Promise<string | null>
{
	if (!process.stdin.isTTY)
	{
		return null;
	}

	try
	{
		const ccJsonPath = join(process.cwd(), "cc.json");
		const config = loadCcConfig(ccJsonPath);
		const machine = await selectMachine(config, flags.machine);
		const rows = flattenMachineRows(machine);

		if (rows.length === 0)
		{
			console.log(chalk.yellow("No rows available to remove."));
			return null;
		}

		const stdout = process.stdout;
		const stdin = process.stdin;
		const ttyStdin = stdin as NodeJS.ReadStream & {
			setRawMode?: (mode: boolean) => void;
			isRaw?: boolean;
		};
		const previousRawMode = ttyStdin.isRaw === true;
		const canSetRawMode = typeof ttyStdin.setRawMode === "function";
		let selectedIndex = 0;

		/**
		 * Handles renderSelectionFrame behavior for this CXC module.
		 */
		const renderSelectionFrame = (): void =>
		{
			stdout.write("\x1b[2J\x1b[H");
			console.log(chalk.bold(`Machine: ${machine.machine}`));
			console.log(chalk.dim("Remove mode: up/down arrows to move, Enter to remove, Esc/Q to cancel."));
			console.log();
			renderListRows(rows, { selectedRow: rows[selectedIndex].row });
		};

		return await new Promise<string | null>((resolve) =>
		{
			let settled = false;

			/**
			 * Handles finish behavior for this CXC module.
			 * @param value - Value consumed by finish.
			 */
			const finish = (value: string | null): void =>
			{
				if (settled)
				{
					return;
				}
				settled = true;
				stdin.off("keypress", onKeypress);
				if (canSetRawMode)
				{
					ttyStdin.setRawMode?.(previousRawMode);
				}
				stdout.write("\n");
				if (value === null)
				{
					cancel("Remove cancelled.");
				}
				resolve(value);
			};

			/**
			 * Handles onKeypress behavior for this CXC module.
			 * @param input - Value consumed by onKeypress.
			 * @param key - Value consumed by onKeypress.
			 */
			const onKeypress = (input: string, key: KeypressLike): void =>
			{
				// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.

				if (key?.ctrl && key.name === "c")
				{
					finish(null);
					return;
				}

				if (key?.name === "up")
				{
					selectedIndex = (selectedIndex - 1 + rows.length) % rows.length;
					renderSelectionFrame();
					return;
				}

				if (key?.name === "down")
				{
					selectedIndex = (selectedIndex + 1) % rows.length;
					renderSelectionFrame();
					return;
				}				// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.


				if (key?.name === "return" || key?.name === "enter")
				{
					finish(String(rows[selectedIndex].row));
					return;
				}

				const token = input.trim().toLowerCase();
				// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.

				if (key?.name === "escape" || token === "q" || token === "x")
				{
					finish(null);
				}
			};

			renderSelectionFrame();
			emitKeypressEvents(stdin);
			stdin.on("keypress", onKeypress);
			stdin.resume();
			if (canSetRawMode)
			{
				ttyStdin.setRawMode?.(true);
			}
		});
	}
	catch (err: unknown)
	{
		console.error(chalk.red(err instanceof Error ? err.message : String(err)));
		return null;
	}
}

/**
 * Handles runInteractiveMode behavior for this CXC module.
 * @param flags - Value consumed by runInteractiveMode.
 * @returns Result produced by runInteractiveMode.
 */
async function runInteractiveMode(flags: CliFlags): Promise<number>
{
	// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.

	if (!process.stdin.isTTY || !process.stdout.isTTY)
	{
		// Non-interactive environments should not hang waiting for prompts.
		return runList(flags);
	}

	if (flags.json)
	{
		return printValidation("--json is only supported with `list`.");
	}

	intro("cxccli interactive mode");
	console.log(chalk.dim("Use arrow menu or hotkeys L/A/E/R/Q."));

	let machineNameForSession: string | undefined;
	try
	{
		const ccJsonPath = join(process.cwd(), "cc.json");
		const config = loadCcConfig(ccJsonPath);
		const selectedMachine = await selectMachine(config, flags.machine, {
			forcePrompt: !flags.machine,
			promptMessage: "Select machine for interactive session:",
		});
		machineNameForSession = selectedMachine.machine;
	}
	catch (err: unknown)
	{
		return printValidation(err instanceof Error ? err.message : String(err));
	}

	const shellFlags: CliFlags = {
		...flags,
		machine: machineNameForSession,
		json: false,
	};

	// Show current state immediately so interactive mode is useful at first prompt.
	await runList(shellFlags);
	// Business logic: this iteration walks every relevant item so operator configuration flows reflects the complete source set instead of a partial snapshot.


	while (true)
	{
		const action = await promptInteractiveAction();
		// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.

		if (!action || action === "quit")
		{
			outro("Bye.");
			return EXIT_SUCCESS;
		}

		if (action === "list")
		{
			await runList(shellFlags);
			continue;
		}

		if (action === "add")
		{
			const code = await runAdd(shellFlags, undefined, { renderUpdatedList: false });
			if (code === EXIT_SUCCESS)
			{
				console.log();
				await runList(shellFlags);
			}
			continue;
		}

		if (action === "edit")
		{
			const row = await promptRowForAction("edit");
			if (!row) continue;
			const code = await runEdit(row, shellFlags);
			if (code === EXIT_SUCCESS)
			{
				console.log();
				await runList(shellFlags);
			}
			continue;
		}

		if (action === "delete")
		{
			const row = await promptRowSelectForDelete(shellFlags);
			if (!row) continue;
			const code = await runDelete(row, shellFlags);
			if (code === EXIT_SUCCESS)
			{
				console.log();
				await runList(shellFlags);
			}
			continue;
		}
	}
}

/**
 * Handles runDefaultCommand behavior for this CXC module.
 * @param flags - Value consumed by runDefaultCommand.
 * @returns Result produced by runDefaultCommand.
 */
async function runDefaultCommand(flags: CliFlags): Promise<number>
{
	// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.

	if (process.stdin.isTTY && process.stdout.isTTY && !flags.json)
	{
		return runInteractiveMode(flags);
	}
	return runList(flags);
}

/**
 * Handles runList behavior for this CXC module.
 * @param flags - Value consumed by runList.
 * @returns Result produced by runList.
 */
async function runList(flags: CliFlags): Promise<number>
{
	if (flags.yes)
	{
		console.warn(chalk.yellow("Warning: `--yes` has no effect for `list`."));
	}

	const ccJsonPath = join(process.cwd(), "cc.json");
	const config = loadCcConfig(ccJsonPath);
	const machine = await selectMachine(config, flags.machine);
	const rows = flattenMachineRows(machine);

	if (flags.json)
	{
		console.log(JSON.stringify(rows, null, "\t"));
		return EXIT_SUCCESS;
	}

	console.log(chalk.bold(`Machine: ${machine.machine}`));
	renderListRows(rows);
	return EXIT_SUCCESS;
}

/**
 * Prints machine-scoped ingest bookmark and local DB fingerprint status.
 * @param flags - CLI flags including selected machine, JSON mode, and all-machine view.
 * @returns Process exit code.
 */
async function runIngestStatus(flags: CliFlags): Promise<number>
{
	try
	{
		const ccJsonPath = join(process.cwd(), "cc.json");
		const config = loadCcConfig(ccJsonPath);
		const machine = await selectMachine(config, flags.machine);
		const store = new GlobalSettingsStore(config.storage, machine.machine);
		store.load();
		const rows = Object.entries(machine.harnesses)
			.filter(([harness]) => !RESERVED_HARNESS_KEYS.has(harness))
			.map(([harness, harnessConfig]) =>
			{
				const paths = readHarnessPaths(harnessConfig);
				const bookmark = store.getHarnessBookmark(harness);
				return {
					harness,
					paths,
					sourcePathHash: hashHarnessPaths({ paths }),
					bookmarkMode: bookmark?.mode ?? null,
					lastSuccessfulIngestAt: bookmark?.lastSuccessfulIngestAt ?? null,
					parserEpoch: bookmark?.parserEpoch ?? null,
					rowids: bookmark?.rowids ?? null,
					progress: bookmark?.progress ?? null,
					manifestPath: bookmark?.manifestPath ?? null,
				};
			});
		const payload = {
			machine: machine.machine,
			storage: config.storage,
			activeMachine: store.getActiveMachineName(),
			runInProgress: store.isRunInProgress(),
			dbFingerprint: store.getDbFingerprint(),
			harnesses: rows,
			machines: flags.allMachines ? store.getAllMachineStates() : undefined,
		};

		if (flags.json)
		{
			console.log(JSON.stringify(payload, null, "\t"));
			return EXIT_SUCCESS;
		}

		console.log(chalk.bold(`Ingest status: ${machine.machine}`));
		console.log(`Storage: ${config.storage}`);
		console.log(`Active machine state: ${store.getActiveMachineName()}`);
		console.log(`Run in progress: ${store.isRunInProgress() ? chalk.yellow("yes") : chalk.green("no")}`);
		const fingerprint = store.getDbFingerprint();
		console.log(`DB fingerprint: ${fingerprint ? `${fingerprint.messageCount} messages, ${fingerprint.sessionCount} sessions` : "missing"}`);
		// Business logic: this iteration walks every relevant item so operator configuration flows reflects the complete source set instead of a partial snapshot.

		for (const row of rows)
		{
			console.log(
				`${chalk.bold(row.harness)} mode=${row.bookmarkMode ?? "none"} ` +
				`last=${row.lastSuccessfulIngestAt ?? "never"} hash=${row.sourcePathHash} ` +
				`rowids=${row.rowids ? JSON.stringify(row.rowids) : "-"} ` +
				`progress=${row.progress ? JSON.stringify(row.progress) : "-"} manifest=${row.manifestPath ?? "-"}`
			);
		}
		if (flags.allMachines)
		{
			console.log(chalk.bold("All machine ingest states:"));
			// Business logic: this diagnostic intentionally reads all machine objects,
			// but it does not mutate them; active-machine status remains the default view.
			for (const [machineName, state] of Object.entries(store.getAllMachineStates()))
			{
				console.log(
					`${machineName}: run=${state.runInProgress ? "yes" : "no"} ` +
					`harnesses=${Object.keys(state.harnesses ?? {}).join(", ") || "-"}`
				);
			}
		}
		return EXIT_SUCCESS;
	}
	catch (err: unknown)
	{
		return printValidation(err instanceof Error ? err.message : String(err));
	}
}

/**
 * Resets active-machine ingest state, one harness bookmark, or all machine state when explicit.
 * @param flags - CLI flags including selected machine and explicit global reset.
 * @param harnessName - Optional harness bookmark to reset within the selected machine.
 * @returns Process exit code.
 */
async function runResetIngest(flags: CliFlags, harnessName?: string): Promise<number>
{
	try
	{
		const ccJsonPath = join(process.cwd(), "cc.json");
		const config = loadCcConfig(ccJsonPath);
		const machine = await selectMachine(config, flags.machine);
		const store = new GlobalSettingsStore(config.storage, machine.machine);
		store.load();

		if (flags.global)
		{
			if (!flags.yes)
			{
				const ok = await promptConfirm("Reset ingest bookmarks for ALL machines?", false);
				if (!ok)
				{
					return printValidation("Reset cancelled.");
				}
			}
			store.resetEveryMachineIngestBookmarks();
			console.log(chalk.green("Reset ingest bookmarks for all machines."));
			return EXIT_SUCCESS;
		}

		// Business logic: harness-scoped reset must stay inside the selected machine's
		// ingest object so one operator action cannot erase another machine's bookmark.
		if (harnessName && !RESERVED_HARNESS_KEYS.has(harnessName))
		{
			store.resetHarnessBookmark(harnessName);
			console.log(chalk.green(`Reset ingest bookmark for ${harnessName} on ${machine.machine}.`));
			return EXIT_SUCCESS;
		}

		if (!flags.yes)
		{
			const ok = await promptConfirm(`Reset all ingest bookmarks for ${machine.machine}?`, false);
			if (!ok)
			{
				return printValidation("Reset cancelled.");
			}
		}
		store.resetAllIngestBookmarks();
		console.log(chalk.green(`Reset all ingest bookmarks for ${machine.machine}.`));
		return EXIT_SUCCESS;
	}
	catch (err: unknown)
	{
		return printValidation(err instanceof Error ? err.message : String(err));
	}
}

/**
 * Handles runAdd behavior for this CXC module.
 * @param flags - Value consumed by runAdd.
 * @param selectionSpec - Value consumed by runAdd.
 * @param options - Options that control runAdd.
 * @returns Result produced by runAdd.
 */
async function runAdd(flags: CliFlags, selectionSpec?: string, options?: RunAddOptions): Promise<number>
{
	if (flags.json)
	{
		return printValidation("--json is only supported with `list`.");
	}

	try
	{
		const ccJsonPath = join(process.cwd(), "cc.json");
		const config = loadCcConfig(ccJsonPath);
		const machine = await selectMachine(config, flags.machine);

		const context = {
			platform: detectPlatform(),
			username: detectUsername(),
		};
		const candidates = scanHarnessCandidates(context, DEFAULT_HARNESS_SCANNERS);
		const candidateBuild = buildAddCandidateRows(machine, candidates, DEFAULT_HARNESS_SCANNERS);
		const candidateRows = candidateBuild.rows;

		if (candidateRows.length === 0)
		{
			console.log(chalk.yellow("No new paths to add for the selected machine."));
			// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.

			if (candidateBuild.skippedAlreadyConfigured > 0 || candidateBuild.skippedScannerDuplicates > 0)
			{
				console.log(
					chalk.dim(
						`Filtered out ${candidateBuild.skippedAlreadyConfigured} already-configured and ${candidateBuild.skippedScannerDuplicates} duplicate scanned path(s).`
					)
				);
			}
			return EXIT_SUCCESS;
		}

		console.log(chalk.bold(`Machine: ${machine.machine}`));
		renderCandidateRows(candidateRows);

		let selectedRowNumbers: number[] | null = null;
		// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.

		if (selectionSpec && selectionSpec.trim())
		{
			selectedRowNumbers = parseSelectionSpec(selectionSpec, candidateRows.length);
		}
		else
		{
			selectedRowNumbers = await promptCandidateSelection(candidateRows);
		}		// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.


		if (!selectedRowNumbers || selectedRowNumbers.length === 0)
		{
			// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.

			if (!process.stdin.isTTY && (!selectionSpec || !selectionSpec.trim()))
			{
				return printValidation("Non-interactive add requires --select <rows> (e.g. 1,3-5).");
			}
			return printValidation("No candidates selected.");
		}

		const selectedRows = candidateRows.filter((row) => selectedRowNumbers!.includes(row.row));

		const applied = applyAddCandidates(machine, selectedRows);
		if (applied.added === 0)
		{
			console.log(chalk.dim("No new paths to add."));
			if (applied.skippedDuplicates > 0)
			{
				console.log(chalk.dim(`Skipped ${applied.skippedDuplicates} duplicate path(s) during write.`));
			}
			return EXIT_SUCCESS;
		}

		if (!flags.yes)
		{
			const ok = await promptConfirm(
				`Add ${applied.added} path(s) to machine "${machine.machine}"?`,
				true
			);
			if (ok === null)
			{
				return printValidation("Add cancelled.");
			}
			if (!ok)
			{
				console.log(chalk.dim("Add aborted."));
				return EXIT_VALIDATION;
			}
		}
		else if (!process.stdin.isTTY)
		{
			// Non-interactive mode with --yes proceeds directly.
		}

		const nextConfig = updateMachineConfig(config, machine.machine, () => applied.machine);
		writeCcConfig(ccJsonPath, nextConfig, { backup: flags.backup });

		const duplicateSuffix = applied.skippedDuplicates > 0
			? chalk.dim(` (${applied.skippedDuplicates} duplicate path(s) skipped during write)`)
			: "";
		console.log(chalk.green(`Added ${applied.added} path(s).`) + duplicateSuffix);
		if (options?.renderUpdatedList !== false)
		{
			console.log();
			renderListRows(flattenMachineRows(applied.machine));
		}
		return EXIT_SUCCESS;
	}
	catch (err: unknown)
	{
		return printValidation(err instanceof Error ? err.message : String(err));
	}
}

/**
 * Handles runEdit behavior for this CXC module.
 * @param rowArg - Value consumed by runEdit.
 * @param flags - Value consumed by runEdit.
 * @param explicitPath - Path used by runEdit to locate the relevant CXC resource.
 * @returns Result produced by runEdit.
 */
async function runEdit(rowArg: string, flags: CliFlags, explicitPath?: string): Promise<number>
{
	if (flags.json)
	{
		return printValidation("--json is only supported with `list`.");
	}

	try
	{
		const row = parseRowNumber(rowArg);
		const ccJsonPath = join(process.cwd(), "cc.json");
		const config = loadCcConfig(ccJsonPath);
		const machine = await selectMachine(config, flags.machine);
		const target = resolveRowTarget(machine, row);

		const nextPath = explicitPath?.trim()
			? explicitPath.trim()
			: await promptTextValue(`New path for row ${row}`, target.configuredPath);
		if (!nextPath)
		{
			return printValidation("Edit requires an interactive terminal.");
		}
		if (nextPath === target.configuredPath)
		{
			console.log(chalk.dim("No changes to save."));
			return EXIT_SUCCESS;
		}
		if (!existsSync(nextPath))
		{
			console.warn(chalk.yellow(`Warning: path does not exist: ${nextPath}`));
		}

		const nextMachine = applyEditPathByRow(machine, row, nextPath);
		const nextConfig = updateMachineConfig(config, machine.machine, () => nextMachine);
		writeCcConfig(ccJsonPath, nextConfig, { backup: flags.backup });

		console.log(chalk.green(`Updated row ${row} (${target.harness}).`));
		return EXIT_SUCCESS;
	}
	catch (err: unknown)
	{
		return printValidation(err instanceof Error ? err.message : String(err));
	}
}

/**
 * Handles runDelete behavior for this CXC module.
 * @param rowArg - Value consumed by runDelete.
 * @param flags - Value consumed by runDelete.
 * @returns Result produced by runDelete.
 */
async function runDelete(rowArg: string, flags: CliFlags): Promise<number>
{
	if (flags.json)
	{
		return printValidation("--json is only supported with `list`.");
	}

	try
	{
		const row = parseRowNumber(rowArg);
		const ccJsonPath = join(process.cwd(), "cc.json");
		const config = loadCcConfig(ccJsonPath);
		const machine = await selectMachine(config, flags.machine);
		const target = resolveRowTarget(machine, row);

		if (!flags.yes)
		{
			const accepted = await promptConfirm(
				`Delete row ${row} (${target.harness})?\n${target.configuredPath}`,
				true
			);
			if (accepted === null)
			{
				return printValidation("Delete cancelled.");
			}
			if (!accepted)
			{
				console.log(chalk.dim("Delete aborted."));
				return EXIT_VALIDATION;
			}
		}

		const harnessConfig = machine.harnesses[target.harness];
		const currentPaths = readHarnessPaths(harnessConfig);
		const wouldBecomeEmpty = currentPaths.length === 1;

		let removeEmptyHarnessBlock = false;
		// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.

		if (wouldBecomeEmpty && !flags.yes)
		{
			const removeBlock = await promptConfirm(
				`"${target.harness}" will have no paths left. Remove the empty harness block?`,
				false
			);
			if (removeBlock === null)
			{
				return printValidation("Delete cancelled.");
			}
			removeEmptyHarnessBlock = removeBlock;
		}

		const result = applyDeletePathByRow(machine, row, { removeEmptyHarnessBlock });
		const nextConfig = updateMachineConfig(config, machine.machine, () => result.machine);
		writeCcConfig(ccJsonPath, nextConfig, { backup: flags.backup });

		const suffix = result.removedEmptyHarnessBlock ? " and removed empty harness block" : "";
		console.log(chalk.green(`Deleted row ${row} (${target.harness})${suffix}.`));
		return EXIT_SUCCESS;
	}
	catch (err: unknown)
	{
		return printValidation(err instanceof Error ? err.message : String(err));
	}
}

/**
 * Creates the value or resource produced by createProgram.
 * @param setRunner - Value consumed by createProgram.
 * @returns Result produced by createProgram.
 */
function createProgram(setRunner: (runner: Promise<number>) => void): Command
{
	const program = new Command();
	program
		.name("cxccli")
		.description("ContextCore cc.json harness path manager")
		.showHelpAfterError()
		.addHelpCommand(true)
		.option("--machine <name>", "Target machine entry from cc.json")
		.option("--json", "Output JSON (list only)")
		.option("--yes", "Skip confirmations for mutation commands")
		.option("--backup", "Write cc.json.bak before mutation write")
		.action(function (this: Command)
		{
			setRunner(runDefaultCommand(flagsFromCommand(this)));
		});

	program
		.command("list")
		.description("List configured harness paths")
		.action(function (this: Command)
		{
			setRunner(runList(flagsFromCommand(this)));
		});

	program
		.command("ingest-status")
		.description("Print ingest bookmark, rowid, manifest, and DB fingerprint status")
		.option("--all-machines", "Include every machine ingest object from synced settings")
		.action(function (this: Command)
		{
			setRunner(runIngestStatus(flagsFromCommand(this)));
		});

	program
		.command("reset-ingest")
		.description("Reset ingest bookmarks without deleting DB or storage")
		.option("--harness <name>", "Reset only one harness bookmark")
		.option("--global", "Reset ingest state for every machine")
		.action(function (this: Command)
		{
			const options = this.opts() as { harness?: string };
			setRunner(runResetIngest(flagsFromCommand(this), options.harness));
		});

	program
		.command("interactive")
		.alias("i")
		.description("Start persistent interactive mode")
		.action(function (this: Command)
		{
			setRunner(runInteractiveMode(flagsFromCommand(this)));
		});

	program
		.command("add")
		.description("Add harness paths to cc.json")
		.option("--select <rows>", "Row selection for non-interactive mode (e.g. 1,3-5)")
		.action(function (this: Command)
		{
			const options = this.opts() as { select?: string };
			setRunner(runAdd(flagsFromCommand(this), options.select));
		});

	program
		.command("edit <row>")
		.description("Edit one row by row number")
		.option("--path <newPath>", "New path value for non-interactive edit")
		.action(function (this: Command, row: string)
		{
			const options = this.opts() as { path?: string };
			setRunner(runEdit(row, flagsFromCommand(this), options.path));
		});

	program
		.command("delete <row>")
		.alias("remove")
		.description("Delete one row by row number")
		.action(function (this: Command, row: string)
		{
			setRunner(runDelete(row, flagsFromCommand(this)));
		});

	return program;
}

/**
 * Handles main behavior for this CXC module.
 * @param argv - Value consumed by main.
 * @returns Result produced by main.
 */
async function main(argv = process.argv): Promise<number>
{
	let runner: Promise<number> | null = null;

	/**
	 * Updates the value managed by setRunner.
	 * @param next - Value consumed by setRunner.
	 */
	const setRunner = (next: Promise<number>): void =>
	{
		runner = next;
	};

	const program = createProgram(setRunner);
	program.exitOverride();

	try
	{
		await program.parseAsync(argv);
	}
	catch (err: unknown)
	{
		if (err instanceof CommanderError)
		{
			return err.exitCode === 0 ? EXIT_SUCCESS : EXIT_VALIDATION;
		}
		throw err;
	}

	if (!runner)
	{
		runner = runDefaultCommand(flagsFromCommand(program));
	}
	return runner;
}

if (import.meta.main)
{
	void (async () =>
	{
		try
		{
			const code = await main();
			process.exit(code);
		}
		catch (err: unknown)
		{
			console.error(chalk.red(err instanceof Error ? err.message : String(err)));
			process.exit(EXIT_FAILURE);
		}
	})();
}

export {
	HARNESS_COLORS,
	HARNESS_ORDER,
	type CliCandidateRow,
	type CliListRow,
	applyAddCandidates,
	buildAddCandidateRows,
	applyDeletePathByRow,
	applyEditPathByRow,
	buildCandidateRows,
	buildMachineRowRefs,
	flattenMachineRows,
	loadCcConfig,
	main,
	resolveInteractiveActionToken,
	parseSelectionSpec,
	resolveRowTarget,
	runDefaultCommand,
	runAdd,
	runInteractiveMode,
	selectMachine,
	updateMachineConfig,
	writeCcConfig,
};
