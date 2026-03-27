/**
 * ContextCore – Kiro IDE harness.
 * Kiro persists chats in `.chat` JSON files keyed by workspace hash.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, join } from "path";
import { DateTime } from "luxon";
import chalk from "chalk";
import { getHostname } from "../config.js";
import { AgentMessage, type AgentRole } from "../models/AgentMessage.js";
import { CCSettings } from "../settings/CCSettings.js";
import type { ToolCall } from "../types.js";
import { generateMessageId } from "../utils/hashId.js";
import { deriveProjectName, sanitizeFilename } from "../utils/pathHelpers.js";
import { copyRawSourceFile, isSourceFileCached } from "../utils/rawCopier.js";

type KiroChatEntry = {
	role?: "human" | "bot" | "tool" | string;
	content?: string;
	context?: Array<{ staticDirectoryView?: string }>;
};

type KiroChatFile = {
	executionId?: string;
	chat?: Array<KiroChatEntry>;
	metadata?: {
		modelId?: string;
	};
};

type KiroParsedFile = {
	filePath: string;
	payload: KiroChatFile;
};

type KiroProjectMappingRule = {
	path: string;
	newProjectName: string;
};

type KiroGenericProjectMappingRule = {
	path: string;
	rule: string;
};

type KiroProjectRuleSet = {
	projectMappingRules: Array<KiroProjectMappingRule>;
	genericProjectMappingRules: Array<KiroGenericProjectMappingRule>;
};

type KiroProjectResolution = {
	project: string;
	mode: "rule" | "auto-derived" | "misc";
	bestPath: string | null;
};

const MISC_KIRO_PROJECT = "Kiro-MISC";

const KIRO_HASH_DIR = /^[a-f0-9]{32}$/i;
const KIRO_HASH_CHAT = /^[a-f0-9]{32}\.chat$/i;

/**
 * Normalizes a path-ish token to comparable lowercase slash form.
 * @param input - Raw rule path or source path.
 */
function normalizeRulePath(input: string): string
{
	return input.replace(/[\\/]+/g, "/").toLowerCase();
}

/**
 * Extracts the first path directory segment after a matched prefix.
 * @param sourcePath - Source path candidate.
 * @param matchedPrefix - Rule prefix that matched inside sourcePath.
 */
function getFirstDirAfterPrefix(sourcePath: string, matchedPrefix: string): string | null
{
	const sourceNormalized = sourcePath.replace(/[\\/]+/g, "/");
	const prefixNormalized = matchedPrefix.replace(/[\\/]+/g, "/");
	const sourceLower = sourceNormalized.toLowerCase();
	const prefixLower = prefixNormalized.toLowerCase();
	const matchIndex = sourceLower.indexOf(prefixLower);
	if (matchIndex === -1)
	{
		return null;
	}

	const tail = sourceNormalized.slice(matchIndex + prefixNormalized.length).replace(/^\/+/, "");
	const [firstDir] = tail.split("/");
	if (!firstDir)
	{
		return null;
	}
	return firstDir.trim() || null;
}

/**
 * Validates one explicit Kiro project mapping rule candidate.
 * @param value - Unknown rule payload.
 */
function asKiroProjectMappingRule(value: unknown): KiroProjectMappingRule | null
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
 * Validates one generic Kiro project mapping rule candidate.
 * @param value - Unknown rule payload.
 */
function asKiroGenericProjectMappingRule(value: unknown): KiroGenericProjectMappingRule | null
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

/**
 * Reads Kiro project routing rules from cc.json for the active machine.
 * Supports generic rules either inside Kiro config or as a machine-level sibling.
 */
