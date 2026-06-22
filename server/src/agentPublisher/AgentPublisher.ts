/**
 * Agent Publisher orchestrator — preview, publish, drift, and platform registry.
 *
 * Architecture: server/zz-reach2/architecture/agents/archi-agent-builder.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ab3-agent-builder-3.md
 */

import { existsSync } from "fs";
import type { DataSourceEntry } from "../types.js";
import type { AgentBuilder } from "../agentBuilder/AgentBuilder.js";
import { mergeDriftIntoPublishedSummaries, toPublishedTargetSummary } from "./canonicalListMapper.js";
import { AgentPublisherBase } from "./AgentPublisherBase.js";
import { AgentPublisherCopilot } from "./platforms/AgentPublisherCopilot.js";
import { AgentPublisherClaude } from "./platforms/AgentPublisherClaude.js";
import { AgentPublisherCodex } from "./platforms/AgentPublisherCodex.js";
import { AgentPublisherCursor } from "./platforms/AgentPublisherCursor.js";
import { AgentPublisherWindsurf } from "./platforms/AgentPublisherWindsurf.js";
import { AgentPublisherAntigravity } from "./platforms/AgentPublisherAntigravity.js";
import { AgentPublisherKiro } from "./platforms/AgentPublisherKiro.js";
import type { CanonicalAgentStore } from "./CanonicalAgentStore.js";
import { decideAgentsCollision, applyIntraPreviewAgentsCollision, isAgentsMdBasename } from "./agentsCollision.js";
import { artifactTemplatesForPlatform, PLATFORM_NOTES } from "./artifactTemplates.js";
import { canonicalHash } from "./canonical.js";
import { hashContent, hashFileIfExists } from "./fileOps.js";
import { buildImportShimPlan } from "./importShim.js";
import {
	assertLinkStrategyAllowed,
	ENABLE_SYMLINK_PUBLISH,
	linkStrategiesByKindForPlatform,
	linkStrategiesForTarget,
} from "./linkStrategyPolicy.js";
import { PathHeatAnalyzer } from "./PathHeatAnalyzer.js";
import { PathPolicy } from "./pathPolicy.js";
import { resolvePlatformPathContract } from "./pathContract.js";
import { PublishLedger } from "./PublishLedger.js";
import { generatedMarkersForPlatform } from "./generatedMarker.js";
import { probeSymlinkSupport } from "./symlinkOps.js";
import { backupUnmanagedFileIfNeeded, ensureDirForFile, writeFileAtomic } from "./fileOps.js";
import type {
	ArtifactKind,
	CanonicalAgentDefinition,
	DriftReport,
	DriftState,
	LinkStrategy,
	PathHeatResult,
	PlatformCapability,
	PreviewResult,
	PublishPlatform,
	PublishResult,
	PublishTarget,
	PublishedArtifactProvenance,
	RenderedArtifact,
} from "./types.js";
import type { DirHeatNode } from "./types.js";

const SUPPORTED_PLATFORMS: PublishPlatform[] = [
	"copilot", "claude", "codex", "cursor", "windsurf", "antigravity", "kiro",
];

const ALL_PLATFORMS: PublishPlatform[] = [
	"copilot", "claude", "codex", "kiro", "cursor", "windsurf", "antigravity",
];

/** Orchestrates platform publishers, heat analysis, preview, publish, and drift. */
export class AgentPublisher
{
	private readonly publishers: Map<PublishPlatform, AgentPublisherBase>;
	private pathPolicy: PathPolicy;
	private heatAnalyzer: PathHeatAnalyzer;
	private readonly ledger: PublishLedger;
	private readonly symlinkProbe: () => boolean;

