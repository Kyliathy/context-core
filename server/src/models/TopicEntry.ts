/**
 * TopicEntry represents an AI-generated or custom summary for a conversation thread.
 * Stored in .settings/topics.json, isolated from AgentMessage storage.
 */

export type TopicEntry = {
	/** Unique session identifier (matches AgentMessage.sessionId) */
	sessionId: string;

	/** Number of characters sent to the AI model for summarization */
	charsSent: number;

	/** AI-generated summary of the conversation thread */
	aiSummary: string;

	/** User-defined custom topic/title (empty string when not set) */
	customTopic: string;
};