function loadKiroProjectRuleSet(): KiroProjectRuleSet
{
	try
	{
		const settings = CCSettings.getInstance();
		const machine = settings.getMachineConfig(getHostname());
		const harnesses = (machine?.harnesses ?? {}) as Record<string, unknown>;
		const kiroConfig = (harnesses.Kiro ?? {}) as Record<string, unknown>;

		const explicitRaw = Array.isArray(kiroConfig.projectMappingRules) ? kiroConfig.projectMappingRules : [];
		const explicitRules = explicitRaw
			.map((rule) => asKiroProjectMappingRule(rule))
			.filter((rule): rule is KiroProjectMappingRule => Boolean(rule));

		//<Allow generic rules under Kiro first, then machine-level fallback.
		const genericSource = Array.isArray(kiroConfig.genericProjectMappingRules)
			? kiroConfig.genericProjectMappingRules
			: Array.isArray(harnesses.genericProjectMappingRules)
				? harnesses.genericProjectMappingRules
				: [];
		const genericRules = genericSource
			.map((rule) => asKiroGenericProjectMappingRule(rule))
			.filter((rule): rule is KiroGenericProjectMappingRule => Boolean(rule));

		const droppedExplicit = explicitRaw.length - explicitRules.length;
		if (droppedExplicit > 0)
		{
			console.warn(chalk.yellow(`[Kiro] ⚠ ${droppedExplicit} projectMappingRules entry(ies) dropped — check that each has a "path" or "paths" key`));
		}
		const droppedGeneric = genericSource.length - genericRules.length;
		if (droppedGeneric > 0)
		{
			console.warn(chalk.yellow(`[Kiro] ⚠ ${droppedGeneric} genericProjectMappingRules entry(ies) dropped — check that each has a "path" or "paths" key`));
		}

		return {
			projectMappingRules: explicitRules,
			genericProjectMappingRules: genericRules,
		};
	} catch
	{
		//<Treat settings errors as no-rule mode.
		return {
			projectMappingRules: [],
			genericProjectMappingRules: [],
		};
	}
}

/**
 * Extracts path-like candidates from freeform text.
 * @param text - Any message or metadata text.
 */
