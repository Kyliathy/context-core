/**
 * ContextCore – Cursor IDE harness: workspace inference + project mapping layer.
 * All functions that map workspace paths to project labels using rule sets.
 */

import { Database } from "bun:sqlite";
import { basename, dirname, extname } from "path";
import chalk from "chalk";
import { getHostname } from "../config.js";
import { CCSettings } from "../settings/CCSettings.js";
import { sanitizeFilename } from "../utils/pathHelpers.js";
import {
	CUR,
	CUR_LINE,
	CURSOR_PROGRESS_EVERY,
	logCursorProgress,
	toDatabaseText,
	extractContextPaths,
	extractSessionHintsFromKey,
	cursorKeyFamily,
	collectPathLikeValues,
	type CursorKVRow,
	type CursorBubbleRecord,
} from "./cursor-query.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CursorProjectLayout = {
	rootPath: string;
	absPath: string;
};

export type CursorWorkspaceSource = "projectLayouts" | "composerFileUris" | "bubbleHeuristics" | "unresolved";

export type CursorWorkspaceInference = {
	projectBySession: Map<string, string>;
	autoDerivedBySession: Map<
		string,
		{
			path: string;
			derivedProject: string;
			source: CursorWorkspaceSource;
			topWorkspaceCandidates: Array<string>;
			contextSamples: Array<string>;
		}
	>;
	miscSessionPaths: Map<string, string>;
	miscSourceBySession: Map<string, CursorWorkspaceSource>;
	sourceCounts: {
		projectLayouts: number;
		composerFileUris: number;
		bubbleHeuristics: number;
		unresolved: number;
	};
	sessionsResolved: number;
	fallbackGlobal: number;
	unresolvedFamilies: Array<string>;
	bubbleKeyCount: number;
	metadataKeyCount: number;
};

export type CursorProjectMappingRule = {
	path: string;
	newProjectName: string;
};

export type CursorProjectNameMappingRule = {
	projectName: string;
	newProjectName: string;
};

export type CursorGenericProjectMappingRule = {
	path: string;
	rule: string;
};

export type CursorProjectRuleSet = {
	projectMappingRules: Array<CursorProjectMappingRule>;
	projectNameMappingRules: Array<CursorProjectNameMappingRule>;
	genericProjectMappingRules: Array<CursorGenericProjectMappingRule>;
};

export type CursorProjectResolution = {
	project: string;
	mode: "rule" | "auto-derived" | "misc";
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT_CACHE = new Map<string, string>();
const WORKSPACE_NORMALIZE_CACHE = new Map<string, string>();
export const MISC_CURSOR_PROJECT = "MISC";
const PROJECT_BOUNDARY_MARKERS = new Set([
	"src",
	"app",
	"apps",
	"lib",
	"libs",
	"test",
	"tests",
	"docs",
	"scripts",
	"interop",
	"node_modules",
]);
const PROJECT_TRAILING_NOISE = new Set(["dist", "build", ".next", ".cursor", ".vscode"]);

// ---------------------------------------------------------------------------
// Rule normalization helpers
// ---------------------------------------------------------------------------

/**
 * Normalizes a path-ish token to comparable lowercase slash form.
 * @param input - Raw rule path or workspace path.
 */
function normalizeRulePath(input: string): string
{
	return input.replace(/[\\/]+/g, "/").toLowerCase();
}

/**
 * Extracts the first directory component after a matched prefix in a path.
 * @param sourcePath - Full workspace or file path.
 * @param matchedPrefix - The rule prefix that matched (may use backslashes).
 */
function getFirstDirAfterPrefix(sourcePath: string, matchedPrefix: string): string | null
{
	const normalizedSource = sourcePath.replace(/[\\/]+/g, "/");
	const normalizedPrefix = matchedPrefix.replace(/[\\/]+/g, "/");

	const prefixIndex = normalizedSource.toLowerCase().indexOf(normalizedPrefix.toLowerCase());
	if (prefixIndex === -1)
	{
		return null;
	}

	const afterPrefix = normalizedSource.slice(prefixIndex + normalizedPrefix.length);
	const trimmed = afterPrefix.replace(/^\/+/, "");
	const firstDir = trimmed.split("/")[0] ?? "";
	return firstDir.trim() || null;
}

// ---------------------------------------------------------------------------
// Rule validators
// ---------------------------------------------------------------------------

/**
 * Validates one explicit Cursor project mapping rule candidate.
 * @param value - Unknown rule payload.
 */
function asCursorProjectMappingRule(value: unknown): CursorProjectMappingRule | null
{
	if (!value || typeof value !== "object")
	{
		return null;
	}
	const candidate = value as Record<string, unknown>;
	const pathValue = typeof candidate.path === "string" ? candidate.path
		: typeof candidate.paths === "string" ? candidate.paths
		: null;
	if (!pathValue)
	{
		return null;
	}
	const rawNewProjectName =
		typeof candidate.newProjectName === "string"
			? candidate.newProjectName
			: typeof candidate.newPath === "string"
				? candidate.newPath
				: "";
	if (!pathValue.trim() || !rawNewProjectName.trim())
	{
		return null;
	}
	return {
		path: pathValue,
		newProjectName: rawNewProjectName,
	};
}

/**
 * Validates one project-name remap rule candidate.
 * @param value - Unknown rule payload.
 */
function asCursorProjectNameMappingRule(value: unknown): CursorProjectNameMappingRule | null
{
	if (!value || typeof value !== "object")
	{
		return null;
	}
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.projectName !== "string" || typeof candidate.newProjectName !== "string")
	{
		return null;
	}
	if (!candidate.projectName.trim() || !candidate.newProjectName.trim())
	{
		return null;
	}
	return {
		projectName: candidate.projectName,
		newProjectName: candidate.newProjectName,
	};
}

