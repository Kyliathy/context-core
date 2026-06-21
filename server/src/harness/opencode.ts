/**
 * ContextCore – OpenCode harness.
 * OpenCode stores all sessions in a single SQLite DB: `opencode.db`.
 *
 * Architecture: server/zz-reach2/architecture/archi-context-core-level0.md
 * Logging: server/zz-reach2/upgrades/2026-06/r2wl-winston-logging.md
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
import { getLogger } from "../logging/logger.js";
import { AgentMessage } from "../models/AgentMessage.js";
import type { ToolCall } from "../types.js";
import { generateMessageId } from "../utils/hashId.js";
import { sanitizeFilename } from "../utils/pathHelpers.js";
import { writeRawSourceData } from "../utils/rawCopier.js";
import type { HarnessIngestBatch } from "../ingest/BatchPersistence.js";

const logger = getLogger("harness:opencode");

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

export type OpenCodeRowIdCheckpoint = {
	sessionRowId: number;
	messageRowId: number;
	partRowId: number;
};

export type OpenCodeIncrementalResult = {
	messages: Array<AgentMessage>;
	checkpoint: OpenCodeRowIdCheckpoint;
	affectedSessionIds: Array<string>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolves the path to `opencode.db` from the configured harness path.
 * The config path may be a directory or point directly to the `.db` file.
 */
export function resolveOpenCodeDbPath(configuredPath: string): string
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

/**
 * Returns the value managed by getMaxOpenCodeRowId.
 * @param db - Database dependency used by getMaxOpenCodeRowId.
 * @param tableName - Value consumed by getMaxOpenCodeRowId.
 * @returns Result produced by getMaxOpenCodeRowId.
 */


function getMaxOpenCodeRowId(db: Database, tableName: "session" | "message" | "part"): number
{
	try
	{
		const row = db.query<{ maxRowId: number | null }, []>(`SELECT MAX(rowid) AS maxRowId FROM ${tableName}`).get();
		return Number(row?.maxRowId ?? 0);
	}
	catch
	{
		return 0;
	}
}

/**
 * Returns the value managed by getOpenCodeRowIdCheckpoint.
 * @param configuredPath - Path used by getOpenCodeRowIdCheckpoint to locate the relevant CXC resource.
 * @returns Result produced by getOpenCodeRowIdCheckpoint.
 */


export function getOpenCodeRowIdCheckpoint(configuredPath: string): OpenCodeRowIdCheckpoint
{
	const dbPath = resolveOpenCodeDbPath(configuredPath);
	if (!existsSync(dbPath))
	{
		return { sessionRowId: 0, messageRowId: 0, partRowId: 0 };
	}

	const db = new Database(dbPath, { readonly: true });
	try
	{
		return {
			sessionRowId: getMaxOpenCodeRowId(db, "session"),
			messageRowId: getMaxOpenCodeRowId(db, "message"),
			partRowId: getMaxOpenCodeRowId(db, "part"),
		};
	}
	finally
	{
		db.close();
	}
}

/**
 * Returns the value managed by getOpenCodeAffectedSessionIds.
 * @param db - Database dependency used by getOpenCodeAffectedSessionIds.
 * @param checkpoint - Value consumed by getOpenCodeAffectedSessionIds.
 * @returns Result produced by getOpenCodeAffectedSessionIds.
 */


export function getOpenCodeAffectedSessionIds(
	db: Database,
	checkpoint: OpenCodeRowIdCheckpoint
): Array<string>
{
	const rows = db
		.query<{ sessionId: string }, [number, number, number]>(
			`SELECT DISTINCT session_id AS sessionId FROM message WHERE rowid > ?
			UNION
			SELECT DISTINCT session_id AS sessionId FROM part WHERE rowid > ?
			UNION
			SELECT id AS sessionId FROM session WHERE rowid > ?`
		)
		.all(checkpoint.messageRowId, checkpoint.partRowId, checkpoint.sessionRowId);
	return rows.map((row) => row.sessionId).filter(Boolean);
}

/**
 * Returns the value managed by getOpenCodeSessionById.
 * @param db - Database dependency used by getOpenCodeSessionById.
 * @param sessionId - Session identifier or session data used by getOpenCodeSessionById.
 * @returns Result produced by getOpenCodeSessionById.
 */