function extractPathCandidates(text: string): Array<string>
{
	const pathPattern = /(?:[a-zA-Z]:\\|\/)[^\s"'`]+/g;
	return text.match(pathPattern) ?? [];
}

/**
 * Resolves one project label from a list of source paths using Kiro rule precedence.
 * @param sourcePaths - Candidate paths from storage root, chat payload, and context.
 * @param ruleSet - Parsed Kiro project mapping rules.
 */
function resolveKiroProjectFromPaths(sourcePaths: Array<string>, ruleSet: KiroProjectRuleSet): string
{
	return resolveKiroProjectResolutionFromPaths(sourcePaths, ruleSet).project;
}

/**
 * Resolves one project label from source paths with resolution metadata.
 * @param sourcePaths - Candidate paths from storage root, chat payload, and context.
 * @param ruleSet - Parsed Kiro project mapping rules.
 */
function resolveKiroProjectResolutionFromPaths(
	sourcePaths: Array<string>,
	ruleSet: KiroProjectRuleSet
): KiroProjectResolution
{
	const normalizedPaths = sourcePaths
		.map((pathValue) => pathValue.trim())
		.filter(Boolean)
		.map((pathValue) => pathValue.replace(/^file:\/\//i, "").replace(/[\\/]+$/, ""));

	//<First pass: explicit remaps (indexOf match) always win.
	for (const sourcePath of normalizedPaths)
	{
		const sourceKey = normalizeRulePath(sourcePath);
		for (const rule of ruleSet.projectMappingRules)
		{
			if (sourceKey.indexOf(normalizeRulePath(rule.path)) !== -1)
			{
				return {
					project: sanitizeFilename(rule.newProjectName),
					mode: "rule",
					bestPath: sourcePath,
				};
			}
		}
	}

	//<Second pass: generic rules (currently byFirstDir).
	for (const sourcePath of normalizedPaths)
	{
		const sourceKey = normalizeRulePath(sourcePath);
		for (const rule of ruleSet.genericProjectMappingRules)
		{
			if (sourceKey.indexOf(normalizeRulePath(rule.path)) === -1)
			{
				continue;
			}
			if (rule.rule.toLowerCase() !== "byfirstdir")
			{
				continue;
			}
			const firstDir = getFirstDirAfterPrefix(sourcePath, rule.path);
			if (firstDir)
			{
				return {
					project: sanitizeFilename(firstDir),
					mode: "rule",
					bestPath: sourcePath,
				};
			}
		}
	}

	const bestPath = normalizedPaths
		.slice()
		.sort((a, b) => b.length - a.length)[0] ?? null;
	if (bestPath)
	{
		const lastSegment = basename(bestPath);
		if (KIRO_HASH_DIR.test(lastSegment) || KIRO_HASH_CHAT.test(lastSegment))
		{
			return {
				project: MISC_KIRO_PROJECT,
				mode: "misc",
				bestPath,
			};
		}
		const autoProject = sanitizeFilename(lastSegment);
		if (autoProject)
		{
			return {
				project: autoProject,
				mode: "auto-derived",
				bestPath,
			};
		}
	}

	//<Everything else goes into MISC.
	return {
		project: MISC_KIRO_PROJECT,
		mode: "misc",
		bestPath,
	};
}

/**
 * Builds compact byFirstDir generic rule suggestions from path evidence.
 * @param paths - Source paths observed for unresolved/auto-derived sessions.
 */
function buildKiroGenericRuleSuggestions(paths: Array<string>): Array<KiroGenericProjectMappingRule>
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

/**
 * Guards against generic labels that are not real workspace names.
 * @param candidate - Potential workspace/project label.
 */
function isLikelyWorkspaceLabel(candidate: string): boolean
{
	const cleaned = candidate.trim().toLowerCase();
	if (!cleaned || cleaned.length < 2)
	{
		return false;
	}
	if (/^[a-f0-9]{16,}$/i.test(cleaned))
	{
		return false;
	}

	const blocked = new Set([
		"listdirectory",
		"listdirectorys",
		"listdirectories",
		"directory",
		"directories",
		"folder",
		"folders",
		"workspace",
		"project",
		"metadata",
		"state",
		"storage",
		"root",
		"default",
		"unknown",
		"untitled",
	]);
	return !blocked.has(cleaned);
}

/**
 * Recursively finds a human-friendly workspace/project name in metadata JSON.
 * @param value - Unknown parsed JSON value.
 */
function findWorkspaceName(value: unknown): string | null
{
	if (!value || typeof value !== "object")
	{
		return null;
	}

	if (Array.isArray(value))
	{
		for (const item of value)
		{
			const match = findWorkspaceName(item);
			if (match)
			{
				return match;
			}
		}
		return null;
	}

	const obj = value as Record<string, unknown>;
	const directCandidates = [
		"workspaceName",
		"projectName",
		"workspace",
		"project",
		"workspacePath",
		"projectPath",
		"rootPath",
		"cwd",
		"path",
	];

	for (const key of directCandidates)
	{
		const raw = obj[key];
		if (typeof raw !== "string" || !raw.trim())
		{
			continue;
		}
		const trimmed = raw.trim().replace(/[\\/]+$/, "");
		const fromPath = trimmed.split(/[\\/]/).filter(Boolean).pop() ?? trimmed;
		if (isLikelyWorkspaceLabel(fromPath))
		{
			return deriveProjectName("Kiro", fromPath);
		}
	}

	for (const child of Object.values(obj))
	{
		const nested = findWorkspaceName(child);
		if (nested)
		{
			return nested;
		}
	}

	return null;
}

/**
 * Reads metadata JSON-like files from hash root and first-level folders.
 * @param storagePath - Source Kiro hash root.
 */
function readKiroWorkspaceNameFromMetadata(storagePath: string): string | null
{
	if (!existsSync(storagePath))
	{
		return null;
	}

	const candidateFiles: Array<string> = [];
	let rootEntries: Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean }> = [];
	try
	{
		rootEntries = readdirSync(storagePath, { withFileTypes: true });
	} catch
	{
		return null;
	}
	for (const entry of rootEntries)
	{
		const full = join(storagePath, entry.name);
		const lowerName = entry.name.toLowerCase();
		const isMetadataLikeFile =
			lowerName.endsWith(".json") ||
			lowerName.includes("workspace") ||
			lowerName.includes("project") ||
			lowerName.includes("meta") ||
			lowerName.includes("state");
		if (entry.isFile() && !entry.name.endsWith(".chat") && isMetadataLikeFile)
		{
			candidateFiles.push(full);
		} else if (entry.isDirectory())
		{
			let nestedEntries: Array<{ name: string; isFile: () => boolean }> = [];
			try
			{
				nestedEntries = readdirSync(full, { withFileTypes: true });
			} catch
			{
				continue;
			}
			for (const nestedEntry of nestedEntries)
			{
				if (!nestedEntry.isFile())
				{
					continue;
				}
				const nestedLower = nestedEntry.name.toLowerCase();
				const isNestedMetadataLike =
					nestedLower.endsWith(".json") ||
					nestedLower.includes("workspace") ||
					nestedLower.includes("project") ||
					nestedLower.includes("meta") ||
					nestedLower.includes("state");
				if (isNestedMetadataLike)
				{
					candidateFiles.push(join(full, nestedEntry.name));
				}
			}
		}
	}

	for (const filePath of candidateFiles)
	{
		try
		{
			const size = statSync(filePath).size;
			if (size <= 0 || size > 2_000_000)
			{
				continue;
			}
			const raw = readFileSync(filePath, "utf-8").trim();
			if (!raw.startsWith("{") && !raw.startsWith("["))
			{
				continue;
			}
			const parsed = JSON.parse(raw) as unknown;
			const workspace = findWorkspaceName(parsed);
			if (workspace)
			{
				return workspace;
			}
		} catch
		{
			continue;
		}
	}

	return null;
}

/**
 * Reads root-level `.chat` files and parses each as one JSON object.
 * @param storagePath - path to `kiro.kiroagent/<hash>/`.
 */
function readKiroChatFiles(storagePath: string): Array<KiroParsedFile>
{
	if (!existsSync(storagePath))
	{
		return [];
	}

	// Map to track the most recent file per executionId
	const sessionFiles = new Map<string, { filePath: string; payload: KiroChatFile; mtime: number }>();

	try
	{
		const entries = readdirSync(storagePath, { withFileTypes: true });
		for (const entry of entries)
		{
			if (!entry.isFile() || !entry.name.endsWith(".chat"))
			{
				continue;
			}

			const filePath = join(storagePath, entry.name);
			try
			{
				const raw = readFileSync(filePath, "utf-8");
				const payload = JSON.parse(raw) as KiroChatFile;
				const mtime = statSync(filePath).mtimeMs;
				const executionId = payload.executionId ?? basename(filePath, ".chat");

				// Only keep the most recent file for each executionId
				const existing = sessionFiles.get(executionId);
				if (!existing || mtime > existing.mtime)
				{
					sessionFiles.set(executionId, { filePath, payload, mtime });
				}
			} catch
			{
				console.warn(`[Kiro] Skipping malformed .chat file: ${filePath}`);
			}
		}
	} catch
	{
		return [];
	}

	// Extract just the filePath and payload for downstream processing
	const results: Array<KiroParsedFile> = [];
	for (const { filePath, payload } of sessionFiles.values())
	{
		results.push({ filePath, payload });
	}

	const totalFiles = readdirSync(storagePath).filter(name => name.endsWith(".chat")).length;
	const dedupedFiles = results.length;
	if (totalFiles > dedupedFiles)
	{
		console.log(chalk.yellow(`[Kiro] Deduplicated ${totalFiles} files → ${dedupedFiles} sessions (skipped ${totalFiles - dedupedFiles} older snapshots)`));
	}

	return results;
}

/**
 * Finds and skips the first `<identity>` human entry and extracts a model label.
 * @param chat - Kiro chat array payload.
 */
function findSystemPromptInfo(chat: Array<KiroChatEntry>):
	{
		startIndex: number;
		model: string | null;
	}
{
	for (let i = 0; i < chat.length; i += 1)
	{
		const entry = chat[i];
		const text = entry.content ?? "";
		if (entry.role === "human" && text.includes("<identity>"))
		{
			const match = text.match(/Name:\s*(.+)/);
			return {
				startIndex: i + 1,
				model: match?.[1]?.trim() ?? null,
			};
		}
	}

	return { startIndex: 0, model: null };
}

/**
 * Extracts file references from markdown path-fenced codeblocks and directory view text.
 * @param message - Message text that can include fenced path blocks.
 * @param staticDirectoryView - Optional workspace tree text snapshot.
 */
function extractKiroContextPaths(message: string, staticDirectoryView?: string): Array<string>
{
	const paths = new Set<string>();
	const fencedPathRegex = /```([^\n`]+?)\r?\n/g;

	for (const match of message.matchAll(fencedPathRegex))
	{
		const maybePath = (match[1] ?? "").trim();
		if (maybePath.includes("/") || maybePath.includes("\\"))
		{
			paths.add(maybePath);
		}
	}

	if (staticDirectoryView)
	{
		for (const rawLine of staticDirectoryView.split(/\r?\n/))
		{
			const line = rawLine.trim();
			if (!line || line.endsWith("/"))
			{
				continue;
			}
			if (line.includes("/") || line.includes("\\"))
			{
				paths.add(line);
			}
		}
	}

	return Array.from(paths);
}

