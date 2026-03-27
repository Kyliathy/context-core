/**
 * AgentThread represents a conversation thread (session) with metadata.
 * Used in thread-level search results where entire conversations are the unit of discovery.
 */

export type AgentThread = {
	/** Unique session identifier */
	sessionId: string;

	/** Thread subject/title (from first message) */
	subject: string;

	/** Source harness (ClaudeCode, Cursor, Kiro, VSCode) */
	harness: string;

	/** Total number of messages in this thread */
	messageCount: number;

	/** Sum of character lengths across all messages in thread */
	totalLength: number;

	/** ISO datetime of earliest message in thread */
	firstDateTime: string;

	/** ISO datetime of latest message in thread */
	lastDateTime: string;

	/** Content of the first message in the thread (typically the initial user prompt) */
	firstMessage: string;

	/** IDs of messages that matched the search query */
	matchingMessageIds: string[];

	/** Highest composite score among matching messages (0-1, higher = better) */
	bestMatchScore: number;

	/** Total count of query term occurrences across all matching messages in this thread */
	hits: number;

	/** Project name of the first message in this thread */
	project: string;
};
