import type { PublishPlatform } from "./types.js";

export type FieldRenderMode = "frontmatter" | "foldIntoDescription" | "body" | "drop";

export type FieldMapEntry = {
	mode: FieldRenderMode;
	key?: string;
};

export const FIELD_MAP = {
	description: {
		copilot: { mode: "frontmatter", key: "description" },
		claude: { mode: "frontmatter", key: "description" },
		codex: { mode: "frontmatter", key: "description" },
		default: { mode: "frontmatter", key: "description" },
	},
	whenToUse: {
		claude: { mode: "frontmatter", key: "when_to_use" },
		default: { mode: "foldIntoDescription" },
	},
	"argument-hint": {
		copilot: { mode: "frontmatter", key: "argument-hint" },
		codex: { mode: "frontmatter", key: "argument-hint" },
		default: { mode: "drop" },
	},
	tools: {
		copilot: { mode: "frontmatter", key: "allowed-tools" },
		claude: { mode: "frontmatter", key: "allowed-tools" },
		default: { mode: "drop" },
	},
	knowledge: {
		default: { mode: "body" },
	},
	paths: {
		default: { mode: "drop" },
	},
	license: {
		default: { mode: "frontmatter", key: "license" },
	},
	compatibility: {
		default: { mode: "frontmatter", key: "compatibility" },
	},
	metadata: {
		default: { mode: "frontmatter" },
	},
} as const;

/** Resolves field map entry for a platform with default fallback. */
export function resolveFieldMap(
	field: keyof typeof FIELD_MAP,
	platform: PublishPlatform,
): FieldMapEntry
{
	const row = FIELD_MAP[field] as Record<string, FieldMapEntry>;
	return row[platform] ?? row.default ?? { mode: "drop" };
}
