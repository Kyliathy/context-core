/**
 * ContextCore shared Winston logging configuration.
 *
 * Architecture: server/zz-reach2/architecture/archi-context-core-level0.md
 * Upgrade plan: server/zz-reach2/upgrades/2026-06/r2wl-winston-logging.md
 *
 * Default console level is `warn`. Startup-related namespaces override to `info`
 * so R2SO ingest/bookmark decisions remain visible without flooding runtime chatter.
 */

import winston from "winston";

/** Winston severity ordering used when comparing configured levels. */
const LEVEL_RANK: Record<string, number> = {
	silly: 0,
	debug: 1,
	verbose: 2,
	info: 3,
	warn: 4,
	error: 5,
};

/** Platform-wide default console threshold; ordinary runtime `info` stays muted. */
const DEFAULT_CONSOLE_LEVEL = "warn";

/**
 * Startup and ingest namespaces that must emit `info` during ContextCore bootstrap.
 * Matches R2WL Groups 2 and R2SO startup paths.
 */
const STARTUP_CONSOLE_INFO_NAMESPACES = new Set<string>([
	"ContextCore",
	"MessageDB",
	"DiskMessageStore",
	"GlobalSettingsStore",
	"FileWatcher",
	"IncrementalPipeline",
	"StartupIngestCoordinator",
	"startup-db-load",
	"startup-ingest-plan",
	"startup-harness-skip",
	"startup-harness-delta",
	"startup-harness-full",
	"startup-harness-batch",
	"harness:index",
	"harness:cursor",
	"harness:cursor-query",
	"harness:cursor-matcher",
	"harness:opencode",
	"utils:rawCopier",
	"db:DiskMessageStore",
	"vector:VectorPipeline",
	"analysis:TopicSummarizer",
	"search:searchEngine",
	"server:ContextServer",
	"agentBuilder:AgentBuilder",
]);

/** Cached namespaced loggers so transport configuration is stable per namespace. */
const loggerCache = new Map<string, winston.Logger>();
/** Cached stderr-only loggers for MCP stdio paths that must not write protocol data to stdout. */
const stderrLoggerCache = new Map<string, winston.Logger>();

/**
 * Resolves the global console level from `LOG_LEVEL` or the platform default.
 * @returns Winston level string such as `warn` or `debug`.
 */
function resolveGlobalConsoleLevel(): string
{
	const fromEnv = (process.env.LOG_LEVEL ?? "").trim().toLowerCase();
	// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting ContextCore runtime behavior from partial or invalid state.

	if (fromEnv && fromEnv in LEVEL_RANK)
	{
		return fromEnv;
	}
	return DEFAULT_CONSOLE_LEVEL;
}

/**
 * Parses `LOG_NAMESPACE_LEVELS` entries shaped as `namespace:level`.
 * @returns Map of namespace → Winston level for operator overrides.
 */
function parseNamespaceLevelOverrides(): Map<string, string>
{
	const raw = (process.env.LOG_NAMESPACE_LEVELS ?? "").trim();
	const overrides = new Map<string, string>();
	if (!raw)
	{
		return overrides;
	}	// Business logic: this iteration walks every relevant item so ContextCore runtime behavior reflects the complete source set instead of a partial snapshot.


	//Each comma-separated pair lets operators tune one namespace without changing global defaults.
	for (const segment of raw.split(","))
	{
		const trimmed = segment.trim();
		if (!trimmed)
		{
			continue;
		}
		const colonIndex = trimmed.lastIndexOf(":");
		// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting ContextCore runtime behavior from partial or invalid state.

		if (colonIndex <= 0 || colonIndex >= trimmed.length - 1)
		{
			continue;
		}
		const namespace = trimmed.slice(0, colonIndex).trim();
		const level = trimmed.slice(colonIndex + 1).trim().toLowerCase();
		// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting ContextCore runtime behavior from partial or invalid state.

		if (namespace && level in LEVEL_RANK)
		{
			overrides.set(namespace, level);
		}
	}
	return overrides;
}

/** Lazily parsed namespace overrides shared by all logger factories. */
let namespaceLevelOverrides: Map<string, string> | null = null;

