/**
 * ContextCore – harness registry and dispatch.
 */

import type { AgentMessage } from "../models/AgentMessage.js";
import type { HarnessConfig } from "../types.js";
import { readClaudeChats } from "./claude.js";
import { readCursorChats } from "./cursor.js";
import { readKiroChats } from "./kiro.js";
import { readVSCodeChats } from "./vscode.js";
import { readAntigravityChats } from "./antigravity.js";
import { readOpenCodeChats } from "./opencode.js";
import { readCodexChats } from "./codex.js";

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
		return [];
	}

	const paths = toPaths(config);
	const results: Array<AgentMessage> = [];

	for (const p of paths)
	{
		results.push(...reader(p, rawBase));
	}

	return results;
}
