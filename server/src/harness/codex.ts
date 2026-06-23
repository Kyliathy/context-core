/**
 * ContextCore - Codex harness.
 * Codex stores conversations as JSONL event logs under `.codex/sessions/...`.
 *
 * Architecture: server/zz-reach2/architecture/archi-context-core-level0.md
 * Logging: server/zz-reach2/upgrades/2026-06/r2wl-winston-logging.md
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, dirname, join, normalize } from "path";
import { DateTime } from "luxon";
import { getLogger } from "../logging/logger.js";
import { AgentMessage, type AgentRole } from "../models/AgentMessage.js";
import type { ToolCall } from "../types.js";
import { generateMessageId } from "../utils/hashId.js";
import { deriveProjectName } from "../utils/pathHelpers.js";
import { copyRawSourceFile, isSourceFileCached } from "../utils/rawCopier.js";

const logger = getLogger("harness:codex");

type JsonRecord = {
	timestamp?: string;
	type?: string;
	payload?: unknown;
};

type SessionMeta = {
	sessionId: string;
	cwd: string | null;
	modelProvider: string | null;
	startedAt: DateTime | null;
};

type StagedMessage = {
	order: number;
	turnId: string | null;
	role: AgentRole;
	phase: string | null;
	message: string;
	dateTime: DateTime;
	model: string | null;
	toolCalls: ToolCall[];
};

type PendingToolCall = {
	callId: string;
	turnId: string | null;
	name: string;
	context: Set<string>;
	results: string[];
	order: number;
};

const MAX_TOOL_OUTPUT_LEN = 2000;
const MAX_CONTEXT_VALUE_LEN = 300;
const MAX_CONTEXT_ITEMS = 16;

/**
 * Handles asObject behavior for this CXC module.
 * @param value - Value consumed by asObject.
 * @returns Result produced by asObject.
 */
function asObject(value: unknown): Record<string, unknown> | null
{
	return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * Handles asString behavior for this CXC module.
 * @param value - Value consumed by asString.
 * @returns Result produced by asString.
 */
function asString(value: unknown): string | null
{
	return typeof value === "string" ? value : null;
}

/**
 * Parses input into the shape expected by parseIsoOrNow.
 * @param value - Value consumed by parseIsoOrNow.
 * @returns Result produced by parseIsoOrNow.
 */
function parseIsoOrNow(value: string | undefined): DateTime
{
	if (!value)
	{
		return DateTime.now();
	}
	const parsed = DateTime.fromISO(value);
	return parsed.isValid ? parsed : DateTime.now();
}

/**
 * Handles normalizeText behavior for this CXC module.
 * @param value - Value consumed by normalizeText.
 * @returns Result produced by normalizeText.
 */
function normalizeText(value: unknown): string
{
	if (typeof value !== "string")
	{
		return "";
	}
	return value.trim();
}

/**
 * Handles isWrapperText behavior for this CXC module.
 * @param text - Value consumed by isWrapperText.
 * @returns Result produced by isWrapperText.
 */
function isWrapperText(text: string): boolean
{
	const normalized = text.trim().toLowerCase();
	return (
		normalized.startsWith("<environment_context>")
		|| normalized.startsWith("<permissions instructions>")
		|| normalized.startsWith("<collaboration_mode>")
		|| normalized.startsWith("<skills_instructions>")
		|| normalized.startsWith("<turn_aborted>")
	);
}

/**
 * Handles truncate behavior for this CXC module.
 * @param value - Value consumed by truncate.
 * @param maxLen - Value consumed by truncate.
 * @returns Result produced by truncate.
 */
function truncate(value: string, maxLen: number): string
{
	if (value.length <= maxLen)
	{
		return value;
	}
	return `${value.slice(0, maxLen)}…`;
}

/**
 * Handles safeParseJsonString behavior for this CXC module.
 * @param value - Value consumed by safeParseJsonString.
 * @returns Result produced by safeParseJsonString.
 */
function safeParseJsonString(value: string): unknown | null
{
	try
	{
		return JSON.parse(value);
	}
	catch
	{
		return null;
	}
}

/**
 * Handles collectPathLikeValues behavior for this CXC module.
 * @param value - Value consumed by collectPathLikeValues.
 * @param parentKey - Value consumed by collectPathLikeValues.
 * @returns Result produced by collectPathLikeValues.
 */
function collectPathLikeValues(value: unknown, parentKey = ""): string[]
{
	const results: string[] = [];

	if (typeof value === "string")
	{
		const key = parentKey.toLowerCase();
		const looksLikePath = value.includes("\\") || value.includes("/") || value.includes(":");
		// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting harness ingest and source normalization from partial or invalid state.

		if (
			key.includes("path")
			|| key.includes("file")
			|| key.includes("cwd")
			|| key.includes("workdir")
			|| key.includes("dir")
			|| key.includes("uri")
			|| key.includes("root")
			|| looksLikePath
		)
		{
			results.push(truncate(value.trim(), MAX_CONTEXT_VALUE_LEN));
		}
		return results;
	}

	if (Array.isArray(value))
	{
		// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.

		for (const item of value)
		{
			results.push(...collectPathLikeValues(item, parentKey));
		}
		return results;
	}

	const obj = asObject(value);
	if (!obj)
	{
		return results;
	}	// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.


	for (const [key, child] of Object.entries(obj))
	{
		results.push(...collectPathLikeValues(child, key));
	}

	return results;
}

/**
 * Handles extractApplyPatchPaths behavior for this CXC module.
 * @param input - Value consumed by extractApplyPatchPaths.
 * @returns Result produced by extractApplyPatchPaths.
 */
function extractApplyPatchPaths(input: string): string[]
{
	const matches = input.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s+(.+)$/gm);
	return [...matches]
		.map((m) => (m[1] ?? "").trim())
		.filter(Boolean)
		.map((p) => truncate(p, MAX_CONTEXT_VALUE_LEN));
}

