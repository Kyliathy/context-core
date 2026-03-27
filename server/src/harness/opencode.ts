/**
 * ContextCore – OpenCode harness.
 * OpenCode stores all sessions in a single SQLite DB: `opencode.db`.
 *
 * Schema used:
 *   session  – one row per conversation (id, directory, title, time_created, time_updated)
 *   message  – metadata row per turn  (id, session_id, time_created, data JSON)
 *   part     – content atom per turn  (id, message_id, session_id, time_created, data JSON)
 *
 * Key quirk: OpenCode's step-based architecture creates N `message` rows for a single
 * logical assistant response (one per tool-call cycle), all linked by `parentID`.
 * This harness consolidates them into a single AgentMessage per user prompt.
 */

import { existsSync } from "fs";
import { basename, join, normalize } from "path";
import { DateTime } from "luxon";
import { Database } from "bun:sqlite";
import chalk from "chalk";
import { AgentMessage } from "../models/AgentMessage.js";
import type { ToolCall } from "../types.js";
import { generateMessageId } from "../utils/hashId.js";
import { sanitizeFilename } from "../utils/pathHelpers.js";
import { writeRawSourceData } from "../utils/rawCopier.js";

// ---------------------------------------------------------------------------
// Local types for the OpenCode DB schema
// ---------------------------------------------------------------------------

type OcSession = {
	id: string;
	project_id: string;
	directory: string;
	title: string;
	slug: string;
	time_created: number;
	time_updated: number;
};

type OcMessageRow = {
	id: string;
	session_id: string;
	time_created: number;
	time_updated: number;
	data: string;
};

type OcPartRow = {
	id: string;
	message_id: string;
	session_id: string;
	time_created: number;
	data: string;
};

/** Parsed shape of `message.data` JSON. */
type OcMessageData = {
	role: "user" | "assistant";
	parentID?: string;
	modelID?: string;
	providerID?: string;
	model?: { providerID?: string; modelID?: string };
	tokens?: { total?: number; input?: number; output?: number; reasoning?: number };
	finish?: "stop" | "tool-calls";
	path?: { cwd?: string };
	time?: { created?: number; completed?: number };
};