	constructor(
		sources: DataSourceEntry[],
		storagePath: string,
		private readonly agentBuilder?: AgentBuilder,
		private readonly onArtifactsWritten?: (sourceName: string, artifacts: RenderedArtifact[]) => void,
		private readonly canonicalStore?: CanonicalAgentStore,
		symlinkProbe: () => boolean = probeSymlinkSupport,
	)
	{
		this.pathPolicy = new PathPolicy(sources);
		this.ledger = new PublishLedger(storagePath);
		this.heatAnalyzer = new PathHeatAnalyzer(this.pathPolicy, agentBuilder);
		this.symlinkProbe = symlinkProbe;
		this.publishers = new Map<PublishPlatform, AgentPublisherBase>([
			["copilot", new AgentPublisherCopilot()],
			["claude", new AgentPublisherClaude()],
			["codex", new AgentPublisherCodex()],
			["cursor", new AgentPublisherCursor()],
			["windsurf", new AgentPublisherWindsurf()],
			["antigravity", new AgentPublisherAntigravity()],
			["kiro", new AgentPublisherKiro()],
		]);
		this.ledger.load();
	}

	/**
	 * Rebuilds path policy and heat analyzer after Add Vault refreshes dataSources.
	 * @param sources - Updated AgentBuilder source list from cc.json.
	 */
	refreshSources(sources: DataSourceEntry[]): void
	{
		this.pathPolicy = new PathPolicy(sources);
		this.heatAnalyzer = new PathHeatAnalyzer(this.pathPolicy, this.agentBuilder);
	}

	/** Exposes ledger for AgentBuilder artifact classification. */
	getPublishLedger(): PublishLedger
	{
		return this.ledger;
	}

	/** Returns supported platform capabilities for the UI. */
	getPlatforms(projectName?: string): PlatformCapability[]
	{
		const labels: Record<PublishPlatform, string> = {
			copilot: "GitHub Copilot",
			claude: "Claude Code",
			codex: "OpenAI Codex (VS Code)",
			kiro: "Kiro",
			cursor: "Cursor",
			windsurf: "Windsurf",
			antigravity: "Antigravity",
		};
		let source: DataSourceEntry | undefined;
		if (projectName)
		{
			try
			{
				source = this.pathPolicy.findSource(projectName);
			} catch
			{
				source = undefined;
			}
		}

		return ALL_PLATFORMS.map((platform) =>
		{
			const supported = SUPPORTED_PLATFORMS.includes(platform);
			const strategiesByKind = supported ? linkStrategiesByKindForPlatform(platform) : undefined;

			return {
				platform,
				label: labels[platform],
				supportedArtifactKinds: supported ? (["agent", "skill"] as ArtifactKind[]) : [],
				defaultDirs: source ? resolvePlatformPathContract(source, platform) : undefined,
				artifactTemplates: supported ? artifactTemplatesForPlatform(platform) : undefined,
				notes: PLATFORM_NOTES[platform],
				supportedLinkStrategies: strategiesByKind?.agent,
				supportedLinkStrategiesByKind: strategiesByKind,
			};
		});
	}

	/** Returns directory tree for project picker. */
	getTree(projectName: string): DirHeatNode[]
	{
		return this.heatAnalyzer.buildDirectoryTree(projectName);
	}

	/** Computes path heat from canonical knowledge refs. */
	computeHeat(def: CanonicalAgentDefinition): PathHeatResult
	{
		return this.heatAnalyzer.analyze(def);
	}

	/** Returns publisher for a platform or throws 400. */
	getPublisher(platform: PublishPlatform): AgentPublisherBase
	{
		const publisher = this.publishers.get(platform);
		if (!publisher)
		{
			throw Object.assign(new Error(`Unsupported publish platform: ${platform}`), { status: 400 });
		}
		return publisher;
	}