function getOpenCodeSessionById(db: Database, sessionId: string): OcSession | null
{
	return db
		.query<OcSession, [string]>(
			"SELECT id, project_id, directory, title, slug, time_created, time_updated FROM session WHERE id = ?"
		)
		.get(sessionId) ?? null;
}

/**
 * Reads data for readOpenCodeChatsIncrementalBatched without changing unrelated CXC state.
 * @param dbDirPath - Path used by readOpenCodeChatsIncrementalBatched to locate the relevant CXC resource.
 * @param rawBase - Value consumed by readOpenCodeChatsIncrementalBatched.
 * @param checkpoint - Value consumed by readOpenCodeChatsIncrementalBatched.
 * @param onBatch - Value consumed by readOpenCodeChatsIncrementalBatched.
 * @returns Result produced by readOpenCodeChatsIncrementalBatched.
 */


export function readOpenCodeChatsIncrementalBatched(
	dbDirPath: string,
	rawBase: string,
	checkpoint: OpenCodeRowIdCheckpoint,
	onBatch: (batch: HarnessIngestBatch) => void
): OpenCodeIncrementalResult
{
	const dbPath = resolveOpenCodeDbPath(dbDirPath);
	if (!existsSync(dbPath))
	{
		onBatch({
			harnessName: "OpenCode",
			messages: [],
			checkpointCandidate: checkpoint,
			isFinalBatch: true,
		});
		return { messages: [], checkpoint, affectedSessionIds: [] };
	}

	const db = new Database(dbPath, { readonly: true });
	try
	{
		const nextCheckpoint: OpenCodeRowIdCheckpoint = {
			sessionRowId: getMaxOpenCodeRowId(db, "session"),
			messageRowId: getMaxOpenCodeRowId(db, "message"),
			partRowId: getMaxOpenCodeRowId(db, "part"),
		};
		const affectedSessionIds = getOpenCodeAffectedSessionIds(db, checkpoint);
		// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.

		for (const sessionId of affectedSessionIds)
		{
			const session = getOpenCodeSessionById(db, sessionId);
			if (!session)
			{
				continue;
			}
			const messages = processOpenCodeSession(db, session, rawBase);
			onBatch({
				harnessName: "OpenCode",
				messages,
				checkpointCandidate: nextCheckpoint,
				isFinalBatch: false,
			});
		}
		onBatch({
			harnessName: "OpenCode",
			messages: [],
			checkpointCandidate: nextCheckpoint,
			isFinalBatch: true,
		});
		return {
			messages: [],
			checkpoint: nextCheckpoint,
			affectedSessionIds,
		};
	}
	finally
	{
		db.close();
	}
}

/**
 * Reads data for readOpenCodeChatsIncremental without changing unrelated CXC state.
 * @param dbDirPath - Path used by readOpenCodeChatsIncremental to locate the relevant CXC resource.
 * @param rawBase - Value consumed by readOpenCodeChatsIncremental.
 * @param checkpoint - Value consumed by readOpenCodeChatsIncremental.
 * @returns Result produced by readOpenCodeChatsIncremental.
 */


export function readOpenCodeChatsIncremental(
	dbDirPath: string,
	rawBase: string,
	checkpoint: OpenCodeRowIdCheckpoint
): OpenCodeIncrementalResult
{
	const batches: HarnessIngestBatch[] = [];
	const result = readOpenCodeChatsIncrementalBatched(dbDirPath, rawBase, checkpoint, (batch) => batches.push(batch));
	return {
		...result,
		messages: batches.flatMap((batch) => batch.messages),
	};
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
	const dbPath = resolveOpenCodeDbPath(dbDirPath);

	if (!existsSync(dbPath))
	{
		logger.warn(`DB not found: ${dbPath} — skipping`);
		return [];
	}

	let db: Database;
	try
	{
		db = new Database(dbPath, { readonly: true });
	}
	catch (err)
	{
		logger.warn(`Cannot open DB at ${dbPath}: ${(err as Error).message} — skipping`);
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

		logger.info(`Found ${sessions.length} session(s)`);
		// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.


		for (const session of sessions)
		{
			try
			{
				const sessionMessages = processSession(db, session, rawBase);
				results.push(...sessionMessages);
			}
			catch (err)
			{
				logger.warn(`Error processing session ${session.id}: ${(err as Error).message}`);
			}
		}
	}
	finally
	{
		db.close();
	}

	logger.info(`Produced ${results.length} AgentMessage(s)`);
	return results;
}

