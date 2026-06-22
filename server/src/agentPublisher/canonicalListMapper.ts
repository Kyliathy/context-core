/**
 * Canonical Agent List projection — maps agent-definitions.json + publish ledger rows.
 *
 * Architecture: server/zz-reach2/architecture/agents/archi-agent-builder.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ap-agent-publisher-2.md (Part A)
 */

import { existsSync } from "fs";
import type {
	ArtifactKind,
	CanonicalAgentDefinition,
	DriftState,
	LinkStrategy,
	PublishLedgerEntry,
	PublishPlatform,
	AgentsArtifactFormat,
} from "./types.js";

/** Per-platform publish summary joined onto a canonical catalog row. */
export interface PublishedTargetSummary
{
	platform: PublishPlatform;
	artifactKind: ArtifactKind;
	absolutePath: string;
	publishedAt: string;
	artifactFormat?: AgentsArtifactFormat;
	actualLinkStrategy?: LinkStrategy;
	/** Codex collection entry id when platform is codex (defaults to canonical id). */
	codexEntryId?: string;
	/** Cheap list-time state: missing-file only unless full drift is requested elsewhere. */
	state?: DriftState;
}

/**
 * Agent List row backed by canonical storage, not disk artifact scans.
 * Disk files are publish output; this catalog is the saved-definition source of truth.
 */
export interface CanonicalAgentListEntry
{
	canonicalId: string;
	projectName: string;
	name: string;
	description: string;
	hint: string;
	kind: ArtifactKind;
	/** ISO timestamp from definition metadata when present. */
	savedAt?: string;
	publishedTo: PublishedTargetSummary[];
	unpublished: boolean;
}

/** Response shape for GET /api/agent-builder/list (canonical-first). */
export interface AgentListResponse
{
	totalAgents: number;
	agents: CanonicalAgentListEntry[];
}

/** Publish status payload for GET /api/agent-publisher/status. */
export interface PublishStatusResponse
{
	canonicalId: string;
	publishedTo: PublishedTargetSummary[];
	drift?: {
		canonicalId: string;
		entries: Array<{
			platform: PublishPlatform;
			artifactKind: ArtifactKind;
			absolutePath: string;
			state: DriftState;
		}>;
	};
}

/**
 * Maps one ledger row to a published target summary for Agent List / status UI.
 * @param entry - Persisted publish ledger row for a materialized artifact.
 * @param includeMissingFileState - When true, performs a cheap existsSync check for list rows.
 */
export function toPublishedTargetSummary(
	entry: PublishLedgerEntry,
	includeMissingFileState = false,
): PublishedTargetSummary
{
	const summary: PublishedTargetSummary = {
		platform: entry.platform,
		artifactKind: entry.artifactKind,
		absolutePath: entry.absolutePath,
		publishedAt: entry.publishedAt,
		artifactFormat: entry.artifactFormat,
		actualLinkStrategy: entry.actualLinkStrategy,
	};

	// Business logic: Codex collections key entries by canonical id — surface that for multi-entry AGENTS.md clarity.
	if (entry.platform === "codex")
	{
		summary.codexEntryId = entry.canonicalId;
	}

	if (includeMissingFileState && !existsSync(entry.absolutePath))
	{
		summary.state = "missing-file";
	}

	return summary;
}

/**
 * Derives display hint from canonical definition fields.
 * @param def - Canonical agent or skill definition from agent-definitions.json.
 */
export function deriveListHint(def: CanonicalAgentDefinition): string
{
	return def["argument-hint"]?.trim() || def.whenToUse?.trim() || "";
}

/**
 * Reads optional saved-at metadata stamped on canonical definitions.
 * @param def - Canonical definition that may carry metadata.savedAt.
 */
export function deriveSavedAt(def: CanonicalAgentDefinition): string | undefined
{
	const raw = def.metadata?.savedAt ?? def.metadata?.["saved-at"];
	return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
}

/**
 * Builds one canonical Agent List entry from store + ledger rows (no disk artifact reads).
 * @param def - Canonical definition from agent-definitions.json.
 * @param rows - Ledger rows keyed by def.id.
 * @param includeMissingFileState - When true, list rows include cheap missing-file state.
 */
export function toCanonicalListEntry(
	def: CanonicalAgentDefinition,
	rows: PublishLedgerEntry[],
	includeMissingFileState = false,
): CanonicalAgentListEntry
{
	const publishedTo = rows.map((row) => toPublishedTargetSummary(row, includeMissingFileState));
	return {
		canonicalId: def.id,
		projectName: def.projectName,
		name: def.name,
		description: def.description,
		hint: deriveListHint(def),
		kind: def.kind,
		savedAt: deriveSavedAt(def),
		publishedTo,
		unpublished: publishedTo.length === 0,
	};
}

/**
 * Maps all canonical definitions to list entries with deterministic sort order.
 * @param definitions - All rows from CanonicalAgentStore.list().
 * @param ledgerRowsByCanonicalId - Ledger rows grouped by canonicalId.
 * @param includeMissingFileState - When true, performs cheap missing-file checks per published path.
 */
export function mapCanonicalAgentList(
	definitions: CanonicalAgentDefinition[],
	ledgerRowsByCanonicalId: Map<string, PublishLedgerEntry[]>,
	includeMissingFileState = false,
): AgentListResponse
{
	const agents = definitions
		.map((def) => toCanonicalListEntry(
			def,
			ledgerRowsByCanonicalId.get(def.id) ?? [],
			includeMissingFileState,
		))
		.sort((a, b) =>
		{
			const projectCmp = a.projectName.localeCompare(b.projectName);
			if (projectCmp !== 0) return projectCmp;
			return a.name.localeCompare(b.name);
		});

	return { totalAgents: agents.length, agents };
}

/**
 * Joins full drift states onto published target summaries for Publisher status rows.
 * @param publishedTo - Ledger-backed publish summaries.
 * @param driftEntries - Drift analyzer rows for the same canonical id.
 */
export function mergeDriftIntoPublishedSummaries(
	publishedTo: PublishedTargetSummary[],
	driftEntries: Array<{
		platform: PublishPlatform;
		artifactKind: ArtifactKind;
		absolutePath: string;
		state: DriftState;
	}>,
): PublishedTargetSummary[]
{
	const normalize = (value: string): string => value.replace(/\\/g, "/").toLowerCase();
	return publishedTo.map((row) =>
	{
		const match = driftEntries.find((entry) =>
			entry.platform === row.platform
			&& entry.artifactKind === row.artifactKind
			&& normalize(entry.absolutePath) === normalize(row.absolutePath),
		);
		return match ? { ...row, state: match.state } : row;
	});
}
