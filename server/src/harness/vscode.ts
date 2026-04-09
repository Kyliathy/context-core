/**
 * ContextCore – VS Code harness.
 * Reads chat sessions from both full JSON and incremental JSONL formats.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, join } from "path";
import { DateTime } from "luxon";
import chalk from "chalk";
import { AgentMessage } from "../models/AgentMessage.js";
import type { ToolCall } from "../types.js";
import { generateMessageId } from "../utils/hashId.js";
import { deriveProjectName } from "../utils/pathHelpers.js";
import { copyRawSourceFile, isSourceFileCached } from "../utils/rawCopier.js";
import { resolveVSCodeWorkspaceMetadata } from "../utils/vscodeWorkspace.js";

type VSCodeVariable = {
	kind?: string;
	value?: {
		fsPath?: string;
	};
};

type VSCodeRequest = {
	message?: {
		text?: string;
		parts?: Array<{ text?: string }>;
	};
	response?: Array<{ kind?: string; value?: string }>;
	inputState?: {
		attachments?: Array<{ kind?: string; value?: { fsPath?: string } }>;
	};
	variableData?: {
		variables?: Array<VSCodeVariable>;
	};
	result?: {
		details?: string;
		metadata?: {
			sessionId?: string;
			toolCallRounds?: Array<{
				toolCalls?: Array<{
					toolId?: string;
					resultDetails?: Array<{ uri?: string }>;
					pastTenseMessage?: { value?: string } | string;
				}>;
			}>;
		};
	};
	modelId?: string;
	timestamp?: number;
};

type VSCodeSessionJson = {
	requests?: Array<VSCodeRequest>;
	sessionId?: string;
};

type VSCodeJsonlEntry = {
	kind?: number;
	k?: Array<string | number>;
	v?: unknown;
};

type JsonlToolPatch = {
	requestIndex: number | null;
	toolCalls: Array<ToolCall>;
};

/**
 * Resolves a friendly workspace project name from `workspace.json`.
 * @param storagePath - VSCode workspaceStorage hash directory.
 */
function resolveVSCodeProjectName(storagePath: string): string
{
	const meta = resolveVSCodeWorkspaceMetadata(storagePath);
	if (meta.workspaceMetaStatus === "ok" && meta.workspacePath)
	{
		return deriveProjectName("VSCode", meta.workspacePath);
	}

	return deriveProjectName("VSCode", storagePath);
}

/**
 * Scans `chatSessions/` and separates `.json` and `.jsonl` files.
 * @param storagePath - VS Code workspaceStorage hash path.
 */
function scanVSCodeChatSessionFiles(storagePath: string):
	{
		jsonFiles: Array<string>;
		jsonlFiles: Array<string>;
	}
{
	const chatSessionsPath = join(storagePath, "chatSessions");
	if (!existsSync(chatSessionsPath))
	{
		return { jsonFiles: [], jsonlFiles: [] };
	}

	try
	{
		const entries = readdirSync(chatSessionsPath, { withFileTypes: true });
		const jsonFiles = entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
			.map((entry) => join(chatSessionsPath, entry.name));
		const jsonlFiles = entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
			.map((entry) => join(chatSessionsPath, entry.name));

		return { jsonFiles, jsonlFiles };
	} catch
	{
		return { jsonFiles: [], jsonlFiles: [] };
	}
}

/**
 * Extracts file-path context references from VS Code request variables.
 * @param request - One request item from VS Code chat session JSON.
 */
function extractVSCodeContext(request: VSCodeRequest): Array<string>
{
	const variablePaths = (request.variableData?.variables ?? [])
		.filter((variable) => variable.kind === "file" && typeof variable.value?.fsPath === "string")
		.map((variable) => variable.value?.fsPath ?? "");
	const attachmentPaths = (request.inputState?.attachments ?? [])
		.filter((attachment) => attachment.kind === "file" && typeof attachment.value?.fsPath === "string")
		.map((attachment) => attachment.value?.fsPath ?? "");

	return Array.from(new Set([...variablePaths, ...attachmentPaths].filter(Boolean)));
}

/**
 * Transforms VS Code metadata toolCallRounds into ToolCall objects.
 * @param request - One request object from the session payload.
 */
