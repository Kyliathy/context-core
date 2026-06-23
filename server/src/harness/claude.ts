/**
 * ContextCore – Claude Code harness.
 * Claude stores one session per `.jsonl` file at the project-root level.
 *
 * Architecture: server/zz-reach2/architecture/archi-context-core-level0.md
 * Logging: server/zz-reach2/upgrades/2026-06/r2wl-winston-logging.md
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import { DateTime } from "luxon";
import { getLogger } from "../logging/logger.js";
import { AgentMessage } from "../models/AgentMessage.js";
import type { ToolCall } from "../types.js";
import { generateMessageId } from "../utils/hashId.js";
import { deriveProjectName } from "../utils/pathHelpers.js";
import { copyRawSourceFile, isSourceFileCached } from "../utils/rawCopier.js";

const logger = getLogger("harness:claude");

type ClaudeContentItem = {
	type?: string;
	text?: string;
	id?: string;
	name?: string;
	input?: unknown;
	tool_use_id?: string;
	content?: unknown;
};

type ClaudeLine = {
	type?: string;
	uuid?: string;
	parentUuid?: string;
	timestamp?: string | number;
	sessionId?: string;
	cwd?: string;
	message?: {
		model?: string;
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			inputTokens?: number;
			outputTokens?: number;
		};
		content?: ClaudeContentItem[];
	};
	content?: ClaudeContentItem[];
};

/**
 * Lists only root-level Claude `.jsonl` session files.
 * @param projectPath - path to `.claude/projects/<project>/`.
 * @returns Absolute file paths to session JSONL files.
 */