/**
 * Returns memoized namespace overrides from the environment.
 * @returns Parsed `LOG_NAMESPACE_LEVELS` map.
 */
function getNamespaceLevelOverrides(): Map<string, string>
{
	if (!namespaceLevelOverrides)
	{
		namespaceLevelOverrides = parseNamespaceLevelOverrides();
	}
	return namespaceLevelOverrides;
}

/**
 * Chooses the effective console level for a namespace.
 * Startup namespaces stay at `info`; everything else inherits the global default unless overridden.
 * @param namespace – logical logger namespace such as `harness:cursor`.
 * @returns Winston level applied to the namespace console transport.
 */
function resolveNamespaceConsoleLevel(namespace: string): string
{
	const envOverride = getNamespaceLevelOverrides().get(namespace);
	if (envOverride)
	{
		return envOverride;
	}
	if (STARTUP_CONSOLE_INFO_NAMESPACES.has(namespace))
	{
		return "info";
	}
	return resolveGlobalConsoleLevel();
}

/**
 * Builds the readable single-line console format shared by stdout and stderr transports.
 * @returns Winston format combining timestamp, level, namespace, and message.
 */
function buildConsoleFormat(): winston.Logform.Format
{
	return winston.format.combine(
		winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
		winston.format.printf(({ timestamp, level, message, namespace }) =>
		{
			const ns = typeof namespace === "string" ? namespace : "unknown";
			return `${timestamp} ${level.toUpperCase().padEnd(5)} [${ns}] ${message}`;
		})
	);
}

/**
 * Creates or returns a cached namespaced logger writing to the shared console transport.
 * @param namespace – stable module identifier used in log lines and level overrides.
 * @returns Winston logger scoped to the namespace.
 */
export function getLogger(namespace: string): winston.Logger
{
	const cached = loggerCache.get(namespace);
	if (cached)
	{
		return cached;
	}

	const consoleLevel = resolveNamespaceConsoleLevel(namespace);
	const logger = winston.createLogger({
		level: "silly",
		defaultMeta: { namespace },
		transports: [
			new winston.transports.Console({
				level: consoleLevel,
				stderrLevels: ["error"],
				format: buildConsoleFormat(),
			}),
		],
	});
	loggerCache.set(namespace, logger);
	return logger;
}

/**
 * Creates or returns a cached namespaced logger that writes every level to stderr.
 * Required for MCP stdio mode where stdout carries JSON-RPC protocol frames only.
 * @param namespace – MCP diagnostic namespace such as `mcp:stdio`.
 * @returns Winston logger whose console transport targets stderr exclusively.
 */
export function getStderrLogger(namespace: string): winston.Logger
{
	const cached = stderrLoggerCache.get(namespace);
	if (cached)
	{
		return cached;
	}

	const consoleLevel = resolveNamespaceConsoleLevel(namespace);
	const logger = winston.createLogger({
		level: "silly",
		defaultMeta: { namespace },
		transports: [
			new winston.transports.Console({
				level: consoleLevel,
				//All severities go to stderr so MCP stdout stays protocol-clean.
				stderrLevels: ["silly", "debug", "verbose", "info", "warn", "error"],
				format: buildConsoleFormat(),
			}),
		],
	});
	stderrLoggerCache.set(namespace, logger);
	return logger;
}

/**
 * Serializes an unknown error value into a plain object safe for structured log metadata.
 * @param error – caught exception or rejection reason.
 * @returns Plain object with message and optional stack.
 */
export function serializeError(error: unknown): { message: string; stack?: string }
{
	if (error instanceof Error)
	{
		return {
			message: error.message,
			stack: error.stack,
		};
	}
	return { message: String(error) };
}

/**
 * Resets cached loggers and parsed overrides — test-only hook.
 * @internal
 */
export function resetLoggerCacheForTests(): void
{
	loggerCache.clear();
	stderrLoggerCache.clear();
	namespaceLevelOverrides = null;
}

/**
 * Exposes the resolved console level for a namespace — test-only hook.
 * @param namespace – namespace under test.
 * @returns Effective console level string.
 * @internal
 */
export function getEffectiveConsoleLevelForTests(namespace: string): string
{
	return resolveNamespaceConsoleLevel(namespace);
}
