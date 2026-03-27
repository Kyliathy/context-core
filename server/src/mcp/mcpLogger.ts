/**
 * Centralized MCP tool-call logger.
 *
 * Console logging (stderr) is always active.
 * File logging is gated by MCP_LOGGING=true.
 *
 * File layout:
 *   logs/YYYY-MM-DD HH:mm MCP Tool Calls.json       — session log (one per run)
 *   logs/mcp-tool-calls/YYYY-MM-DD/HH:mm:ss Tool- <name>.json  — per-call detail
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import chalk from "chalk";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface McpToolLogEntry
{
	tool: string;
	durationMs: number;
	request: Record<string, unknown>;
	/** Full response text returned to the MCP client. */
	responseText: string;
	/** Optional result count parsed from the response. */
	resultCount?: number;
	isError?: boolean;
}

// ─── State ────────────────────────────────────────────────────────────────────

let loggingEnabled = false;
let logsDir = "";
let sessionLogPath = "";
/** In-memory list of session log entries — flushed to disk after each call. */
const sessionEntries: object[] = [];
/** Call counter per filename to avoid collisions within the same second. */
const filenameCounters = new Map<string, number>();

// ─── Initialization ───────────────────────────────────────────────────────────

/**
 * Call once at MCP startup.
 * - Reads MCP_LOGGING from env (CCSettings may not be available in all entry points)
 * - Creates the logs directory if needed
 * - Freezes the session log filename for the lifetime of the process
 *
 * @param serverLogsDir - Absolute path to the logs directory (e.g. /project/server/logs)
 * @param mcpLoggingEnabled - Value of CCSettings.MCP_LOGGING
 */
export function initMcpLogger(serverLogsDir: string, mcpLoggingEnabled: boolean): void
{
	loggingEnabled = mcpLoggingEnabled;
	if (!loggingEnabled) return;

	logsDir = serverLogsDir;
	mkdirSync(logsDir, { recursive: true });

	const now = new Date();
	const datePart = formatDate(now);      // YYYY-MM-DD
	const timePart = formatTime(now);      // HH:mm
	sessionLogPath = join(logsDir, `${datePart} ${timePart} MCP Tool Calls.json`);

	// Write an empty array to seed a valid JSON file
	writeFileSync(sessionLogPath, "[]", "utf-8");

	process.stderr.write(chalk.blue(`[MCP] File logging enabled → ${sessionLogPath}\n`));
}

// ─── Request logging ──────────────────────────────────────────────────────────

/**
 * Log the incoming tool request to stderr.
 * Call this immediately on entry, before dispatch.
 */
export function logToolRequest(toolName: string, args: Record<string, unknown>): void
{
	const argsStr = formatArgs(args);
	process.stderr.write(chalk.cyan(`[MCP/Tool] ${toolName} ← ${argsStr}\n`));
}

// ─── Result logging ───────────────────────────────────────────────────────────

/**
 * Log a completed tool call to console (always) and to files (when enabled).
 * Call this after dispatch, with the final response text.
 */
export function logToolCall(entry: McpToolLogEntry): void
{
	const { tool, durationMs, request, responseText, isError } = entry;
	const resultCount = entry.resultCount ?? parseResultCount(tool, responseText);
	const countStr = resultCount !== undefined ? ` | ${resultCount} results` : "";
	const errorFlag = isError ? chalk.red(" [ERROR]") : "";

	// Console: always
	process.stderr.write(
		chalk.cyan(`[MCP/Tool] ${tool} →`) +
		chalk.white(` ${durationMs}ms${countStr} | ${responseText.length} chars`) +
		errorFlag + "\n"
	);

	if (!loggingEnabled) return;

	// Session log entry (no full response text)
	const sessionEntry = {
		timestamp: new Date().toISOString(),
		tool,
		durationMs,
		request,
		responseChars: responseText.length,
		resultCount,
		...(isError ? { isError: true } : {}),
	};
	sessionEntries.push(sessionEntry);
	flushSessionLog();

	// Per-call detail file (full response text)
	writeDetailLog(tool, { ...sessionEntry, response: responseText });
}

// ─── Error logging ────────────────────────────────────────────────────────────

/**
 * Log a tool error to console (always) and to files (when enabled).
 */
