/**
 * Single platform row in PublishAgentDialog.
 *
 * Architecture: visualizer/zz-reach2/architecture/agents/archi-agent-builder-ui.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ab3-agent-builder-3.md
 */

import type { ArtifactKind, LinkStrategy, PublishPlatform } from "../../types";

export type PlatformTargetRowProps = {
	platform: PublishPlatform;
	label: string;
	selected: boolean;
	supported: boolean;
	artifactKind: ArtifactKind;
	outputDir: string;
	linkStrategy: LinkStrategy;
	supportedLinkStrategies?: LinkStrategy[];
	platformNotes?: string[];
	filenameHint: string;
	nativeDefaultDir?: string;
	heatSuggestedDir?: string;
	onToggle: () => void;
	onArtifactKindChange: (kind: ArtifactKind) => void;
	onLinkStrategyChange: (strategy: LinkStrategy) => void;
	onPickDirectory: () => void;
};

export default function PlatformTargetRow({
	platform,
	label,
	selected,
	supported,
	artifactKind,
	outputDir,
	linkStrategy,
	supportedLinkStrategies,
	platformNotes,
	filenameHint,
	nativeDefaultDir,
	heatSuggestedDir,
	onToggle,
	onArtifactKindChange,
	onLinkStrategyChange,
	onPickDirectory,
}: PlatformTargetRowProps)
{
	const showHeatHint = heatSuggestedDir
		&& nativeDefaultDir
		&& heatSuggestedDir.replace(/\\/g, "/").replace(/\/+$/, "") !== nativeDefaultDir.replace(/\\/g, "/").replace(/\/+$/, "");

	const strategies = supportedLinkStrategies ?? ["copy"];
	const showStrategySelector = strategies.length > 1;

	return (
		<div className={`platform-target-row${selected ? " platform-target-row-selected" : ""}${!supported ? " platform-target-row-disabled" : ""}`}>
			<label className="platform-target-row-check">
				<input type="checkbox" checked={selected} disabled={!supported} onChange={onToggle} />
				<span>{label}</span>
			</label>
			{supported && platformNotes && platformNotes.length > 0 && (
				<div className="platform-target-notes">{platformNotes[0]}</div>
			)}
			{selected && supported && (
				<div className="platform-target-row-body">
					<div className="platform-target-kind">
						<button
							type="button"
							className={artifactKind === "agent" ? "active" : ""}
							onClick={() => onArtifactKindChange("agent")}>
							Agent
						</button>
						<button
							type="button"
							className={artifactKind === "skill" ? "active" : ""}
							onClick={() => onArtifactKindChange("skill")}>
							Skill
						</button>
					</div>
					{showStrategySelector && (
						<div className="platform-target-strategy">
							<label>
								Strategy{" "}
								<select
									value={linkStrategy}
									onChange={(e) => onLinkStrategyChange(e.target.value as LinkStrategy)}>
									{strategies.map((strategy) => (
										<option key={strategy} value={strategy}>{strategy}</option>
									))}
								</select>
							</label>
						</div>
					)}
					<div className="platform-target-dir">
						<button type="button" onClick={onPickDirectory} title={outputDir || "Select directory"}>
							{outputDir || "Select directory…"}
						</button>
					</div>
					{nativeDefaultDir && (
						<div className="platform-target-hint platform-target-native-hint" title={nativeDefaultDir}>
							Native default: {nativeDefaultDir}
						</div>
					)}
					{showHeatHint && (
						<div className="platform-target-hint platform-target-heat-hint" title={heatSuggestedDir}>
							Suggested by heat: {heatSuggestedDir}
						</div>
					)}
					<div className="platform-target-hint">
						Will write: {filenameHint}
						{artifactKind === "skill" ? " (skill root → SKILL.md path above)" : ""}
					</div>
				</div>
			)}
			{!supported && <div className="platform-target-unsupported">Not supported in this rollout</div>}
		</div>
	);
}