	/**
	 * Renders artifacts for one target, including import-shim override for Claude.
	 * @param def - Canonical definition.
	 * @param target - Publish target.
	 */
	private renderTargetArtifacts(def: CanonicalAgentDefinition, target: PublishTarget): RenderedArtifact[]
	{
		const requested = target.linkStrategy ?? "copy";
		assertLinkStrategyAllowed(target.platform, target.artifactKind, requested);

		if (requested === "import-shim")
		{
			const roots = this.pathPolicy.getAllowedRoots(def.projectName, target.platform);
			const shimResult = buildImportShimPlan(target, roots);
			if ("error" in shimResult)
			{
				throw Object.assign(new Error(shimResult.error), { status: 400 });
			}
			const plan = shimResult.plan;
			return [{
				absolutePath: plan.shimPath,
				content: plan.content,
				platform: "claude",
				artifactKind: "agent",
				canonicalId: def.id,
				previewStatus: this.getPublisher("claude").previewStatusFor(plan.shimPath, generatedMarkersForPlatform("claude")),
				materialization: { requestedLinkStrategy: "import-shim", actualLinkStrategy: "import-shim" },
			}];
		}

		const publisher = this.getPublisher(target.platform);
		const artifacts = publisher.render(def, target);
		return artifacts.map((artifact) => ({
			...artifact,
			canonicalId: artifact.canonicalId ?? def.id,
			materialization: {
				requestedLinkStrategy: requested,
				actualLinkStrategy: requested,
			},
		}));
	}

	/**
	 * Applies AGENTS.md collision policy to rendered artifacts.
	 * @param artifacts - Rendered preview artifacts.
	 * @param errors - Mutable error list for blocked collisions.
	 */
	private applyAgentsCollisionChecks(artifacts: RenderedArtifact[], errors: string[]): RenderedArtifact[]
	{
		const result: RenderedArtifact[] = [];
		// Business logic: each generated AGENTS.md replacement must be compatible with existing ledger provenance.
		for (const artifact of artifacts)
		{
			if (!isAgentsMdBasename(artifact.absolutePath) || artifact.isCompanionJson)
			{
				result.push(artifact);
				continue;
			}

			// Business logic: new files skip collision; ledger-backed or generated replacements must be checked.
			const existingEntry = this.ledger.getByAbsolutePath(artifact.absolutePath);
			const needsCollisionCheck = artifact.previewStatus === "replace-generated" || !!existingEntry;

			if (!needsCollisionCheck)
			{
				result.push(artifact);
				continue;
			}

			if (artifact.previewStatus === "new")
			{
				result.push(artifact);
				continue;
			}

			if (artifact.previewStatus === "backup-unmanaged" && !existingEntry)
			{
				result.push(artifact);
				continue;
			}

			const existing: PublishedArtifactProvenance | undefined = existingEntry
				? {
					platform: existingEntry.platform,
					artifactKind: existingEntry.artifactKind,
					artifactFormat: existingEntry.artifactFormat,
					canonicalId: existingEntry.canonicalId,
				}
				: undefined;

			const incoming: PublishedArtifactProvenance = {
				platform: artifact.platform,
				artifactKind: artifact.artifactKind,
				artifactFormat: artifact.artifactFormat,
				canonicalId: artifact.canonicalId,
			};

			const decision = decideAgentsCollision(existing, incoming);
			if (!decision.ok)
			{
				errors.push(`${artifact.absolutePath}: ${decision.reason}`);
				continue;
			}
			result.push(artifact);
		}
		return result;
	}

	/** Renders artifacts without writing. */
	preview(def: CanonicalAgentDefinition, targets: PublishTarget[]): PreviewResult
	{
		const warnings: string[] = [];
		const errors: string[] = [];
		const artifacts: RenderedArtifact[] = [];

		for (const target of targets)
		{
			try
			{
				this.pathPolicy.assertOutputDirAllowed(def.projectName, target.platform, target.outputDir);
				const rendered = this.renderTargetArtifacts(def, target);
				artifacts.push(...rendered);
			} catch (error)
			{
				errors.push((error as Error).message);
			}
		}

		const intraErrors: string[] = [];
		const intraChecked = applyIntraPreviewAgentsCollision(artifacts, intraErrors);
		errors.push(...intraErrors);

		const collisionErrors: string[] = [];
		const checked = this.applyAgentsCollisionChecks(intraChecked, collisionErrors);
		errors.push(...collisionErrors);

		return { artifacts: checked, warnings, errors };
	}