function scanClaudeSessionFiles(projectPath: string): Array<string>
{
	if (!existsSync(projectPath))
	{
		return [];
	}

	try
	{
		return readdirSync(projectPath, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
			.map((entry) => join(projectPath, entry.name));
	} catch
	{
		return [];
	}
}

/**
 * Parses JSONL line-by-line and keeps only user/assistant entries.
 * @param filePath - Claude JSONL session path.
 * @returns Parsed and filtered session lines.
 */
function parseClaudeJsonl(filePath: string): Array<ClaudeLine>
{
	const parsedLines: Array<ClaudeLine> = [];
	const raw = readFileSync(filePath, "utf-8");
	const lines = raw.split(/\r?\n/);
	// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.


	for (const line of lines)
	{
		const trimmed = line.trim();
		if (!trimmed)
		{
			continue;
		}

		try
		{
			const obj = JSON.parse(trimmed) as ClaudeLine;
			// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting harness ingest and source normalization from partial or invalid state.

			if (obj.type === "user" || obj.type === "assistant")
			{
				parsedLines.push(obj);
			}
		} catch
		{
			logger.warn(`Skipping malformed JSONL line in ${filePath}`);
		}
	}

	return parsedLines;
}

/**
 * Collects path-like values from nested objects used in tool inputs.
 * @param value - Unknown nested object from a tool input payload.
 * @param parentKey - Parent key used to detect path-like semantics.
 */
function collectPathValues(value: unknown, parentKey = ""): Array<string>
{
	const results: Array<string> = [];

	if (typeof value === "string")
	{
		const key = parentKey.toLowerCase();
		// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting harness ingest and source normalization from partial or invalid state.

		if (key.includes("path") || key.includes("file") || key.includes("uri"))
		{
			results.push(value);
		}
		return results;
	}

	if (Array.isArray(value))
	{
		// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.

		for (const item of value)
		{
			results.push(...collectPathValues(item, parentKey));
		}
		return results;
	}	// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting harness ingest and source normalization from partial or invalid state.


	if (value && typeof value === "object")
	{
		// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.

		for (const [key, child] of Object.entries(value as Record<string, unknown>))
		{
			results.push(...collectPathValues(child, key));
		}
	}

	return results;
}

/**
 * Converts tool result content payloads into plain text snippets.
 * @param value - Unknown tool result content shape from Claude.
 */
function toolResultToText(value: unknown): string
{
	if (typeof value === "string")
	{
		return value;
	}
	if (Array.isArray(value))
	{
		return value.map((item) => toolResultToText(item)).filter(Boolean).join("\n");
	}	// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting harness ingest and source normalization from partial or invalid state.

	if (value && typeof value === "object")
	{
		const maybeText = (value as { text?: unknown }).text;
		if (typeof maybeText === "string")
		{
			return maybeText;
		}
		return JSON.stringify(value);
	}
	return "";
}

/**
 * Converts Claude timestamp variants into Luxon DateTime.
 * @param timestamp - ISO string or epoch number from Claude payloads.
 */
function parseClaudeDateTime(timestamp: string | number | undefined): DateTime
{
	if (typeof timestamp === "number")
	{
		return DateTime.fromMillis(timestamp);
	}
	if (typeof timestamp === "string")
	{
		const maybeIso = DateTime.fromISO(timestamp);
		if (maybeIso.isValid)
		{
			return maybeIso;
		}
	}
	return DateTime.now();
}

/**
 * Extracts plain text and ide-opened-file tags from user content blocks.
 * @param content - Claude message content array.
 */
function extractUserTextAndContext(content: Array<ClaudeContentItem>):
	{
		message: string;
		context: Array<string>;
		toolResults: Array<{ toolUseId: string; text: string }>;
	}
{
	const context: Array<string> = [];
	const messageParts: Array<string> = [];
	const toolResults: Array<{ toolUseId: string; text: string }> = [];
	const openedFileTagRegex = /<ide_opened_file>(.*?)<\/ide_opened_file>/g;
	// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.


	for (const item of content)
	{
		if (item.type === "tool_result")
		{
			const toolUseId = item.tool_use_id ?? "";
			const text = toolResultToText(item.content).slice(0, 2000);
			// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting harness ingest and source normalization from partial or invalid state.

			if (toolUseId && text)
			{
				toolResults.push({ toolUseId, text });
			}
			continue;
		}		// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting harness ingest and source normalization from partial or invalid state.


		if (item.type !== "text" || !item.text)
		{
			continue;
		}

		messageParts.push(item.text);
		// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.

		for (const match of item.text.matchAll(openedFileTagRegex))
		{
			const value = (match[1] ?? "").trim();
			if (value)
			{
				context.push(value);
			}
		}
	}

	const message = messageParts
		.join("\n")
		.replace(openedFileTagRegex, "")
		.trim();

	return { message, context, toolResults };
}

/**
 * Extracts structured tool calls from Claude assistant content blocks.
 * @param content - Assistant content array with text and tool_use entries.
 */
function extractClaudeToolCalls(content: Array<ClaudeContentItem>):
	{
		toolCalls: Array<ToolCall>;
		toolUseIndex: Map<string, ToolCall>;
	}
{
	const toolCalls: Array<ToolCall> = [];
	const toolUseIndex = new Map<string, ToolCall>();
	// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.


	for (const item of content)
	{
		if (item.type !== "tool_use")
		{
			continue;
		}

		const toolCall: ToolCall = {
			name: item.name ?? "unknownTool",
			context: Array.from(new Set(collectPathValues(item.input))),
			results: [],
		};
		toolCalls.push(toolCall);

		if (item.id)
		{
			toolUseIndex.set(item.id, toolCall);
		}
	}

	return { toolCalls, toolUseIndex };
}

/**
 * Reads normalized AgentMessages from Claude session JSONL files.
 * @param projectPath - path to `.claude/projects/<project>/`.
 * @param rawBase - Raw archive directory for this harness.
 */
function readClaudeChatFilesFromList(
	projectPath: string,
	rawBase: string,
	sessionFiles: Array<string>
): Array<AgentMessage>
{
	const project = deriveProjectName("ClaudeCode", projectPath);
	const results: Array<AgentMessage> = [];
	let skippedCount = 0;
	// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.


	for (const filePath of sessionFiles)
	{
		// Skip processing if file is already cached (same size and mtime)
		if (isSourceFileCached(filePath, rawBase, project))
		{
			skippedCount++;
			continue;
		}

		const lines = parseClaudeJsonl(filePath);
		if (lines.length === 0)
		{
			continue;
		}

		const rawDest = copyRawSourceFile(rawBase, project, filePath);

		const first = lines[0];
		const sessionId = first.sessionId ?? basename(filePath, ".jsonl");
		const toolUseMap = new Map<string, ToolCall>();
		// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.


		for (const line of lines)
		{
			const dateTime = parseClaudeDateTime(line.timestamp);
			const role = line.type === "assistant" ? "assistant" : "user";

			if (role === "user")
			{
				const userContent = line.message?.content ?? [];
				const extracted = extractUserTextAndContext(userContent);

				// Skip empty user messages (e.g. tool-result-only protocol lines)
				if (!extracted.message)
				{
					// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.

					// Still correlate tool results even for skipped messages
					for (const result of extracted.toolResults)
					{
						const toolCall = toolUseMap.get(result.toolUseId);
						if (toolCall)
						{
							toolCall.results.push(result.text);
						}
					}
					continue;
				}

				const id =
					line.uuid ??
					generateMessageId(sessionId, role, dateTime.toMillis(), extracted.message.slice(0, 120));

				results.push(
					new AgentMessage({
						id,
						sessionId,
						harness: "ClaudeCode",
						machine: "",
						role,
						model: null,
						message: extracted.message,
						subject: "",
						context: extracted.context,
						symbols: [],
						length: extracted.message.length,
						history: [],
						tags: [],
						project: line.cwd ? deriveProjectName("ClaudeCode", line.cwd) : project,
						parentId: line.parentUuid ?? null,
						tokenUsage: null,
						toolCalls: [],
						rationale: [],
						source: rawDest,
						dateTime,
					})
				);
				// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.


				for (const result of extracted.toolResults)
				{
					const toolCall = toolUseMap.get(result.toolUseId);
					if (toolCall)
					{
						toolCall.results.push(result.text);
					}
				}
			} else
			{
				const assistantContent = line.message?.content ?? line.content ?? [];
				const assistantMessage = assistantContent
					.filter((item) => item.type === "text" && typeof item.text === "string")
					.map((item) => item.text ?? "")
					.join("\n")
					.trim();

				const usage = line.message?.usage;
				const tokenUsage = usage
					? {
						input: usage.input_tokens ?? usage.inputTokens ?? null,
						output: usage.output_tokens ?? usage.outputTokens ?? null,
					}
					: null;
				const extractedTools = extractClaudeToolCalls(assistantContent);
				// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.

				for (const [toolUseId, toolCall] of extractedTools.toolUseIndex.entries())
				{
					toolUseMap.set(toolUseId, toolCall);
				}				// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting harness ingest and source normalization from partial or invalid state.


				// Skip empty assistant messages (e.g. tool-use-only lines with no text)
				if (!assistantMessage && extractedTools.toolCalls.length === 0)
				{
					continue;
				}

				const id =
					line.uuid ??
					generateMessageId(sessionId, role, dateTime.toMillis(), assistantMessage.slice(0, 120));

				results.push(
					new AgentMessage({
						id,
						sessionId,
						harness: "ClaudeCode",
						machine: "",
						role,
						model: line.message?.model ?? null,
						message: assistantMessage,
						subject: "",
						context: [],
						symbols: [],
						length: assistantMessage.length,
						history: [],
						tags: [],
						project: line.cwd ? deriveProjectName("ClaudeCode", line.cwd) : project,
						parentId: line.parentUuid ?? null,
						tokenUsage,
						toolCalls: extractedTools.toolCalls,
						rationale: [],
						source: rawDest,
						dateTime,
					})
				);
			}
		}
	}

	logger.info(
		`Processed ${sessionFiles.length} files: ${skippedCount} cached, ${sessionFiles.length - skippedCount} new/modified`
	);
	return results;
}

/**
 * Reads data for readClaudeChats without changing unrelated CXC state.
 * @param projectPath - Path used by readClaudeChats to locate the relevant CXC resource.
 * @param rawBase - Value consumed by readClaudeChats.
 * @returns Result produced by readClaudeChats.
 */


export function readClaudeChats(projectPath: string, rawBase: string): Array<AgentMessage>
{
	return readClaudeChatFilesFromList(projectPath, rawBase, scanClaudeSessionFiles(projectPath));
}

/**
 * Reads data for readClaudeChatFiles without changing unrelated CXC state.
 * @param filePaths - Path used by readClaudeChatFiles to locate the relevant CXC resource.
 * @param rawBase - Value consumed by readClaudeChatFiles.
 * @returns Result produced by readClaudeChatFiles.
 */


export function readClaudeChatFiles(filePaths: Array<string>, rawBase: string): Array<AgentMessage>
{
	const grouped = new Map<string, Array<string>>();
	// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.

	for (const filePath of filePaths)
	{
		const projectPath = filePath.replace(/[\\/][^\\/]+$/, "");
		const files = grouped.get(projectPath) ?? [];
		files.push(filePath);
		grouped.set(projectPath, files);
	}

	const results: Array<AgentMessage> = [];
	// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.

	for (const [projectPath, files] of grouped.entries())
	{
		results.push(...readClaudeChatFilesFromList(projectPath, rawBase, files));
	}
	return results;
}
