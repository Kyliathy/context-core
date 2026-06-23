/**
 * ContextCore – Cursor IDE harness.
 * Entry point: reads chat history from state.vscdb (SQLite) and emits AgentMessage[].
 * Query logic: cursor-query.ts  |  Workspace/project matching: cursor-matcher.ts
 *
 * Architecture: server/zz-reach2/architecture/archi-context-core-level0.md
 * Startup resume: server/zz-reach2/upgrades/2026-06/r2so2-startup-optimization2.md
 * Logging: server/zz-reach2/upgrades/2026-06/r2wl-winston-logging.md
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { basename } from "path";
import { getLogger } from "../logging/logger.js";
import { AgentMessage } from "../models/AgentMessage.js";
import { generateMessageId } from "../utils/hashId.js";
import { writeRawSourceData } from "../utils/rawCopier.js";
import { getCursorIngestBatchSize } from "../ingest/IngestConfig.js";
import type { HarnessIngestBatch } from "../ingest/BatchPersistence.js";
import {
	CUR_LINE,
	buildCursorSessionModelMap,
	buildCursorSessionTimestampMap,
	extractCursorBubbleMessages,
	extractCursorBubbleMessagesSinceRowId,
	readCursorBubblePage,
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
	inferCursorWorkspaceForSessions,
	buildCursorGenericRuleSuggestions,
	chooseBestWorkspacePath,
	normalizePathCandidate,
	resolveCursorProjectFromWorkspacePath,
} from "./cursor-matcher.js";

const logger = getLogger("harness:cursor");

export type CursorRowIdCheckpoint = {
	cursorDiskKVRowId: number;
	itemTableRowId: number;
};

export type CursorIncrementalResult = {
	messages: Array<AgentMessage>;
	checkpoint: CursorRowIdCheckpoint;
};

export type CursorBatchState = {
	lastMessageIdBySession: Map<string, string>;
};

export type CursorBatchedReadMode = "full" | "recovery-full" | "rowid-delta";

export type CursorBatchedReadOptions = {
	mode: CursorBatchedReadMode;
	sinceCheckpoint?: CursorRowIdCheckpoint;
	batchSize?: number;
	state?: CursorBatchState;
	onBatch: (batch: HarnessIngestBatch) => void;
};

/**
 * Reads the current maximum rowid for a Cursor table.
 * @param db - Open Cursor SQLite database.
 * @param tableName - Cursor table whose rowid should be inspected.
 * @returns Maximum rowid, or zero when the table is empty.
 */
function getMaxTableRowId(db: Database, tableName: "cursorDiskKV" | "ItemTable"): number
{
	const row = db.query<{ maxRowId: number | null }, []>(`SELECT MAX(rowid) AS maxRowId FROM ${tableName}`).get();
	return Number(row?.maxRowId ?? 0);
}

/**
 * Infers project names from paths embedded directly in Cursor bubble context.
 * @param bubbleMessages - Bubble records from the current bounded page.
 * @param defaultProject - Project name used when no path rule matches.
 * @returns Project name keyed by Cursor session id.
 */
