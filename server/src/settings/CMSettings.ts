import { mkdirSync, readFileSync } from "fs";
import { resolve } from "path";
import type { ContextCoreConfig, MachineConfig } from "../types.js";

/** Singleton settings loader for cc.json and storage initialization. */
export class CCSettings
{
	private static instance: CCSettings | null = null;

	readonly configPath: string;
	readonly config: ContextCoreConfig;
	readonly storage: string;

	/**
	 * Loads cc.json once and ensures storage exists.
	 * @param rootDir - Project root directory that contains cc.json.
	 */
	private constructor(rootDir: string)
	{
		this.configPath = resolve(rootDir, "cc.json");
		const rawText = readFileSync(this.configPath, "utf-8");
		this.config = JSON.parse(rawText) as ContextCoreConfig;
		this.storage = this.config.storage;
		mkdirSync(this.storage, { recursive: true });
	}

	/**
	 * Returns the singleton settings instance.
	 * @param rootDir - Optional root override, defaults to current working directory.
	 */
	static getInstance(rootDir = process.cwd()): CCSettings
	{
		if (!CCSettings.instance)
		{
			CCSettings.instance = new CCSettings(rootDir);
		}
		return CCSettings.instance;
	}

	/**
	 * Selects a machine block by exact hostname match.
		* @param machineName - Hostname to match against cc.json machine entries.
	 */
	getMachineConfig(machineName: string): MachineConfig | null
	{
		const expected = machineName.toLowerCase();
		return this.config.machines.find((machine) => machine.machine.toLowerCase() === expected) ?? null;
	}
}
