import { existsSync } from "fs";
import type { DataSourceEntry } from "../types.js";
import type { AgentBuilder } from "../agentBuilder/AgentBuilder.js";
import { AgentPublisherBase } from "./AgentPublisherBase.js";
import { AgentPublisherCopilot } from "./platforms/AgentPublisherCopilot.js";
import { AgentPublisherClaude } from "./platforms/AgentPublisherClaude.js";
import { AgentPublisherCodex } from "./platforms/AgentPublisherCodex.js";
import type { CanonicalAgentStore } from "./CanonicalAgentStore.js";
import { canonicalHash } from "./canonical.js";
import { hashContent, hashFileIfExists } from "./fileOps.js";
import { PathHeatAnalyzer } from "./PathHeatAnalyzer.js";
import { PathPolicy } from "./pathPolicy.js";
import { resolvePlatformPathContract } from "./pathContract.js";
import { PublishLedger } from "./PublishLedger.js";
import type {
	ArtifactKind,
	CanonicalAgentDefinition,
	DriftReport,
	DriftState,
	PathHeatResult,
	PlatformCapability,
	PreviewResult,
	PublishPlatform,
	PublishResult,
	PublishTarget,
	RenderedArtifact,
} from "./types.js";
import type { DirHeatNode } from "./types.js";

const SUPPORTED_PLATFORMS: PublishPlatform[] = ["copilot", "claude", "codex"];

/** Orchestrates platform publishers, heat analysis, preview, publish, and drift. */
export class AgentPublisher
{
	private readonly publishers: Map<PublishPlatform, AgentPublisherBase>;
	private readonly pathPolicy: PathPolicy;
	private readonly heatAnalyzer: PathHeatAnalyzer;
	private readonly ledger: PublishLedger;

	constructor(
		sources: DataSourceEntry[],
		storagePath: string,
		private readonly agentBuilder?: AgentBuilder,
		private readonly onArtifactsWritten?: (sourceName: string, artifacts: RenderedArtifact[]) => void,
		private readonly canonicalStore?: CanonicalAgentStore,
	)
	{
		this.pathPolicy = new PathPolicy(sources);
		this.ledger = new PublishLedger(storagePath);
		this.heatAnalyzer = new PathHeatAnalyzer(this.pathPolicy, agentBuilder);
		this.publishers = new Map<PublishPlatform, AgentPublisherBase>([
			["copilot", new AgentPublisherCopilot()],
			["claude", new AgentPublisherClaude()],
			["codex", new AgentPublisherCodex()],
		]);
		this.ledger.load();
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
		return (["copilot", "claude", "codex", "kiro", "cursor", "windsurf", "antigravity"] as PublishPlatform[]).map((platform) => ({
			platform,
			label: labels[platform],
			supportedArtifactKinds: SUPPORTED_PLATFORMS.includes(platform) ? (["agent", "skill"] as ArtifactKind[]) : [],
			defaultDirs: source ? resolvePlatformPathContract(source, platform) : undefined,
		}));
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
				const publisher = this.getPublisher(target.platform);
				artifacts.push(...publisher.render(def, target));
			} catch (error)
			{
				errors.push((error as Error).message);
			}
		}

		return { artifacts, warnings, errors };
	}

	/** Materializes artifacts, updates ledger and index. */
	publish(def: CanonicalAgentDefinition, targets: PublishTarget[]): PublishResult
	{
		const preview = this.preview(def, targets);
		if (preview.errors.length > 0)
		{
			return { written: [], warnings: preview.warnings, errors: preview.errors };
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

		for (const [platform, artifacts] of byPlatform)
		{
			const publisher = this.getPublisher(platform);
			const materializeWarnings = publisher.materializeArtifacts(artifacts);
			warnings.push(...materializeWarnings);

			for (const artifact of artifacts)
			{
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
				});
			}
		}

		this.ledger.save();

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
}
