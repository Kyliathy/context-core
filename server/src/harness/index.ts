/**
 * ContextCore – harness registry and dispatch.
 *
 * Architecture: server/zz-reach2/architecture/archi-context-core-level0.md
 * Logging: server/zz-reach2/upgrades/2026-06/r2wl-winston-logging.md
 */

import { getLogger } from "../logging/logger.js";
import type { AgentMessage } from "../models/AgentMessage.js";
import type { HarnessConfig } from "../types.js";
import { readClaudeChatFiles, readClaudeChats } from "./claude.js";
import { readCursorChats } from "./cursor.js";
import { readKiroChatFilesScoped, readKiroChats } from "./kiro.js";
import { readVSCodeChatFiles, readVSCodeChats } from "./vscode.js";
import { readAntigravityChats } from "./antigravity.js";
import { readOpenCodeChats } from "./opencode.js";
import { readCodexChatFiles, readCodexChats } from "./codex.js";

const logger = getLogger("harness:index");

/** Returns the paths array from HarnessConfig, normalizing a bare string to a single-element array. */
function toPaths(config: HarnessConfig): string[]
{
	const p = config.paths;
	return Array.isArray(p) ? p : [p];
}

/** Harness name → reader function (now accepts rawBase for source archiving). */
const READERS: Record<
	string,
	(path: string, rawBase: string) => Array<AgentMessage>
> = {
	ClaudeCode: readClaudeChats,
	Cursor: readCursorChats,
	Kiro: readKiroChats,
	VSCode: readVSCodeChats,
	//Antigravity: readAntigravityChats, //DISABLED UNTIL WE CAN READ STORAGE.
	OpenCode: readOpenCodeChats,
	Codex: readCodexChats,
};

const SCOPED_READERS: Record<string, (filePaths: Array<string>, rawBase: string) => Array<AgentMessage>> = {
	ClaudeCode: readClaudeChatFiles,
	Kiro: readKiroChatFilesScoped,
	VSCode: readVSCodeChatFiles,
	Codex: readCodexChatFiles,
};

/**
 * Returns whether a full-root reader is registered for a harness.
 * @param harnessName - Harness name from `cc.json`.
 * @returns True when startup can perform a full read for the harness.
 */
export function hasHarnessReader(harnessName: string): boolean
{
	return !!READERS[harnessName];
}

/**
 * Returns whether a scoped file reader is registered for a harness.
 * @param harnessName - Harness name from `cc.json`.
 * @returns True when startup can read only selected changed files for the harness.
 */
export function hasScopedHarnessReader(harnessName: string): boolean
{
	return !!SCOPED_READERS[harnessName];
}

/**
 * Reads all chat data for a harness config.
 * @param harnessName – e.g. ClaudeCode, Cursor, Kiro, VSCode
 * @param config – harness config with paths
 * @param rawBase – raw archive root for this harness, e.g. `{storage}/{machine}-RAW/{harness}/`
 */
export function readHarnessChats(
	harnessName: string,
	config: HarnessConfig,
	rawBase: string
): Array<AgentMessage>
{
	const reader = READERS[harnessName];
	if (!reader)
	{
		logger.warn(`No reader registered for harness "${harnessName}" — returning empty results`);
		return [];
	}

	const paths = toPaths(config);
	const results: Array<AgentMessage> = [];

	// Business logic: one harness can have multiple configured roots on a machine,
	// and startup must combine them before persistence so the DB sees one harness-wide ingest.
	for (const p of paths)
	{
		results.push(...reader(p, rawBase));
	}

	return results;
}

/**
 * Reads a scoped list of files for file-manifest startup delta ingest.
 * @param harnessName - Harness name with a scoped reader.
 * @param filePaths - Source files selected by the manifest diff.
 * @param rawBase - Raw archive root for this harness.
 * @returns Normalized messages from only the requested files.
 */
export function readHarnessFiles(
	harnessName: string,
	filePaths: Array<string>,
	rawBase: string
): Array<AgentMessage>
{
	const reader = SCOPED_READERS[harnessName];
	if (!reader)
	{
		logger.warn(`No scoped reader registered for harness "${harnessName}" — returning empty results`);
		return [];
	}
	if (filePaths.length === 0)
	{
		return [];
	}
	return reader(filePaths, rawBase);
}