function inferProjectsFromBubbleContext(
	bubbleMessages: Array<CursorBubbleRecord>,
	defaultProject: string
): Map<string, string>
{
	const projectsBySession = new Map<string, string>();
	const hintsBySession = new Map<string, Map<string, number>>();
	const ruleSet = loadCursorProjectRuleSet();

	// Business logic: page-local context hints are enough for raw archive routing,
	// so the batched reader does not need to retain workspace hints for the whole DB.
	for (const bubble of bubbleMessages)
	{
		const hintCounter = hintsBySession.get(bubble.sessionId) ?? new Map<string, number>();
		// Business logic: each path-like hint votes for the most likely workspace root
		// for this session, which keeps project routing stable across partial pages.
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

	// Business logic: every active session in the page receives a project label before
	// raw page data is archived, preserving storage provenance for resume/replay.
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
 * Groups page-local bubble context paths by Cursor session id.
 * @param bubbleMessages - Bubble records from one bounded reader page.
 * @returns Context paths keyed by session id.
 */
function buildBubbleContextBySession(
	bubbleMessages: Array<CursorBubbleRecord>
): Map<string, Array<string>>
{
	const bubbleContextBySession = new Map<string, Array<string>>();
	// Business logic: workspace inference only needs context for sessions touched by
	// this page, keeping recovery/full reads bounded in memory.
	for (const bubble of bubbleMessages)
	{
		const existing = bubbleContextBySession.get(bubble.sessionId) ?? [];
		existing.push(...bubble.context);
		bubbleContextBySession.set(bubble.sessionId, existing);
	}
	return bubbleContextBySession;
}

/**
 * Clamps a requested Cursor batch size to the configured hard limit.
 * @param batchSize - Optional caller-provided batch size.
 * @returns Batch size between 1 and the configured Cursor maximum.
 */
function clampCursorBatchSize(batchSize: number | undefined): number
{
	const configured = getCursorIngestBatchSize();
	// Business logic: bad test/operator input must fall back to the same memory ceiling
	// as production startup so no full/recovery path can emit an unbounded batch.
	if (!Number.isFinite(batchSize ?? NaN) || !batchSize || batchSize <= 0)
	{
		return configured;
	}
	return Math.min(Math.max(1, Math.floor(batchSize)), configured);
}

/**
 * Groups Cursor bubble records by session for raw page archival.
 * @param bubbles - Bubble records from one bounded page.
 * @returns Bubble records keyed by Cursor session id.
 */
function groupBubbleRecordsBySession(
	bubbles: Array<CursorBubbleRecord>
): Map<string, Array<CursorBubbleRecord>>
{
	const grouped = new Map<string, Array<CursorBubbleRecord>>();
	// Business logic: raw archive files are written per session/page so replayed
	// recovery batches retain precise provenance without one giant raw dump.
	for (const bubble of bubbles)
	{
		const existing = grouped.get(bubble.sessionId);
		if (existing)
		{
			existing.push(bubble);
		}
		else
		{
			grouped.set(bubble.sessionId, [bubble]);
		}
	}
	return grouped;
}

/**
 * Writes raw Cursor page data into collision-safe per-session files.
 * @param rawBase - Raw archive root for Cursor.
 * @param pageFirstRowId - First source rowid represented by the page.
 * @param pageLastRowId - Last source rowid represented by the page.
 * @param projectBySession - Project name keyed by session id.
 * @param defaultProject - Fallback project name.
 * @param bubbles - Bubble records from one bounded page.
 * @returns Raw archive path keyed by session id.
 */
function writeCursorRawPageSources(
	rawBase: string,
	pageFirstRowId: number,
	pageLastRowId: number,
	projectBySession: Map<string, string>,
	defaultProject: string,
	bubbles: Array<CursorBubbleRecord>
): Map<string, string>
{
	const rawDestBySession = new Map<string, string>();
	const sessionBubbles = groupBubbleRecordsBySession(bubbles);
	const pageRange = `${Math.max(0, pageFirstRowId)}-${Math.max(0, pageLastRowId)}`;

	// Business logic: archiving one page/session at a time lets interrupted full
	// reads resume without rewriting or retaining the whole Cursor source corpus.
	for (const [sid, sessionRecords] of sessionBubbles.entries())
	{
		const project = projectBySession.get(sid) ?? defaultProject;
		const rawDest = writeRawSourceData(rawBase, project, `${sid}.${pageRange}.json`, sessionRecords.map((b) => ({
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

	return rawDestBySession;
}

/**
 * Converts page-local Cursor bubble records into normalized AgentMessages.
 * @param bubbles - Bubble records from one bounded page.
 * @param rawDestBySession - Raw archive path keyed by session id.
 * @param projectBySession - Project name keyed by session id.
 * @param defaultProject - Fallback project name.
 * @param state - Cross-page parent-chain state.
 * @returns Normalized AgentMessages for the page.
 */
function cursorBubbleRecordsToMessages(
	bubbles: Array<CursorBubbleRecord>,
	rawDestBySession: Map<string, string>,
	projectBySession: Map<string, string>,
	defaultProject: string,
	state: CursorBatchState
): Array<AgentMessage>
{
	const messages: Array<AgentMessage> = [];
	// Business logic: parent-chain state crosses page boundaries so bounded startup
	// batches keep conversation threading intact after resume.
	for (const bubbleMessage of bubbles)
	{
		const parentId = state.lastMessageIdBySession.get(bubbleMessage.sessionId) ?? null;
		const id = generateMessageId(
			bubbleMessage.sessionId,
			bubbleMessage.role,
			bubbleMessage.bubbleId,
			bubbleMessage.message.slice(0, 120)
		);

		messages.push(
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

		state.lastMessageIdBySession.set(bubbleMessage.sessionId, id);
	}
	return messages;
}

/**
 * Emits one or more bounded Cursor ingest batches to the persistence callback.
 * @param messages - Page messages to split by batch size.
 * @param checkpointCandidate - Durable checkpoint represented by the page.
 * @param batchSize - Maximum messages per emitted batch.
 * @param isFinalBatch - Whether this page is the reader's final signal.
 * @param onBatch - Consumer callback that persists each emitted batch.
 */
function emitCursorMessageBatches(
	messages: Array<AgentMessage>,
	checkpointCandidate: CursorRowIdCheckpoint,
	batchSize: number,
	isFinalBatch: boolean,
	onBatch: (batch: HarnessIngestBatch) => void
): void
{
	if (messages.length === 0)
	{
		if (isFinalBatch)
		{
			onBatch({
				harnessName: "Cursor",
				messages: [],
				checkpointCandidate,
				isFinalBatch: true,
			});
		}
		return;
	}

	// Business logic: a single source page can expand to more messages than the memory
	// budget permits, so emitted batches are capped before storage/DB persistence.
	for (let start = 0; start < messages.length; start += batchSize)
	{
		const chunk = messages.slice(start, start + batchSize);
		onBatch({
			harnessName: "Cursor",
			messages: chunk,
			checkpointCandidate,
			isFinalBatch: isFinalBatch && start + batchSize >= messages.length,
		});
	}
}

/**
 * Cursor bubble reader for startup/recovery paths that cannot hold all rows in memory.
 * Emits at most CURSOR_INGEST_BATCH_SIZE messages per HarnessIngestBatch.
 * @param dbPath - Path to Cursor `state.vscdb`.
 * @param rawBase - Raw archive root for Cursor page dumps.
 * @param options - Batched reader mode, checkpoint, state, and persistence callback.
 * @returns Empty message array plus the final source checkpoint.
 */
export function readCursorChatsBatched(
	dbPath: string,
	rawBase: string,
	options: CursorBatchedReadOptions
): CursorIncrementalResult
{
	const emptyCheckpoint = options.sinceCheckpoint ?? { cursorDiskKVRowId: 0, itemTableRowId: 0 };
	if (!existsSync(dbPath))
	{
		options.onBatch({
			harnessName: "Cursor",
			messages: [],
			checkpointCandidate: emptyCheckpoint,
			isFinalBatch: true,
		});
		return {
			messages: [],
			checkpoint: emptyCheckpoint,
		};
	}

	const db = new Database(dbPath, { readonly: true });
	const defaultProject = MISC_CURSOR_PROJECT;
	const state = options.state ?? { lastMessageIdBySession: new Map<string, string>() };
	const batchSize = clampCursorBatchSize(options.batchSize);
	const startMs = Date.now();
	let emittedMessages = 0;
	let emittedBatches = 0;
	let peakRssBytes = process.memoryUsage().rss;

	try
	{
		const nextCheckpoint: CursorRowIdCheckpoint = {
			cursorDiskKVRowId: getMaxTableRowId(db, "cursorDiskKV"),
			itemTableRowId: getMaxTableRowId(db, "ItemTable"),
		};
		const sinceCheckpoint = options.sinceCheckpoint ?? { cursorDiskKVRowId: 0, itemTableRowId: 0 };
		// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting harness ingest and source normalization from partial or invalid state.


		if (
			options.mode === "rowid-delta" &&
			nextCheckpoint.cursorDiskKVRowId <= sinceCheckpoint.cursorDiskKVRowId &&
			nextCheckpoint.itemTableRowId <= sinceCheckpoint.itemTableRowId
		)
		{
			emitCursorMessageBatches([], nextCheckpoint, batchSize, true, options.onBatch);
			return { messages: [], checkpoint: nextCheckpoint };
		}

		const sessionModelMap = buildCursorSessionModelMap(db);
		const sessionTimestampMap = buildCursorSessionTimestampMap(db);
		let lastBubbleRowId = options.mode === "rowid-delta" ? sinceCheckpoint.cursorDiskKVRowId : 0;
		let sawBubbleRows = false;

		// Business logic: full/recovery startup reads Cursor in bounded rowid pages so
		// large local Cursor DBs never materialize all bubble rows at once.
		while (true)
		{
			const page = readCursorBubblePage(db, sessionModelMap, sessionTimestampMap, lastBubbleRowId, `bubble-${options.mode}`);
			peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
			if (page.selectedRows === 0)
			{
				break;
			}

			sawBubbleRows = true;
			lastBubbleRowId = page.lastRowId;
			if (page.records.length === 0)
			{
				continue;
			}

			const projectBySession = inferCursorWorkspaceForSessions(
				db,
				new Set(page.records.map((item) => item.sessionId)),
				buildBubbleContextBySession(page.records),
				loadCursorProjectRuleSet()
			).projectBySession;
			peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
			const rawDestBySession = writeCursorRawPageSources(
				rawBase,
				page.firstRowId,
				page.lastRowId,
				projectBySession,
				defaultProject,
				page.records
			);
			const pageMessages = cursorBubbleRecordsToMessages(
				page.records,
				rawDestBySession,
				projectBySession,
				defaultProject,
				state
			);
			const checkpointCandidate: CursorRowIdCheckpoint = {
				cursorDiskKVRowId: page.lastRowId,
				itemTableRowId: nextCheckpoint.itemTableRowId,
			};
			const before = Math.ceil(pageMessages.length / batchSize);
			emitCursorMessageBatches(pageMessages, checkpointCandidate, batchSize, false, options.onBatch);
			peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
			emittedMessages += pageMessages.length;
			emittedBatches += before;
		}

		emitCursorMessageBatches([], nextCheckpoint, batchSize, true, options.onBatch);
		emittedBatches += 1;

		// Business logic: modern Cursor ingestion treats bubble rows as the authoritative
		// startup source; ItemTable fallback remains legacy-only and is not used by resume.
		if (!sawBubbleRows && options.mode !== "rowid-delta")
		{
			logger.info("Batched reader found no bubble rows; legacy ItemTable fallback was intentionally not used.");
		}
		logger.info(
			`Batched ${options.mode} emitted ${emittedMessages} messages in ${emittedBatches} batches (${Date.now() - startMs}ms)`
			+ ` peakRssMb=${Math.round(peakRssBytes / 1024 / 1024)}`
		);

		return {
			messages: [],
			checkpoint: nextCheckpoint,
		};
	}
	finally
	{
		db.close();
	}
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
	logger.info(`Starting ingest from ${dbPath}`);
	logger.info(
		`Project rules: explicit=${ruleSet.projectMappingRules.length}, nameRemaps=${ruleSet.projectNameMappingRules.length}, generic=${ruleSet.genericProjectMappingRules.length}, fallback=${MISC_CURSOR_PROJECT}`
	);

	try
	{
		const sessionModelMap = buildCursorSessionModelMap(db);
		const sessionTimestampMap = buildCursorSessionTimestampMap(db);
		const bubbleMessages = extractCursorBubbleMessages(db, sessionModelMap, sessionTimestampMap);
		logger.info(`Bubble messages extracted=${bubbleMessages.length}`);
		if (bubbleMessages.length > 0)
		{
			const workspaceInference = inferCursorWorkspaceForSessions(
				db,
				new Set(bubbleMessages.map((item) => item.sessionId)),
				buildBubbleContextBySession(bubbleMessages),
				ruleSet
			);
			logger.info(
				`Workspace inference: resolved=${workspaceInference.sessionsResolved}, fallbackGlobal=${workspaceInference.fallbackGlobal}, bubbleKeys=${workspaceInference.bubbleKeyCount}, metadataKeys=${workspaceInference.metadataKeyCount}`
			);
			if (workspaceInference.unresolvedFamilies.length > 0)
			{
				logger.debug(`Unresolved key families: ${workspaceInference.unresolvedFamilies.join(", ")}`);
			}
			const sc = workspaceInference.sourceCounts;
			logger.info(
				`Workspace sources: projectLayouts=${sc.projectLayouts}, composerFileUris=${sc.composerFileUris}, bubbleHeuristics=${sc.bubbleHeuristics}, unresolved=${sc.unresolved}`
			);
			//<Emit a small sample so we can quickly audit session->project routing.
			const routingSample = Array.from(workspaceInference.projectBySession.entries())
				.slice(0, 8)
				.map(([session, project]) => `${session.slice(0, 8)}…→${project}`)
				.join(" │ ");
			if (routingSample)
			{
				logger.debug(`Routing sample: ${routingSample}`);
			}

			if (workspaceInference.autoDerivedBySession.size > 0)
			{
				const adCount = workspaceInference.autoDerivedBySession.size;
				logger.warn(CUR_LINE);
				logger.warn(`Auto-derived projects (${adCount} sessions, no rule match)`);
				logger.warn(CUR_LINE);
				const adEntries = Array.from(workspaceInference.autoDerivedBySession.entries());
				// Business logic: diagnostics list auto-derived projects so operators can
				// promote recurring fallback mappings into explicit project rules.
				for (let adIdx = 0; adIdx < adEntries.length; adIdx += 1)
				{
					const [sessionId, data] = adEntries[adIdx];
					const isLast = adIdx === adEntries.length - 1;
					const branch = isLast ? "└" : "├";
					const cont = isLast ? " " : "│";
					logger.warn(
						`  ${branch} ${sessionId.slice(0, 8)}… → "${data.derivedProject}" ← ${data.path} [${data.source}]`
					);
					if (data.topWorkspaceCandidates.length > 0)
					{
						logger.warn(`  ${cont}   candidates: ${data.topWorkspaceCandidates.join(" │ ")}`);
					}
					if (data.contextSamples.length > 0)
					{
						logger.warn(`  ${cont}   context:    ${data.contextSamples.join(" │ ")}`);
					}
				}
			}

			if (workspaceInference.miscSessionPaths.size > 0)
			{
				const miscCount = workspaceInference.miscSessionPaths.size;
				logger.warn(CUR_LINE);
				logger.warn(`MISC sessions (${miscCount} sessions, no matching project rule)`);
				logger.warn(CUR_LINE);
				const miscEntries = Array.from(workspaceInference.miscSessionPaths.entries());
				// Business logic: MISC routing diagnostics expose unresolved sessions that
				// may need new Cursor project mapping rules.
				for (let mIdx = 0; mIdx < miscEntries.length; mIdx += 1)
				{
					const [sessionId, path] = miscEntries[mIdx];
					const source = workspaceInference.miscSourceBySession.get(sessionId) ?? "unresolved";
					const isLast = mIdx === miscEntries.length - 1;
					const branch = isLast ? "└" : "├";
					logger.warn(
						`  ${branch} ${sessionId.slice(0, 8)}… → path: ${path} [${source}]`
					);
				}
				logger.warn("Hint: add a genericProjectMappingRule for these paths in cc.json");
			}

			const suggestedRules = buildCursorGenericRuleSuggestions([
				...Array.from(workspaceInference.autoDerivedBySession.values()).map((item) => item.path),
				...Array.from(workspaceInference.miscSessionPaths.values()).filter((path) => path !== "(no workspace path found)"),
			]);
			if (suggestedRules.length > 0)
			{
				logger.warn("Suggested cc.json genericProjectMappingRules snippet:");
				logger.warn(
					JSON.stringify(
						{
							genericProjectMappingRules: suggestedRules,
						},
						null,
						2
					)
				);
			}
			const previousBySession = new Map<string, string | null>();
			//Group bubble messages by session for raw archival.
			const sessionBubbles = new Map<string, Array<CursorBubbleRecord>>();
			// Business logic: legacy full reads still preserve intra-session parent chains
			// for any operators forcing a non-batched Cursor refresh path.
			// Business logic: watcher incremental reads also keep parent chains within
			// the changed bubble set before messages are persisted into the shared model.
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
			// Business logic: legacy raw archives remain grouped by session so provenance
			// matches the storage/session model used by the API.
			// Business logic: changed Cursor bubbles are archived per session so watcher
			// updates preserve the same provenance shape as startup ingest.
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

			// Business logic: after raw archive paths are known, each legacy bubble message
			// receives the source path that points back to its archived session payload.
			// Business logic: each incremental bubble message receives the raw archive path
			// for its changed session batch before storage/DB persistence.
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
			logger.info(`Parsed ${bubbleMessages.length} bubble records from cursorDiskKV.`);
			logger.info(`Total ingest time=${Date.now() - startMs}ms`);
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
		logger.debug(`Discovered keys (${discoveredKeys.length}): ${discoveredKeys.join(", ")}`);

		// Business logic: ItemTable fallback scans only discovered chat-like keys so the
		// legacy path can recover unusual Cursor records without parsing unrelated state.
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
					// Business logic: fallback request-like messages inherit the raw key dump
					// so provenance is retained even when no bubble row exists.
					for (const msg of requestLikeMessages) { msg.source = rawDest; }
					results.push(...requestLikeMessages);
					continue;
				}

				const messageLike: Array<CursorMessageLike> = [];
				walkMessageLikeNodes(parsed, { sessionHint: key, modelHint: pickModel(parsed) }, messageLike);
				let previousId: string | null = null;

				// Business logic: generic message-like nodes are chained in discovery order
				// because fallback payloads may not expose stronger parent metadata.
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
				logger.warn(`Failed parsing key "${key}": ${(error as Error).message}`);
			}
		}
	} finally
	{
		db.close();
	}
	logger.info(`Total ingest time=${Date.now() - startMs}ms`);

	return results;
}

/**
 * Reads the latest rowid checkpoint for Cursor tables.
 * Used to persist/restore incremental watcher state.
 * @param dbPath - Path to Cursor `state.vscdb`.
 * @returns Latest rowid checkpoint for Cursor's tracked tables.
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
 * @param dbPath - Path to Cursor `state.vscdb`.
 * @param rawBase - Raw archive root for changed Cursor rows.
 * @param sinceCheckpoint - Previously committed Cursor rowid checkpoint.
 * @returns New messages plus the latest checkpoint.
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
		// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting harness ingest and source normalization from partial or invalid state.


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
			// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.

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
			// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.

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
			}			// Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.


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

			// Business logic: ItemTable watcher fallback is limited to newly changed keys
			// so live updates do not reparse the whole Cursor ItemTable.
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
						// Business logic: request-like fallback messages inherit the raw key dump
						// so live incremental provenance remains traceable.
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

					// Business logic: generic fallback nodes are chained in payload order when
					// Cursor does not provide explicit parent metadata.
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

		logger.info(
			`Incremental ingest: +${results.length} messages in ${Date.now() - startMs}ms ` +
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