	/**
	 * Materializes one artifact honoring link strategy metadata.
	 * @param artifact - Rendered artifact with content.
	 * @param warnings - Mutable warning list for downgrade messages.
	 */
	private materializeOneArtifact(artifact: RenderedArtifact, warnings: string[]): void
	{
		if (artifact.isCompanionJson)
		{
			ensureDirForFile(artifact.absolutePath);
			writeFileAtomic(artifact.absolutePath, artifact.content);
			return;
		}

		const markers = generatedMarkersForPlatform(artifact.platform);
		const requested = artifact.materialization?.requestedLinkStrategy ?? "copy";
		let actual: LinkStrategy = artifact.materialization?.actualLinkStrategy ?? requested;

		// Business logic: symlink is gated off the active product surface until a stable source path RFC lands.
		if (requested === "symlink")
		{
			actual = "copy";
			if (artifact.materialization) artifact.materialization.actualLinkStrategy = "copy";
			if (ENABLE_SYMLINK_PUBLISH)
			{
				warnings.push(`Symlink publish requires a stable source path; wrote copy to ${artifact.absolutePath}`);
			}
		}

		const backup = backupUnmanagedFileIfNeeded(artifact.absolutePath, markers);
		if (backup) warnings.push(`Backed up unmanaged file: ${backup}`);
		ensureDirForFile(artifact.absolutePath);
		writeFileAtomic(artifact.absolutePath, artifact.content);
		if (artifact.materialization) artifact.materialization.actualLinkStrategy = actual;
	}

	/** Materializes artifacts, updates ledger and index. */
	publish(def: CanonicalAgentDefinition, targets: PublishTarget[]): PublishResult
	{
		const preview = this.preview(def, targets);
		if (preview.errors.length > 0)
		{
			return { written: [], warnings: preview.warnings, errors: preview.errors };
		}

		// Business logic: persist canonical definition before any disk writes so publish-from-list flows survive refresh.
		if (this.canonicalStore)
		{
			try
			{
				const existing = this.canonicalStore.get(def.id);
				const defToSave = existing?.publishedArtifacts?.length
					? { ...def, publishedArtifacts: existing.publishedArtifacts }
					: def;
				this.canonicalStore.upsert(defToSave);
				this.canonicalStore.save();
			} catch (error)
			{
				return {
					written: [],
					warnings: preview.warnings,
					errors: [`Failed to persist canonical definition before publish: ${(error as Error).message}`],
				};
			}
		}

		const written: PublishResult["written"] = [];
		const warnings = [...preview.warnings];
		const defHash = canonicalHash(def);
		const knowledgeValues = def.knowledge.map((k) => k.value);
		const referencedPaths: string[] = [];

		for (const item of def.knowledge)
		{
			if (item.kind === "file")
			{
				const indexed = this.agentBuilder?.findIndexedFile(item.value, def.projectName);
				if (indexed) referencedPaths.push(indexed.absolutePath);
			}
		}

		const byPlatform = new Map<PublishPlatform, RenderedArtifact[]>();
		for (const artifact of preview.artifacts)
		{
			const list = byPlatform.get(artifact.platform) ?? [];
			list.push(artifact);
			byPlatform.set(artifact.platform, list);
		}

		for (const [, artifacts] of byPlatform)
		{
			for (const artifact of artifacts)
			{
				this.materializeOneArtifact(artifact, warnings);

				if (artifact.isCompanionJson) continue;
				written.push({
					absolutePath: artifact.absolutePath,
					platform: artifact.platform,
					artifactKind: artifact.artifactKind,
				});
				this.ledger.upsert({
					canonicalId: def.id,
					platform: artifact.platform,
					artifactKind: artifact.artifactKind,
					absolutePath: artifact.absolutePath,
					canonicalHash: defHash,
					artifactHash: hashContent(artifact.content),
					knowledge: knowledgeValues,
					referencedPaths,
					publishedAt: new Date().toISOString(),
					artifactFormat: artifact.artifactFormat,
					actualLinkStrategy: artifact.materialization?.actualLinkStrategy ?? "copy",
				});
			}
		}

		this.ledger.save();

		// Business logic: append publish history on the canonical definition for Publisher "Already published" UI.
		if (this.canonicalStore && written.length > 0)
		{
			const stored = this.canonicalStore.get(def.id) ?? def;
			const history = [...(stored.publishedArtifacts ?? [])];
			const publishedAt = new Date().toISOString();
			for (const row of written)
			{
				const artifact = preview.artifacts.find((item) => item.absolutePath === row.absolutePath);
				history.push({
					platform: row.platform,
					artifactKind: row.artifactKind,
					absolutePath: row.absolutePath,
					publishedAt,
					linkStrategy: artifact?.materialization?.actualLinkStrategy,
				});
			}
			this.canonicalStore.upsert({ ...stored, publishedArtifacts: history });
			this.canonicalStore.save();
		}

		const markdownArtifacts = preview.artifacts.filter((a) => !a.isCompanionJson);
		if (this.onArtifactsWritten && markdownArtifacts.length > 0)
		{
			this.onArtifactsWritten(def.projectName, markdownArtifacts);
		}

		return { written, warnings, errors: [] };
	}

