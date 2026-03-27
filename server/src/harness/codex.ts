/**
 * ContextCore - Codex harness.
 * Codex stores conversations as JSONL event logs under `.codex/sessions/...`.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, dirname, join, normalize } from "path";
import { DateTime } from "luxon";
import chalk from "chalk";
import { AgentMessage, type AgentRole } from "../models/AgentMessage.js";
import type { ToolCall } from "../types.js";
import { generateMessageId } from "../utils/hashId.js";
import { deriveProjectName } from "../utils/pathHelpers.js";
import { copyRawSourceFile, isSourceFileCached } from "../utils/rawCopier.js";

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

function asObject(value: unknown): Record<string, unknown> | null
{
	return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null
{
	return typeof value === "string" ? value : null;
}

function parseIsoOrNow(value: string | undefined): DateTime
{
	if (!value)
	{
		return DateTime.now();
	}
	const parsed = DateTime.fromISO(value);
	return parsed.isValid ? parsed : DateTime.now();
}

function normalizeText(value: unknown): string
{
	if (typeof value !== "string")
	{
		return "";
	}
	return value.trim();
}

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

function truncate(value: string, maxLen: number): string
{
	if (value.length <= maxLen)
	{
		return value;
	}
	return `${value.slice(0, maxLen)}…`;
}

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

function collectPathLikeValues(value: unknown, parentKey = ""): string[]
{
	const results: string[] = [];

	if (typeof value === "string")
	{
		const key = parentKey.toLowerCase();
		const looksLikePath = value.includes("\\") || value.includes("/") || value.includes(":");
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
	}

	for (const [key, child] of Object.entries(obj))
	{
		results.push(...collectPathLikeValues(child, key));
	}

	return results;
}

function extractApplyPatchPaths(input: string): string[]
{
	const matches = input.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s+(.+)$/gm);
	return [...matches]
		.map((m) => (m[1] ?? "").trim())
		.filter(Boolean)
		.map((p) => truncate(p, MAX_CONTEXT_VALUE_LEN));
}

function dedupeStrings(values: string[], maxItems = MAX_CONTEXT_ITEMS): string[]
{
	const unique = new Set<string>();
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

function normalizeToolOutput(value: unknown): string
{
	if (typeof value === "string")
	{
		return truncate(value.trim(), MAX_TOOL_OUTPUT_LEN);
	}
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

function resolveCodexRoot(configuredPath: string): string | null
{
	const normalized = normalize(configuredPath).replace(/[\\/]+$/, "");
	return existsSync(normalized) ? normalized : null;
}

function scanCodexSessionFiles(rootPath: string): string[]
{
	if (!existsSync(rootPath))
	{
		return [];
	}

	const results: string[] = [];
	const queue: string[] = [rootPath];

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
		}

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

function parseSessionMeta(lines: string[]): SessionMeta
{
	const fallbackSessionId = "";
	const meta: SessionMeta = {
		sessionId: fallbackSessionId,
		cwd: null,
		modelProvider: null,
		startedAt: null,
	};

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

function toToolCall(call: PendingToolCall): ToolCall
{
	return {
		name: call.name,
		context: [...call.context],
		results: dedupeStrings(call.results, MAX_CONTEXT_ITEMS),
	};
}

export function readCodexChats(configuredPath: string, rawBase: string): AgentMessage[]
{
	const resolvedRoot = resolveCodexRoot(configuredPath);
	if (!resolvedRoot)
	{
		console.log(chalk.yellow(`[Codex] Path not found: ${configuredPath} - skipping`));
		return [];
	}

	const sessionFiles = scanCodexSessionFiles(resolvedRoot);
	if (sessionFiles.length === 0)
	{
		console.log(chalk.yellow(`[Codex] No rollout JSONL files found under ${resolvedRoot}`));
		return [];
	}

	const rawProject = deriveProjectName("Codex", resolvedRoot);
	const results: AgentMessage[] = [];
	let skippedCount = 0;
	let malformedLineCount = 0;

	for (const filePath of sessionFiles)
	{
		if (isSourceFileCached(filePath, rawBase, rawProject))
		{
			skippedCount++;
			continue;
		}

		let rawText = "";
		try
		{
			rawText = readFileSync(filePath, "utf-8");
		}
		catch
		{
			continue;
		}

		const lines = rawText.split(/\r?\n/);
		const sessionMeta = parseSessionMeta(lines);
		const sessionId = sessionMeta.sessionId || basename(filePath, ".jsonl");
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
				}

				if (eventType === "task_complete" || eventType === "turn_aborted")
				{
					const turnId = asString(payload.turn_id);
					if (turnId && activeTurnId === turnId)
					{
						activeTurnId = null;
					}
					continue;
				}

				if (eventType === "user_message")
				{
					const text = normalizeText(payload.message);
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
		}

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
		}

		// Attach turn-level tool calls to the terminal assistant message in each turn.
		for (const turnId of turnOrder)
		{
			const callMap = turnCalls.get(turnId);
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
		for (const msg of deduped)
		{
			msg.parentId = previousId;
			previousId = msg.id;
		}

		results.push(...deduped);
	}

	console.log(
		`[Codex] Processed ${sessionFiles.length} files: `
		+ `${chalk.green(`${skippedCount} cached`)}, `
		+ `${chalk.blue(`${sessionFiles.length - skippedCount} new/modified`)}, `
		+ `${chalk.magenta(`${results.length} messages`)}`
	);

	if (malformedLineCount > 0)
	{
		console.log(chalk.yellow(`[Codex] Skipped ${malformedLineCount} malformed JSONL lines.`));
	}

	return results;
}