/**
 * Validates one generic Cursor project mapping rule candidate.
 * @param value - Unknown rule payload.
 */
function asCursorGenericProjectMappingRule(value: unknown): CursorGenericProjectMappingRule | null
{
	if (!value || typeof value !== "object")
	{
		return null;
	}
	const candidate = value as Record<string, unknown>;
	const pathValue = typeof candidate.path === "string" ? candidate.path
		: typeof candidate.paths === "string" ? candidate.paths
		: null;
	if (!pathValue || typeof candidate.rule !== "string")
	{
		return null;
	}
	if (!pathValue.trim() || !candidate.rule.trim())
	{
		return null;
	}
	return {
		path: pathValue,
		rule: candidate.rule,
	};
}

// ---------------------------------------------------------------------------
// Rule loading
// ---------------------------------------------------------------------------

/**
 * Reads Cursor project routing rules from cc.json for the active machine.
 * Supports generic rules either inside Cursor config or as a machine-level sibling.
 */
export function loadCursorProjectRuleSet(): CursorProjectRuleSet
{
	try
	{
		const settings = CCSettings.getInstance();
		const machine = settings.getMachineConfig(getHostname());
		const harnesses = (machine?.harnesses ?? {}) as Record<string, unknown>;
		const cursorConfig = (harnesses.Cursor ?? {}) as Record<string, unknown>;

		const explicitRaw = Array.isArray(cursorConfig.projectMappingRules) ? cursorConfig.projectMappingRules : [];
		const explicitRules = explicitRaw
			.map((rule) => asCursorProjectMappingRule(rule))
			.filter((rule): rule is CursorProjectMappingRule => Boolean(rule));
		const projectNameRules = explicitRaw
			.map((rule) => asCursorProjectNameMappingRule(rule))
			.filter((rule): rule is CursorProjectNameMappingRule => Boolean(rule));

		//<Allow generic rules under Cursor first, then machine-level fallback.
		const genericSource = Array.isArray(cursorConfig.genericProjectMappingRules)
			? cursorConfig.genericProjectMappingRules
			: Array.isArray(harnesses.genericProjectMappingRules)
				? harnesses.genericProjectMappingRules
				: [];
		const genericRules = genericSource
			.map((rule) => asCursorGenericProjectMappingRule(rule))
			.filter((rule): rule is CursorGenericProjectMappingRule => Boolean(rule));

		const droppedExplicit = explicitRaw.length - explicitRules.length - projectNameRules.length;
		if (droppedExplicit > 0)
		{
			console.warn(`${CUR} ${chalk.red(`⚠ ${droppedExplicit} projectMappingRules entry(ies) dropped — check that each has a "path" or "paths" key`)}`);
		}
		const droppedGeneric = genericSource.length - genericRules.length;
		if (droppedGeneric > 0)
		{
			console.warn(`${CUR} ${chalk.red(`⚠ ${droppedGeneric} genericProjectMappingRules entry(ies) dropped — check that each has a "path" or "paths" key`)}`);
		}

		return {
			projectMappingRules: explicitRules,
			projectNameMappingRules: projectNameRules,
			genericProjectMappingRules: genericRules,
		};
	} catch
	{
		//<Treat settings errors as no-rule mode.
		return {
			projectMappingRules: [],
			projectNameMappingRules: [],
			genericProjectMappingRules: [],
		};
	}
}

/**
 * Applies explicit project-name remaps (legacy auto-derived aliases to canonical names).
 * @param project - Current resolved project label.
 * @param ruleSet - Cursor-specific project routing rules.
 */
function remapCursorProjectName(project: string, ruleSet: CursorProjectRuleSet): string
{
	for (const rule of ruleSet.projectNameMappingRules)
	{
		if (rule.projectName.toLowerCase() === project.toLowerCase())
		{
			return sanitizeFilename(rule.newProjectName);
		}
	}
	return project;
}

// ---------------------------------------------------------------------------
// Path normalization and analysis
// ---------------------------------------------------------------------------

/**
 * Normalizes a potential path/URI string to a local path candidate.
 * @param raw - Raw path-like value from Cursor payloads.
 */