/**
 * Reads data for readOpenCodeChatsBatched without changing unrelated CXC state.
 * @param dbDirPath - Path used by readOpenCodeChatsBatched to locate the relevant CXC resource.
 * @param rawBase - Value consumed by readOpenCodeChatsBatched.
 * @param onBatch - Value consumed by readOpenCodeChatsBatched.
 * @returns Result produced by readOpenCodeChatsBatched.
 */


export function readOpenCodeChatsBatched(
	dbDirPath: string,
	rawBase: string,
	onBatch: (batch: HarnessIngestBatch) => void
): OpenCodeIncrementalResult
{
	const dbPath = resolveOpenCodeDbPath(dbDirPath);
	if (!existsSync(dbPath))
	{
		const checkpoint = { sessionRowId: 0, messageRowId: 0, partRowId: 0 };
		onBatch({
			harnessName: "OpenCode",
			messages: [],
			checkpointCandidate: checkpoint,
			isFinalBatch: true,
		});
		return { messages: [], checkpoint, affectedSessionIds: [] };
	}

	const db = new Database(dbPath, { readonly: true });
	try
	{
		const checkpoint: OpenCodeRowIdCheckpoint = {
			sessionRowId: getMaxOpenCodeRowId(db, "session"),
			messageRowId: getMaxOpenCodeRowId(db, "message"),
			partRowId: getMaxOpenCodeRowId(db, "part"),
		};
		const sessions = db
			.query<OcSession, []>(
				"SELECT id, project_id, directory, title, slug, time_created, time_updated FROM session"
			)
			.all();
		// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.


		for (const session of sessions)
		{
			const messages = processOpenCodeSession(db, session, rawBase);
			onBatch({
				harnessName: "OpenCode",
				messages,
				checkpointCandidate: checkpoint,
				isFinalBatch: false,
			});
		}
		onBatch({
			harnessName: "OpenCode",
			messages: [],
			checkpointCandidate: checkpoint,
			isFinalBatch: true,
		});
		return {
			messages: [],
			checkpoint,
			affectedSessionIds: sessions.map((session) => session.id),
		};
	}
	finally
	{
		db.close();
	}
}

/**
 * Handles processOpenCodeSession behavior for this CXC module.
 * @param db - Database dependency used by processOpenCodeSession.
 * @param session - Session identifier or session data used by processOpenCodeSession.
 * @param rawBase - Value consumed by processOpenCodeSession.
 * @returns Result produced by processOpenCodeSession.
 */


// ---------------------------------------------------------------------------
// Per-session processing
// ---------------------------------------------------------------------------

export function processOpenCodeSession(
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
	const rawDest = writeRawSourceData(rawBase, project, `${session.id}.json`, {
		session,
		messages: messageRows,
		parts: partRows,
	});

	// Build a Map<messageId → parts>
	const partsByMessage = new Map<string, OcPartData[]>();
	// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.

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
	// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.

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

	const messages = buildAgentMessages(parsedMessages, partsByMessage, session, project);
	// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.

	for (const message of messages)
	{
		message.source = rawDest;
	}
	return messages;
}

const processSession = processOpenCodeSession;

/**
 * Builds the value produced by buildAgentMessages.
 * @param parsedMessages - Message data processed by buildAgentMessages.
 * @param partsByMessage - Message data processed by buildAgentMessages.
 * @param session - Session identifier or session data used by buildAgentMessages.
 * @param project - Value consumed by buildAgentMessages.
 * @returns Result produced by buildAgentMessages.
 */


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
	// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.

	for (const msg of assistantMessages)
	{
		const parentId = msg.data.parentID ?? "__orphan__";
		if (!assistantByParent.has(parentId))
		{
			assistantByParent.set(parentId, []);
		}
		assistantByParent.get(parentId)!.push(msg);
	}	// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.


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
	// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.

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
	// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.

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
	// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.

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