/**
 * Handles dedupeStrings behavior for this CXC module.
 * @param values - Value consumed by dedupeStrings.
 * @param maxItems - Value consumed by dedupeStrings.
 * @returns Result produced by dedupeStrings.
 */
function dedupeStrings(values: string[], maxItems = MAX_CONTEXT_ITEMS): string[]
{
	const unique = new Set<string>();
	// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.

	for (const value of values)
	{
		const normalized = value.trim();
		if (!normalized)
		{
			continue;
		}
		unique.add(normalized);
		if (unique.size >= maxItems)
		{
			break;
		}
	}
	return [...unique];
}

/**
 * Handles extractToolContext behavior for this CXC module.
 * @param name - Value consumed by extractToolContext.
 * @param rawInput - Value consumed by extractToolContext.
 * @returns Result produced by extractToolContext.
 */
function extractToolContext(name: string, rawInput: unknown): string[]
{
	if (typeof rawInput === "string")
	{
		if (name === "apply_patch")
		{
			return dedupeStrings(extractApplyPatchPaths(rawInput));
		}

		const parsed = safeParseJsonString(rawInput);
		if (parsed)
		{
			const context = collectPathLikeValues(parsed);
			const obj = asObject(parsed);
			// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting harness ingest and source normalization from partial or invalid state.

			if (name === "shell_command" && obj)
			{
				const command = asString(obj.command);
				if (command)
				{
					context.unshift(`command: ${truncate(command, 180)}`);
				}
			}
			return dedupeStrings(context);
		}

		if (name === "shell_command")
		{
			return dedupeStrings([`command: ${truncate(rawInput, 180)}`]);
		}

		return [];
	}

	return dedupeStrings(collectPathLikeValues(rawInput));
}

/**
 * Handles normalizeToolOutput behavior for this CXC module.
 * @param value - Value consumed by normalizeToolOutput.
 * @returns Result produced by normalizeToolOutput.
 */
function normalizeToolOutput(value: unknown): string
{
	if (typeof value === "string")
	{
		return truncate(value.trim(), MAX_TOOL_OUTPUT_LEN);
	}	// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting harness ingest and source normalization from partial or invalid state.

	if (value === null || value === undefined)
	{
		return "";
	}
	try
	{
		return truncate(JSON.stringify(value), MAX_TOOL_OUTPUT_LEN);
	}
	catch
	{
		return "";
	}
}

