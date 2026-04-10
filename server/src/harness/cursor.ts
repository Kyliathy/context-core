/**
 * ContextCore – Cursor IDE harness.
 * Entry point: reads chat history from state.vscdb (SQLite) and emits AgentMessage[].
 * Query logic: cursor-query.ts  |  Workspace/project matching: cursor-matcher.ts
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { basename } from "path";
import chalk from "chalk";
import { AgentMessage } from "../models/AgentMessage.js";
import { generateMessageId } from "../utils/hashId.js";
import { writeRawSourceData } from "../utils/rawCopier.js";
import {
	CUR,
	CUR_LINE,
	buildCursorSessionModelMap,
	buildCursorSessionTimestampMap,
	extractCursorBubbleMessages,
	extractCursorBubbleMessagesSinceRowId,
	extractFromRequestLikeSessions,
	extractContextPaths,
	isCursorChatKeyCandidate,
	toDatabaseText,
	normalizeMessageText,
	pickModel,
	mapCursorRole,
	parseCursorDateTime,
	walkMessageLikeNodes,
	type CursorMessageLike,
	type CursorBubbleRecord,
} from "./cursor-query.js";
import {
	MISC_CURSOR_PROJECT,
	loadCursorProjectRuleSet,
	inferCursorWorkspaceBySession,
	buildCursorGenericRuleSuggestions,
	chooseBestWorkspacePath,
	normalizePathCandidate,
	resolveCursorProjectFromWorkspacePath,
} from "./cursor-matcher.js";

export type CursorRowIdCheckpoint = {
	cursorDiskKVRowId: number;
	itemTableRowId: number;
};

export type CursorIncrementalResult = {
	messages: Array<AgentMessage>;
	checkpoint: CursorRowIdCheckpoint;
};

function getMaxTableRowId(db: Database, tableName: "cursorDiskKV" | "ItemTable"): number
{
	const row = db.query<{ maxRowId: number | null }, []>(`SELECT MAX(rowid) AS maxRowId FROM ${tableName}`).get();
	return Number(row?.maxRowId ?? 0);
}

function inferProjectsFromBubbleContext(
	bubbleMessages: Array<CursorBubbleRecord>,
	defaultProject: string
): Map<string, string>
{
	const projectsBySession = new Map<string, string>();
	const hintsBySession = new Map<string, Map<string, number>>();
	const ruleSet = loadCursorProjectRuleSet();

	for (const bubble of bubbleMessages)
	{
		const hintCounter = hintsBySession.get(bubble.sessionId) ?? new Map<string, number>();
		for (const contextPath of bubble.context)
		{
			const normalized = normalizePathCandidate(contextPath);
			if (!normalized)
			{
				continue;
			}
			hintCounter.set(normalized, (hintCounter.get(normalized) ?? 0) + 1);
		}
		hintsBySession.set(bubble.sessionId, hintCounter);
	}

	for (const [sessionId, hintCounter] of hintsBySession.entries())
	{
		const workspacePath = chooseBestWorkspacePath(hintCounter);
		if (!workspacePath)
		{
			projectsBySession.set(sessionId, defaultProject);
			continue;
		}

		const resolution = resolveCursorProjectFromWorkspacePath(workspacePath, ruleSet);
		projectsBySession.set(sessionId, resolution.project);
	}

	return projectsBySession;
}

/**
 * Entry point for Cursor chat history ingestion.
 * @param dbPath - Path to state.vscdb SQLite database.
 * @param rawBase - Raw archive directory for this harness.
 */
