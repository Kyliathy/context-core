import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { BaseMessageStore } from "./BaseMessageStore.js";
import { AgentMessage } from "../models/AgentMessage.js";

/**
 * On-disk SQLite store. Data persists across restarts.
 * Uses WAL journal mode and a 64 MB page cache for performance.
 * loadFromStorage() skips sessions already present in the DB (incremental).
 * Use when IN_MEMORY_DB=false (the default).
 */
export class DiskMessageStore extends BaseMessageStore
{
	constructor(dbPath: string)
	{
		const db = new Database(dbPath, { create: true });

		// WAL mode: concurrent readers + single writer; safe and faster than DELETE journal.
		db.run("PRAGMA journal_mode = WAL");
		db.run("PRAGMA synchronous = NORMAL");
		db.run("PRAGMA cache_size = -64000"); // 64 MB page cache
		db.run("PRAGMA busy_timeout = 5000"); // wait up to 5s on lock contention

		super(db);
		console.log(`[MessageDB] On-disk database: ${dbPath}`);
	}

	/**
	 * Incremental load: only inserts sessions not already in the DB.
	 * Reads existing sessionIds once, then skips files whose first message
	 * belongs to a known session.
	 * @param storagePath - Root storage path produced by StorageWriter.
	 * @returns Number of messages inserted (not counting skipped sessions).
	 */
	override loadFromStorage(storagePath: string): number
	{
		// Build a set of sessionIds already in the DB.
		const existingRows = this.db
			.query("SELECT DISTINCT sessionId FROM AgentMessages")
			.all() as Array<{ sessionId: string }>;
		const existingSessionIds = new Set(existingRows.map((r) => r.sessionId));

		const files = this.collectJsonFiles(storagePath);
		let loaded = 0;
		let skipped = 0;

		// Wrap all inserts in a single transaction for batch-insert performance.
		const insertAll = this.db.transaction(() =>
		{
			for (const filePath of files)
			{
				try
				{
					const raw = JSON.parse(readFileSync(filePath, "utf-8")) as Array<unknown>;
					if (raw.length === 0)
					{
						continue;
					}

					// Peek at the first message's sessionId to decide whether to skip.
					const firstMessage = AgentMessage.deserialize(raw[0]);
					if (existingSessionIds.has(firstMessage.sessionId))
					{
						skipped += 1;
						continue;
					}

					for (const row of raw)
					{
						const message = AgentMessage.deserialize(row);
						this.insertMessage(message);
						loaded += 1;
					}
				} catch
				{
					// Skip malformed session files and continue ingestion.
				}
			}
		});

		insertAll();

		console.log(`[MessageDB] Loaded ${loaded} new messages (${skipped} sessions already in DB skipped).`);
		return loaded;
	}

	/**
	 * Batch insert with a transaction for better write throughput on disk.
	 */
	override addMessages(messages: Array<AgentMessage>): number
	{
		let inserted = 0;
		const insertBatch = this.db.transaction(() =>
		{
			for (const message of messages)
			{
				if (this.insertMessage(message))
				{
					inserted += 1;
				}
			}
		});
		insertBatch();
		return inserted;
	}
}
