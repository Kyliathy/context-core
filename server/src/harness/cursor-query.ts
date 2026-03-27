/**
 * ContextCore – Cursor IDE harness: SQLite query layer.
 * All functions that read from state.vscdb and parse raw Cursor payloads.
 */

import { Database } from "bun:sqlite";
import chalk from "chalk";
import { DateTime } from "luxon";
import { AgentMessage } from "../models/AgentMessage.js";
import { generateMessageId } from "../utils/hashId.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CursorMessageLike = {
	role: string;
	content: unknown;
	model: string | null;
	sessionHint: string;
	timestamp: string | number | null;
};

export type CursorWalkerState = {
	sessionHint: string;
	modelHint: string | null;
};

export type CursorRequestLike = {
	message?: {
		text?: string;
		parts?: Array<{ text?: string }>;
	};
	response?: Array<{ value?: string }>;
	variableData?: {
		variables?: Array<{ kind?: string; value?: { fsPath?: string } }>;
	};
	inputState?: {
		attachments?: Array<{ kind?: string; value?: { fsPath?: string } }>;
	};
	result?: {
		details?: string;
		metadata?: {
			sessionId?: string;
		};
	};
	timestamp?: number | string;
	modelId?: string;
};

export type CursorSessionLike = {
	sessionId?: string;
	creationDate?: number | string;
	selectedModel?: {
		identifier?: string;
		metadata?: {
			name?: string;
		};
	};
	inputState?: {
		selectedModel?: {
			identifier?: string;
			metadata?: {
				name?: string;
			};
		};
	};
	requests?: Array<CursorRequestLike>;
};

export type CursorKVRow = {
	key: string;
	value: unknown;
};

export type CursorBubbleRecord = {
	sessionId: string;
	bubbleId: string;
	role: "user" | "assistant";
	message: string;
	model: string | null;
	dateTime: DateTime;
	context: Array<string>;
};

// ---------------------------------------------------------------------------
// Shared constants (also used by cursor-matcher and cursor)
// ---------------------------------------------------------------------------

export const CUR = chalk.hex("#00CED1")("[Cursor]");
export const CUR_LINE = chalk.hex("#00CED1")("━".repeat(60));
export const CURSOR_PROGRESS_EVERY = 5000;

// ---------------------------------------------------------------------------
// Progress logging
// ---------------------------------------------------------------------------

/**
 * Logs ingest progress at regular intervals.
 * @param phase - Phase label for the progress message.
 * @param index - Current item index.
 * @param total - Total item count.
 */
export function logCursorProgress(phase: string, index: number, total: number): void
{
	if (index === 0 || index === total || index % CURSOR_PROGRESS_EVERY === 0)
	{
		console.log(`${CUR}${chalk.dim(`[${phase}]`)} ${index}/${total}`);
	}
}

// ---------------------------------------------------------------------------
// Raw value helpers
// ---------------------------------------------------------------------------

/**
 * Converts sqlite value payloads into safe string values.
 * @param value - Raw sqlite cell value.
 */
export function toDatabaseText(value: unknown): string
{
	if (typeof value === "string")
	{
		return value;
	}
	if (value === null || value === undefined)
	{
		return "";
	}
	if (value instanceof Uint8Array)
	{
		return new TextDecoder().decode(value);
	}
	return String(value);
}

/**
 * Picks a model candidate from a generic object.
 * @param value - Unknown object potentially containing model metadata.
 */
export function pickModel(value: unknown): string | null
{
	if (!value || typeof value !== "object")
	{
		return null;
	}

	const obj = value as Record<string, unknown>;
	const direct =
		(typeof obj.model === "string" && obj.model) ||
		(typeof obj.modelName === "string" && obj.modelName) ||
		(typeof obj.modelId === "string" && obj.modelId);
	if (direct)
	{
		return direct;
	}

	if (obj.selectedModel && typeof obj.selectedModel === "object")
	{
		const selected = obj.selectedModel as Record<string, unknown>;
		if (typeof selected.identifier === "string")
		{
			return selected.identifier;
		}
		if (selected.metadata && typeof selected.metadata === "object")
		{
			const metadata = selected.metadata as Record<string, unknown>;
			if (typeof metadata.name === "string")
			{
				return metadata.name;
			}
		}
	}

	return null;
}

