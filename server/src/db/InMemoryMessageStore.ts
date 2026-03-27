import { Database } from "bun:sqlite";
import { BaseMessageStore } from "./BaseMessageStore.js";

/**
 * In-memory SQLite store. All data is lost on process exit.
 * loadFromStorage() always loads the full corpus from JSON files.
 * Use when IN_MEMORY_DB=true.
 */
export class InMemoryMessageStore extends BaseMessageStore
{
	constructor()
	{
		super(new Database(":memory:"));
	}
}
