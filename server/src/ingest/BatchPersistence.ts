/**
 * Startup ingest batch persistence helpers.
 *
 * Architecture: server/zz-reach2/architecture/archi-context-core-level0.md
 * Upgrade plan: server/zz-reach2/upgrades/2026-06/r2so2-startup-optimization2.md
 */

import { relative } from "path";
import type { AgentMessage } from "../models/AgentMessage.js";
import type { IMessageStore } from "../db/IMessageStore.js";
import type { StorageWriter } from "../storage/StorageWriter.js";
import { deriveProjectName } from "../utils/pathHelpers.js";
import { groupBySession } from "./sessionGrouping.js";

export type HarnessIngestBatch = {
	harnessName: string;
	messages: Array<AgentMessage>;
	checkpointCandidate?: unknown;
	isFinalBatch: boolean;
};

export type BatchPersistResult = {
	sessionsScanned: number;
	newSessionsFound: number;
	messagesAdded: number;
	storageFilesWritten: number;
	storageFilesOverwritten: number;
	touchedSessionIds: Set<string>;
	allNewMessages: Array<AgentMessage>;
	sessionErrors: Array<{ sessionId: string; error: string }>;
	fatalError: boolean;
	durationMs: number;
};

export type BatchPersistenceOptions = {
	messageDB: IMessageStore;
	storageWriter: StorageWriter;
	machineName: string;
	storagePath: string;
	preferExistingCursorProject?: boolean;
};

/**
 * Handles stampMessages behavior for this CXC module.
 * @param messages - Message data processed by stampMessages.
 * @param machineName - Value consumed by stampMessages.
 * @param harnessName - Harness name or harness data used by stampMessages.
 * @param storagePath - Path used by stampMessages to locate the relevant CXC resource.
 */
export function stampMessages(
	messages: Array<AgentMessage>,
	machineName: string,
	harnessName: string,
	storagePath: string
): void
{
	// Business logic: this iteration walks every relevant item so startup ingest planning and bookmark safety reflects the complete source set instead of a partial snapshot.

	for (const message of messages)
	{
		message.machine = machineName;
		message.harness = harnessName;
		if (message.source)
		{
			message.source = relative(storagePath, message.source);
		}
	}
}

/**
 * Handles persistIngestBatch behavior for this CXC module.
 * @param batch - Value consumed by persistIngestBatch.
 * @param options - Options that control persistIngestBatch.
 * @returns Result produced by persistIngestBatch.
 */
export function persistIngestBatch(
	batch: HarnessIngestBatch,
	options: BatchPersistenceOptions
): BatchPersistResult
{
	const startMs = Date.now();
	const result: BatchPersistResult = {
		sessionsScanned: 0,
		newSessionsFound: 0,
		messagesAdded: 0,
		storageFilesWritten: 0,
		storageFilesOverwritten: 0,
		touchedSessionIds: new Set<string>(),
		allNewMessages: [],
		sessionErrors: [],
		fatalError: false,
		durationMs: 0,
	};

	try
	{
		// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting startup ingest planning and bookmark safety from partial or invalid state.

		if (batch.messages.length === 0 && batch.checkpointCandidate !== undefined && !batch.isFinalBatch)
		{
			result.fatalError = true;
			result.sessionErrors.push({
				sessionId: "(batch)",
				error: "empty checkpoint batch must be final",
			});
			return result;
		}

		stampMessages(batch.messages, options.machineName, batch.harnessName, options.storagePath);
		const sessions = groupBySession(batch.messages);
		result.sessionsScanned = sessions.size;
		// Business logic: this iteration walks every relevant item so startup ingest planning and bookmark safety reflects the complete source set instead of a partial snapshot.


		for (const [, sessionMessages] of sessions.entries())
		{
			if (sessionMessages.length === 0)
			{
				continue;
			}

			const first = sessionMessages[0];
			let project = first.project || deriveProjectName(batch.harnessName, first.sessionId);
			// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting startup ingest planning and bookmark safety from partial or invalid state.


			if (options.preferExistingCursorProject && batch.harnessName === "Cursor")
			{
				const existingSession = options.messageDB.getBySessionId(first.sessionId);
				const existingProject = existingSession[0]?.project;
				// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting startup ingest planning and bookmark safety from partial or invalid state.

				if (existingProject && (!first.project || first.project === "MISC"))
				{
					project = existingProject;
					// Business logic: this iteration walks every relevant item so startup ingest planning and bookmark safety reflects the complete source set instead of a partial snapshot.

					for (const message of sessionMessages)
					{
						message.project = existingProject;
					}
				}
			}

			try
			{
				const outPath = options.storageWriter.writeSession(
					sessionMessages,
					options.machineName,
					batch.harnessName,
					project
				);
				if (outPath)
				{
					result.storageFilesWritten += 1;
				}

				const newCount = options.messageDB.addMessages(sessionMessages);
				if (newCount > 0)
				{
					result.newSessionsFound += 1;
					result.messagesAdded += newCount;
					result.touchedSessionIds.add(first.sessionId);
					result.allNewMessages.push(...sessionMessages);

					const allSessionMessages = options.messageDB.getBySessionId(first.sessionId);
					options.storageWriter.writeSession(
						allSessionMessages,
						options.machineName,
						batch.harnessName,
						project,
						true
					);
					result.storageFilesOverwritten += 1;
				}
			}
			catch (error)
			{
				result.sessionErrors.push({
					sessionId: first.sessionId,
					error: (error as Error).message,
				});
			}
		}
	}
	catch (error)
	{
		result.fatalError = true;
		result.sessionErrors.push({
			sessionId: "(batch)",
			error: (error as Error).message,
		});
	}
	finally
	{
		result.durationMs = Date.now() - startMs;
	}

	return result;
}