/**
 * Resolves the value needed by resolveCodexRoot.
 * @param configuredPath - Path used by resolveCodexRoot to locate the relevant CXC resource.
 * @returns Result produced by resolveCodexRoot.
 */
function resolveCodexRoot(configuredPath: string): string | null
{
	const normalized = normalize(configuredPath).replace(/[\\/]+$/, "");
	return existsSync(normalized) ? normalized : null;
}

/**
 * Handles scanCodexSessionFiles behavior for this CXC module.
 * @param rootPath - Path used by scanCodexSessionFiles to locate the relevant CXC resource.
 * @returns Result produced by scanCodexSessionFiles.
 */
function scanCodexSessionFiles(rootPath: string): string[]
{
	if (!existsSync(rootPath))
	{
		return [];
	}

	const results: string[] = [];
	const queue: string[] = [rootPath];
	// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.


	while (queue.length > 0)
	{
		const current = queue.pop()!;
		let entries: Array<import("fs").Dirent<string>> = [];
		try
		{
			entries = readdirSync(current, { withFileTypes: true, encoding: "utf8" });
		}
		catch
		{
			continue;
		}		// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.


		for (const entry of entries)
		{
			const entryName = String(entry.name);
			const fullPath = join(current, entryName);
			if (entry.isDirectory())
			{
				queue.push(fullPath);
				continue;
			}
			if (!entry.isFile())
			{
				continue;
			}
			if (!entryName.toLowerCase().endsWith(".jsonl"))
			{
				continue;
			}
			if (!entryName.toLowerCase().startsWith("rollout-"))
			{
				continue;
			}
			results.push(fullPath);
		}
	}

	return results.sort();
}

/**
 * Parses input into the shape expected by parseSessionMeta.
 * @param lines - Value consumed by parseSessionMeta.
 * @returns Result produced by parseSessionMeta.
 */
function parseSessionMeta(lines: string[]): SessionMeta
{
	const fallbackSessionId = "";
	const meta: SessionMeta = {
		sessionId: fallbackSessionId,
		cwd: null,
		modelProvider: null,
		startedAt: null,
	};
	// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.


	for (const line of lines)
	{
		const trimmed = line.trim();
		if (!trimmed)
		{
			continue;
		}

		let record: JsonRecord;
		try
		{
			record = JSON.parse(trimmed) as JsonRecord;
		}
		catch
		{
			continue;
		}

		if (record.type !== "session_meta")
		{
			continue;
		}

		const payload = asObject(record.payload);
		if (!payload)
		{
			break;
		}

		meta.sessionId = asString(payload.id) ?? fallbackSessionId;
		meta.cwd = asString(payload.cwd);
		meta.modelProvider = asString(payload.model_provider);
		const payloadTimestamp = asString(payload.timestamp);
		if (payloadTimestamp)
		{
			const dt = parseIsoOrNow(payloadTimestamp);
			meta.startedAt = dt.isValid ? dt : null;
		}
		break;
	}

	return meta;
}

/**
 * Handles toToolCall behavior for this CXC module.
 * @param call - Value consumed by toToolCall.
 * @returns Result produced by toToolCall.
 */
function toToolCall(call: PendingToolCall): ToolCall
{
	return {
		name: call.name,
		context: [...call.context],
		results: dedupeStrings(call.results, MAX_CONTEXT_ITEMS),
	};
}

/**
 * Reads data for readCodexSessionFilesFromList without changing unrelated CXC state.
 * @param resolvedRoot - Value consumed by readCodexSessionFilesFromList.
 * @param rawBase - Value consumed by readCodexSessionFilesFromList.
 * @param sessionFiles - Session identifier or session data used by readCodexSessionFilesFromList.
 * @returns Result produced by readCodexSessionFilesFromList.
 */