export function readCursorChats(dbPath: string, rawBase: string): Array<AgentMessage>
{
	if (!existsSync(dbPath))
	{
		return [];
	}

	const db = new Database(dbPath, { readonly: true });
	const results: Array<AgentMessage> = [];
	const defaultProject = MISC_CURSOR_PROJECT;
	const ruleSet = loadCursorProjectRuleSet();
	const startMs = Date.now();
	console.log(`${CUR} Starting ingest from ${chalk.blue(dbPath)}`);
	console.log(
		`${CUR} Project rules: explicit=${chalk.green(ruleSet.projectMappingRules.length + '')}, nameRemaps=${chalk.green(ruleSet.projectNameMappingRules.length + '')}, generic=${chalk.green(ruleSet.genericProjectMappingRules.length + '')}, fallback=${chalk.yellow(MISC_CURSOR_PROJECT)}`
	);

	try
	{
		const sessionModelMap = buildCursorSessionModelMap(db);
		const sessionTimestampMap = buildCursorSessionTimestampMap(db);
		const bubbleMessages = extractCursorBubbleMessages(db, sessionModelMap, sessionTimestampMap);
		console.log(`${CUR} Bubble messages extracted=${chalk.green(bubbleMessages.length + '')}`);
		if (bubbleMessages.length > 0)
		{
			const workspaceInference = inferCursorWorkspaceBySession(db, bubbleMessages, ruleSet);
			console.log(
				`${CUR} Workspace inference: resolved=${chalk.green(workspaceInference.sessionsResolved + '')}, fallbackGlobal=${workspaceInference.fallbackGlobal > 0 ? chalk.red(workspaceInference.fallbackGlobal + '') : '0'}, bubbleKeys=${workspaceInference.bubbleKeyCount}, metadataKeys=${workspaceInference.metadataKeyCount}`
			);
			if (workspaceInference.unresolvedFamilies.length > 0)
			{
				console.log(`${CUR} Unresolved key families: ${chalk.dim(workspaceInference.unresolvedFamilies.join(", "))}`);
			}
			const sc = workspaceInference.sourceCounts;
			console.log(
				`${CUR} Workspace sources: projectLayouts=${chalk.magenta(sc.projectLayouts + '')}, composerFileUris=${chalk.magenta(sc.composerFileUris + '')}, bubbleHeuristics=${chalk.magenta(sc.bubbleHeuristics + '')}, unresolved=${sc.unresolved > 0 ? chalk.red(sc.unresolved + '') : '0'}`
			);
			//<Emit a small sample so we can quickly audit session->project routing.
			const routingSample = Array.from(workspaceInference.projectBySession.entries())
				.slice(0, 8)
				.map(([session, project]) => `${chalk.dim(session.slice(0, 8))}${chalk.dim("…")}→${chalk.green(project)}`)
				.join(chalk.dim(" │ "));
			if (routingSample)
			{
				console.log(`${CUR} Routing sample: ${routingSample}`);
			}

			if (workspaceInference.autoDerivedBySession.size > 0)
			{
				const adCount = workspaceInference.autoDerivedBySession.size;
				console.warn(`${CUR} ${CUR_LINE}`);
				console.warn(`${CUR} ${chalk.yellow(`Auto-derived projects (${adCount} sessions, no rule match)`)}`);
				console.warn(`${CUR} ${CUR_LINE}`);
				const adEntries = Array.from(workspaceInference.autoDerivedBySession.entries());
				for (let adIdx = 0; adIdx < adEntries.length; adIdx += 1)
				{
					const [sessionId, data] = adEntries[adIdx];
					const isLast = adIdx === adEntries.length - 1;
					const branch = isLast ? "└" : "├";
					const cont = isLast ? " " : "│";
					console.warn(
						`${CUR}  ${chalk.dim(branch)} ${chalk.dim(sessionId.slice(0, 8) + "…")} → ${chalk.green.bold(`"${data.derivedProject}"`)} ← ${chalk.blue(data.path)} ${chalk.magenta(`[${data.source}]`)}`
					);
					if (data.topWorkspaceCandidates.length > 0)
					{
						console.warn(`${CUR}  ${chalk.dim(cont)}   ${chalk.dim("candidates:")} ${chalk.dim(data.topWorkspaceCandidates.join(" │ "))}`);
					}
					if (data.contextSamples.length > 0)
					{
						console.warn(`${CUR}  ${chalk.dim(cont)}   ${chalk.dim("context:   ")} ${chalk.dim(data.contextSamples.join(" │ "))}`);
					}
				}
			}

			if (workspaceInference.miscSessionPaths.size > 0)
			{
				const miscCount = workspaceInference.miscSessionPaths.size;
				console.warn(`${CUR} ${CUR_LINE}`);
				console.warn(`${CUR} ${chalk.red(`MISC sessions (${miscCount} sessions, no matching project rule)`)}`);
				console.warn(`${CUR} ${CUR_LINE}`);
				const miscEntries = Array.from(workspaceInference.miscSessionPaths.entries());
				for (let mIdx = 0; mIdx < miscEntries.length; mIdx += 1)
				{
					const [sessionId, path] = miscEntries[mIdx];
					const source = workspaceInference.miscSourceBySession.get(sessionId) ?? "unresolved";
					const isLast = mIdx === miscEntries.length - 1;
					const branch = isLast ? "└" : "├";
					console.warn(
						`${CUR}  ${chalk.dim(branch)} ${chalk.dim(sessionId.slice(0, 8) + "…")} → path: ${chalk.blue(path)} ${chalk.magenta(`[${source}]`)}`
					);
				}
				console.warn(`${CUR} ${chalk.yellow("Hint:")} add a genericProjectMappingRule for these paths in cc.json`);
			}

			const suggestedRules = buildCursorGenericRuleSuggestions([
				...Array.from(workspaceInference.autoDerivedBySession.values()).map((item) => item.path),
				...Array.from(workspaceInference.miscSessionPaths.values()).filter((path) => path !== "(no workspace path found)"),
			]);
			if (suggestedRules.length > 0)
			{
				console.warn(`${CUR} ${chalk.cyan("Suggested cc.json genericProjectMappingRules snippet:")}`);
				console.warn(
					chalk.cyan(JSON.stringify(
						{
							genericProjectMappingRules: suggestedRules,
						},
						null,
						2
					))
				);
			}
			const previousBySession = new Map<string, string | null>();
			//Group bubble messages by session for raw archival.
			const sessionBubbles = new Map<string, Array<CursorBubbleRecord>>();
			for (const bubbleMessage of bubbleMessages)
			{
				const sid = bubbleMessage.sessionId;
				if (!sessionBubbles.has(sid))
				{
					sessionBubbles.set(sid, []);
				}
				sessionBubbles.get(sid)!.push(bubbleMessage);
			}

			//Dump each session's raw bubble data to the -RAW archive.
			const rawDestBySession = new Map<string, string>();
			for (const [sid, bubbles] of sessionBubbles.entries())
			{
				const project = workspaceInference.projectBySession.get(sid) ?? defaultProject;
				const rawDest = writeRawSourceData(rawBase, project, `${sid}.json`, bubbles.map((b) => ({
					sessionId: b.sessionId,
					bubbleId: b.bubbleId,
					role: b.role,
					message: b.message,
					model: b.model,
					dateTime: b.dateTime.toISO(),
					context: b.context,
				})));
				rawDestBySession.set(sid, rawDest);
			}

			for (const bubbleMessage of bubbleMessages)
			{
				const parentId = previousBySession.get(bubbleMessage.sessionId) ?? null;
				const id = generateMessageId(
					bubbleMessage.sessionId,
					bubbleMessage.role,
					bubbleMessage.bubbleId,
					bubbleMessage.message.slice(0, 120)
				);

				results.push(
					new AgentMessage({
						id,
						sessionId: bubbleMessage.sessionId,
						harness: "Cursor",
						machine: "",
						role: bubbleMessage.role,
						model: bubbleMessage.role === "assistant" ? bubbleMessage.model : null,
						message: bubbleMessage.message,
						subject: "",
						context: bubbleMessage.context,
						symbols: [],
						history: [],
						tags: [],
						project: workspaceInference.projectBySession.get(bubbleMessage.sessionId) ?? defaultProject,
						parentId,
						tokenUsage: null,
						toolCalls: [],
						rationale: [],
						source: rawDestBySession.get(bubbleMessage.sessionId) ?? "",
						dateTime: bubbleMessage.dateTime,
						length: bubbleMessage.message.length,
					})
				);

				previousBySession.set(bubbleMessage.sessionId, id);
			}
			console.log(`${CUR} Parsed ${chalk.green(bubbleMessages.length + '')} bubble records from cursorDiskKV.`);
			console.log(`${CUR} Total ingest time=${chalk.green((Date.now() - startMs) + "ms")}`);
			return results;
		}

		const keyRows = db
			.query<{ key: string }, []>(
				"SELECT key FROM ItemTable WHERE key LIKE '%chat%' OR key LIKE '%ai%' OR key LIKE '%composer%' OR key LIKE '%conversation%'"
			)
			.all();
		const discoveredKeys = keyRows
			.map((row) => row.key)
			.filter((key) => isCursorChatKeyCandidate(key));
		console.log(`${CUR} Discovered keys (${chalk.green(discoveredKeys.length + '')}): ${chalk.dim(discoveredKeys.join(", "))}`);

		for (const key of discoveredKeys)
		{
			try
			{
				const row = db
					.query<{ value: unknown }, [string]>("SELECT value FROM ItemTable WHERE key = ?")
					.get(key);
				const rawValue = toDatabaseText(row?.value);
				if (!rawValue)
				{
					continue;
				}

				const parsed = JSON.parse(rawValue) as unknown;

				// Dump raw data for this key to the -RAW archive.
				const safeKey = key.replace(/[^a-zA-Z0-9_\-\.]/g, "_").slice(0, 120);
				const rawDest = writeRawSourceData(rawBase, defaultProject, `${safeKey}.json`, parsed);

				const requestLikeMessages = extractFromRequestLikeSessions(key, parsed, defaultProject, new Map<string, string>());
				if (requestLikeMessages.length > 0)
				{
					for (const msg of requestLikeMessages) { msg.source = rawDest; }
					results.push(...requestLikeMessages);
					continue;
				}

				const messageLike: Array<CursorMessageLike> = [];
				walkMessageLikeNodes(parsed, { sessionHint: key, modelHint: pickModel(parsed) }, messageLike);
				let previousId: string | null = null;

				for (let i = 0; i < messageLike.length; i += 1)
				{
					const messageNode = messageLike[i];
					const role = mapCursorRole(messageNode.role);
					const message = normalizeMessageText(messageNode.content);
					if (!message.trim())
					{
						continue;
					}

					const dateTime = parseCursorDateTime(messageNode.timestamp);
					const sessionId = messageNode.sessionHint || key || basename(dbPath);
					const project = defaultProject;
					const id = generateMessageId(sessionId, role, `${key}-${i}`, message.slice(0, 120));

					results.push(
						new AgentMessage({
							id,
							sessionId,
							harness: "Cursor",
							machine: "",
							role,
							model: role === "assistant" ? messageNode.model : null,
							message,
							subject: "",
							context: extractContextPaths(message),
							symbols: [],
							history: [],
							tags: [],
							project,
							parentId: previousId,
							tokenUsage: null,
							toolCalls: [],
							rationale: [],
							source: rawDest,
							dateTime,
							length: message.length,
						})
					);
					previousId = id;
				}
			} catch (error)
			{
				//Skip individual malformed keys and keep scanning.
				console.warn(`${CUR} ${chalk.red("Failed parsing key")} "${key}": ${(error as Error).message}`);
			}
		}
	} finally
	{
		db.close();
	}
	console.log(`${CUR} Total ingest time=${chalk.green((Date.now() - startMs) + "ms")}`);

	return results;
}