/**
 * Converts unknown content payload into message text.
 * @param value - Raw message content payload.
 */
export function normalizeMessageText(value: unknown): string
{
	if (typeof value === "string")
	{
		return value;
	}
	if (Array.isArray(value))
	{
		return value.map((item) => normalizeMessageText(item)).filter(Boolean).join("\n").trim();
	}
	if (value && typeof value === "object")
	{
		const obj = value as Record<string, unknown>;
		if (typeof obj.text === "string")
		{
			return obj.text;
		}
		if (typeof obj.value === "string")
		{
			return obj.value;
		}
		return JSON.stringify(obj);
	}
	return "";
}

/**
 * Extracts simple file-path references from free text.
 * @param text - Message text payload.
 */
export function extractContextPaths(text: unknown): Array<string>
{
	if (typeof text !== "string")
	{
		return [];
	}
	const pathPattern = /(?:[a-zA-Z]:\\|\/)[^\s"'`]+/g;
	return Array.from(new Set(text.match(pathPattern) ?? []));
}

// ---------------------------------------------------------------------------
// Role and DateTime parsing
// ---------------------------------------------------------------------------

/**
 * Normalizes raw Cursor role values into AgentMessage roles.
 * @param rawRole - Raw role from Cursor payload.
 */
export function mapCursorRole(rawRole: string): "user" | "assistant" | "tool" | "system"
{
	const role = rawRole.toLowerCase();
	if (role.includes("assistant") || role === "bot" || role === "ai")
	{
		return "assistant";
	}
	if (role.includes("tool"))
	{
		return "tool";
	}
	if (role.includes("system"))
	{
		return "system";
	}
	return "user";
}

/**
 * Parses timestamps found in Cursor payloads.
 * @param timestamp - String/number timestamp candidate.
 */
export function parseCursorDateTime(timestamp: string | number | null): DateTime
{
	if (typeof timestamp === "number")
	{
		return timestamp > 10_000_000_000 ? DateTime.fromMillis(timestamp) : DateTime.fromSeconds(timestamp);
	}
	if (typeof timestamp === "string")
	{
		const numeric = Number(timestamp);
		if (!Number.isNaN(numeric))
		{
			return parseCursorDateTime(numeric);
		}
		const iso = DateTime.fromISO(timestamp);
		if (iso.isValid)
		{
			return iso;
		}
	}
	return DateTime.now();
}

/**
 * Parses timestamps for bubble/composer metadata without falling back to now.
 * Returns null for invalid or implausible values.
 * @param timestamp - String/number timestamp candidate.
 */
export function parseCursorDateTimeStrict(timestamp: string | number | null): DateTime | null
{
	if (typeof timestamp === "number")
	{
		const dt = timestamp > 10_000_000_000 ? DateTime.fromMillis(timestamp) : DateTime.fromSeconds(timestamp);
		if (!dt.isValid || dt.year < 2020)
		{
			return null;
		}
		return dt;
	}

	if (typeof timestamp === "string")
	{
		const trimmed = timestamp.trim();
		if (!trimmed)
		{
			return null;
		}

		const numeric = Number(trimmed);
		if (!Number.isNaN(numeric))
		{
			return parseCursorDateTimeStrict(numeric);
		}

		const iso = DateTime.fromISO(trimmed);
		if (!iso.isValid || iso.year < 2020)
		{
			return null;
		}
		return iso;
	}

	return null;
}

/**
 * Recursively scans an object for the first numeric value that looks like
 * a plausible epoch timestamp (seconds or milliseconds after 2020-01-01).
 */
export function findDeepTimestamp(obj: unknown, depth: number = 0): number | null
{
	if (depth > 4 || !obj || typeof obj !== "object")
	{
		return null;
	}

	if (Array.isArray(obj))
	{
		for (const item of obj)
		{
			const found = findDeepTimestamp(item, depth + 1);
			if (found !== null)
			{
				return found;
			}
		}
		return null;
	}

	const record = obj as Record<string, unknown>;
	const TIMESTAMP_FIELD_HINTS = /^(timestamp|time|created|updated|date|start|end|sent|complete|first)/i;
	for (const [key, value] of Object.entries(record))
	{
		if (typeof value === "number" && TIMESTAMP_FIELD_HINTS.test(key))
		{
			// Plausible epoch seconds (after 2020) or epoch milliseconds (after 2020).
			if ((value > 1_577_836_800 && value < 10_000_000_000) ||
				(value > 1_577_836_800_000 && value < 10_000_000_000_000))
			{
				return value;
			}
		}
		if (typeof value === "string" && TIMESTAMP_FIELD_HINTS.test(key))
		{
			const num = Number(value);
			if (!Number.isNaN(num) &&
				((num > 1_577_836_800 && num < 10_000_000_000) ||
					(num > 1_577_836_800_000 && num < 10_000_000_000_000)))
			{
				return num;
			}
			const iso = DateTime.fromISO(value);
			if (iso.isValid)
			{
				return iso.toMillis();
			}
		}
	}
	// Recurse into nested objects.
	for (const value of Object.values(record))
	{
		if (value && typeof value === "object")
		{
			const found = findDeepTimestamp(value, depth + 1);
			if (found !== null)
			{
				return found;
			}
		}
	}
	return null;
}

/**
 * Converts Cursor bubble type to normalized AgentMessage role.
 * @param bubbleType - Cursor bubble type numeric field.
 */
export function mapBubbleTypeToRole(bubbleType: unknown): "user" | "assistant" | null
{
	if (bubbleType === 1 || bubbleType === "1")
	{
		return "user";
	}
	if (bubbleType === 2 || bubbleType === "2")
	{
		return "assistant";
	}
	return null;
}

/**
 * Parses DateTime from Cursor bubble-like payloads.
 * @param parsed - Parsed bubble JSON object.
 */
export function parseCursorBubbleDateTime(parsed: Record<string, unknown>): DateTime | null
{
	const timingInfo =
		parsed.timingInfo && typeof parsed.timingInfo === "object"
			? (parsed.timingInfo as Record<string, unknown>)
			: null;
	const candidates: Array<unknown> = [
		parsed.timestamp,
		parsed.time,
		parsed.createdAt,
		parsed.updatedAt,
		timingInfo?.createdAt,
		timingInfo?.start,
		timingInfo?.startTime,
		timingInfo?.firstTokenAt,
		timingInfo?.requestStartTime,
		timingInfo?.requestSentAt,
		timingInfo?.completeAt,
		timingInfo?.endTime,
	];

	for (const candidate of candidates)
	{
		if (typeof candidate === "string" || typeof candidate === "number")
		{
			const parsedCandidate = parseCursorDateTimeStrict(candidate);
			if (parsedCandidate)
			{
				return parsedCandidate;
			}
		}
	}

	// Deep-scan: look for any numeric field that resembles an epoch timestamp.
	const deepTs = findDeepTimestamp(parsed);
	if (deepTs !== null)
	{
		return parseCursorDateTime(deepTs);
	}

	return null;
}

// ---------------------------------------------------------------------------
// Path extraction from raw values
// ---------------------------------------------------------------------------

/**
 * Recursively extracts path-like context references from unknown payloads.
 * @param value - Unknown object tree.
 * @param out - Mutable Set of path references.
 */
export function collectPathLikeValues(value: unknown, out: Set<string>): void
{
	if (Array.isArray(value))
	{
		for (const item of value)
		{
			collectPathLikeValues(item, out);
		}
		return;
	}
	if (!value || typeof value !== "object")
	{
		if (typeof value === "string")
		{
			for (const textPath of extractContextPaths(value))
			{
				out.add(textPath);
			}
		}
		return;
	}

	const obj = value as Record<string, unknown>;
	for (const [key, nested] of Object.entries(obj))
	{
		const lower = key.toLowerCase();
		if (
			(lower.includes("path") || lower.includes("uri") || lower.includes("file")) &&
			typeof nested === "string"
		)
		{
			const normalized = nested.replace(/^file:\/\//i, "");
			if (normalized.includes("/") || normalized.includes("\\"))
			{
				out.add(normalized);
			}
		}
		collectPathLikeValues(nested, out);
	}
}

// ---------------------------------------------------------------------------
// Key classification
// ---------------------------------------------------------------------------

/**
 * Builds a stable key family label for runtime diagnostics.
 * @param key - cursorDiskKV key.
 */
export function cursorKeyFamily(key: string): string
{
	if (key.startsWith("bubbleId:"))
	{
		return "bubbleId";
	}
	const [family] = key.split(":");
	return family || "unknown";
}

/**
 * Extracts session-like tokens from cursorDiskKV keys.
 * @param key - cursorDiskKV key.
 */
export function extractSessionHintsFromKey(key: string): Array<string>
{
	const hints = new Set<string>();
	const parts = key.split(":");
	if (parts[0] === "bubbleId" && parts[1])
	{
		hints.add(parts[1]);
	}

	const tokenPattern = /[A-Za-z0-9-]{16,}/g;
	for (const token of key.match(tokenPattern) ?? [])
	{
		if (!token.includes("bubbleId"))
		{
			hints.add(token);
		}
	}
	return Array.from(hints);
}

/**
 * Filters noisy Cursor DB keys that are unlikely to store chat payloads.
 * @param key - Candidate key from ItemTable.
 */
export function isCursorChatKeyCandidate(key: string): boolean
{
	const lower = key.toLowerCase();
	if (!lower.includes("chat") && !lower.includes("composer") && !lower.includes("conversation"))
	{
		return false;
	}

	const blockedPrefixes = [
		"aicodetracking.",
		"cursorai/",
		"cursor/",
		"workbench.contrib.",
		"workbench.view.",
		"workbench.services.",
		"memento/",
		"memento.",
	];
	if (blockedPrefixes.some((prefix) => lower.startsWith(prefix)))
	{
		return false;
	}
	if (lower.endsWith(".hidden"))
	{
		return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// SQLite model + timestamp map builders
// ---------------------------------------------------------------------------

/**
 * Builds a session-ID → model-name map from composerData entries.
 * @param db - Open SQLite database handle.
 */
export function buildCursorSessionModelMap(db: Database): Map<string, string>
{
	const map = new Map<string, string>();
	const rows = db
		.query<CursorKVRow, []>("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
		.all();

	for (const row of rows)
	{
		try
		{
			const sessionId = row.key.replace("composerData:", "");
			if (!sessionId)
			{
				continue;
			}
			const rawValue = toDatabaseText(row.value);
			if (!rawValue)
			{
				continue;
			}
			const parsed = JSON.parse(rawValue) as Record<string, unknown>;
			const modelConfig = parsed.modelConfig as { modelName?: string } | undefined;
			const modelName = modelConfig?.modelName;
			if (modelName && modelName !== "default")
			{
				map.set(sessionId, modelName);
			}
		} catch
		{
			// Skip malformed composerData entries.
		}
	}
	console.log(`${CUR} Session model map: ${chalk.green(map.size + '')} sessions with explicit model (from ${rows.length} composerData entries)`);
	return map;
}

/**
 * Builds a session-ID → DateTime map from composerData entries.
 * @param db - Open SQLite database handle.
 */
export function buildCursorSessionTimestampMap(db: Database): Map<string, DateTime>
{
	const map = new Map<string, DateTime>();
	const rows = db
		.query<CursorKVRow, []>("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
		.all();

	for (const row of rows)
	{
		try
		{
			const sessionId = row.key.replace("composerData:", "");
			if (!sessionId)
			{
				continue;
			}
			const rawValue = toDatabaseText(row.value);
			if (!rawValue)
			{
				continue;
			}
			const parsed = JSON.parse(rawValue) as Record<string, unknown>;
			const tsFields = [
				parsed.createdAt, parsed.updatedAt, parsed.timestamp,
				parsed.lastSendTime, parsed.creationDate, parsed.startTime,
			];
			let found = false;
			for (const candidate of tsFields)
			{
				if (typeof candidate === "string" || typeof candidate === "number")
				{
					const dt = parseCursorDateTimeStrict(candidate);
					if (dt)
					{
						map.set(sessionId, dt);
						found = true;
						break;
					}
				}
			}
			if (!found)
			{
				const deepTs = findDeepTimestamp(parsed);
				if (deepTs !== null)
				{
					const dt = parseCursorDateTime(deepTs);
					if (dt.isValid && dt.year >= 2020)
					{
						map.set(sessionId, dt);
					}
				}
			}
		} catch
		{
			// Skip malformed composerData entries.
		}
	}
	console.log(`${CUR} Session timestamp map: ${chalk.green(map.size + '')} sessions with timestamps (from ${rows.length} composerData entries)`);
	return map;
}

// ---------------------------------------------------------------------------
// Bubble extraction
// ---------------------------------------------------------------------------

/**
 * Parses bubbleId records from cursorDiskKV.
 * @param db - Open SQLite database handle.
 * @param sessionModelMap - Session-ID → model-name map from composerData.
 * @param sessionTimestampMap - Session-ID → DateTime fallback map.
 */
export function extractCursorBubbleMessages(
	db: Database,
	sessionModelMap: Map<string, string>,
	sessionTimestampMap: Map<string, DateTime>
): Array<CursorBubbleRecord>
{
	const rows = db.query<CursorKVRow, []>("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'").all();
	const records: Array<CursorBubbleRecord> = [];
	let dateNowFallbacks = 0;
	let sessionTsFallbacks = 0;
	let sampleBubbleFieldsLogged = false;
	console.log(`${CUR}${chalk.dim("[bubble-scan]")} rows=${rows.length}`);

	for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1)
	{
		const row = rows[rowIndex];
		logCursorProgress("bubble-scan", rowIndex, rows.length);
		const keyParts = row.key.split(":");
		if (keyParts.length < 3)
		{
			continue;
		}

		const sessionId = keyParts[1] || "cursor-session";
		const bubbleId = keyParts[2] || row.key;
		try
		{
			const rawValue = toDatabaseText(row.value);
			if (!rawValue)
			{
				continue;
			}
			const parsed = JSON.parse(rawValue) as Record<string, unknown>;

			if (!sampleBubbleFieldsLogged)
			{
				const fieldNames = Object.keys(parsed);
				console.log(`${CUR}${chalk.dim("[bubble-scan]")} Sample bubble fields: ${chalk.dim(fieldNames.join(", "))}`);
				sampleBubbleFieldsLogged = true;
			}

			const role = mapBubbleTypeToRole(parsed.type);
			if (!role)
			{
				continue;
			}

			const message = typeof parsed.text === "string" ? parsed.text.trim() : "";
			if (!message)
			{
				continue;
			}

			const model = pickModel(parsed) ?? sessionModelMap.get(sessionId) ?? null;
			let dateTime = parseCursorBubbleDateTime(parsed);
			if (dateTime === null)
			{
				const sessionTs = sessionTimestampMap.get(sessionId);
				if (sessionTs)
				{
					dateTime = sessionTs;
					sessionTsFallbacks += 1;
				}
				else
				{
					dateTime = DateTime.now();
					dateNowFallbacks += 1;
				}
			}
			const contextPaths = new Set<string>(extractContextPaths(message));
			collectPathLikeValues(parsed.context, contextPaths);
			collectPathLikeValues(parsed.codeBlocks, contextPaths);
			collectPathLikeValues(parsed.toolResults, contextPaths);

			records.push({
				sessionId,
				bubbleId,
				role,
				message,
				model,
				dateTime,
				context: Array.from(contextPaths),
			});
		} catch
		{
			//<Skip malformed bubble payloads.
		}
	}
	logCursorProgress("bubble-scan", rows.length, rows.length);
	if (sessionTsFallbacks > 0)
	{
		console.warn(`${CUR} ${chalk.yellow(sessionTsFallbacks + '')} bubbles used session-level timestamp fallback (no per-bubble timestamp)`);
	}
	if (dateNowFallbacks > 0)
	{
		console.warn(`${CUR} ${chalk.red("WARNING:")} ${chalk.red(dateNowFallbacks + '')} bubbles fell back to DateTime.now() — these messages will appear dated to today`);
	}

	records.sort((a, b) =>
	{
		const timeDiff = a.dateTime.toMillis() - b.dateTime.toMillis();
		if (timeDiff !== 0)
		{
			return timeDiff;
		}
		return a.bubbleId.localeCompare(b.bubbleId);
	});

	return records;
}

// ---------------------------------------------------------------------------
// Request-like extraction
// ---------------------------------------------------------------------------

/**
 * Extracts file context from VSCode/Cursor-like request payloads.
 * @param request - Cursor request-like node.
 */
export function extractRequestContextPaths(request: CursorRequestLike): Array<string>
{
	const variablePaths = (request.variableData?.variables ?? [])
		.filter((item) => item.kind === "file" && typeof item.value?.fsPath === "string")
		.map((item) => item.value?.fsPath ?? "");
	const attachmentPaths = (request.inputState?.attachments ?? [])
		.filter((item) => item.kind === "file" && typeof item.value?.fsPath === "string")
		.map((item) => item.value?.fsPath ?? "");

	return Array.from(new Set([...variablePaths, ...attachmentPaths].filter(Boolean)));
}

/**
 * Builds user text from request payload.
 * @param request - Cursor request-like node.
 */
export function extractRequestUserText(request: CursorRequestLike): string
{
	const fallback = (request.message?.parts ?? [])
		.map((part) => part.text ?? "")
		.join("\n")
		.trim();
	return (request.message?.text ?? fallback ?? "").trim();
}

/**
 * Builds assistant text from request payload.
 * @param request - Cursor request-like node.
 */
export function extractRequestAssistantText(request: CursorRequestLike): string
{
	return (request.response ?? [])
		.map((entry) => entry.value ?? "")
		.join("\n")
		.trim();
}

/**
 * Extracts normalized messages from Cursor request-like session containers.
 * @param key - DB key owning the parsed value.
 * @param parsed - Parsed JSON value from ItemTable.
 * @param defaultProject - Fallback project label.
 * @param projectBySession - Session → project routing map.
 */
export function extractFromRequestLikeSessions(
	key: string,
	parsed: unknown,
	defaultProject: string,
	projectBySession: Map<string, string>
): Array<AgentMessage>
{
	const results: Array<AgentMessage> = [];
	const stack: Array<unknown> = [parsed];

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

		const obj = current as CursorSessionLike;
		const requests = Array.isArray(obj.requests) ? obj.requests : null;
		if (requests)
		{
			const containerModel =
				pickModel(obj) ??
				pickModel(obj.inputState) ??
				pickModel(obj.selectedModel) ??
				null;
			const containerTimestamp = obj.creationDate ?? null;
			const containerSessionId = obj.sessionId ?? key;
			let previousAssistantId: string | null = null;

			for (let i = 0; i < requests.length; i += 1)
			{
				const request = requests[i];
				const sessionId = request.result?.metadata?.sessionId ?? containerSessionId;
				const project = projectBySession.get(sessionId) ?? defaultProject;
				const userText = extractRequestUserText(request);
				const assistantText = extractRequestAssistantText(request);
				const context = extractRequestContextPaths(request);
				const modelFromDetails = (request.result?.details ?? "").split(" • ")[0]?.trim() || null;
				const model = request.modelId ?? modelFromDetails ?? containerModel;
				const requestTimestamp = request.timestamp ?? containerTimestamp;
				const dateTime = parseCursorDateTime(requestTimestamp ?? null);

				const userId = generateMessageId(sessionId, "user", `${key}-${i}-u`, userText.slice(0, 120));
				const assistantId = generateMessageId(
					sessionId,
					"assistant",
					`${key}-${i}-a`,
					assistantText.slice(0, 120)
				);

				if (userText)
				{
					results.push(
						new AgentMessage({
							id: userId,
							sessionId,
							harness: "Cursor",
							machine: "",
							role: "user",
							model: null,
							message: userText,
							subject: "",
							context,
							symbols: [],
							history: [],
							tags: [],
							project,
							parentId: previousAssistantId,
							tokenUsage: null,
							toolCalls: [],
							rationale: [],
							source: "",
							dateTime,
							length: userText.length,
						})
					);
				}

				if (assistantText)
				{
					results.push(
						new AgentMessage({
							id: assistantId,
							sessionId,
							harness: "Cursor",
							machine: "",
							role: "assistant",
							model,
							message: assistantText,
							subject: "",
							context,
							symbols: [],
							history: [],
							tags: [],
							project,
							parentId: userText ? userId : previousAssistantId,
							tokenUsage: null,
							toolCalls: [],
							rationale: [],
							source: "",
							dateTime,
							length: assistantText.length,
						})
					);
					previousAssistantId = assistantId;
				}
			}
		}

		for (const nested of Object.values(current as Record<string, unknown>))
		{
			stack.push(nested);
		}
	}

	return results;
}

// ---------------------------------------------------------------------------
// Message walker
// ---------------------------------------------------------------------------

/**
 * Recursively finds message-like objects with `role` and `content`.
 * @param value - Current node in the parsed JSON tree.
 * @param state - Session/model hints inherited from parent containers.
 * @param out - Accumulator for discovered message-like objects.
 */
export function walkMessageLikeNodes(
	value: unknown,
	state: CursorWalkerState,
	out: Array<CursorMessageLike>
): void
{
	if (Array.isArray(value))
	{
		for (const item of value)
		{
			walkMessageLikeNodes(item, state, out);
		}
		return;
	}

	if (!value || typeof value !== "object")
	{
		return;
	}

	const obj = value as Record<string, unknown>;
	const currentModel = pickModel(obj) ?? state.modelHint;
	const sessionHint =
		(typeof obj.sessionId === "string" && obj.sessionId) ||
		(typeof obj.conversationId === "string" && obj.conversationId) ||
		state.sessionHint;

	if (typeof obj.role === "string" && obj.content !== undefined)
	{
		const timestamp =
			(typeof obj.timestamp === "string" || typeof obj.timestamp === "number" ? obj.timestamp : null) ??
			(typeof obj.time === "string" || typeof obj.time === "number" ? obj.time : null);
		out.push({
			role: obj.role,
			content: obj.content,
			model: currentModel,
			sessionHint,
			timestamp,
		});
	}

	const childState: CursorWalkerState = { sessionHint, modelHint: currentModel };
	for (const nested of Object.values(obj))
	{
		walkMessageLikeNodes(nested, childState, out);
	}
}