function readCodexSessionFilesFromList(
	resolvedRoot: string,
	rawBase: string,
	sessionFiles: string[]
): AgentMessage[]
{
	logger.debug(`scan root=${resolvedRoot} rolloutFiles=${sessionFiles.length}`);
	if (sessionFiles.length === 0)
	{
		logger.debug(`No rollout JSONL files found under ${resolvedRoot}`);
		return [];
	}

	const rawProject = deriveProjectName("Codex", resolvedRoot);
	const results: AgentMessage[] = [];
	let skippedCount = 0;
	let malformedLineCount = 0;
	let emptySessionCount = 0;
	// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.


	for (const filePath of sessionFiles)
	{
		const rolloutBasename = basename(filePath);
		logger.silly(`session mark file=${rolloutBasename}`);

		if (isSourceFileCached(filePath, rawBase, rawProject))
		{
			skippedCount++;
			logger.silly(`session skipped (cached) file=${rolloutBasename} cacheProject=${rawProject}`);
			continue;
		}

		let rawText = "";
		try
		{
			rawText = readFileSync(filePath, "utf-8");
		}
		catch (err)
		{
			logger.debug(`session read failed file=${rolloutBasename} err=${String(err)}`);
			continue;
		}

		const lines = rawText.split(/\r?\n/);
		const sessionMeta = parseSessionMeta(lines);
		const sessionId = sessionMeta.sessionId || basename(filePath, ".jsonl");
		logger.silly(`session parsing file=${rolloutBasename} sessionId=${sessionId} cwd=${sessionMeta.cwd ?? "(none)"}`);
		const project = sessionMeta.cwd
			? deriveProjectName("Codex", sessionMeta.cwd)
			: deriveProjectName("Codex", dirname(filePath));
		const rawDest = copyRawSourceFile(rawBase, rawProject, filePath);

		const turnModels = new Map<string, string>();
		const turnOrder: string[] = [];
		const turnCalls = new Map<string, Map<string, PendingToolCall>>();
		const allCallsById = new Map<string, PendingToolCall>();
		const waitingOutputs = new Map<string, string[]>();
		const orphanCalls: PendingToolCall[] = [];
		const staged: StagedMessage[] = [];

		let activeTurnId: string | null = null;
		let order = 0;
		// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.


		for (const line of lines)
		{
			const trimmed = line.trim();
			if (!trimmed)
			{
				continue;
			}

			let record: JsonRecord;
			try
			{
				record = JSON.parse(trimmed) as JsonRecord;
			}
			catch
			{
				malformedLineCount++;
				continue;
			}

			const dateTime = parseIsoOrNow(record.timestamp);

			if (record.type === "turn_context")
			{
				const payload = asObject(record.payload);
				if (!payload)
				{
					continue;
				}
				const turnId = asString(payload.turn_id);
				const model = asString(payload.model);
				// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting harness ingest and source normalization from partial or invalid state.

				if (turnId && model)
				{
					turnModels.set(turnId, model);
				}
				continue;
			}

			if (record.type === "event_msg")
			{
				const payload = asObject(record.payload);
				if (!payload)
				{
					continue;
				}
				const eventType = asString(payload.type);
				if (!eventType)
				{
					continue;
				}

				if (eventType === "task_started")
				{
					const turnId = asString(payload.turn_id);
					if (turnId)
					{
						activeTurnId = turnId;
						if (!turnCalls.has(turnId))
						{
							turnCalls.set(turnId, new Map());
							turnOrder.push(turnId);
						}
					}
					continue;
				}				// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting harness ingest and source normalization from partial or invalid state.


				if (eventType === "task_complete" || eventType === "turn_aborted")
				{
					const turnId = asString(payload.turn_id);
					// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting harness ingest and source normalization from partial or invalid state.

					if (turnId && activeTurnId === turnId)
					{
						activeTurnId = null;
					}
					continue;
				}

				if (eventType === "user_message")
				{
					const text = normalizeText(payload.message);
					// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting harness ingest and source normalization from partial or invalid state.

					if (!text || isWrapperText(text))
					{
						continue;
					}

					staged.push({
						order: order++,
						turnId: activeTurnId,
						role: "user",
						phase: null,
						message: text,
						dateTime,
						model: null,
						toolCalls: [],
					});
					continue;
				}

				if (eventType === "agent_message")
				{
					const text = normalizeText(payload.message);
					if (!text)
					{
						continue;
					}

					staged.push({
						order: order++,
						turnId: activeTurnId,
						role: "assistant",
						phase: asString(payload.phase),
						message: text,
						dateTime,
						model: null,
						toolCalls: [],
					});
				}

				continue;
			}

			if (record.type !== "response_item")
			{
				continue;
			}

			const payload = asObject(record.payload);
			if (!payload)
			{
				continue;
			}
			const payloadType = asString(payload.type);
			if (!payloadType)
			{
				continue;
			}

			const isToolCall = payloadType === "function_call" || payloadType === "custom_tool_call";
			if (isToolCall)
			{
				const callId = asString(payload.call_id);
				if (!callId)
				{
					continue;
				}

				if (allCallsById.has(callId))
				{
					continue;
				}

				const name = asString(payload.name) ?? "unknownTool";
				const rawInput = payloadType === "function_call" ? payload.arguments : payload.input;
				const context = new Set<string>(extractToolContext(name, rawInput));
				const pending: PendingToolCall = {
					callId,
					turnId: activeTurnId,
					name,
					context,
					results: [],
					order,
				};

				const bufferedResults = waitingOutputs.get(callId);
				if (bufferedResults)
				{
					// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.

					for (const output of bufferedResults)
					{
						if (output)
						{
							pending.results.push(output);
						}
					}
					waitingOutputs.delete(callId);
				}

				allCallsById.set(callId, pending);

				if (activeTurnId)
				{
					if (!turnCalls.has(activeTurnId))
					{
						turnCalls.set(activeTurnId, new Map());
						turnOrder.push(activeTurnId);
					}
					turnCalls.get(activeTurnId)!.set(callId, pending);
				}
				else
				{
					orphanCalls.push(pending);
				}

				continue;
			}

			const isToolOutput = payloadType === "function_call_output" || payloadType === "custom_tool_call_output";
			if (!isToolOutput)
			{
				continue;
			}

			const callId = asString(payload.call_id);
			if (!callId)
			{
				continue;
			}
			const output = normalizeToolOutput(payload.output);
			if (!output)
			{
				continue;
			}

			const existing = allCallsById.get(callId);
			if (existing)
			{
				existing.results.push(output);
			}
			else
			{
				if (!waitingOutputs.has(callId))
				{
					waitingOutputs.set(callId, []);
				}
				waitingOutputs.get(callId)!.push(output);
			}
		}		// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.


		// Assign model names to assistant staged messages.
		for (const message of staged)
		{
			if (message.role !== "assistant")
			{
				continue;
			}
			if (message.turnId)
			{
				message.model = turnModels.get(message.turnId) ?? sessionMeta.modelProvider ?? null;
			}
			else
			{
				message.model = sessionMeta.modelProvider ?? null;
			}
		}		// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.


		// Attach turn-level tool calls to the terminal assistant message in each turn.
		for (const turnId of turnOrder)
		{
			const callMap = turnCalls.get(turnId);
			// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting harness ingest and source normalization from partial or invalid state.

			if (!callMap || callMap.size === 0)
			{
				continue;
			}

			const assistantInTurn = staged
				.filter((m) => m.turnId === turnId && m.role === "assistant")
				.sort((a, b) => a.order - b.order);

			if (assistantInTurn.length === 0)
			{
				continue;
			}

			const finalAssistant = [...assistantInTurn]
				.reverse()
				.find((m) => m.phase === "final_answer")
				?? assistantInTurn[assistantInTurn.length - 1];

			const sortedCalls = [...callMap.values()].sort((a, b) => a.order - b.order);
			finalAssistant.toolCalls.push(...sortedCalls.map(toToolCall));
		}

		// Fallback: attach orphan tool calls to the last assistant message in the session.
		if (orphanCalls.length > 0)
		{
			const lastAssistant = [...staged].reverse().find((m) => m.role === "assistant");
			if (lastAssistant)
			{
				const sortedOrphans = [...orphanCalls].sort((a, b) => a.order - b.order);
				lastAssistant.toolCalls.push(...sortedOrphans.map(toToolCall));
			}
		}

		// Emit AgentMessages in canonical order.
		const emitted: AgentMessage[] = staged
			.sort((a, b) => a.order - b.order)
			.map((entry) =>
			{
				const millis = entry.dateTime.isValid ? entry.dateTime.toMillis() : entry.order;
				const id = generateMessageId(sessionId, entry.role, millis, entry.message.slice(0, 120));
				return new AgentMessage({
					id,
					sessionId,
					harness: "Codex",
					machine: "",
					role: entry.role,
					model: entry.role === "assistant" ? entry.model : null,
					message: entry.message,
					subject: "",
					context: [],
					symbols: [],
					history: [],
					tags: [],
					project,
					parentId: null,
					tokenUsage: null,
					toolCalls: entry.toolCalls,
					rationale: [],
					source: rawDest,
					dateTime: entry.dateTime.isValid ? entry.dateTime : (sessionMeta.startedAt ?? DateTime.now()),
					length: entry.message.length,
				});
			});

		// Final deduplication by message id.
		const seen = new Set<string>();
		const deduped: AgentMessage[] = [];
		// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.

		for (const msg of emitted)
		{
			if (seen.has(msg.id))
			{
				continue;
			}
			seen.add(msg.id);
			deduped.push(msg);
		}

		// Parent chaining after dedup.
		let previousId: string | null = null;
		// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.

		for (const msg of deduped)
		{
			msg.parentId = previousId;
			previousId = msg.id;
		}

		if (deduped.length === 0)
		{
			emptySessionCount++;
			logger.debug(
				`session produced 0 messages file=${rolloutBasename} `
				+ `sessionId=${sessionId} staged=${staged.length} lines=${lines.length}`
			);
		}
		else
		{
			logger.silly(
				`session ingested file=${rolloutBasename} `
				+ `sessionId=${sessionId} messages=${deduped.length} project=${project}`
			);
		}

		results.push(...deduped);
	}

	logger.info(
		`Processed ${sessionFiles.length} files: `
		+ `${skippedCount} cached, `
		+ `${sessionFiles.length - skippedCount} new/modified, `
		+ `${results.length} messages`
	);

	if (malformedLineCount > 0)
	{
		logger.info(`Skipped ${malformedLineCount} malformed JSONL lines.`);
	}

	if (emptySessionCount > 0)
	{
		logger.debug(`${emptySessionCount} rollout file(s) produced zero AgentMessages`);
	}

	logger.debug(`readCodexChats done totalMessages=${results.length}`);

	return results;
}

