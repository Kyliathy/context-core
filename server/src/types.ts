/**
 * ContextCore – shared types for config and harness definitions.
 */

/** Harness config: paths to chat history storage for a given IDE. */
export type HarnessConfig = {
	/** Array of paths to chat history storage (e.g. multiple workspace storages). */
	paths: string[];
};

/** Harnesses keyed by IDE name (ClaudeCode, Cursor, Kiro, VSCode). */
export type Harnesses = Record<string, HarnessConfig>;

/**
 * Keys inside `harnesses` that are NOT actual harness entries.
 * These provide shared configuration (e.g. generic project mapping rules)
 * and must be excluded when enumerating real harness names.
 */
const RESERVED_HARNESS_KEYS = new Set(["genericProjectMappingRules"]);

/**
 * Returns only the real harness names from a Harnesses record,
 * filtering out reserved config keys like `genericProjectMappingRules`.
 */
export function getHarnessNames(harnesses: Harnesses): string[]
{
	return Object.keys(harnesses).filter((key) => !RESERVED_HARNESS_KEYS.has(key));
}

/**
 * Returns [name, config] entries for real harnesses only,
 * filtering out reserved config keys like `genericProjectMappingRules`.
 */
export function getHarnessEntries(harnesses: Harnesses): [string, HarnessConfig][]
{
	return Object.entries(harnesses).filter(
		([key]) => !RESERVED_HARNESS_KEYS.has(key)
	) as [string, HarnessConfig][];
}

/** A data source entry from cc.json dataSources. */
export type DataSourceEntry = {
	path: string;
	/** Directory where GitHub Copilot .agent.md files are written. */
	agentPath?: string;
	/** Directory where Claude Code .md sub-agent files are written. Falls back to {dirname(dirname(agentPath))}/.claude/agents when absent. */
	claudeAgentPath?: string;
	/** Directory where Codex project instruction files are written. Falls back to inferred repo root from `agentPath` (`.github/agents` → project root), then `path` when inference is unavailable. */
	codexAgentPath?: string;
	/** Optional ordered list of Codex output directories. First item is default when codexDirectory is not explicitly provided. */
	codexAgentPaths?: string[];
	name: string;
	type: string;
	purpose: string;
};

/** Data sources keyed by category name (e.g. "zz-reach2"). */
export type DataSources = Record<string, DataSourceEntry[]>;

/** Machine-specific config: hostname + harness paths for that machine. */
export type MachineConfig = {
	/** Computer hostname (e.g. from os.hostname() or COMPUTERNAME). */
	machine: string;
	/** Harness configs per IDE. */
	harnesses: Harnesses;
	/** Optional data sources for AgentBuilder indexing. */
	dataSources?: DataSources;
};

/** Root config shape read from cc.json. */
export type ContextCoreConfig = {
	/** Root storage directory where normalized chat exports are written. */
	storage: string;
	/** Path to the on-disk SQLite database file. Defaults to {storage}/cxc-db.sqlite when absent. */
	databaseFile?: string;
	/** Array of machine configs; app selects the one matching current hostname. */
	machines: MachineConfig[];
};

/** Structured tool invocation data stored on assistant messages. */
export type ToolCall = {
	/** Tool function name (e.g. Read, Edit, search). */
	name: string;
	/** Paths or other contextual inputs provided to the tool call. */
	context: string[];
	/** Tool outputs captured from subsequent result payloads. */
	results: string[];
};
