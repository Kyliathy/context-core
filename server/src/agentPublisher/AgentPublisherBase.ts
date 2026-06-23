import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { CanonicalAgentDefinition, PublishPlatform, PublishTarget, RenderedArtifact } from "./types.js";
import { backupUnmanagedFileIfNeeded, ensureDirForFile, writeFileAtomic } from "./fileOps.js";
import { generatedMarkersForPlatform } from "./generatedMarker.js";
import { renderKnowledgeSection } from "./platforms/knowledgeFormat.js";
import { renderYamlFrontmatter } from "./platforms/yamlFrontmatter.js";

/** Shared base for platform-specific publishers. */
export abstract class AgentPublisherBase
{
	abstract readonly platform: PublishPlatform;

	/** Renders artifacts for one publish target without writing. */
	abstract render(def: CanonicalAgentDefinition, target: PublishTarget): RenderedArtifact[];

	/** Resolves concrete publish targets (usually one per render call). */
	resolveTargets(_def: CanonicalAgentDefinition, target: PublishTarget): PublishTarget[]
	{
		return [target];
	}

	/** Renders knowledge refs as markdown list lines. */
	protected renderKnowledgeList(def: CanonicalAgentDefinition, style: "github" | "claude" = "github"): string[]
	{
		return renderKnowledgeSection(def, style);
	}

	/** Renders YAML frontmatter block lines. */
	protected renderYamlFrontmatter(fields: Record<string, string | string[] | undefined>): string[]
	{
		return renderYamlFrontmatter(fields);
	}

	/** Determines preview status for an artifact path. */
	previewStatusFor(filePath: string, generatedMarker?: string | string[]): RenderedArtifact["previewStatus"]
	{
		if (!existsSync(filePath)) return "new";
		const markers = generatedMarker
			? (Array.isArray(generatedMarker) ? generatedMarker : [generatedMarker])
			: [];
		if (markers.length === 0) return "unknown";
		try
		{
			const content = readFileSync(filePath, "utf8");
			return markers.some((marker) => content.includes(marker)) ? "replace-generated" : "backup-unmanaged";
		} catch
		{
			return "unknown";
		}
	}

	/** Writes rendered artifacts with backup + atomic write. */
	materializeArtifacts(artifacts: RenderedArtifact[]): string[]
	{
		const warnings: string[] = [];
		const generatedMarkers = generatedMarkersForPlatform(this.platform);
		for (const artifact of artifacts)
		{
			if (artifact.isCompanionJson)
			{
				ensureDirForFile(artifact.absolutePath);
				writeFileAtomic(artifact.absolutePath, artifact.content);
				continue;
			}
			const backup = backupUnmanagedFileIfNeeded(artifact.absolutePath, generatedMarkers);
			if (backup) warnings.push(`Backed up unmanaged file: ${backup}`);
			writeFileAtomic(artifact.absolutePath, artifact.content);
		}
		return warnings;
	}

	/** Joins output dir with relative file segment. */
	protected joinOutput(outputDir: string, fileName: string): string
	{
		return join(outputDir, fileName);
	}
}