function extractVSCodeToolCallsFromRequest(request: VSCodeRequest): Array<ToolCall>
{
	const rounds = request.result?.metadata?.toolCallRounds ?? [];
	const calls: Array<ToolCall> = [];

	for (const round of rounds)
	{
		for (const call of round.toolCalls ?? [])
		{
			const results: Array<string> = [];
			const pastTense = call.pastTenseMessage;
			if (typeof pastTense === "string")
			{
				results.push(pastTense);
			} else if (typeof pastTense?.value === "string")
			{
				results.push(pastTense.value);
			}

			calls.push({
				name: call.toolId ?? "unknownTool",
				context: (call.resultDetails ?? [])
					.map((detail) => detail.uri ?? "")
					.filter(Boolean),
				results,
			});
		}
	}

	return calls;
}

/**
 * Recursively collects toolInvocationSerialized payloads from arbitrary JSON.
 * @param value - Unknown object tree from VS Code kind:2 patches.
 */
function collectToolInvocationPayloads(value: unknown): Array<Record<string, unknown>>
{
	const collected: Array<Record<string, unknown>> = [];
	const stack: Array<unknown> = [value];

	while (stack.length > 0)
	{
		const current = stack.pop();
		if (!current || typeof current !== "object")
		{
			continue;
		}
		if (Array.isArray(current))
		{
			for (let i = current.length - 1; i >= 0; i -= 1)
			{
				stack.push(current[i]);
			}
			continue;
		}

		const obj = current as Record<string, unknown>;
		if (obj.kind === "toolInvocationSerialized")
		{
			collected.push(obj);
		}
		for (const child of Object.values(obj))
		{
			stack.push(child);
		}
	}

	return collected;
}

/**
 * Builds ToolCall objects from incremental kind:2 response patch rows.
 * @param entries - Parsed JSONL rows.
 */
function extractToolCallsFromKind2(entries: Array<VSCodeJsonlEntry>): Array<JsonlToolPatch>
{
	const patches: Array<JsonlToolPatch> = [];

	for (const entry of entries)
	{
		if (entry.kind !== 2)
		{
			continue;
		}

		const requestIndex =
			typeof entry.k?.[1] === "number"
				? (entry.k?.[1] as number)
				: null;
		const payloads = collectToolInvocationPayloads(entry.v);
		const toolCalls: Array<ToolCall> = payloads.map((payload) =>
		{
			const resultDetails = Array.isArray(payload.resultDetails)
				? (payload.resultDetails as Array<{ uri?: string }>)
				: [];
			const past = payload.pastTenseMessage as { value?: string } | string | undefined;
			const results: Array<string> = [];

			if (typeof past === "string")
			{
				results.push(past);
			} else if (typeof past?.value === "string")
			{
				results.push(past.value);
			}

			return {
				name: (payload.toolId as string | undefined) ?? "unknownTool",
				context: resultDetails.map((item) => item.uri ?? "").filter(Boolean),
				results,
			};
		});

		if (toolCalls.length > 0)
		{
			patches.push({ requestIndex, toolCalls });
		}
	}

	return patches;
}

/**
 * Appends array items at the path specified by a kind:2 patch row.
 * @param root - Mutable session reconstruction object.
 * @param path - Key path from the kind:2 entry.
 * @param items - Array of items to append at the path.
 */
function appendByPath(root: Record<string, unknown>, path: Array<string | number>, items: unknown[]): void
{
	if (path.length === 0)
	{
		return;
	}

	let current: unknown = root;
	for (const segment of path)
	{
		if (current === undefined || current === null)
		{
			return;
		}
		if (typeof segment === "number")
		{
			if (!Array.isArray(current))
			{
				return;
			}
			current = current[segment];
		} else
		{
			current = (current as Record<string, unknown>)[segment];
		}
	}

	if (Array.isArray(current))
	{
		current.push(...items);
	}
}

/**
 * Writes a value into a nested object using a key path Array.
 * @param root - Mutable session reconstruction object.
 * @param path - Path from kind:1 patch row.
 * @param value - Value to set at the path.
 */
function setByPath(root: Record<string, unknown>, path: Array<string | number>, value: unknown): void
{
	if (path.length === 0)
	{
		return;
	}

	let current: unknown = root;
	for (let i = 0; i < path.length - 1; i += 1)
	{
		const segment = path[i];
		const nextSegment = path[i + 1];
		if (typeof segment === "number")
		{
			if (!Array.isArray(current))
			{
				return;
			}
			if (current[segment] === undefined)
			{
				current[segment] = typeof nextSegment === "number" ? [] : {};
			}
			current = current[segment];
		} else
		{
			const obj = current as Record<string, unknown>;
			if (!(segment in obj) || obj[segment] === undefined || obj[segment] === null)
			{
				obj[segment] = typeof nextSegment === "number" ? [] : {};
			}
			current = obj[segment];
		}
	}

	const final = path[path.length - 1];
	if (typeof final === "number")
	{
		if (Array.isArray(current))
		{
			current[final] = value;
		}
	} else
	{
		(current as Record<string, unknown>)[final] = value;
	}
}

