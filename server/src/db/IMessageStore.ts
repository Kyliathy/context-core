import type { AgentMessage } from "../models/AgentMessage.js";
import type { CCSettings } from "../settings/CCSettings.js";

export type MessageQueryFilters = {
	role?: string;
	harness?: string;
	model?: string;
	project?: string;
	subject?: string;
	from?: string;
	to?: string;
	page?: number;
	pageSize?: number;
};

export type MessageQueryResult = {
	total: number;
	page: number;
	results: Array<AgentMessage>;
};

export type SessionSummary = {
	sessionId: string;
	count: number;
	firstDateTime: string;
	lastDateTime: string;
	harness: string;
};

/**
 * Creates the appropriate MessageStore based on the IN_MEMORY_DB setting.
 * Use this as the single construction point in entry-point files.
 * @param settings - CCSettings singleton with databaseFile path and IN_MEMORY_DB flag.
 */
export async function createMessageStore(settings: CCSettings): Promise<IMessageStore>
{
	if (settings.IN_MEMORY_DB)
	{
		const { InMemoryMessageStore } = await import("./InMemoryMessageStore.js");
		return new InMemoryMessageStore();
	}
	const { DiskMessageStore } = await import("./DiskMessageStore.js");
	return new DiskMessageStore(settings.databaseFile);
}

/**
 * Common contract for all MessageStore implementations (in-memory and on-disk).
 */
export interface IMessageStore
{
	/** Closes the underlying database connection. */
	close(): void;

	/**
	 * Inserts multiple messages, ignoring duplicates.
	 * @returns Number of rows actually inserted (not duplicates).
	 */
	addMessages(messages: Array<AgentMessage>): number;

	/**
	 * Loads serialized sessions from storage JSON files and inserts all messages.
	 * @param storagePath - Root storage path produced by StorageWriter.
	 * @returns Total number of messages loaded.
	 */
	loadFromStorage(storagePath: string): number;

	/** Returns one message by unique ID, or null if not found. */
	getById(id: string): AgentMessage | null;

	/** Returns all messages for a session, ordered by timestamp ascending. */
	getBySessionId(sessionId: string): Array<AgentMessage>;

	/** Lists session metadata for summary views, ordered by most-recent first. */
	listSessions(): Array<SessionSummary>;

	/** Returns all messages ordered by timestamp descending. */
	getAllMessages(): Array<AgentMessage>;

	/** Returns message count grouped by harness for diagnostics. */
	getHarnessCounts(): Array<{ harness: string; count: number }>;

	/** Returns date range per harness for diagnostics. */
	getHarnessDateRanges(): Array<{ harness: string; earliest: string; latest: string; count: number }>;

	/** Performs a filtered message query with pagination. */
	queryMessages(filters: MessageQueryFilters): MessageQueryResult;

	/** Returns total number of messages in the store. */
	getMessageCount(): number;

	/** Returns all known projects grouped by harness, sorted alphabetically. */
	getProjectsByHarness(): Array<{ harness: string; projects: Array<string> }>;
}
