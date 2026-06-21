import { existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import type { CanonicalAgentDefinition } from "./types.js";
import { writeFileAtomic } from "./fileOps.js";

/** Metadata key stamped on CXC-created canonical definitions for future migrations. */
export const CXC_CANONICAL_SOURCE_KEY = "x-cxc-generated";
export const CXC_CANONICAL_SOURCE_VALUE = "ContextCore-AgentBuilder";

type StoreFile = {
	version: 1;
	definitions: CanonicalAgentDefinition[];
};

/** Persists canonical agent definitions at {storage}/.settings/agent-definitions.json. */
export class CanonicalAgentStore
{
	private definitions: CanonicalAgentDefinition[] = [];
	private readonly storePath: string;
	private loadWarning: string | undefined;

	constructor(storagePath: string)
	{
		const settingsDir = join(storagePath, ".settings");
		this.storePath = join(settingsDir, "agent-definitions.json");
	}

	/** Loads store from disk; corrupt JSON yields empty store + warning. */
	load(): string | undefined
	{
		if (!existsSync(this.storePath))
		{
			this.definitions = [];
			return undefined;
		}
		try
		{
			const parsed = JSON.parse(readFileSync(this.storePath, "utf8")) as StoreFile;
			this.definitions = Array.isArray(parsed.definitions) ? parsed.definitions : [];
			return undefined;
		} catch
		{
			this.definitions = [];
			this.loadWarning = "Corrupt agent-definitions.json — starting with empty store";
			return this.loadWarning;
		}
	}

	/** Returns warning from last load if any. */
	getLoadWarning(): string | undefined
	{
		return this.loadWarning;
	}

	/** Saves store atomically. */
	save(): void
	{
		mkdirSync(join(this.storePath, ".."), { recursive: true });
		const payload: StoreFile = { version: 1, definitions: this.definitions };
		writeFileAtomic(this.storePath, `${JSON.stringify(payload, null, 2)}\n`);
	}

	/** Upserts one canonical definition keyed by id. */
	upsert(definition: CanonicalAgentDefinition): void
	{
		const stamped: CanonicalAgentDefinition = {
			...definition,
			metadata: {
				...definition.metadata,
				[CXC_CANONICAL_SOURCE_KEY]: CXC_CANONICAL_SOURCE_VALUE,
			},
		};
		const idx = this.definitions.findIndex((d) => d.id === stamped.id);
		if (idx >= 0) this.definitions[idx] = stamped;
		else this.definitions.push(stamped);
	}

	/** Returns one definition by canonical id. */
	get(id: string): CanonicalAgentDefinition | undefined
	{
		return this.definitions.find((d) => d.id === id);
	}

	/** Returns all stored definitions. */
	list(): CanonicalAgentDefinition[]
	{
		return [...this.definitions];
	}

	/** Absolute path to agent-definitions.json on disk. */
	getStorePath(): string
	{
		return this.storePath;
	}
}