/**
 * Reconstructs a JSON-like session object from VS Code incremental JSONL rows.
 * @param filePath - path to a VS Code `chatSessions/*.jsonl` file.
 */
function reconstructVSCodeJsonlSession(filePath: string):
	{
		reconstructed: VSCodeSessionJson;
		toolPatches: Array<JsonlToolPatch>;
	}
{
	const rows = readFileSync(filePath, "utf-8").split(/\r?\n/).filter(Boolean);
	const entries: Array<VSCodeJsonlEntry> = [];

	for (const row of rows)
	{
		try
		{
			entries.push(JSON.parse(row) as VSCodeJsonlEntry);
		} catch
		{
			//Skip malformed rows.
		}
	}

	const firstSkeleton = entries.find((entry) => entry.kind === 0);
	const reconstructed = ((firstSkeleton?.v as VSCodeSessionJson) ?? {}) as VSCodeSessionJson;
	const mutable = reconstructed as unknown as Record<string, unknown>;

	for (const entry of entries)
	{
		if (!Array.isArray(entry.k))
		{
			continue;
		}

		if (entry.kind === 1)
		{
			setByPath(mutable, entry.k, entry.v);
		}
		else if (entry.kind === 2 && Array.isArray(entry.v))
		{
			appendByPath(mutable, entry.k, entry.v as unknown[]);
		}
	}

	return {
		reconstructed,
		toolPatches: extractToolCallsFromKind2(entries),
	};
}

/**
 * Parses JSONL reconstruction output as if it were a classic session JSON.
 * @param filePath - path to a VS Code `chatSessions/*.jsonl` file.
 * @param project - Project name derived from workspaceStorage path.
 */
function parseVSCodeJsonlFile(filePath: string, project: string): Array<AgentMessage>
{
	const rebuilt = reconstructVSCodeJsonlSession(filePath);
	const tempJsonPath = `${filePath}.reconstructed.json`;
	const messages = parseVSCodeJsonObject(tempJsonPath, rebuilt.reconstructed, project);

	//Apply incremental tool patches only for assistant messages that have no
	//tool calls from the primary result.metadata extraction path.
	for (const patch of rebuilt.toolPatches)
	{
		const assistantMessages = messages.filter((message) => message.role === "assistant");
		if (assistantMessages.length === 0)
		{
			continue;
		}

		const target =
			patch.requestIndex !== null && assistantMessages[patch.requestIndex]
				? assistantMessages[patch.requestIndex]
				: assistantMessages[assistantMessages.length - 1];
		if (target.toolCalls.length === 0)
		{
			target.toolCalls.push(...patch.toolCalls);
		}
	}

	return messages;
}

/**
 * Shared parser body used by both `.json` and reconstructed `.jsonl`.
 * @param sourceId - Source identifier for fallback session IDs.
 * @param parsed - Parsed session object.
 * @param project - Project name derived from workspaceStorage path.
 */
