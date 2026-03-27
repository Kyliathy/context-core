/**
 * TopicStore — persistence layer for AI-generated and custom topic summaries.
 * Stores topic entries in .settings/topics.json, isolated from AgentMessage storage.
 */

import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import type { TopicEntry } from "../models/TopicEntry.js";

export class TopicStore
{
	private readonly settingsDir: string;
	private readonly topicsFilePath: string;
	private entries: Map<string, TopicEntry>;

	/**
	 * Creates a TopicStore instance.
	 * @param storagePath - Root storage directory (e.g., "d:\\Codez\\Nexus\\design\\CXC")
	 */
	constructor(storagePath: string)
	{
		this.settingsDir = join(storagePath, ".settings");
		this.topicsFilePath = join(this.settingsDir, "topics.json");
		this.entries = new Map();

		// Ensure .settings directory exists
		if (!existsSync(this.settingsDir))
		{
			mkdirSync(this.settingsDir, { recursive: true });
		}
	}

	/**
	 * Loads topic entries from topics.json.
	 * If the file doesn't exist, initializes with an empty map silently.
	 * If the file contains invalid JSON, logs a warning and starts with an empty map.
	 */
	load(): void
	{
		if (!existsSync(this.topicsFilePath))
		{
			// File doesn't exist yet — this is expected on first run
			this.entries = new Map();
			return;
		}

		try
		{
			const fileContent = readFileSync(this.topicsFilePath, "utf-8");
			const entriesArray = JSON.parse(fileContent) as TopicEntry[];

			// Build map keyed by sessionId for fast lookups
			this.entries = new Map();
			for (const entry of entriesArray)
			{
				this.entries.set(entry.sessionId, entry);
			}
		} catch (error)
		{
			console.warn(
				`[TopicStore] Failed to parse topics.json: ${(error as Error).message}. Starting with empty map.`
			);
			this.entries = new Map();
		}
	}

	/**
	 * Saves the current topic entries to topics.json.
	 * Serializes the map to a JSON array with 2-space indentation.
	 */
	save(): void
	{
		const entriesArray = Array.from(this.entries.values());
		const jsonContent = JSON.stringify(entriesArray, null, 2);
		writeFileSync(this.topicsFilePath, jsonContent, "utf-8");
	}

	/**
	 * Retrieves a topic entry by session ID.
	 * @param sessionId - Session identifier to look up.
	 * @returns The topic entry if found, otherwise undefined.
	 */
	getBySessionId(sessionId: string): TopicEntry | undefined
	{
		return this.entries.get(sessionId);
	}

	/**
	 * Inserts or updates a topic entry.
	 * @param entry - Topic entry to upsert.
	 */
	upsert(entry: TopicEntry): void
	{
		this.entries.set(entry.sessionId, entry);
	}

	/**
	 * Checks if a topic entry exists for a given session.
	 * @param sessionId - Session identifier to check.
	 * @returns True if an entry exists, false otherwise.
	 */
	hasSession(sessionId: string): boolean
	{
		return this.entries.has(sessionId);
	}

	/**
	 * Determines whether summarization should be skipped for a session.
	 * Skip when an entry already has meaningful aiSummary or customTopic.
	 */
	shouldSkipSummarization(sessionId: string): boolean
	{
		const entry = this.entries.get(sessionId);
		if (!entry)
		{
			return false;
		}

		const hasAiSummary = entry.aiSummary.trim().length > 0;
		const hasCustomTopic = entry.customTopic.trim().length > 0;
		return hasAiSummary || hasCustomTopic;
	}

	/**
	 * Returns all entries whose aiSummary exceeds maxChars and have no customTopic.
	 * Used by pass 2 to find sessions that need re-summarization with a smarter model.
	 * @param maxChars - Character limit; entries with aiSummary.length > maxChars are returned.
	 */
	getVerboseEntries(maxChars: number): TopicEntry[]
	{
		return Array.from(this.entries.values()).filter(
			(entry) =>
				entry.aiSummary.trim().length > maxChars &&
				entry.customTopic.trim().length === 0
		);
	}

	/**
	 * Returns all topic entries as an array.
	 * Used by SummaryEmbeddingCache to iterate sessions for summary embedding.
	 */
	getAll(): TopicEntry[]
	{
		return Array.from(this.entries.values());
	}

	/**
	 * Returns the number of topic entries currently loaded.
	 * Used for startup logging and diagnostics.
	 */
	get count(): number
	{
		return this.entries.size;
	}
}
