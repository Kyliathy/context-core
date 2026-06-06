/** Supported publish target platforms. */
export type PublishPlatform = "copilot" | "claude" | "codex" | "kiro" | "cursor" | "windsurf" | "antigravity";

/** Materialized artifact category. */
export type ArtifactKind = "agent" | "skill";

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
}

/** One publish destination selected in the Publisher UI. */
export interface PublishTarget
{
	platform: PublishPlatform;
	artifactKind: ArtifactKind;
	outputDir: string;
	/** Codex collection entry id override (defaults to canonical id). */
	codexEntryId?: string;
}

/** Drift state for a published artifact. */
export type DriftState = "clean" | "canonical-changed" | "disk-changed" | "missing-file" | "unknown";

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
}

/** Per-platform default directory contract returned by GET /platforms. */
export interface PlatformDefaultDirs
{
	projectRoot: string;
	agentOutputDir: string;
	skillRootDir: string;
}

/** Platform capability metadata returned by GET /platforms. */
export interface PlatformCapability
{
	platform: PublishPlatform;
	label: string;
	supportedArtifactKinds: ArtifactKind[];
	defaultDirs?: PlatformDefaultDirs;
}