export function normalizePathCandidate(raw: string): string | null
{
	const trimmed = raw.trim();
	if (!trimmed)
	{
		return null;
	}

	const withoutFileScheme = trimmed.replace(/^file:\/\//i, "");
	let decoded = withoutFileScheme;
	try
	{
		decoded = decodeURIComponent(withoutFileScheme);
	} catch
	{
		decoded = withoutFileScheme;
	}
	if (!decoded.includes("\\") && !decoded.includes("/"))
	{
		return null;
	}

	const clean = decoded.replace(/[?#].*$/, "").replace(/[\\/]+$/, "");
	if (!clean)
	{
		return null;
	}
	return clean;
}

/**
 * Converts one path into slash-separated non-empty segments.
 * @param value - Path candidate.
 */
export function splitPathSegments(value: string): Array<string>
{
	return value.replace(/[\\/]+/g, "/").replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
}

/**
 * Builds a path string from segments using host-appropriate separators.
 * @param segments - Normalized path segments.
 * @param preferBackslash - Whether to emit windows separators.
 */
function joinPathSegments(segments: Array<string>, preferBackslash: boolean): string
{
	if (segments.length === 0)
	{
		return "";
	}
	const separator = preferBackslash ? "\\" : "/";
	if (/^[A-Za-z]:$/.test(segments[0]))
	{
		if (segments.length === 1)
		{
			return `${segments[0]}${separator}`;
		}
		return `${segments[0]}${separator}${segments.slice(1).join(separator)}`;
	}
	return `${separator}${segments.join(separator)}`;
}

/**
 * Computes a common parent directory for a set of absolute paths.
 * @param paths - Absolute path candidates.
 */
export function deriveCommonDirectoryPath(paths: Array<string>): string | null
{
	if (paths.length === 0)
	{
		return null;
	}

	const normalized = paths
		.map((item) => normalizePathCandidate(item) ?? item)
		.map((item) => item.replace(/[\\/]+$/, ""))
		.filter(Boolean);
	if (normalized.length === 0)
	{
		return null;
	}

	const split = normalized.map((item) => splitPathSegments(item));
	const shortest = split.reduce((best, current) => Math.min(best, current.length), Number.MAX_SAFE_INTEGER);
	if (shortest === 0 || shortest === Number.MAX_SAFE_INTEGER)
	{
		return null;
	}

	const common: Array<string> = [];
	for (let index = 0; index < shortest; index += 1)
	{
		const first = split[0][index]?.toLowerCase();
		if (!first)
		{
			break;
		}
		if (split.every((segments) => (segments[index] ?? "").toLowerCase() === first))
		{
			common.push(split[0][index]);
		} else
		{
			break;
		}
	}

	if (common.length === 0)
	{
		return null;
	}

	const preferBackslash = normalized.some((item) => item.includes("\\"));
	return joinPathSegments(common, preferBackslash);
}

/**
 * Parses Cursor file URI values into local absolute path candidates.
 * @param uri - Raw URI candidate.
 */
export function parseFileUriToPath(uri: string): string | null
{
	if (!uri)
	{
		return null;
	}
	const normalized = normalizePathCandidate(uri);
	if (!normalized)
	{
		return null;
	}
	if (/^\/[A-Za-z]:/.test(normalized))
	{
		return normalized.slice(1);
	}
	return normalized;
}

/**
 * Detects whether a path candidate likely points at a file.
 * @param pathCandidate - Workspace hint path candidate.
 */
function isLikelyFilePath(pathCandidate: string): boolean
{
	const name = basename(pathCandidate.replace(/[\\/]+$/, ""));
	const extension = extname(name).toLowerCase();
	if (!extension)
	{
		return false;
	}
	const blockedExtensions = new Set([".git", ".config"]);
	return !blockedExtensions.has(extension);
}

/**
 * Resolves a path candidate to a directory suitable for project-root probing.
 * @param pathCandidate - Raw workspace or file path candidate.
 */
function toProjectDirectory(pathCandidate: string): string
{
	const normalized = pathCandidate.replace(/[\\/]+$/, "");
	if (isLikelyFilePath(normalized))
	{
		return dirname(normalized);
	}
	return normalized;
}

/**
 * Trims directories to likely project-root boundaries using path heuristics only.
 * @param startDirectory - Directory to start probing from.
 */
function findProjectRootFromDirectory(startDirectory: string): string
{
	const cached = PROJECT_ROOT_CACHE.get(startDirectory);
	if (cached)
	{
		return cached;
	}

	const delimiter = startDirectory.includes("\\") ? "\\" : "/";
	const segments = startDirectory.split(/[\\/]+/).filter(Boolean);
	let trimmed = [...segments];

	for (let i = 0; i < trimmed.length; i += 1)
	{
		if (PROJECT_BOUNDARY_MARKERS.has(trimmed[i].toLowerCase()) && i > 0)
		{
			trimmed = trimmed.slice(0, i);
			break;
		}
	}

	if (trimmed.length > 0)
	{
		const last = trimmed[trimmed.length - 1].toLowerCase();
		if (PROJECT_TRAILING_NOISE.has(last) && trimmed.length > 1)
		{
			trimmed = trimmed.slice(0, -1);
		}
	}

	const rebuilt = (startDirectory.startsWith("\\") || startDirectory.startsWith("/"))
		? `${delimiter}${trimmed.join(delimiter)}`
		: trimmed.join(delimiter);
	const result = rebuilt || startDirectory;
	PROJECT_ROOT_CACHE.set(startDirectory, result);
	return result;
}

/**
 * Normalizes raw workspace hints into stable project-root-like paths.
 * @param pathCandidate - Raw workspace hint.
 */
export function normalizeWorkspaceRoot(pathCandidate: string): string
{
	const cached = WORKSPACE_NORMALIZE_CACHE.get(pathCandidate);
	if (cached)
	{
		return cached;
	}
	const directory = toProjectDirectory(pathCandidate);
	const resolved = findProjectRootFromDirectory(directory);
	WORKSPACE_NORMALIZE_CACHE.set(pathCandidate, resolved);
	return resolved;
}

// ---------------------------------------------------------------------------
// Path filtering
// ---------------------------------------------------------------------------

/**
 * Detects paths that point to harness storage roots rather than user projects.
 * @param candidate - Workspace path candidate.
 */
export function isLikelyHarnessStoragePath(candidate: string): boolean
{
	const normalized = candidate.replace(/[\\/]+/g, "/").toLowerCase();
	const blockedFragments = [
		"/appdata/roaming/cursor/user/globalstorage",
		"/appdata/roaming/code/user/workspacestorage",
		"/appdata/roaming/kiro/user/globalstorage",
		"/.claude/projects/",
		"/.codex/sessions/",
		"/.local/share/opencode/",
		"/.gemini/antigravity/",
	];
	return blockedFragments.some((fragment) => normalized.includes(fragment));
}

/**
 * Rejects noisy path-like values that are unlikely to be real workspace roots.
 * @param candidate - Workspace path candidate.
 */
export function isLowSignalWorkspaceCandidate(candidate: string): boolean
{
	if (!candidate)
	{
		return true;
	}

	if (isLikelyHarnessStoragePath(candidate))
	{
		return true;
	}

	const normalized = candidate.replace(/[\\/]+/g, "/").replace(/\/$/, "");
	const lowered = normalized.toLowerCase();
	const bareToken = lowered.replace(/^\//, "");
	if (["jsonl", "shape", "schema", "symbol", "chat"].includes(bareToken))
	{
		return true;
	}

	if (/^[a-z0-9+/_=-]+$/i.test(normalized) && /[=+]/.test(normalized) && !/^[a-z]:\//i.test(normalized))
	{
		return true;
	}

	if (normalized.startsWith("/") && normalized.split("/").filter(Boolean).length === 1)
	{
		return true;
	}

	return false;
}

// ---------------------------------------------------------------------------
// Project resolution
// ---------------------------------------------------------------------------

/**
 * Chooses a stable project label from a workspace path candidate.
 * @param workspacePath - Resolved workspace or directory path.
 * @param ruleSet - Cursor-specific project routing rules.
 */
export function workspacePathToProject(workspacePath: string, ruleSet: CursorProjectRuleSet): string
{
	const resolution = resolveCursorProjectFromWorkspacePath(workspacePath, ruleSet);
	return resolution.project;
}

/**
 * Resolves one workspace path into project + resolution mode.
 * @param workspacePath - Resolved workspace or directory path.
 * @param ruleSet - Cursor-specific project routing rules.
 */
export function resolveCursorProjectFromWorkspacePath(
	workspacePath: string,
	ruleSet: CursorProjectRuleSet
): CursorProjectResolution
{
	const normalized = workspacePath.replace(/[\\/]+$/, "");

	//<First pass: explicit remaps (indexOf match) always win.
	const normalizedRulePath = normalizeRulePath(normalized);
	for (const rule of ruleSet.projectMappingRules)
	{
		if (normalizedRulePath.indexOf(normalizeRulePath(rule.path)) !== -1)
		{
			const remapped = remapCursorProjectName(sanitizeFilename(rule.newProjectName), ruleSet);
			return {
				project: remapped,
				mode: "rule",
			};
		}
	}

	//<Second pass: generic rules (currently byFirstDir).
	for (const rule of ruleSet.genericProjectMappingRules)
	{
		if (normalizedRulePath.indexOf(normalizeRulePath(rule.path)) === -1)
		{
			continue;
		}
		if (rule.rule.toLowerCase() !== "byfirstdir")
		{
			continue;
		}

		const firstDir = getFirstDirAfterPrefix(normalized, rule.path);
		if (firstDir)
		{
			const remapped = remapCursorProjectName(sanitizeFilename(firstDir), ruleSet);
			return {
				project: remapped,
				mode: "rule",
			};
		}
	}

	const lastSegment = basename(normalized);
	const autoProject = sanitizeFilename(lastSegment);
	if (autoProject)
	{
		const remapped = remapCursorProjectName(autoProject, ruleSet);
		const mode: "rule" | "auto-derived" = remapped === autoProject ? "auto-derived" : "rule";
		return {
			project: remapped,
			mode,
		};
	}

	//<Everything else goes into MISC.
	return {
		project: MISC_CURSOR_PROJECT,
		mode: "misc",
	};
}

/**
 * Builds compact byFirstDir generic rule suggestions from path evidence.
 * @param paths - Source paths observed for unresolved/auto-derived sessions.
 */
export function buildCursorGenericRuleSuggestions(paths: Array<string>): Array<CursorGenericProjectMappingRule>
{
	const basePrefixes = ["Codez\\Nexus", "Codez"];
	const prefixSet = new Set<string>();

	for (const rawPath of paths)
	{
		const normalized = rawPath.replace(/[\\/]+/g, "\\").replace(/^[\\]+/, "");
		for (const base of basePrefixes)
		{
			if (normalizeRulePath(normalized).indexOf(normalizeRulePath(base)) !== -1)
			{
				prefixSet.add(base);
			}
		}
	}

	return Array.from(prefixSet)
		.sort((a, b) => b.length - a.length)
		.map((prefix) => ({
			path: prefix,
			rule: "byFirstDir",
		}));
}

// ---------------------------------------------------------------------------
// Workspace hint collection
// ---------------------------------------------------------------------------

/**
 * Recursively collects workspace path hints from unknown payload nodes.
 * @param value - Parsed JSON payload.
 * @param out - Mutable Set of workspace path candidates.
 */
export function collectWorkspaceHints(value: unknown, out: Set<string>): void
{
	if (Array.isArray(value))
	{
		for (const item of value)
		{
			collectWorkspaceHints(item, out);
		}
		return;
	}

	if (!value || typeof value !== "object")
	{
		if (typeof value === "string")
		{
			const normalized = normalizePathCandidate(value);
			if (normalized)
			{
				out.add(normalized);
			}
		}
		return;
	}

	const obj = value as Record<string, unknown>;
	for (const [rawKey, nested] of Object.entries(obj))
	{
		const key = rawKey.toLowerCase();
		if (
			typeof nested === "string" &&
			(key.includes("workspace") ||
				key.includes("cwd") ||
				key.includes("root") ||
				key.includes("folder") ||
				key.includes("path") ||
				key.includes("uri"))
		)
		{
			const normalized = normalizePathCandidate(nested);
			if (normalized)
			{
				out.add(normalized);
			}
		}
		collectWorkspaceHints(nested, out);
	}
}

/**
 * Scores and picks one best workspace path candidate.
 * @param hints - Path candidates and their frequency counts.
 */
export function chooseBestWorkspacePath(hints: Map<string, number>): string | null
{
	const ordered = Array.from(hints.entries()).sort((a, b) => b[1] - a[1]);
	if (ordered.length === 0)
	{
		return null;
	}

	for (const [path] of ordered)
	{
		if (!isLowSignalWorkspaceCandidate(path))
		{
			return normalizeWorkspaceRoot(path);
		}
	}

	for (const [path] of ordered)
	{
		if (!isLikelyHarnessStoragePath(path))
		{
			return normalizeWorkspaceRoot(path);
		}
	}

	return ordered[0]?.[0] ? normalizeWorkspaceRoot(ordered[0][0]) : null;
}

// ---------------------------------------------------------------------------
// Workspace evidence extractors
// ---------------------------------------------------------------------------

/**
 * Extracts Cursor projectLayouts records from messageRequestContext payload nodes.
 * @param payload - Parsed messageRequestContext payload.
 */
export function extractProjectLayoutsForSession(payload: unknown): Array<CursorProjectLayout>
{
	if (!payload || typeof payload !== "object")
	{
		return [];
	}

	const obj = payload as Record<string, unknown>;
	const layouts = Array.isArray(obj.projectLayouts) ? obj.projectLayouts : [];
	const results: Array<CursorProjectLayout> = [];

	for (const layoutNode of layouts)
	{
		if (!layoutNode || typeof layoutNode !== "object")
		{
			continue;
		}
		const layout = layoutNode as Record<string, unknown>;
		const rootPath = typeof layout.rootPath === "string" ? layout.rootPath.trim() : "";
		const listDirV2Result =
			layout.listDirV2Result && typeof layout.listDirV2Result === "object"
				? (layout.listDirV2Result as Record<string, unknown>)
				: null;
		const directoryTreeRoot =
			listDirV2Result?.directoryTreeRoot && typeof listDirV2Result.directoryTreeRoot === "object"
				? (listDirV2Result.directoryTreeRoot as Record<string, unknown>)
				: null;
		const absPath = typeof directoryTreeRoot?.absPath === "string" ? directoryTreeRoot.absPath.trim() : "";
		const normalized = normalizePathCandidate(absPath);
		if (!normalized)
		{
			continue;
		}
		results.push({
			rootPath,
			absPath: normalized,
		});
	}

	return results;
}

/**
 * Extracts local absolute file paths from one composerData payload.
 * @param payload - Parsed composerData payload.
 */
export function extractComposerFileUris(payload: unknown): Array<string>
{
	if (!payload || typeof payload !== "object")
	{
		return [];
	}

	const obj = payload as Record<string, unknown>;
	const out = new Set<string>();

	if (obj.originalFileStates && typeof obj.originalFileStates === "object")
	{
		for (const key of Object.keys(obj.originalFileStates as Record<string, unknown>))
		{
			const parsed = parseFileUriToPath(key);
			if (parsed)
			{
				out.add(parsed);
			}
		}
	}

	if (Array.isArray(obj.allAttachedFileCodeChunksUris))
	{
		for (const uri of obj.allAttachedFileCodeChunksUris)
		{
			if (typeof uri !== "string")
			{
				continue;
			}
			const parsed = parseFileUriToPath(uri);
			if (parsed)
			{
				out.add(parsed);
			}
		}
	}

	return Array.from(out);
}

/**
 * Chooses a stable workspace root from composerData file URI evidence.
 * @param fileUris - Local file path list extracted from composerData.
 */
export function deriveWorkspaceRootFromFileUris(fileUris: Array<string>): string | null
{
	if (fileUris.length === 0)
	{
		return null;
	}

	const directories = fileUris
		.map((uri) => parseFileUriToPath(uri) ?? uri)
		.map((item) => toProjectDirectory(item))
		.filter(Boolean);
	if (directories.length === 0)
	{
		return null;
	}

	const common = deriveCommonDirectoryPath(directories);
	if (common)
	{
		const commonSegments = splitPathSegments(common);
		const isDriveRoot = commonSegments.length <= 1;
		if (!isDriveRoot)
		{
			return normalizeWorkspaceRoot(common);
		}
	}

	const byDirectory = new Map<string, number>();
	for (const directory of directories)
	{
		const normalized = normalizeWorkspaceRoot(directory);
		byDirectory.set(normalized, (byDirectory.get(normalized) ?? 0) + 1);
	}

	const winner = Array.from(byDirectory.entries()).sort((a, b) => b[1] - a[1])[0];
	return winner?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// Workspace map builders
// ---------------------------------------------------------------------------

/**
 * Builds session -> workspace-root from composerData payloads.
 * @param composerDataBySession - Parsed composerData payload grouped by session.
 */
export function buildComposerWorkspaceMap(composerDataBySession: Map<string, unknown>): Map<string, string>
{
	const result = new Map<string, string>();
	let processed = 0;
	for (const [sessionId, payload] of composerDataBySession.entries())
	{
		processed += 1;
		if (processed % CURSOR_PROGRESS_EVERY === 0 || processed === composerDataBySession.size)
		{
			console.log(`${CUR}${chalk.dim("[composer-workspace-map]")} ${processed}/${composerDataBySession.size}`);
		}
		const paths = extractComposerFileUris(payload);
		const workspaceRoot = deriveWorkspaceRootFromFileUris(paths);
		if (workspaceRoot)
		{
			result.set(sessionId, workspaceRoot);
		}
	}
	return result;
}

/**
 * Builds session -> workspace-root from messageRequestContext projectLayouts payloads.
 * @param projectLayoutsBySession - Parsed projectLayouts grouped by session.
 */
export function buildProjectLayoutWorkspaceMap(projectLayoutsBySession: Map<string, Array<CursorProjectLayout>>): Map<string, string>
{
	const result = new Map<string, string>();
	let processed = 0;
	for (const [sessionId, layouts] of projectLayoutsBySession.entries())
	{
		processed += 1;
		if (processed % CURSOR_PROGRESS_EVERY === 0 || processed === projectLayoutsBySession.size)
		{
			console.log(`${CUR}${chalk.dim("[project-layout-map]")} ${processed}/${projectLayoutsBySession.size}`);
		}

		const absPaths = Array.from(
			new Set(
				layouts
					.map((layout) => normalizePathCandidate(layout.absPath) ?? layout.absPath)
					.filter(Boolean)
			)
		);
		if (absPaths.length === 0)
		{
			continue;
		}

		const commonParent = deriveCommonDirectoryPath(absPaths);
		if (commonParent && splitPathSegments(commonParent).length > 1)
		{
			result.set(sessionId, normalizeWorkspaceRoot(commonParent));
			continue;
		}

		result.set(sessionId, normalizeWorkspaceRoot(absPaths[0]));
	}
	return result;
}

// ---------------------------------------------------------------------------
// Session evidence query
// ---------------------------------------------------------------------------

/**
 * Returns quick evidence counts for one session hash across cursorDiskKV.
 * @param db - Open Cursor SQLite handle.
 * @param sessionId - Session identifier to probe.
 */
export function queryCursorSessionEvidence(
	db: Database,
	sessionId: string
): { matchingKeys: number; workspaceLikeKeys: number }
{
	const likeToken = `%${sessionId}%`;
	const matchingRow = db
		.query<{ count: number }, [string]>("SELECT COUNT(*) as count FROM cursorDiskKV WHERE key LIKE ?")
		.get(likeToken);
	const workspaceRow = db
		.query<{ count: number }, [string]>(
			"SELECT COUNT(*) as count FROM cursorDiskKV WHERE key LIKE ? AND (key LIKE '%workspace%' OR key LIKE '%folder%' OR key LIKE '%root%' OR key LIKE '%path%')"
		)
		.get(likeToken);

	return {
		matchingKeys: Number(matchingRow?.count ?? 0),
		workspaceLikeKeys: Number(workspaceRow?.count ?? 0),
	};
}

// ---------------------------------------------------------------------------
// Main workspace inference orchestrator
// ---------------------------------------------------------------------------

/**
 * Infers per-session Cursor workspace/project labels from cursorDiskKV payloads.
 * @param db - Open Cursor SQLite handle.
 * @param bubbleMessages - Already parsed bubble records.
 * @param ruleSet - Cursor-specific project routing rules.
 */
export function inferCursorWorkspaceBySession(
	db: Database,
	bubbleMessages: Array<CursorBubbleRecord>,
	ruleSet: CursorProjectRuleSet
): CursorWorkspaceInference
{
	const startMs = Date.now();
	const sessionHintCounts = new Map<string, Map<string, number>>();
	const unresolvedFamilies = new Map<string, number>();
	const knownSessions = new Set<string>(bubbleMessages.map((item) => item.sessionId));
	const bubbleContextBySession = new Map<string, Array<string>>();
	const autoDerivedBySession = new Map<
		string,
		{
			path: string;
			derivedProject: string;
			source: CursorWorkspaceSource;
			topWorkspaceCandidates: Array<string>;
			contextSamples: Array<string>;
		}
	>();
	const miscSessionPaths = new Map<string, string>();
	const miscSourceBySession = new Map<string, CursorWorkspaceSource>();
	const sourceCounts = {
		projectLayouts: 0,
		composerFileUris: 0,
		bubbleHeuristics: 0,
		unresolved: 0,
	};
	const composerDataBySession = new Map<string, unknown>();
	const projectLayoutsBySession = new Map<string, Array<CursorProjectLayout>>();

	for (const bubble of bubbleMessages)
	{
		const existing = bubbleContextBySession.get(bubble.sessionId) ?? [];
		existing.push(...bubble.context);
		bubbleContextBySession.set(bubble.sessionId, existing);
	}

	const allRows = db.query<CursorKVRow, []>("SELECT key, value FROM cursorDiskKV").all();
	let bubbleRowCount = 0;
	let metadataRowCount = 0;
	console.log(
		`${CUR}${chalk.dim("[workspace-infer]")} allRows=${allRows.length}, sessions=${knownSessions.size}`
	);

	for (let rowIndex = 0; rowIndex < allRows.length; rowIndex += 1)
	{
		const row = allRows[rowIndex];
		const rowKey = typeof row.key === "string" ? row.key : "";
		if (!rowKey)
		{
			continue;
		}
		if (rowKey.startsWith("bubbleId:"))
		{
			bubbleRowCount += 1;
		}
		if (/(workspace|session|chat|composer|conversation|folder|root|path)/i.test(rowKey))
		{
			metadataRowCount += 1;
		}
		logCursorProgress("workspace-rows", rowIndex, allRows.length);
		const sessionHints = extractSessionHintsFromKey(rowKey);

		let parsed: unknown = null;
		const rawValue = toDatabaseText(row.value);
		if (!rawValue)
		{
			if (sessionHints.length === 0)
			{
				unresolvedFamilies.set(cursorKeyFamily(rowKey), (unresolvedFamilies.get(cursorKeyFamily(rowKey)) ?? 0) + 1);
			}
			continue;
		}
		try
		{
			parsed = JSON.parse(rawValue);
		} catch
		{
			parsed = rawValue;
		}

		if (rowKey.startsWith("composerData:"))
		{
			const sessionId = rowKey.slice("composerData:".length).trim();
			if (sessionId)
			{
				composerDataBySession.set(sessionId, parsed);
			}
		}
		if (rowKey.startsWith("messageRequestContext:"))
		{
			const keyParts = rowKey.split(":");
			const sessionId = keyParts[1]?.trim();
			if (sessionId)
			{
				const existingLayouts = projectLayoutsBySession.get(sessionId) ?? [];
				existingLayouts.push(...extractProjectLayoutsForSession(parsed));
				projectLayoutsBySession.set(sessionId, existingLayouts);
			}
		}

		if (sessionHints.length === 0)
		{
			unresolvedFamilies.set(cursorKeyFamily(rowKey), (unresolvedFamilies.get(cursorKeyFamily(rowKey)) ?? 0) + 1);
			continue;
		}

		const pathHints = new Set<string>();
		collectWorkspaceHints(parsed, pathHints);
		for (const hint of extractContextPaths(rawValue))
		{
			const normalized = normalizePathCandidate(hint);
			if (normalized)
			{
				pathHints.add(normalized);
			}
		}
		if (pathHints.size === 0)
		{
			unresolvedFamilies.set(cursorKeyFamily(rowKey), (unresolvedFamilies.get(cursorKeyFamily(rowKey)) ?? 0) + 1);
			continue;
		}

		for (const sessionId of sessionHints)
		{
			const counter = sessionHintCounts.get(sessionId) ?? new Map<string, number>();
			for (const pathHint of pathHints)
			{
				const normalizedRoot = normalizeWorkspaceRoot(pathHint);
				counter.set(normalizedRoot, (counter.get(normalizedRoot) ?? 0) + 1);
			}
			sessionHintCounts.set(sessionId, counter);
		}
	}
	logCursorProgress("workspace-rows", allRows.length, allRows.length);

	const projectLayoutWorkspaceMap = buildProjectLayoutWorkspaceMap(projectLayoutsBySession);
	const composerWorkspaceMap = buildComposerWorkspaceMap(composerDataBySession);

	const projectBySession = new Map<string, string>();
	const knownSessionList = Array.from(knownSessions);
	for (let index = 0; index < knownSessionList.length; index += 1)
	{
		const sessionId = knownSessionList[index];
		logCursorProgress("workspace-sessions", index, knownSessionList.length);
		const sessionCounter = sessionHintCounts.get(sessionId) ?? new Map<string, number>();
		for (const contextPath of bubbleContextBySession.get(sessionId) ?? [])
		{
			const normalized = normalizePathCandidate(contextPath);
			if (!normalized)
			{
				continue;
			}
			const normalizedRoot = normalizeWorkspaceRoot(normalized);
			sessionCounter.set(normalizedRoot, (sessionCounter.get(normalizedRoot) ?? 0) + 1);
		}

		const byProjectLayout = projectLayoutWorkspaceMap.get(sessionId) ?? null;
		const byComposer = composerWorkspaceMap.get(sessionId) ?? null;
		const byBubbleHint = chooseBestWorkspacePath(sessionCounter);
		const topWorkspaceCandidates = Array.from(sessionCounter.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 4)
			.map(([candidate, count]) => `${candidate} (${count})`);
		const contextSamples = Array.from(
			new Set(
				(bubbleContextBySession.get(sessionId) ?? [])
					.map((value) => value.trim())
					.filter(Boolean)
			)
		)
			.sort((a, b) => b.length - a.length)
			.slice(0, 4);
		let workspacePath: string | null = null;
		let workspaceSource: CursorWorkspaceSource = "unresolved";
		if (byProjectLayout)
		{
			workspacePath = byProjectLayout;
			workspaceSource = "projectLayouts";
		} else if (byComposer)
		{
			workspacePath = byComposer;
			workspaceSource = "composerFileUris";
		} else if (byBubbleHint)
		{
			workspacePath = byBubbleHint;
			workspaceSource = "bubbleHeuristics";
		}

		if (workspacePath)
		{
			sourceCounts[workspaceSource] += 1;
			const resolution = resolveCursorProjectFromWorkspacePath(workspacePath, ruleSet);
			projectBySession.set(sessionId, resolution.project);
			if (resolution.mode === "auto-derived")
			{
				autoDerivedBySession.set(sessionId, {
					path: workspacePath,
					derivedProject: resolution.project,
					source: workspaceSource,
					topWorkspaceCandidates,
					contextSamples,
				});
			}
			if (resolution.mode === "misc")
			{
				miscSessionPaths.set(sessionId, workspacePath);
				miscSourceBySession.set(sessionId, workspaceSource);
			}
		} else
		{
			sourceCounts.unresolved += 1;
			miscSessionPaths.set(sessionId, "(no workspace path found)");
			miscSourceBySession.set(sessionId, "unresolved");
			projectBySession.set(sessionId, MISC_CURSOR_PROJECT);
		}
	}
	logCursorProgress("workspace-sessions", knownSessionList.length, knownSessionList.length);

	const fallbackGlobal = Array.from(knownSessions).filter((sessionId) => !projectBySession.has(sessionId)).length;
	const unresolvedFamilyList = Array.from(unresolvedFamilies.entries())
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([family]) => family);

	if (fallbackGlobal > 0)
	{
		const unresolvedSession = Array.from(knownSessions).find((sessionId) => !projectBySession.has(sessionId));
		if (unresolvedSession)
		{
			const evidence = queryCursorSessionEvidence(db, unresolvedSession);
			console.log(
				`${CUR} Session evidence for unresolved ${chalk.dim(unresolvedSession)}: matchingKeys=${evidence.matchingKeys}, workspaceLikeKeys=${evidence.workspaceLikeKeys}`
			);
		}
	}
	console.log(
		`${CUR}${chalk.dim("[workspace-infer]")} done in ${chalk.green((Date.now() - startMs) + "ms")}, projectCache=${PROJECT_ROOT_CACHE.size}, normalizeCache=${WORKSPACE_NORMALIZE_CACHE.size}`
	);

	return {
		projectBySession,
		autoDerivedBySession,
		miscSessionPaths,
		miscSourceBySession,
		sourceCounts,
		sessionsResolved: projectBySession.size,
		fallbackGlobal,
		unresolvedFamilies: unresolvedFamilyList,
		bubbleKeyCount: bubbleRowCount,
		metadataKeyCount: metadataRowCount,
	};
}