/**
 * Reads data for readCodexChats without changing unrelated CXC state.
 * @param configuredPath - Path used by readCodexChats to locate the relevant CXC resource.
 * @param rawBase - Value consumed by readCodexChats.
 * @returns Result produced by readCodexChats.
 */
export function readCodexChats(configuredPath: string, rawBase: string): AgentMessage[]
{
	logger.debug(`readCodexChats configuredPath=${configuredPath} rawBase=${rawBase}`);

	const resolvedRoot = resolveCodexRoot(configuredPath);
	if (!resolvedRoot)
	{
		logger.debug(`Path not found: ${configuredPath} - skipping entire harness`);
		return [];
	}

	return readCodexSessionFilesFromList(resolvedRoot, rawBase, scanCodexSessionFiles(resolvedRoot));
}

/**
 * Reads data for readCodexChatFiles without changing unrelated CXC state.
 * @param filePaths - Path used by readCodexChatFiles to locate the relevant CXC resource.
 * @param rawBase - Value consumed by readCodexChatFiles.
 * @returns Result produced by readCodexChatFiles.
 */
export function readCodexChatFiles(filePaths: Array<string>, rawBase: string): AgentMessage[]
{
	const existingFiles = filePaths.filter((filePath) => existsSync(filePath));
	if (existingFiles.length === 0)
	{
		return [];
	}

	const commonRoot = dirname(existingFiles[0]);
	return readCodexSessionFilesFromList(commonRoot, rawBase, existingFiles);
}
