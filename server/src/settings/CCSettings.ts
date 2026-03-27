import { mkdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import type { ContextCoreConfig, MachineConfig } from "../types.js";

/** Singleton settings loader for cc.json and storage initialization. */
export class CCSettings
{
	private static instance: CCSettings | null = null;

	readonly configPath: string;
	readonly config: ContextCoreConfig;
	readonly storage: string;
	/** Resolved path to the on-disk SQLite database file. */
	readonly databaseFile: string;
	/** When true, use in-memory SQLite instead of on-disk (set via IN_MEMORY_DB env var). */
	readonly IN_MEMORY_DB: boolean;

	// ─── Search Configuration ───────────────────────────────────────────────────

	/** Fuse.js search threshold (0.0 = exact match, 1.0 = match anything). Lower = stricter. */
	readonly FUSE_THRESHOLD: number;

	/** Minimum Qdrant cosine similarity score to include in results (0.0-1.0). Higher = stricter. */
	readonly QDRANT_MIN_SCORE: number;

	/** Whether to disable the search response cache (for debugging). */
	readonly DISABLE_SEARCH_CACHE: boolean;

	// ─── Server Configuration ────────────────────────────────────────────────────

	/** HTTP port to bind. If busy, server tries PORT+1 through PORT+10 (default: 3210). */
	readonly PORT: number;

	// ─── MCP Configuration ──────────────────────────────────────────────────────

	/** Master switch for MCP server startup (stdio and SSE). */
	readonly MCP_ENABLED: boolean;

	/** Whether to mount MCP SSE routes on the Express server. */
	readonly MCP_SSE_ENABLED: boolean;

	/** When true: log full MCP tool requests/responses to files under /logs. */
	readonly MCP_LOGGING: boolean;

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
		this.databaseFile = this.config.databaseFile ?? join(this.storage, "cxc-db.sqlite");
		this.IN_MEMORY_DB = this.parseEnvBoolean(process.env.IN_MEMORY_DB, false);
		this.PORT = this.parseEnvInt(process.env.PORT, 3210, 1024, 65535);

		// Load search configuration from environment variables with defaults
		this.FUSE_THRESHOLD = this.parseEnvFloat(process.env.FUSE_THRESHOLD, 0.4, 0, 1);
		this.QDRANT_MIN_SCORE = this.parseEnvFloat(process.env.QDRANT_MIN_SCORE, 0.6, 0, 1);
		this.DISABLE_SEARCH_CACHE = this.parseEnvBoolean(process.env.DISABLE_SEARCH_CACHE, false);

		// MCP defaults: enabled for stdio, SSE disabled unless explicitly enabled.
		this.MCP_ENABLED = this.parseEnvBoolean(process.env.MCP_ENABLED, true);
		this.MCP_SSE_ENABLED = this.parseEnvBoolean(process.env.MCP_SSE_ENABLED, false);
		this.MCP_LOGGING = this.parseEnvBoolean(process.env.MCP_LOGGING, false);
	}

	/**
	 * Parses a float from env var with default and range validation.
	 * @param value - Environment variable value.
	 * @param defaultValue - Default if missing or invalid.
	 * @param min - Minimum allowed value.
	 * @param max - Maximum allowed value.
	 */
	private parseEnvFloat(value: string | undefined, defaultValue: number, min: number, max: number): number
	{
		if (!value) return defaultValue;
		const parsed = parseFloat(value);
		if (Number.isNaN(parsed)) return defaultValue;
		return Math.max(min, Math.min(max, parsed));
	}

	private parseEnvInt(value: string | undefined, defaultValue: number, min: number, max: number): number
	{
		if (!value) return defaultValue;
		const parsed = parseInt(value, 10);
		if (Number.isNaN(parsed)) return defaultValue;
		return Math.max(min, Math.min(max, parsed));
	}

	/**
	 * Parses a boolean from env var.
	 * @param value - Environment variable value.
	 * @param defaultValue - Default if missing.
	 */
	private parseEnvBoolean(value: string | undefined, defaultValue: boolean): boolean
	{
		if (!value) return defaultValue;
		const normalized = value.trim().toLowerCase();
		return normalized === "true" || normalized === "1" || normalized === "yes";
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