function parseVSCodeJsonObject(
	sourceId: string,
	parsed: VSCodeSessionJson,
	project: string
): Array<AgentMessage>
{
	const requests = parsed.requests ?? [];
	const sourceMtimeMs = sourceId.endsWith(".json") || sourceId.endsWith(".jsonl")
		? statSync(sourceId.replace(".reconstructed.json", "")).mtimeMs
		: Date.now();
	const fileMtime = DateTime.fromMillis(sourceMtimeMs);
	const messages: Array<AgentMessage> = [];

	for (let i = 0; i < requests.length; i += 1)
	{
		const request = requests[i];
		if (!request || typeof request !== "object")
		{
			continue;
		}
		const fallbackUserText = (request.message?.parts ?? [])
			.map((part) => part.text ?? "")
			.join("\n")
			.trim();
		const userMessage = request.message?.text ?? fallbackUserText;

		//Separate response items by kind: thinking entries → rationale, text entries → assistant message.
		const responseItems = request.response ?? [];
		const rationale: string[] = [];
		const textParts: string[] = [];

		for (const entry of responseItems)
		{
			if (entry.kind === "thinking")
			{
				const thinkingText = typeof entry.value === "string" ? entry.value.trim() : "";
				if (thinkingText)
				{
					rationale.push(thinkingText);
				}
			}
			else if (!entry.kind || entry.kind === "text" || entry.kind === "inlineReference")
			{
				const text = typeof entry.value === "string" ? entry.value.trim() : "";
				if (text)
				{
					textParts.push(text);
				}
			}
			//Skip non-text kinds: toolInvocationSerialized, prepareToolInvocation,
			//undoStop, codeblockUri, textEditGroup, mcpServersStarting, etc.
		}

		const assistantMessage = textParts.join("\n").trim();
		const context = extractVSCodeContext(request);

		//Prefer modelId (from kind:2 request patch) over result.details parsing.
		const details = request.result?.details ?? "";
		const modelFromDetails = details.split(" • ")[0]?.trim() || null;
		const model = request.modelId ?? modelFromDetails;

		//Use request timestamp when available (precise per-turn time).
		const dateTime = request.timestamp
			? DateTime.fromMillis(request.timestamp)
			: fileMtime;

		const toolCalls = extractVSCodeToolCallsFromRequest(request);
		const fallbackSessionId = basename(sourceId).replace(/\.reconstructed\.json$/, "").replace(/\.(json|jsonl)$/, "");
		const sessionId =
			request.result?.metadata?.sessionId ?? parsed.sessionId ?? fallbackSessionId;

		const userId = generateMessageId(sessionId, "user", `${dateTime.toMillis()}-${i}-u`, userMessage.slice(0, 120));
		const assistantId = generateMessageId(
			sessionId,
			"assistant",
			`${dateTime.toMillis()}-${i}-a`,
			assistantMessage.slice(0, 120)
		);

		messages.push(
			new AgentMessage({
				id: userId,
				sessionId,
				harness: "VSCode",
				machine: "",
				role: "user",
				model: null,
				message: userMessage,
				subject: "",
				context,
				symbols: [],
				history: [],
				tags: [],
				project,
				parentId: null,
				tokenUsage: null,
				toolCalls: [],
				rationale: [],
				source: "",
				dateTime,
				length: userMessage.length,
			})
		);

		messages.push(
			new AgentMessage({
				id: assistantId,
				sessionId,
				harness: "VSCode",
				machine: "",
				role: "assistant",
				model,
				message: assistantMessage,
				subject: "",
				context,
				symbols: [],
				history: [],
				tags: [],
				project,
				parentId: userId,
				tokenUsage: null,
				toolCalls,
				rationale,
				source: "",
				dateTime,
				length: assistantMessage.length,
			})
		);
	}

	return messages;
}

/**
 * Reads normalized AgentMessages from VS Code workspace storage.
 * @param storagePath - path to `workspaceStorage/<hash>/`.
 * @param rawBase - Raw archive directory for this harness (`{storage}/{machine}-RAW/VSCode/`).
 */
export function readVSCodeChats(storagePath: string, rawBase: string): Array<AgentMessage>
{
	const { jsonFiles, jsonlFiles } = scanVSCodeChatSessionFiles(storagePath);
	const project = resolveVSCodeProjectName(storagePath);
	const results: Array<AgentMessage> = [];
	let skippedCount = 0;

	for (const jsonPath of jsonFiles)
	{
		// Skip processing if file is already cached (same size and mtime)
		if (isSourceFileCached(jsonPath, rawBase, project))
		{
			skippedCount++;
			continue;
		}

		try
		{
			const raw = readFileSync(jsonPath, "utf-8");
			const parsed = JSON.parse(raw) as VSCodeSessionJson;
			const messages = parseVSCodeJsonObject(jsonPath, parsed, project);
			const rawDest = copyRawSourceFile(rawBase, project, jsonPath);
			for (const message of messages)
			{
				message.source = rawDest;
			}
			results.push(...messages);
		} catch
		{
			console.warn(`[VSCode] Skipping malformed chat JSON file: ${jsonPath}`);
		}
	}

	for (const jsonlPath of jsonlFiles)
	{
		// Skip processing if file is already cached (same size and mtime)
		if (isSourceFileCached(jsonlPath, rawBase, project))
		{
			skippedCount++;
			continue;
		}

		try
		{
			const messages = parseVSCodeJsonlFile(jsonlPath, project);
			const rawDest = copyRawSourceFile(rawBase, project, jsonlPath);
			for (const message of messages)
			{
				message.source = rawDest;
			}
			results.push(...messages);
		} catch (error)
		{
			console.warn(
				`[VSCode] Skipping malformed chat JSONL file: ${jsonlPath} (${(error as Error).message})`
			);
		}
	}

	const totalFiles = jsonFiles.length + jsonlFiles.length;
	console.log(`[VSCode] Processed ${totalFiles} files: ${chalk.green(skippedCount + ' cached')}, ${chalk.blue((totalFiles - skippedCount) + ' new/modified')}`);
	return results;
}
