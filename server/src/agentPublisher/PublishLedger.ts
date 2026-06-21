import { existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import type { PublishLedgerEntry } from "./types.js";
import { writeFileAtomic } from "./fileOps.js";

type LedgerFile = {
	version: 1;
	entries: PublishLedgerEntry[];
};

/** Persists publish provenance at {storage}/.settings/agent-publish.json. */
export class PublishLedger
{
	private entries: PublishLedgerEntry[] = [];
	private readonly ledgerPath: string;
	private loadWarning: string | undefined;

	constructor(storagePath: string)
	{
		const settingsDir = join(storagePath, ".settings");
		this.ledgerPath = join(settingsDir, "agent-publish.json");
	}

	/** Loads ledger from disk; corrupt JSON yields empty ledger + warning. */
	load(): string | undefined
	{
		if (!existsSync(this.ledgerPath))
		{
			this.entries = [];
			return undefined;
		}
		try
		{
			const parsed = JSON.parse(readFileSync(this.ledgerPath, "utf8")) as LedgerFile;
			this.entries = Array.isArray(parsed.entries) ? parsed.entries : [];
			return undefined;
		} catch
		{
			this.entries = [];
			this.loadWarning = "Corrupt agent-publish.json — starting with empty ledger";
			return this.loadWarning;
		}
	}

	/** Saves ledger atomically. */
	save(): void
	{
		mkdirSync(join(this.ledgerPath, ".."), { recursive: true });
		const payload: LedgerFile = { version: 1, entries: this.entries };
		writeFileAtomic(this.ledgerPath, `${JSON.stringify(payload, null, 2)}\n`);
	}

	/** Upserts one ledger row keyed by canonicalId + platform + artifactKind + absolutePath. */
	upsert(entry: PublishLedgerEntry): void
	{
		const idx = this.entries.findIndex((e) =>
			e.canonicalId === entry.canonicalId &&
			e.platform === entry.platform &&
			e.artifactKind === entry.artifactKind &&
			e.absolutePath === entry.absolutePath
		);
		if (idx >= 0) this.entries[idx] = entry;
		else this.entries.push(entry);
	}

	/** Returns all entries for a canonical id. */
	getByCanonicalId(canonicalId: string): PublishLedgerEntry[]
	{
		return this.entries.filter((e) => e.canonicalId === canonicalId);
	}

	/** Returns all ledger entries. */
	getAll(): PublishLedgerEntry[]
	{
		return [...this.entries];
	}

	/**
	 * Returns the most recent ledger entry for an absolute artifact path.
	 * @param absolutePath - Normalized absolute path of a materialized artifact.
	 */
	getByAbsolutePath(absolutePath: string): PublishLedgerEntry | undefined
	{
		const normalized = absolutePath.replace(/\\/g, "/");
		const matches = this.entries.filter((e) => e.absolutePath.replace(/\\/g, "/") === normalized);
		if (matches.length === 0) return undefined;
		return matches.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0];
	}
}
