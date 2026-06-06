import type { ArtifactKind, PublishPlatform } from "../../types";

export type PlatformTargetRowProps = {
	platform: PublishPlatform;
	label: string;
	selected: boolean;
	supported: boolean;
	artifactKind: ArtifactKind;
	outputDir: string;
	filenameHint: string;
	nativeDefaultDir?: string;
	heatSuggestedDir?: string;
	onToggle: () => void;
	onArtifactKindChange: (kind: ArtifactKind) => void;
	onPickDirectory: () => void;
};

export default function PlatformTargetRow({
	platform,
	label,
	selected,
	supported,
	artifactKind,
	outputDir,
	filenameHint,
	nativeDefaultDir,
	heatSuggestedDir,
	onToggle,
	onArtifactKindChange,
	onPickDirectory,
}: PlatformTargetRowProps)
{
	const showHeatHint = heatSuggestedDir
		&& nativeDefaultDir
		&& heatSuggestedDir.replace(/\\/g, "/").replace(/\/+$/, "") !== nativeDefaultDir.replace(/\\/g, "/").replace(/\/+$/, "");

	return (
		<div className={`platform-target-row${selected ? " platform-target-row-selected" : ""}${!supported ? " platform-target-row-disabled" : ""}`}>
			<label className="platform-target-row-check">
				<input type="checkbox" checked={selected} disabled={!supported} onChange={onToggle} />
				<span>{label}</span>
			</label>
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