/**
 * Derives Kiro project name from directory tree text or falls back to hash folder.
 * @param storagePath - Source hash folder path.
 * @param staticDirectoryView - Optional static tree representation from Kiro context.
 */
function deriveKiroProject(storagePath: string, staticDirectoryView?: string): string
{
	if (staticDirectoryView)
	{
		const packageLine = staticDirectoryView
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => line.toLowerCase().includes("package.json"));

		if (packageLine)
		{
			const cleaned = packageLine.replace(/package\.json.*/i, "").replace(/[\\/]+$/, "");
			const segment = cleaned.split(/[\\/]/).filter(Boolean).pop();
			if (segment && isLikelyWorkspaceLabel(segment))
			{
				return deriveProjectName("Kiro", segment);
			}
		}

		const rootLine = staticDirectoryView
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => line.endsWith("/"));

		if (rootLine)
		{
			const candidate = rootLine.replace(/[\\/]+$/, "");
			if (isLikelyWorkspaceLabel(candidate))
			{
				return deriveProjectName("Kiro", candidate);
			}
		}
	}

	return deriveProjectName("Kiro", basename(storagePath));
}

/**
 * Uses message text paths as a fallback project signal.
 * @param chat - Kiro chat entries for one file.
 */
function deriveKiroProjectFromMessagePaths(chat: Array<KiroChatEntry>): string | null
{
	const pathPattern = /(?:[a-zA-Z]:\\|\/)[^\s"'`]+/g;
	const counts = new Map<string, number>();

	for (const entry of chat)
	{
		const text = entry.content ?? "";
		const matches = text.match(pathPattern) ?? [];
		for (const pathValue of matches)
		{
			const segment = pathValue
				.replace(/[\\/]+$/, "")
				.split(/[\\/]/)
				.filter(Boolean)
				.pop();
			if (!segment || !isLikelyWorkspaceLabel(segment))
			{
				continue;
			}
			counts.set(segment, (counts.get(segment) ?? 0) + 1);
		}
	}

	const top = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
	return top ? deriveProjectName("Kiro", top) : null;
}

/**
 * Maps Kiro chat roles to normalized AgentMessage roles.
 * @param role - Role field from Kiro chat entry.
 */
function mapKiroRole(role: string | undefined): AgentRole | null
{
	if (role === "human")
	{
		return "user";
	}
	if (role === "bot")
	{
		return "assistant";
	}
	if (role === "tool")
	{
		return "tool";
	}
	return null;
}

/**
 * Infers a best-effort tool name from assistant action language.
 * @param text - Assistant/bot message text preceding a tool entry.
 */
function inferKiroToolName(text: string): string
{
	const lower = text.toLowerCase();
	if (lower.includes("read"))
	{
		return "readFile";
	}
	if (lower.includes("search") || lower.includes("find"))
	{
		return "search";
	}
	if (lower.includes("write") || lower.includes("create"))
	{
		return "writeFile";
	}
	if (lower.includes("edit") || lower.includes("update"))
	{
		return "editFile";
	}
	return "unknownTool";
}

/**
 * Reads normalized AgentMessages from Kiro `.chat` sessions.
 * @param storagePath - path to `kiro.kiroagent/<hash>/`.
 */
/**
 * Reads full-session AgentMessages from Kiro `.chat` files.
 * @param storagePath - Kiro workspace hash directory.
 * @param rawBase - Raw archive directory for this harness.
 */
export function readKiroChats(storagePath: string, rawBase: string): Array<AgentMessage>
{
	const parsedFiles = readKiroChatFiles(storagePath);
	const ruleSet = loadKiroProjectRuleSet();
	const results: Array<AgentMessage> = [];
	const autoDerivedSessions: Array<{ path: string }> = [];
	const miscSessions: Array<{ candidates: Array<string> }> = [];
	let skippedCount = 0;
	console.log(
		`[Kiro] Project rules: explicit=${ruleSet.projectMappingRules.length}, generic=${ruleSet.genericProjectMappingRules.length}, fallback=${MISC_KIRO_PROJECT}`
	);

	for (const parsedFile of parsedFiles)
	{
		const chat = parsedFile.payload.chat ?? [];
		const { startIndex } = findSystemPromptInfo(chat);
		const model = parsedFile.payload.metadata?.modelId ?? null;
		const mtimeMs = statSync(parsedFile.filePath).mtimeMs;
		const dateTime = DateTime.fromMillis(mtimeMs);
		const sessionId = parsedFile.payload.executionId ?? basename(parsedFile.filePath, ".chat");
		const staticDirectoryView = chat[startIndex]?.context?.[0]?.staticDirectoryView;
		const projectCandidates = new Set<string>([storagePath, parsedFile.filePath]);
		if (staticDirectoryView)
		{
			for (const line of staticDirectoryView.split(/\r?\n/))
			{
				const trimmed = line.trim();
				if (!trimmed)
				{
					continue;
				}
				projectCandidates.add(trimmed);
			}
			for (const candidate of extractPathCandidates(staticDirectoryView))
			{
				projectCandidates.add(candidate);
			}
		}
		for (const entry of chat)
		{
			const text = entry.content ?? "";
			for (const candidate of extractPathCandidates(text))
			{
				projectCandidates.add(candidate);
			}
			for (const contextPath of extractKiroContextPaths(text, entry.context?.[0]?.staticDirectoryView))
			{
				projectCandidates.add(contextPath);
			}
		}
		const projectResolution = resolveKiroProjectResolutionFromPaths(Array.from(projectCandidates), ruleSet);
		const project = projectResolution.project;
		if (projectResolution.mode === "auto-derived" && projectResolution.bestPath)
		{
			autoDerivedSessions.push({
				path: projectResolution.bestPath,
			});
		}
		if (projectResolution.mode === "misc")
		{
			const candidates = Array.from(projectCandidates)
				.map((value) => value.trim())
				.filter(Boolean)
				.slice(0, 3);
			miscSessions.push({ candidates });
		}

		// Skip processing if file is already cached (same size and mtime)
		if (isSourceFileCached(parsedFile.filePath, rawBase, project))
		{
			skippedCount++;
			continue;
		}

		const rawDest = copyRawSourceFile(rawBase, project, parsedFile.filePath);
		let previousId: string | null = null;

		for (let i = startIndex; i < chat.length; i += 1)
		{
			const entry = chat[i];
			const role = mapKiroRole(entry.role);
			if (!role)
			{
				continue;
			}

			const message = entry.content ?? "";
			const context = extractKiroContextPaths(message, entry.context?.[0]?.staticDirectoryView);
			const id = generateMessageId(sessionId, role, `${mtimeMs}-${i}`, message.slice(0, 120));
			const nextEntry = chat[i + 1];
			const inferredToolCalls: Array<ToolCall> = [];

			if (
				role === "assistant" &&
				nextEntry?.role === "tool" &&
				!(nextEntry.content ?? "").trim()
			)
			{
				inferredToolCalls.push({
					name: inferKiroToolName(message),
					context: [],
					results: [],
				});
			}

			results.push(
				new AgentMessage({
					id,
					sessionId,
					harness: "Kiro",
					machine: "",
					role,
					model: role === "assistant" ? model : null,
					message,
					subject: "",
					context,
					symbols: [],
					history: [],
					tags: [],
					project,
					parentId: previousId,
					tokenUsage: null,
					toolCalls: inferredToolCalls,
					rationale: [],
					source: rawDest,
					dateTime,
					length: message.length,
				})
			);

			previousId = id;
		}
	}

	if (autoDerivedSessions.length > 0)
	{
		console.warn(`[Kiro] Auto-derived project names for ${autoDerivedSessions.length} session(s) from path segments.`);
	}

	if (miscSessions.length > 0)
	{
		console.warn(`[Kiro] Routed ${miscSessions.length} session(s) to Kiro-MISC due to unresolved or hash-like project names.`);
		console.warn("[Kiro] Hint: run `bun run setup` and configure Kiro projectMappingRules for hash directories.");
	}

	const suggestedRules = buildKiroGenericRuleSuggestions([
		...autoDerivedSessions.map((entry) => entry.path),
		...miscSessions.flatMap((entry) => entry.candidates),
	]);
	if (suggestedRules.length > 0)
	{
		console.warn("[Kiro] Suggested cc.json genericProjectMappingRules snippet:");
		console.warn(
			JSON.stringify(
				{
					genericProjectMappingRules: suggestedRules,
				},
				null,
				2
			)
		);
	}

	console.log(`[Kiro] Processed ${parsedFiles.length} files: ${chalk.green(skippedCount + ' cached')}, ${chalk.blue((parsedFiles.length - skippedCount) + ' new/modified')}`);
	return results;
}