	/** Detects drift for all ledger entries of a canonical id. */
	detectDrift(canonicalId: string, currentDef?: CanonicalAgentDefinition): DriftReport
	{
		const resolvedDef = currentDef
			?? this.agentBuilder?.getCanonicalDefinition(canonicalId)
			?? this.canonicalStore?.get(canonicalId);
		const currentHash = resolvedDef ? canonicalHash(resolvedDef) : undefined;
		const entries = this.ledger.getByCanonicalId(canonicalId).map((entry) =>
		{
			let state: DriftState = "unknown";
			if (!existsSync(entry.absolutePath))
			{
				state = "missing-file";
			}
			else
			{
				const diskHash = hashFileIfExists(entry.absolutePath);
				if (!diskHash || diskHash !== entry.artifactHash)
				{
					state = "disk-changed";
				}
				else if (currentHash && currentHash !== entry.canonicalHash)
				{
					state = "canonical-changed";
				}
				else
				{
					state = "clean";
				}
			}
			return {
				platform: entry.platform,
				artifactKind: entry.artifactKind,
				absolutePath: entry.absolutePath,
				state,
			};
		});

		return { canonicalId, entries };
	}

	/**
	 * Returns publish status for Publisher dialog (ledger join + full drift).
	 * @param canonicalId - Canonical definition id from agent-definitions.json.
	 * @param currentDef - Optional in-memory definition override (e.g. after Expand Context).
	 */
	getPublishStatus(canonicalId: string, currentDef?: CanonicalAgentDefinition)
	{
		const definition = currentDef
			?? this.agentBuilder?.getCanonicalDefinition(canonicalId)
			?? this.canonicalStore?.get(canonicalId);
		if (!definition)
		{
			throw Object.assign(new Error(`No canonical definition found for id "${canonicalId}"`), { status: 404 });
		}

		const rows = this.ledger.getByCanonicalId(canonicalId);
		const drift = this.detectDrift(canonicalId, definition);
		const publishedTo = mergeDriftIntoPublishedSummaries(
			rows.map((row) => toPublishedTargetSummary(row)),
			drift.entries,
		);

		return {
			canonicalId,
			publishedTo,
			publishedArtifacts: definition.publishedArtifacts ?? [],
			drift,
		};
	}
}
