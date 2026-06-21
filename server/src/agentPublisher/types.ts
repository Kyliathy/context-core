/**
 * Agent Publisher shared types.
 *
 * Architecture: server/zz-reach2/architecture/agents/archi-agent-builder.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ab3-agent-builder-3.md
 */

/** Supported publish target platforms. */
export type PublishPlatform = "copilot" | "claude" | "codex" | "kiro" | "cursor" | "windsurf" | "antigravity";

/** Materialized artifact category. */
export type ArtifactKind = "agent" | "skill";

/** Distinguishes Codex collections from plain AGENTS.md guidance files. */
export type AgentsArtifactFormat =
	| "codex-collection"
	| "plain-agents-md"
	| "plain-agents-override-md";

/** Materialization strategy for a publish target (omitted means copy). */
export type LinkStrategy = "copy" | "import-shim" | "symlink";

/** Provenance attached to rendered artifacts and ledger rows. */
export interface PublishedArtifactProvenance
{
	platform: PublishPlatform;
	artifactKind: ArtifactKind;
	artifactFormat?: AgentsArtifactFormat;
	canonicalId?: string;
}

/** A single knowledge reference inside a canonical definition. */
export interface KnowledgeRef
{
	kind: "file" | "text";
	value: string;
}

/** Canonical agent/skill definition used by Builder save and Publisher materialization. */
export interface CanonicalAgentDefinition
{
	id: string;
	kind: ArtifactKind;
	projectName: string;
	name: string;
	description: string;
	whenToUse?: string;
	"argument-hint"?: string;
	tools?: string[];
	knowledge: KnowledgeRef[];
	body?: string;
	license?: string;
	compatibility?: string;
	metadata?: Record<string, string>;
	/** Cursor skill path globs (portable open-skill extension used by Cursor). */
	paths?: string[];
	/** When true, Cursor skill is manual-invocation only (maps to disable-model-invocation). */
	disableModelInvocation?: boolean;
}

/** One publish destination selected in the Publisher UI. */
export interface PublishTarget
{
	platform: PublishPlatform;
	artifactKind: ArtifactKind;
	outputDir: string;
	/** Codex collection entry id override (defaults to canonical id). */
	codexEntryId?: string;
	/** Materialization strategy; omitted defaults to copy. */
	linkStrategy?: LinkStrategy;
}

/** Drift state for a published artifact. */
export type DriftState = "clean" | "canonical-changed" | "disk-changed" | "missing-file" | "unknown";

/** Link strategy metadata on a rendered artifact. */
export interface MaterializationMetadata
{
	requestedLinkStrategy?: LinkStrategy;
	actualLinkStrategy?: LinkStrategy;
}

/** One materialized file produced by a platform publisher. */
export interface RenderedArtifact
{
	absolutePath: string;
	content: string;
	platform: PublishPlatform;
	artifactKind: ArtifactKind;
	/** Preview hint: new file, replace generated, backup unmanaged, or unknown existing. */
	previewStatus?: "new" | "replace-generated" | "backup-unmanaged" | "unknown";
	isCompanionJson?: boolean;
	artifactFormat?: AgentsArtifactFormat;
	canonicalId?: string;
	materialization?: MaterializationMetadata;
}

/** Result of POST /api/agent-publisher/publish. */
export interface PublishResult
{
	written: Array<{ absolutePath: string; platform: PublishPlatform; artifactKind: ArtifactKind }>;
	warnings: string[];
	errors: string[];
}

/** Result of POST /api/agent-publisher/preview. */
export interface PreviewResult
{
	artifacts: RenderedArtifact[];
	warnings: string[];
	errors: string[];
}

/** One ledger row tracking provenance for a materialized artifact. */
export interface PublishLedgerEntry
{
	canonicalId: string;
	platform: PublishPlatform;
	artifactKind: ArtifactKind;
	absolutePath: string;
	canonicalHash: string;
	artifactHash: string;
	knowledge: string[];
	referencedPaths: string[];
	publishedAt: string;
	artifactFormat?: AgentsArtifactFormat;
	actualLinkStrategy?: LinkStrategy;
}

/** Drift report for one canonical agent id. */
export interface DriftReport
{
	canonicalId: string;
	entries: Array<{
		platform: PublishPlatform;
		artifactKind: ArtifactKind;
		absolutePath: string;
		state: DriftState;
	}>;
}

/** Directory node for path heat visualization. */
export interface DirHeatNode
{
	name: string;
	absolutePath: string;
	directHits: number;
	subtreeHits: number;
	/** Normalized heat 0..1 for UI coloring. */
	heat: number;
	children: DirHeatNode[];
}

/** Path heat analysis result for one project. */
export interface PathHeatResult
{
	projectName: string;
	projectRoot: string;
	totalHits: number;
	tree: DirHeatNode[];
	topPaths: Array<{ path: string; hits: number }>;
	suggestedOutputDir?: string;
	droppedPathCount: number;
	/** Absolute paths of knowledge basket files included in this analysis. */
	knowledgeFilePaths?: string[];
}

/** Per-platform default directory contract returned by GET /platforms. */
export interface PlatformDefaultDirs
{
	projectRoot: string;
	agentOutputDir: string;
	skillRootDir: string;
}

/** Describes a native artifact path shape for Publisher UI hints. */
export interface PlatformArtifactTemplate
{
	artifactKind: ArtifactKind;
	rootKey: "agentOutputDir" | "skillRootDir" | "projectRoot";
	relativePathTemplate: string;
	note?: string;
}

/** Platform capability metadata returned by GET /platforms. */
export interface PlatformCapability
{
	platform: PublishPlatform;
	label: string;
	supportedArtifactKinds: ArtifactKind[];
	defaultDirs?: PlatformDefaultDirs;
	artifactTemplates?: PlatformArtifactTemplate[];
	notes?: string[];
	/** @deprecated Prefer supportedLinkStrategiesByKind */
	supportedLinkStrategies?: LinkStrategy[];
	/** Per-artifact-kind link strategies exposed to the Publisher UI. */
	supportedLinkStrategiesByKind?: Partial<Record<ArtifactKind, LinkStrategy[]>>;
}
