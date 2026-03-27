/**
 * ContextCore – config loading and hostname-based machine selection.
 */

import { hostname } from "os";
import { join } from "path";
import type { ContextCoreConfig, MachineConfig } from "./types.js";

/** Path to cc.json relative to project root. */
const CONFIG_PATH = "cc.json";

/**
 * Resolves the current machine's hostname.
 * Uses COMPUTERNAME on Windows, os.hostname() elsewhere.
 */
export function getHostname(): string
{
	if (process.platform === "win32" && process.env.COMPUTERNAME)
	{
		return process.env.COMPUTERNAME;
	}
	return hostname();
}

/**
 * Loads and parses cc.json from the project root.
 * @param rootDir – project root (default: cwd)
 */
export async function loadConfig(rootDir?: string): Promise<ContextCoreConfig>
{
	const base = rootDir ?? process.cwd();
	const configPath = join(base, CONFIG_PATH);
	const file = Bun.file(configPath);

	if (!(await file.exists()))
	{
		throw new Error(`Config not found: ${configPath}`);
	}

	const raw = await file.json();
	return raw as ContextCoreConfig;
}

/**
 * Selects the machine config for the current hostname.
 * @param config – loaded ContextCore config
 * @param hostname – optional override; defaults to current machine
 */
export function selectMachineConfig(
	config: ContextCoreConfig,
	hostname?: string
): MachineConfig | null
{
	const name = hostname ?? getHostname();
	return config.machines.find((m) => m.machine === name) ?? null;
}
