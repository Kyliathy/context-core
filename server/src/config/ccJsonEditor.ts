/**
 * Shared cc.json parse and atomic write helpers for CLI and server vault routes.
 *
 * Architecture: server/zz-reach2/architecture/cli/archi-cli.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ap-agent-publisher-2.md (Part B)
 */

import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { ContextCoreConfig, MachineConfig } from "../types.js";

export type WriteCcJsonOptions = {
	/** When true, copies the existing file to cc.json.bak before replace. */
	backup?: boolean;
};

/**
 * Loads and minimally validates cc.json from disk.
 * @param ccJsonPath - Absolute or cwd-relative path to cc.json.
 */
export function loadCcJson(ccJsonPath: string): ContextCoreConfig
{
	if (!existsSync(ccJsonPath))
	{
		throw Object.assign(new Error(`cc.json not found at: ${ccJsonPath}`), { status: 404 });
	}

	let parsed: unknown;
	try
	{
		parsed = JSON.parse(readFileSync(ccJsonPath, "utf-8"));
	}
	catch (err: unknown)
	{
		throw Object.assign(
			new Error(`Failed to parse cc.json: ${err instanceof Error ? err.message : String(err)}`),
			{ status: 400 },
		);
	}

	if (!parsed || typeof parsed !== "object")
	{
		throw Object.assign(new Error("Invalid cc.json: expected top-level JSON object."), { status: 400 });
	}

	const record = parsed as Record<string, unknown>;
	if (typeof record.storage !== "string" || record.storage.trim() === "")
	{
		throw Object.assign(new Error("Invalid cc.json: `storage` must be a non-empty string."), { status: 400 });
	}
	if (!Array.isArray(record.machines))
	{
		throw Object.assign(new Error("Invalid cc.json: `machines` must be an array."), { status: 400 });
	}

	return parsed as ContextCoreConfig;
}

/**
 * Returns one machine block by exact machine name (case-sensitive match on cc.json value).
 * @param config - Parsed cc.json configuration.
 * @param machineName - Host machine name from cc.json machines[].machine.
 */
export function findMachineConfig(config: ContextCoreConfig, machineName: string): MachineConfig | undefined
{
	return config.machines.find((m) => m.machine === machineName);
}

/**
 * Applies an update function to one machine while preserving all other machines and top-level fields.
 * @param config - Parsed cc.json configuration.
 * @param machineName - Target machine name.
 * @param updateFn - Mutator for the matched machine row.
 */
export function updateMachineConfig(
	config: ContextCoreConfig,
	machineName: string,
	updateFn: (machine: MachineConfig) => MachineConfig,
): ContextCoreConfig
{
	const machines = config.machines.map((machine) =>
		machine.machine === machineName ? updateFn(machine) : machine,
	);
	return { ...config, machines };
}

/**
 * Creates cc.json.bak when backup is enabled and the target file already exists.
 * @param ccJsonPath - Path to cc.json.
 * @param backupEnabled - Whether to copy before overwrite.
 */
function createBackupIfNeeded(ccJsonPath: string, backupEnabled: boolean): void
{
	// Business logic: backup only when explicitly requested and the live config file exists.
	if (!backupEnabled || !existsSync(ccJsonPath))
	{
		return;
	}
	copyFileSync(ccJsonPath, `${ccJsonPath}.bak`);
}

/**
 * Atomically writes cc.json using temp-file rename (tab-indented JSON).
 * @param ccJsonPath - Path to cc.json.
 * @param config - Full configuration object to persist.
 * @param options - Optional backup behavior.
 */
export function writeCcJson(ccJsonPath: string, config: ContextCoreConfig, options?: WriteCcJsonOptions): void
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
			if (existsSync(swapPath) && !existsSync(ccJsonPath))
			{
				renameSync(swapPath, ccJsonPath);
			}
			throw err;
		}
	}
	catch (err: unknown)
	{
		if (existsSync(tempPath))
		{
			try { unlinkSync(tempPath); } catch { /* best effort */ }
		}
		throw err;
	}
}