/**
 * Reads the latest rowid checkpoint for Cursor tables.
 * Used to persist/restore incremental watcher state.
 */
export function getCursorRowIdCheckpoint(dbPath: string): CursorRowIdCheckpoint
{
	if (!existsSync(dbPath))
	{
		return { cursorDiskKVRowId: 0, itemTableRowId: 0 };
	}

	const db = new Database(dbPath, { readonly: true });
	try
	{
		return {
			cursorDiskKVRowId: getMaxTableRowId(db, "cursorDiskKV"),
			itemTableRowId: getMaxTableRowId(db, "ItemTable"),
		};
	}
	finally
	{
		db.close();
	}
}

/**
 * Incremental Cursor ingest for watcher events.
 * Reads only rows whose rowid is newer than the stored checkpoint.
 */
export function readCursorChatsIncremental(
	dbPath: string,
	rawBase: string,
	sinceCheckpoint: CursorRowIdCheckpoint
): CursorIncrementalResult
{
	if (!existsSync(dbPath))
	{
		return {
			messages: [],
			checkpoint: sinceCheckpoint,
		};
	}

	const db = new Database(dbPath, { readonly: true });
	const results: Array<AgentMessage> = [];
	const defaultProject = MISC_CURSOR_PROJECT;
	const startMs = Date.now();

	try
	{
		const nextCheckpoint: CursorRowIdCheckpoint = {
			cursorDiskKVRowId: getMaxTableRowId(db, "cursorDiskKV"),
			itemTableRowId: getMaxTableRowId(db, "ItemTable"),
		};

		// No DB movement since last checkpoint -> fast no-op.
		if (
			nextCheckpoint.cursorDiskKVRowId <= sinceCheckpoint.cursorDiskKVRowId &&
			nextCheckpoint.itemTableRowId <= sinceCheckpoint.itemTableRowId
		)
		{
			return { messages: [], checkpoint: nextCheckpoint };
		}

		const changedBubbleRow = db
			.query<{ count: number }, [number]>(
				"SELECT COUNT(*) AS count FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND rowid > ?"
			)
			.get(sinceCheckpoint.cursorDiskKVRowId);
		const changedBubbleCount = Number(changedBubbleRow?.count ?? 0);

		let bubbleMessages: Array<CursorBubbleRecord> = [];
		if (changedBubbleCount > 0)
		{
			const sessionModelMap = buildCursorSessionModelMap(db);
			const sessionTimestampMap = buildCursorSessionTimestampMap(db);
			bubbleMessages = extractCursorBubbleMessagesSinceRowId(
				db,
				sessionModelMap,
				sessionTimestampMap,
				sinceCheckpoint.cursorDiskKVRowId
			);
		}

		if (bubbleMessages.length > 0)
		{
			const projectBySession = inferProjectsFromBubbleContext(bubbleMessages, defaultProject);
			const previousBySession = new Map<string, string | null>();

			const sessionBubbles = new Map<string, Array<CursorBubbleRecord>>();
			for (const bubbleMessage of bubbleMessages)
			{
				const sid = bubbleMessage.sessionId;
				if (!sessionBubbles.has(sid))
				{
					sessionBubbles.set(sid, []);
				}
				sessionBubbles.get(sid)!.push(bubbleMessage);
			}

			const rawDestBySession = new Map<string, string>();
			for (const [sid, bubbles] of sessionBubbles.entries())
			{
				const project = projectBySession.get(sid) ?? defaultProject;
				const rawDest = writeRawSourceData(rawBase, project, `${sid}.json`, bubbles.map((b) => ({
					sessionId: b.sessionId,
					bubbleId: b.bubbleId,
					role: b.role,
					message: b.message,
					model: b.model,
					dateTime: b.dateTime.toISO(),
					context: b.context,
				})));
				rawDestBySession.set(sid, rawDest);
			}

			for (const bubbleMessage of bubbleMessages)
			{
				const parentId = previousBySession.get(bubbleMessage.sessionId) ?? null;
				const id = generateMessageId(
					bubbleMessage.sessionId,
					bubbleMessage.role,
					bubbleMessage.bubbleId,
					bubbleMessage.message.slice(0, 120)
				);

				results.push(
					new AgentMessage({
						id,
						sessionId: bubbleMessage.sessionId,
						harness: "Cursor",
						machine: "",
						role: bubbleMessage.role,
						model: bubbleMessage.role === "assistant" ? bubbleMessage.model : null,
						message: bubbleMessage.message,
						subject: "",
						context: bubbleMessage.context,
						symbols: [],
						history: [],
						tags: [],
						project: projectBySession.get(bubbleMessage.sessionId) ?? defaultProject,
						parentId,
						tokenUsage: null,
						toolCalls: [],
						rationale: [],
						source: rawDestBySession.get(bubbleMessage.sessionId) ?? "",
						dateTime: bubbleMessage.dateTime,
						length: bubbleMessage.message.length,
					})
				);

				previousBySession.set(bubbleMessage.sessionId, id);
			}
		}
		else
		{
			const keyRows = db
				.query<{ key: string }, [number]>(
					"SELECT key FROM ItemTable WHERE rowid > ? AND (key LIKE '%chat%' OR key LIKE '%ai%' OR key LIKE '%composer%' OR key LIKE '%conversation%')"
				)
				.all(sinceCheckpoint.itemTableRowId);

			const discoveredKeys = keyRows
				.map((row) => row.key)
				.filter((key) => isCursorChatKeyCandidate(key));

			for (const key of discoveredKeys)
			{
				try
				{
					const row = db
						.query<{ value: unknown }, [string]>("SELECT value FROM ItemTable WHERE key = ?")
						.get(key);
					const rawValue = toDatabaseText(row?.value);
					if (!rawValue)
					{
						continue;
					}

					const parsed = JSON.parse(rawValue) as unknown;
					const safeKey = key.replace(/[^a-zA-Z0-9_\-\.]/g, "_").slice(0, 120);
					const rawDest = writeRawSourceData(rawBase, defaultProject, `${safeKey}.json`, parsed);

					const requestLikeMessages = extractFromRequestLikeSessions(
						key,
						parsed,
						defaultProject,
						new Map<string, string>()
					);
					if (requestLikeMessages.length > 0)
					{
						for (const msg of requestLikeMessages)
						{
							msg.source = rawDest;
						}
						results.push(...requestLikeMessages);
						continue;
					}

					const messageLike: Array<CursorMessageLike> = [];
					walkMessageLikeNodes(parsed, { sessionHint: key, modelHint: pickModel(parsed) }, messageLike);
					let previousId: string | null = null;

					for (let i = 0; i < messageLike.length; i += 1)
					{
						const messageNode = messageLike[i];
						const role = mapCursorRole(messageNode.role);
						const message = normalizeMessageText(messageNode.content);
						if (!message.trim())
						{
							continue;
						}

						const dateTime = parseCursorDateTime(messageNode.timestamp);
						const sessionId = messageNode.sessionHint || key || basename(dbPath);
						const id = generateMessageId(sessionId, role, `${key}-${i}`, message.slice(0, 120));

						results.push(
							new AgentMessage({
								id,
								sessionId,
								harness: "Cursor",
								machine: "",
								role,
								model: role === "assistant" ? messageNode.model : null,
								message,
								subject: "",
								context: extractContextPaths(message),
								symbols: [],
								history: [],
								tags: [],
								project: defaultProject,
								parentId: previousId,
								tokenUsage: null,
								toolCalls: [],
								rationale: [],
								source: rawDest,
								dateTime,
								length: message.length,
							})
						);
						previousId = id;
					}
				}
				catch
				{
					// Skip malformed ItemTable payloads during incremental pass.
				}
			}
		}

		console.log(
			`${CUR} Incremental ingest: +${chalk.green(results.length + "")} messages in ${chalk.green((Date.now() - startMs) + "ms")} ` +
			`(rowid ${sinceCheckpoint.cursorDiskKVRowId}->${nextCheckpoint.cursorDiskKVRowId})`
		);

		return {
			messages: results,
			checkpoint: nextCheckpoint,
		};
	}
	finally
	{
		db.close();
	}
}