export function logToolError(
	toolName: string,
	durationMs: number,
	request: Record<string, unknown>,
	errorMessage: string,
	isMcpError = false
): void
{
	const label = isMcpError ? "MCP error" : "error";
	process.stderr.write(
		chalk.cyan(`[MCP/Tool] ${toolName} →`) +
		chalk.red(` ${label} in ${durationMs}ms: ${errorMessage}`) + "\n"
	);

	if (!loggingEnabled) return;

	const sessionEntry = {
		timestamp: new Date().toISOString(),
		tool: toolName,
		durationMs,
		request,
		isError: true,
		errorMessage,
	};
	sessionEntries.push(sessionEntry);
	flushSessionLog();

	writeDetailLog(toolName, sessionEntry);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function flushSessionLog(): void
{
	try
	{
		writeFileSync(sessionLogPath, JSON.stringify(sessionEntries, null, 2), "utf-8");
	} catch (err)
	{
		process.stderr.write(`[MCP] Failed to write session log: ${err}\n`);
	}
}

function writeDetailLog(toolName: string, data: object): void
{
	try
	{
		const now = new Date();
		const datePart = formatDate(now);
		const timePart = formatTimeSeconds(now);   // HH-mm-ss

		const dir = join(logsDir, "mcp-tool-calls", datePart);
		mkdirSync(dir, { recursive: true });

		const baseFilename = `${timePart} Tool- ${toolName}`;
		const filename = uniqueFilename(dir, baseFilename);

		writeFileSync(join(dir, filename), JSON.stringify(data, null, 2), "utf-8");
	} catch (err)
	{
		process.stderr.write(`[MCP] Failed to write detail log for ${toolName}: ${err}\n`);
	}
}

/**
 * Returns a unique filename by appending a counter if the base name already exists.
 * e.g. "07:51:03 Tool- search_messages.json" → "07:51:03 Tool- search_messages (2).json"
 */
function uniqueFilename(dir: string, baseName: string): string
{
	const key = join(dir, baseName);
	let counter = filenameCounters.get(key) ?? 1;

	let candidate = `${baseName}.json`;
	while (existsSync(join(dir, candidate)))
	{
		counter++;
		candidate = `${baseName} (${counter}).json`;
	}

	filenameCounters.set(key, counter);
	return candidate;
}

/**
 * Extracts a result count from the formatted response text using known header patterns.
 * Returns undefined when no pattern matches.
 */
export function parseResultCount(toolName: string, text: string): number | undefined
{
	// Search/list tools: "Found N messages|threads|sessions..."
	const foundMatch = text.match(/^Found (\d+) /m);
	if (foundMatch) return parseInt(foundMatch[1], 10);

	// query_messages: "Page X of Y (Z total)"
	const pageMatch = text.match(/\((\d+) total\)/);
	if (pageMatch) return parseInt(pageMatch[1], 10);

	// get_session header: "Session ... (N messages)"
	const sessionMatch = text.match(/\((\d+) messages?\)/);
	if (sessionMatch) return parseInt(sessionMatch[1], 10);

	// list_sessions: "N sessions"
	const sessionsMatch = text.match(/^(\d+) sessions/m);
	if (sessionsMatch) return parseInt(sessionsMatch[1], 10);

	// get_topics: count separator lines  (entries separated by ---)
	if (toolName === "get_topics")
	{
		const separators = (text.match(/^---$/gm) ?? []).length;
		if (separators > 0) return separators + 1;
	}

	// Single-result tools
	if (toolName === "get_message" || toolName === "get_topic")
	{
		return text.includes("not found") || text.includes("No ") ? 0 : 1;
	}

	return undefined;
}

// ─── Date/time formatters ─────────────────────────────────────────────────────

function formatDate(d: Date): string
{
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

function formatTime(d: Date): string
{
	const hh = String(d.getHours()).padStart(2, "0");
	const min = String(d.getMinutes()).padStart(2, "0");
	return `${hh}-${min}`;
}

function formatTimeSeconds(d: Date): string
{
	const hh = String(d.getHours()).padStart(2, "0");
	const min = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	return `${hh}-${min}-${ss}`;
}

function formatArgs(args: Record<string, unknown>): string
{
	try
	{
		const str = JSON.stringify(args);
		// Truncate very long args in console output (full args always go to file)
		return str.length > 200 ? str.slice(0, 197) + "…}" : str;
	} catch
	{
		return "(unparseable args)";
	}
}