/** Parsed shape of `part.data` JSON. */
type OcPartData =
	| { type: "text"; text: string; time?: { start: number; end: number } }
	| { type: "reasoning"; text: string; metadata?: unknown; time?: { start: number; end: number } }
	| { type: "tool"; callID: string; tool: string; state?: { status?: string; input?: Record<string, string>; output?: string; title?: string; time?: { start: number; end: number } } }
	| { type: "step-start" }
	| { type: "step-finish"; reason: string; cost?: number; tokens?: { total?: number; input?: number; output?: number; reasoning?: number; cache?: unknown } }
	| { type: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolves the path to `opencode.db` from the configured harness path.
 * The config path may be a directory or point directly to the `.db` file.
 */
function resolveDbPath(configuredPath: string): string
{
	const norm = normalize(configuredPath);
	if (norm.toLowerCase().endsWith(".db"))
	{
		return norm;
	}
	// Strip trailing separators then append filename
	return join(norm.replace(/[\\/]+$/, ""), "opencode.db");
}

/**
 * Derives the project name from a session's working directory.
 * Falls back to "OpenCode" if the directory is missing or empty.
 */
function sessionProject(directory: string): string
{
	if (!directory)
	{
		return "OpenCode";
	}
	const last = basename(normalize(directory).replace(/[\\/]+$/, ""));
	return sanitizeFilename(last || "OpenCode");
}

// ---------------------------------------------------------------------------
// Main reader
// ---------------------------------------------------------------------------

/**
 * Reads all chat sessions from OpenCode's `opencode.db` and returns normalized AgentMessages.
 * @param dbDirPath - Path configured in cc.json (directory or direct `.db` path).
 * @param rawBase   - Raw archive root for this harness, e.g. `{storage}/{machine}-RAW/OpenCode/`.
 */
export function readOpenCodeChats(
	dbDirPath: string,
	rawBase: string
): Array<AgentMessage>
{
	const dbPath = resolveDbPath(dbDirPath);

	if (!existsSync(dbPath))
	{
		console.log(chalk.yellow(`[OpenCode] DB not found: ${dbPath} — skipping`));
		return [];
	}

	let db: Database;
	try
	{
		db = new Database(dbPath, { readonly: true });
	}
	catch (err)
	{
		console.log(chalk.yellow(`[OpenCode] Cannot open DB at ${dbPath}: ${(err as Error).message} — skipping`));
		return [];
	}

	const results: Array<AgentMessage> = [];

	try
	{
		const sessions = db
			.query<OcSession, []>(
				"SELECT id, project_id, directory, title, slug, time_created, time_updated FROM session"
			)
			.all();

		console.log(chalk.cyan(`[OpenCode] Found ${sessions.length} session(s)`));

		for (const session of sessions)
		{
			try
			{
				const sessionMessages = processSession(db, session, rawBase);
				results.push(...sessionMessages);
			}
			catch (err)
			{
				console.log(chalk.yellow(`[OpenCode] Error processing session ${session.id}: ${(err as Error).message}`));
			}
		}
	}
	finally
	{
		db.close();
	}

	console.log(chalk.green(`[OpenCode] Produced ${results.length} AgentMessage(s)`));
	return results;
}

// ---------------------------------------------------------------------------
// Per-session processing
// ---------------------------------------------------------------------------

function processSession(
	db: Database,
	session: OcSession,
	rawBase: string
): Array<AgentMessage>
{
	// Query all messages and parts for this session
	const messageRows = db
		.query<OcMessageRow, [string]>(
			"SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id = ? ORDER BY time_created"
		)
		.all(session.id);

	if (messageRows.length === 0)
	{
		return [];
	}

	const partRows = db
		.query<OcPartRow, [string]>(
			"SELECT id, message_id, session_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created"
		)
		.all(session.id);

	// Archive raw data (skips if already exists)
	const project = sessionProject(session.directory);
	writeRawSourceData(rawBase, project, `${session.id}.json`, {
		session,
		messages: messageRows,
		parts: partRows,
	});

	// Build a Map<messageId → parts>
	const partsByMessage = new Map<string, OcPartData[]>();
	for (const partRow of partRows)
	{
		try
		{
			const parsed = JSON.parse(partRow.data) as OcPartData;
			if (!partsByMessage.has(partRow.message_id))
			{
				partsByMessage.set(partRow.message_id, []);
			}
			partsByMessage.get(partRow.message_id)!.push(parsed);
		}
		catch
		{
			// Malformed part — skip
		}
	}

	// Parse message rows
	const parsedMessages: Array<{ row: OcMessageRow; data: OcMessageData }> = [];
	for (const row of messageRows)
	{
		try
		{
			const data = JSON.parse(row.data) as OcMessageData;
			parsedMessages.push({ row, data });
		}
		catch
		{
			// Malformed message — skip
		}
	}

	return buildAgentMessages(parsedMessages, partsByMessage, session, project);
}

// ---------------------------------------------------------------------------
// AgentMessage construction
// ---------------------------------------------------------------------------

function buildAgentMessages(
	parsedMessages: Array<{ row: OcMessageRow; data: OcMessageData }>,
	partsByMessage: Map<string, OcPartData[]>,
	session: OcSession,
	project: string
): Array<AgentMessage>
{
	const agentMessages: Array<AgentMessage> = [];

	// Separate user and assistant messages
	const userMessages = parsedMessages.filter((m) => m.data.role === "user");
	const assistantMessages = parsedMessages.filter((m) => m.data.role === "assistant");

	// Group assistant messages by parentID for consolidation
	const assistantByParent = new Map<string, Array<{ row: OcMessageRow; data: OcMessageData }>>();
	for (const msg of assistantMessages)
	{
		const parentId = msg.data.parentID ?? "__orphan__";
		if (!assistantByParent.has(parentId))
		{
			assistantByParent.set(parentId, []);
		}
		assistantByParent.get(parentId)!.push(msg);
	}

	// Emit each user message followed by its consolidated assistant response
	for (const userMsg of userMessages)
	{
		// Build user AgentMessage
		const userParts = partsByMessage.get(userMsg.row.id) ?? [];
		const userText = userParts
			.filter((p): p is Extract<OcPartData, { type: "text" }> => p.type === "text")
			.map((p) => p.text)
			.join("\n")
			.trim();

		const userDt = DateTime.fromMillis(userMsg.row.time_created);

		agentMessages.push(
			new AgentMessage({
				id: generateMessageId(session.id, "user", userMsg.row.time_created, userText.slice(0, 120)),
				sessionId: session.id,
				harness: "OpenCode",
				machine: "",
				role: "user",
				model: null,
				message: userText,
				subject: "",
				context: [],
				symbols: [],
				history: [],
				tags: [],
				project,
				parentId: null,
				tokenUsage: null,
				toolCalls: [],
				rationale: [],
				source: "",
				dateTime: userDt,
				length: userText.length,
			})
		);

		// Consolidate all assistant steps that share this user message as parent
		const assistantGroup = assistantByParent.get(userMsg.row.id) ?? [];
		if (assistantGroup.length > 0)
		{
			const assistantMsg = buildConsolidatedAssistant(
				assistantGroup,
				partsByMessage,
				session,
				project
			);
			if (assistantMsg)
			{
				agentMessages.push(assistantMsg);
			}
		}
	}

	// Emit any orphaned assistant messages (no matching parentID)
	const orphanedGroup = assistantByParent.get("__orphan__") ?? [];
	for (const orphan of orphanedGroup)
	{
		const msg = buildConsolidatedAssistant([orphan], partsByMessage, session, project);
		if (msg)
		{
			agentMessages.push(msg);
		}
	}

	return agentMessages;
}

/**
 * Consolidates one or more sequential assistant messages (all with the same parentID)
 * into a single AgentMessage. Text, rationale, and tool calls are merged in time order.
 */
function buildConsolidatedAssistant(
	group: Array<{ row: OcMessageRow; data: OcMessageData }>,
	partsByMessage: Map<string, OcPartData[]>,
	session: OcSession,
	project: string
): AgentMessage | null
{
	if (group.length === 0)
	{
		return null;
	}

	// Sort by time_created to guarantee chronological merge
	const sorted = [...group].sort((a, b) => a.row.time_created - b.row.time_created);
	const first = sorted[0];

	// Collect all parts across all steps, preserving order
	const allParts: OcPartData[] = [];
	for (const msg of sorted)
	{
		allParts.push(...(partsByMessage.get(msg.row.id) ?? []));
	}

	// Extract text (final response body)
	const textParts = allParts.filter(
		(p): p is Extract<OcPartData, { type: "text" }> => p.type === "text"
	);
	const messageText = textParts.map((p) => p.text).join("\n").trim();

	// Extract rationale (thinking / reasoning)
	const rationale = allParts
		.filter((p): p is Extract<OcPartData, { type: "reasoning" }> => p.type === "reasoning")
		.map((p) => p.text)
		.filter(Boolean);

	// Extract tool calls
	const toolCalls: ToolCall[] = allParts
		.filter((p): p is Extract<OcPartData, { type: "tool" }> => p.type === "tool")
		.map((p) => {
			const filePath = p.state?.input?.filePath ?? p.state?.input?.path ?? "";
			const output = p.state?.output ?? "";
			return {
				name: p.tool,
				context: filePath ? [filePath] : [],
				results: output ? [output] : [],
			};
		});

	// Sum token usage across all step-finish parts
	let inputTokens = 0;
	let outputTokens = 0;
	for (const p of allParts)
	{
		if (p.type === "step-finish")
		{
			const sf = p as Extract<OcPartData, { type: "step-finish" }>;
			inputTokens += sf.tokens?.input ?? 0;
			outputTokens += sf.tokens?.output ?? 0;
		}
	}
	const tokenUsage = inputTokens > 0 || outputTokens > 0
		? { input: inputTokens, output: outputTokens }
		: null;

	const model = first.data.modelID ?? null;
	const dt = DateTime.fromMillis(first.row.time_created);

	return new AgentMessage({
		id: generateMessageId(session.id, "assistant", first.row.time_created, messageText.slice(0, 120)),
		sessionId: session.id,
		harness: "OpenCode",
		machine: "",
		role: "assistant",
		model,
		message: messageText,
		subject: "",
		context: [],
		symbols: [],
		history: [],
		tags: [],
		project,
		parentId: null,
		tokenUsage,
		toolCalls,
		rationale,
		source: "",
		dateTime: dt,
		length: messageText.length,
	});
}
