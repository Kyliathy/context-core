import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { join, relative, dirname } from "path";
import type { MachineConfig, DataSourceEntry } from "../types.js";

/** A single indexed file from a data source directory. */
export interface IndexedFile
{
	/** Relative path from the data source root. */
	relativePath: string;
	/** Absolute path on disk. */
	absolutePath: string;
	/** File size in bytes. */
	size: number;
	/** Last modified timestamp (ISO string). */
	lastModified: string;
	/** Data source name this file belongs to. */
	sourceName: string;
	/** Data source type (informational). */
	sourceType: string;
	/** Whether the file comes from path ("content") or agentPath ("agent"). */
	origin: "content" | "agent";
	/** First 1000 characters of the file content. */
	excerpt: string;
}

/** Summary of a single data source included in a PrepareResponse. */
export interface PrepareSource
{
	name: string;
	type: string;
	path: string;
	agentPath?: string;
	/** Candidate Codex output directories for this source (ordered by resolver precedence). */
	codexDirectories?: string[];
	/** Default Codex output directory selected when no explicit directory is provided. */
	codexDefaultDirectory?: string;
	fileCount: number;
}

/** Input for POST /api/agent-builder/create. */
export interface CreateAgentInput
{
	projectName: string;
	agentName: string;
	description: string;
	"argument-hint": string;
	tools?: string[];
	agentKnowledge: string[];
	/** Stable Codex entry id when editing/updating one entry inside AGENTS.md/AGENTS.json. */
	codexEntryId?: string;
	/** Explicit Codex output directory (must be one of the source's allowed Codex directories). */
	codexDirectory?: string;
	/** Target platform for the generated agent file. "github" writes .agent.md; "claude" writes a Claude Code sub-agent .md; "codex" writes AGENTS.md. */
	platform: "github" | "claude" | "codex";
}

/** Response shape for POST /api/agent-builder/create. */
export interface CreateAgentResponse
{
	created: boolean;
	path: string;
	agentName: string;
	codexEntryId?: string;
}

/** Per-platform location info within a consolidated agent list entry. */
export interface AgentListPlatformEntry
{
	platform: "github" | "claude" | "codex";
	path: string;
	codexEntryId?: string;
	codexDirectory?: string;
	/** Byte size of the agent definition file (used to pick primary version for editing). */
	dataLength: number;
}

/** Summary entry for GET /api/agent-builder/list (consolidated across platforms). */
export interface AgentListEntry
{
	/** Agent name (filename stem, e.g. cxc-ui-worker). */
	name: string;
	/** Absolute path to the primary platform's agent file (biggest dataLength). */
	path: string;
	/** Optional entry id (set when primary platform is Codex). */
	codexEntryId?: string;
	/** Optional Codex directory (set when primary platform is Codex). */
	codexDirectory?: string;
	/** Primary platform (the one with the biggest dataLength). */
	platform?: "github" | "claude" | "codex";
	/** All platforms this logical agent exists on. */
	platforms: AgentListPlatformEntry[];
	/** True when the agent content differs between platforms (knowledge, description, etc.). */
	contentDiverged: boolean;
	/** Agent description from JSON or frontmatter (from primary platform). */
	description: string;
	/** Argument hint from JSON or frontmatter (from primary platform). */
	hint: string;
	/** First 1000 characters of primary platform file content. */
	excerpt: string;
}

/** Response shape for GET /api/agent-builder/list. */
export interface AgentListResponse
{
	totalAgents: number;
	agents: AgentListEntry[];
}

/** Structured payload returned by GET /api/agent-builder/get-agent. */
export interface AgentDefinition extends CreateAgentInput
{
	/** True when loaded from .agent.json, false when reconstructed from .agent.md. */
	fromJson: boolean;
}

/** Response shape for GET /api/agent-builder/get-agent. */
export interface GetAgentResponse
{
	agent: AgentDefinition;
}

/** Response shape for POST /api/agent-builder/prepare. */
export interface PrepareResponse
{
	/** Total number of files across all included sources. */
	totalFiles: number;
	/** Data sources included in this response. */
	sources: PrepareSource[];
	/** Flat list of all indexed files. */
	files: IndexedFile[];
}

/** Input for POST /api/agent-builder/add-template. */
export interface CreateTemplateInput
{
	templateName: string;
	description: string;
	"argument-hint": string;
	tools?: string[];
	agentKnowledge: string[];
}

/** Response shape for POST /api/agent-builder/add-template. */
export interface CreateTemplateResponse
{
	created: boolean;
	templateName: string;
	path: string;
}

/** Response shape for GET /api/agent-builder/list-templates. */
export interface TemplateListResponse
{
	totalTemplates: number;
	templates: CreateTemplateInput[];
}

/** Directories to skip during recursive file scanning. */
const SKIP_DIRS = new Set([".git", "node_modules"]);

/** Hidden directories that are allowed during recursive scanning. */
const ALLOWED_HIDDEN_DIRS = new Set([".github", ".claude"]);

/**
 * Codex discovers project instructions from AGENTS filenames, so generated
 * Codex agent output must use these exact names for automatic discovery.
 */
const CODEX_AGENTS_FILE = "AGENTS.md";
const CODEX_AGENTS_OVERRIDE_FILE = "AGENTS.override.md";
const CODEX_AGENTS_JSON_FILE = "AGENTS.json";
const CODEX_GENERATED_MARKER = "<!-- Generated by ContextCore AgentBuilder (platform: codex) -->";
const CODEX_ENTRY_BEGIN_PREFIX = "<!-- CXC-CODEX-ENTRY:";
const CODEX_ENTRY_END = "<!-- /CXC-CODEX-ENTRY -->";
const CODEX_COLLECTION_VERSION = 2 as const;
const CODEX_COLLECTION_GENERATOR = "ContextCore AgentBuilder";

function formatBackupTimestamp(date: Date): string
{
	const y = String(date.getFullYear());
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	const hh = String(date.getHours()).padStart(2, "0");
	const mm = String(date.getMinutes()).padStart(2, "0");
	const ss = String(date.getSeconds()).padStart(2, "0");
	return `${y}${m}${d}-${hh}${mm}${ss}`;
}

type CodexAgentEntry = {
	id: string;
	projectName: string;
	agentName: string;
	description: string;
	"argument-hint": string;
	tools: string[];
	agentKnowledge: string[];
	platform: "codex";
	updatedAt: string;
};

type CodexAgentCollection = {
	version: typeof CODEX_COLLECTION_VERSION;
	platform: "codex";
	generatedBy: string;
	updatedAt: string;
	agents: CodexAgentEntry[];
};

function normalizeList(values: unknown): string[]
{
	if (!Array.isArray(values)) return [];
	return values.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
}

function slugifyId(raw: string): string
{
	const normalized = raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || "codex-agent";
}

function makeUniqueCodexEntryId(existingIds: Set<string>, base: string): string
{
	const seed = slugifyId(base);
	if (!existingIds.has(seed))
	{
		existingIds.add(seed);
		return seed;
	}
	let suffix = 2;
	while (existingIds.has(`${seed}-${suffix}`))
	{
		suffix++;
	}
	const id = `${seed}-${suffix}`;
	existingIds.add(id);
	return id;
}

function normalizeCodexEntry(input: {
	id: string;
	projectName?: unknown;
	agentName?: unknown;
	description?: unknown;
	"argument-hint"?: unknown;
	tools?: unknown;
	agentKnowledge?: unknown;
	updatedAt?: unknown;
}, fallbackProjectName: string): CodexAgentEntry
{
	return {
		id: slugifyId(input.id),
		projectName: typeof input.projectName === "string" && input.projectName.trim() !== ""
			? input.projectName.trim()
			: fallbackProjectName,
		agentName: typeof input.agentName === "string" ? input.agentName.trim() : "",
		description: typeof input.description === "string" ? input.description : "",
		"argument-hint": typeof input["argument-hint"] === "string" ? input["argument-hint"] : "",
		tools: normalizeList(input.tools),
		agentKnowledge: normalizeList(input.agentKnowledge),
		platform: "codex",
		updatedAt: typeof input.updatedAt === "string" && input.updatedAt.trim() !== "" ? input.updatedAt : new Date().toISOString(),
	};
}

function toCodexCollection(agents: CodexAgentEntry[]): CodexAgentCollection
{
	return {
		version: CODEX_COLLECTION_VERSION,
		platform: "codex",
		generatedBy: CODEX_COLLECTION_GENERATOR,
		updatedAt: new Date().toISOString(),
		agents,
	};
}

function toCodexEntryFromInput(input: CreateAgentInput, id: string): CodexAgentEntry
{
	return {
		id: slugifyId(id),
		projectName: input.projectName,
		agentName: input.agentName,
		description: input.description,
		"argument-hint": input["argument-hint"],
		tools: normalizeList(input.tools),
		agentKnowledge: normalizeList(input.agentKnowledge),
		platform: "codex",
		updatedAt: new Date().toISOString(),
	};
}

function parseCodexCollectionFromJson(jsonContent: string, fallbackProjectName: string): CodexAgentCollection | null
{
	let parsed: unknown;
	try
	{
		parsed = JSON.parse(jsonContent);
	} catch
	{
		return null;
	}

	// v2: { version: 2, platform: "codex", agents: [...] }
	if (parsed && typeof parsed === "object" && Array.isArray((parsed as { agents?: unknown }).agents))
	{
		const obj = parsed as Record<string, unknown>;
		const rawAgents = obj.agents as unknown[];
		const usedIds = new Set<string>();
		const agents = rawAgents
			.filter((candidate): candidate is Record<string, unknown> => !!candidate && typeof candidate === "object")
			.map((candidate) =>
			{
				const requested = typeof candidate.id === "string" && candidate.id.trim() !== ""
					? candidate.id
					: typeof candidate.agentName === "string" ? candidate.agentName : "codex-agent";
				const id = makeUniqueCodexEntryId(usedIds, requested);
				return normalizeCodexEntry({
					id,
					projectName: typeof candidate.projectName === "string" ? candidate.projectName : fallbackProjectName,
					agentName: typeof candidate.agentName === "string" ? candidate.agentName : "",
					description: typeof candidate.description === "string" ? candidate.description : "",
					"argument-hint": typeof candidate["argument-hint"] === "string" ? candidate["argument-hint"] : "",
					tools: candidate.tools,
					agentKnowledge: candidate.agentKnowledge,
					updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : undefined,
				}, fallbackProjectName);
			});

		return {
			version: CODEX_COLLECTION_VERSION,
			platform: "codex",
			generatedBy: typeof obj.generatedBy === "string" && obj.generatedBy.trim() !== "" ? obj.generatedBy : CODEX_COLLECTION_GENERATOR,
			updatedAt: typeof obj.updatedAt === "string" && obj.updatedAt.trim() !== "" ? obj.updatedAt : new Date().toISOString(),
			agents,
		};
	}

	// Legacy v1: CreateAgentInput-like payload
	if (parsed && typeof parsed === "object")
	{
		const obj = parsed as Record<string, unknown>;
		const legacyName = typeof obj.agentName === "string" && obj.agentName.trim() !== ""
			? obj.agentName
			: "codex-agent";
		const id = slugifyId(legacyName);
		const entry = normalizeCodexEntry({
			id,
			projectName: typeof obj.projectName === "string" ? obj.projectName : fallbackProjectName,
			agentName: legacyName,
			description: typeof obj.description === "string" ? obj.description : "",
			"argument-hint": typeof obj["argument-hint"] === "string" ? obj["argument-hint"] : "",
			tools: obj.tools,
			agentKnowledge: obj.agentKnowledge,
		}, fallbackProjectName);
		return toCodexCollection([entry]);
	}

	return null;
}

function buildCodexEntryMarkdown(entry: CodexAgentEntry): string
{
	const toolsLine = entry.tools.length > 0
		? `tools: [${entry.tools.map((t) => `'${t}'`).join(", ")}]`
		: "# tools: [] # optional tool preference hints";
	const knowledgeLines = entry.agentKnowledge.length > 0
		? [
			"To get context for your task, you MUST read the following files:",
			"",
			...entry.agentKnowledge.map(formatGithubKnowledgeEntry),
		]
		: [];

	return [
		`${CODEX_ENTRY_BEGIN_PREFIX}${entry.id} -->`,
		"---",
		`name: ${entry.agentName}`,
		`description: ${entry.description}`,
		`argument-hint: ${entry["argument-hint"]}`,
		toolsLine,
		"---",
		"",
		...knowledgeLines,
		CODEX_ENTRY_END,
		"",
	].join("\n");
}

function buildCodexCollectionMarkdown(collection: CodexAgentCollection): string
{
	const ordered = [...collection.agents].sort((a, b) => a.agentName.localeCompare(b.agentName));
	return [
		CODEX_GENERATED_MARKER,
		"<!-- CXC-CODEX-FORMAT: v2 -->",
		"<!-- One AGENTS.md file can contain multiple logical Codex agents. -->",
		"",
		...ordered.map(buildCodexEntryMarkdown),
	].join("\n");
}

function parseCodexCollectionFromMarkdown(content: string, sourceName: string): CodexAgentCollection | null
{
	const lines = content.split("\n");
	const entries: CodexAgentEntry[] = [];
	const usedIds = new Set<string>();

	for (let i = 0; i < lines.length; i++)
	{
		const raw = lines[i]?.trim() ?? "";
		if (!raw.startsWith(CODEX_ENTRY_BEGIN_PREFIX) || !raw.endsWith("-->")) continue;

		const idRaw = raw.slice(CODEX_ENTRY_BEGIN_PREFIX.length, -"-->".length).trim();
		const id = makeUniqueCodexEntryId(usedIds, idRaw || "codex-agent");

		const blockLines: string[] = [];
		for (let j = i + 1; j < lines.length; j++)
		{
			const line = lines[j] ?? "";
			if (line.trim() === CODEX_ENTRY_END)
			{
				i = j;
				break;
			}
			blockLines.push(line);
		}

		const block = blockLines.join("\n");
		const reconstructed = reconstructAgentInput(block, sourceName, `/tmp/${CODEX_AGENTS_FILE}`);
		entries.push({
			id,
			projectName: reconstructed.projectName,
			agentName: reconstructed.agentName,
			description: reconstructed.description,
			"argument-hint": reconstructed["argument-hint"],
			tools: normalizeList(reconstructed.tools),
			agentKnowledge: normalizeList(reconstructed.agentKnowledge),
			platform: "codex",
			updatedAt: new Date().toISOString(),
		});
	}

	if (entries.length > 0)
	{
		return toCodexCollection(entries);
	}

	// Legacy single-frontmatter Codex markdown fallback.
	const legacy = reconstructAgentInput(content, sourceName, `/tmp/${CODEX_AGENTS_FILE}`);
	if (!legacy.agentName && !legacy.description && legacy.agentKnowledge.length === 0)
	{
		return null;
	}
	return toCodexCollection([{
		id: slugifyId(legacy.agentName || "codex-agent"),
		projectName: legacy.projectName,
		agentName: legacy.agentName,
		description: legacy.description,
		"argument-hint": legacy["argument-hint"],
		tools: normalizeList(legacy.tools),
		agentKnowledge: normalizeList(legacy.agentKnowledge),
		platform: "codex",
		updatedAt: new Date().toISOString(),
	}]);
}

function loadCodexCollection(agentMdPath: string, sourceName: string): CodexAgentCollection
{
	const jsonPath = toAgentJsonPath(agentMdPath);
	if (existsSync(jsonPath))
	{
		try
		{
			const parsed = parseCodexCollectionFromJson(readFileSync(jsonPath, "utf8"), sourceName);
			if (parsed) return parsed;
		} catch
		{
			// fall through to markdown recovery
		}
	}

	if (existsSync(agentMdPath))
	{
		try
		{
			const parsed = parseCodexCollectionFromMarkdown(readFileSync(agentMdPath, "utf8"), sourceName);
			if (parsed) return parsed;
		} catch
		{
			// fall through to empty collection
		}
	}

	return toCodexCollection([]);
}

/**
 * Recursively collects all file paths under a directory.
 * Skips .git, node_modules, and other hidden directories (except .github and .claude).
 */
function collectFiles(dir: string): string[]
{
	const results: string[] = [];
	if (!existsSync(dir)) return results;

	let entries: string[];
	try
	{
		entries = readdirSync(dir);
	} catch
	{
		return results;
	}

	for (const entry of entries)
	{
		// Skip hidden dirs except .github and .claude
		if (entry.startsWith(".") && !ALLOWED_HIDDEN_DIRS.has(entry)) continue;
		if (SKIP_DIRS.has(entry)) continue;

		const fullPath = join(dir, entry);
		let stat;
		try
		{
			stat = statSync(fullPath);
		} catch
		{
			continue;
		}

		if (stat.isDirectory())
		{
			results.push(...collectFiles(fullPath));
		} else if (stat.isFile())
		{
			results.push(fullPath);
		}
	}

	return results;
}

/**
 * Reads the first 1000 characters of a file as an excerpt.
 * Returns an empty string if the file cannot be read.
 */
function readExcerpt(filePath: string): string
{
	try
	{
		const content = readFileSync(filePath, "utf8");
		return content.slice(0, 1000);
	} catch
	{
		return "";
	}
}

/** Returns true when file path is a GitHub .agent.md file. */
function isAgentMdPath(filePath: string): boolean
{
	return filePath.toLowerCase().endsWith(".agent.md");
}

/** Returns true when file path is a Claude Code sub-agent .md (lives inside .claude/agents/). */
function isClaudeAgentMdPath(filePath: string): boolean
{
	const normalized = filePath.replace(/\\/g, "/");
	return normalized.includes("/.claude/agents/") && normalized.toLowerCase().endsWith(".md") && !normalized.toLowerCase().endsWith(".agent.md");
}

/** Returns true when file path is a Codex AGENTS.md file. */
function isCodexAgentsMdPath(filePath: string): boolean
{
	const normalized = filePath.replace(/\\/g, "/");
	return normalized.toLowerCase().endsWith(`/${CODEX_AGENTS_FILE.toLowerCase()}`);
}

/** Returns true when file path is a Codex AGENTS.override.md file. */
function isCodexOverrideMdPath(filePath: string): boolean
{
	const normalized = filePath.replace(/\\/g, "/");
	return normalized.toLowerCase().endsWith(`/${CODEX_AGENTS_OVERRIDE_FILE.toLowerCase()}`);
}

/** Returns true when file path is any supported agent definition artifact. */
function isAnyAgentDefinitionPath(filePath: string): boolean
{
	return isAgentMdPath(filePath) || isClaudeAgentMdPath(filePath) || isCodexAgentsMdPath(filePath) || isCodexOverrideMdPath(filePath);
}

/**
 * Derives the companion JSON file path from an agent file path.
 * GitHub (.agent.md) → .agent.json
 * Claude (.md)       → .json
 */
function toAgentJsonPath(agentMdPath: string): string
{
	if (isCodexAgentsMdPath(agentMdPath))
	{
		return join(dirname(agentMdPath), CODEX_AGENTS_JSON_FILE);
	}
	if (isCodexOverrideMdPath(agentMdPath))
	{
		return join(dirname(agentMdPath), "AGENTS.override.json");
	}
	if (agentMdPath.toLowerCase().endsWith(".agent.md"))
	{
		return `${agentMdPath.slice(0, -".agent.md".length)}.agent.json`;
	}
	return `${agentMdPath.slice(0, -".md".length)}.json`;
}

/** Returns filename stem for a .agent.md (GitHub) or .md (Claude) agent path. */
function getAgentNameFromPath(agentMdPath: string): string
{
	if (isCodexAgentsMdPath(agentMdPath)) return "codex-agents";
	if (isCodexOverrideMdPath(agentMdPath)) return "codex-agents-override";

	const normalized = agentMdPath.replace(/\\/g, "/");
	const fileName = normalized.split("/").pop() ?? normalized;
	if (fileName.endsWith(".agent.md")) return fileName.slice(0, -".agent.md".length);
	if (fileName.endsWith(".md")) return fileName.slice(0, -".md".length);
	return fileName;
}

type FrontmatterBounds = { start: number; end: number };

/**
 * Finds YAML frontmatter bounds, allowing optional leading HTML comments/blank lines
 * (used by generated Codex AGENTS.md files).
 */
function getFrontmatterBounds(lines: string[]): FrontmatterBounds | null
{
	let start = -1;
	for (let i = 0; i < lines.length; i++)
	{
		const line = lines[i]?.trim() ?? "";
		if (line === "---")
		{
			start = i;
			break;
		}
		if (line === "" || line.startsWith("<!--")) continue;
		break;
	}
	if (start < 0) return null;

	for (let i = start + 1; i < lines.length; i++)
	{
		if ((lines[i]?.trim() ?? "") === "---")
		{
			return { start, end: i };
		}
	}
	return null;
}

/** Parses frontmatter key/value pairs from a markdown file. */
function parseFrontmatter(content: string): Record<string, string>
{
	const result: Record<string, string> = {};
	const lines = content.split("\n");
	const bounds = getFrontmatterBounds(lines);
	if (!bounds) return result;

	for (let i = bounds.start + 1; i < bounds.end; i++)
	{
		const line = lines[i]?.trim() ?? "";
		if (line.startsWith("#")) continue;

		const colonIdx = line.indexOf(":");
		if (colonIdx <= 0) continue;

		const key = line.slice(0, colonIdx).trim();
		const value = line.slice(colonIdx + 1).trim();
		result[key] = value;
	}

	return result;
}

/** Parses tools from frontmatter. Commented tools line means no tools are set. */
function parseToolsFromFrontmatter(content: string): string[]
{
	const lines = content.split("\n");
	const bounds = getFrontmatterBounds(lines);
	if (!bounds) return [];

	for (let i = bounds.start + 1; i < bounds.end; i++)
	{
		const line = lines[i]?.trim() ?? "";

		if (/^#\s*tools\s*:/.test(line))
		{
			return [];
		}

		const match = line.match(/^tools\s*:\s*\[(.*)\]\s*$/);
		if (match)
		{
			const raw = match[1].trim();
			if (!raw) return [];
			return raw
				.split(",")
				.map((item) => item.trim().replace(/^['\"]|['\"]$/g, ""))
				.filter(Boolean);
		}
	}

	return [];
}

/** Extracts markdown link targets from the body (after frontmatter). */
function parseKnowledgeLinks(content: string): string[]
{
	const lines = content.split("\n");
	const links: string[] = [];
	const bounds = getFrontmatterBounds(lines);
	const startIdx = bounds ? bounds.end + 1 : 0;

	for (let i = startIdx; i < lines.length; i++)
	{
		const line = lines[i] ?? "";
		const matches = line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g);
		for (const match of matches)
		{
			if (match[1]) links.push(match[1].trim());
		}
	}

	return links;
}

/** Reconstructs CreateAgentInput from a legacy agent file without companion JSON. */
function reconstructAgentInput(content: string, sourceName: string, agentMdPath: string): CreateAgentInput
{
	const frontmatter = parseFrontmatter(content);
	const parsedName = frontmatter["name"]?.trim();
	const platform: "github" | "claude" | "codex" = isCodexAgentsMdPath(agentMdPath) || isCodexOverrideMdPath(agentMdPath)
		? "codex"
		: isClaudeAgentMdPath(agentMdPath) ? "claude" : "github";

	return {
		projectName: sourceName,
		agentName: parsedName || getAgentNameFromPath(agentMdPath),
		description: frontmatter["description"]?.trim() ?? "",
		"argument-hint": frontmatter["argument-hint"]?.trim() ?? "",
		tools: parseToolsFromFrontmatter(content),
		agentKnowledge: parseKnowledgeLinks(content),
		platform,
	};
}

/**
 * Resolves the Claude agent output directory for a data source.
 * Uses `claudeAgentPath` from config when present; otherwise derives it by
 * going two levels up from `agentPath` (e.g. .github/agents → project root)
 * and appending .claude/agents.
 * @throws Error with status 400 when no path can be resolved.
 */
function resolveClaudeAgentPath(source: DataSourceEntry): string
{
	if (source.claudeAgentPath) return source.claudeAgentPath;
	if (!source.agentPath)
	{
		throw Object.assign(
			new Error(`Data source "${source.name}" has no claudeAgentPath or agentPath configured`),
			{ status: 400 }
		);
	}
	const projectRoot = dirname(dirname(source.agentPath));
	return join(projectRoot, ".claude", "agents");
}

/**
 * Returns all allowed Codex output directories for a source, ordered by
 * precedence for default selection.
 *
 * Order:
 * 1) codexAgentPaths[] entries (when present)
 * 2) codexAgentPath (legacy single path)
 * 3) inferred repo root from agentPath when it points to .github/agents
 * 4) source.path
 */
function resolveCodexAgentPaths(source: DataSourceEntry): string[]
{
	const candidates: string[] = [];
	const seen = new Set<string>();
	const add = (value: string | undefined): void =>
	{
		if (!value) return;
		const trimmed = value.trim();
		if (!trimmed || seen.has(trimmed)) return;
		seen.add(trimmed);
		candidates.push(trimmed);
	};

	if (Array.isArray(source.codexAgentPaths))
	{
		for (const item of source.codexAgentPaths)
		{
			if (typeof item === "string") add(item);
		}
	}
	add(source.codexAgentPath);

	if (source.agentPath && source.agentPath.trim() !== "")
	{
		const normalized = source.agentPath.replace(/\\/g, "/").replace(/\/+$/, "");
		if (/(^|\/)\.github\/agents$/i.test(normalized))
		{
			add(dirname(dirname(source.agentPath)));
		}
	}

	add(source.path);
	return candidates;
}

/**
 * Resolves one Codex output directory from allowed paths and an optional
 * caller-selected directory.
 * @throws Error with status 400 when selectedDirectory is not allowed.
 */
function resolveCodexAgentPath(source: DataSourceEntry, selectedDirectory?: string): string
{
	const allowed = resolveCodexAgentPaths(source);
	if (allowed.length === 0)
	{
		throw Object.assign(new Error(`Data source "${source.name}" has no resolvable Codex output path`), { status: 400 });
	}

	if (selectedDirectory && selectedDirectory.trim() !== "")
	{
		const requested = selectedDirectory.trim();
		if (!allowed.includes(requested))
		{
			throw Object.assign(
				new Error(`codexDirectory must be one of the configured directories for "${source.name}"`),
				{ status: 400 }
			);
		}
		return requested;
	}

	const configuredMany = Array.isArray(source.codexAgentPaths)
		? source.codexAgentPaths.filter((item): item is string => typeof item === "string" && item.trim() !== "").length
		: 0;
	if (configuredMany > 1)
	{
		throw Object.assign(
			new Error(`codexDirectory is required for "${source.name}" because multiple codexAgentPaths are configured`),
			{ status: 400 }
		);
	}

	return allowed[0]!;
}

/**
 * Creates a timestamped backup when a user-managed AGENTS.md is about to be overwritten.
 * Files already generated by CXC (marker present) are overwritten in-place without backup.
 */
function backupUnmanagedCodexAgentsFileIfNeeded(agentPath: string): void
{
	if (!existsSync(agentPath)) return;
	const currentContent = readFileSync(agentPath, "utf8");
	if (currentContent.includes(CODEX_GENERATED_MARKER)) return;

	const stamp = formatBackupTimestamp(new Date());
	let backupPath = `${agentPath}.bak.${stamp}`;
	let suffix = 1;
	while (existsSync(backupPath))
	{
		backupPath = `${agentPath}.bak.${stamp}-${suffix}`;
		suffix++;
	}

	writeFileSync(backupPath, currentContent, "utf8");
	console.log(`[AgentBuilder] Backed up unmanaged Codex AGENTS file: ${backupPath}`);
}

/**
 * Writes file content through a same-directory temporary file, then replaces the
 * destination via rename to reduce partial-write risk for collection updates.
 */
function writeFileAtomic(targetPath: string, content: string): void
{
	const tempPath = `${targetPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
	writeFileSync(tempPath, content, "utf8");
	try
	{
		renameSync(tempPath, targetPath);
	} catch (error)
	{
		try { unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
		throw error;
	}
}

/** Builds the content of a Claude Code .md sub-agent file. */
/**
 * Returns true when an agentKnowledge entry looks like a file path rather than
 * plain text instruction. A file path contains "/" but no whitespace.
 * Plain-text instructions always have spaces even when they include "/" (e.g. "easy/medium/hard").
 */
function isFilePath(entry: string): boolean
{
	const normalized = entry.replace(/\\/g, "/");
	return normalized.includes("/") && !/\s/.test(normalized);
}

/**
 * Formats a single knowledge entry for a Claude agent file.
 * File paths → [basename](path) link. Plain text → bare list item.
 */
function formatClaudeKnowledgeEntry(entry: string): string
{
	if (isFilePath(entry))
	{
		const normalized = entry.replace(/\\/g, "/");
		const basename = normalized.split("/").pop() ?? normalized;
		return `- [${basename}](${entry})`;
	}
	return `- ${entry}`;
}

/**
 * Formats a single knowledge entry for a GitHub .agent.md file.
 * File paths → [path](path) link. Plain text → bare list item.
 */
function formatGithubKnowledgeEntry(entry: string): string
{
	return isFilePath(entry) ? `- [${entry}](${entry})` : `- ${entry}`;
}

function buildClaudeAgentContent(input: CreateAgentInput): string
{
	const knowledgeLines = input.agentKnowledge.length > 0
		? [
			"To get context for your task, you MUST read the following files:",
			"",
			...input.agentKnowledge.map(formatClaudeKnowledgeEntry),
		]
		: [];

	return [
		"---",
		`name: ${input.agentName}`,
		`description: ${input.description}`,
		"---",
		"",
		...knowledgeLines,
		"",
	].join("\n");
}

/**
 * Indexes files from dataSources entries with purpose "AgentBuilder" and
 * serves the listing through /api/agent-builder/prepare.
 */
export class AgentBuilder
{
	private indexedFiles: IndexedFile[] = [];
	private sources: DataSourceEntry[] = [];

	constructor(machineConfig: MachineConfig)
	{
		this.sources = this.extractAgentBuilderSources(machineConfig);
	}

	/** Extracts all DataSourceEntry items with purpose "AgentBuilder". */
	private extractAgentBuilderSources(machineConfig: MachineConfig): DataSourceEntry[]
	{
		if (!machineConfig.dataSources) return [];
		const results: DataSourceEntry[] = [];
		for (const entries of Object.values(machineConfig.dataSources))
		{
			for (const entry of entries)
			{
				if (entry.purpose === "AgentBuilder")
				{
					results.push(entry);
				}
			}
		}
		return results;
	}

	/**
	 * Scans all AgentBuilder data source directories and builds the in-memory file index.
	 * Deduplicates by absolute path so repeated entries in cc.json don't cause duplicates.
	 */
	async index(): Promise<void>
	{
		const seen = new Set<string>();
		const indexByPath = new Map<string, number>();
		this.indexedFiles = [];

		for (const source of this.sources)
		{
			// Index content files from path
			const contentFiles = collectFiles(source.path);
			for (const absPath of contentFiles)
			{
				if (seen.has(absPath)) continue;
				seen.add(absPath);

				let stat;
				try { stat = statSync(absPath); } catch { continue; }

				this.indexedFiles.push({
					relativePath: relative(source.path, absPath).replace(/\\/g, "/"),
					absolutePath: absPath,
					size: stat.size,
					lastModified: stat.mtime.toISOString(),
					sourceName: source.name,
					sourceType: source.type,
					origin: "content",
					excerpt: readExcerpt(absPath),
				});
				indexByPath.set(absPath, this.indexedFiles.length - 1);
			}

			// Index agent files from agentPath, claudeAgentPath, and codexAgentPath/source.path.
			const agentDirs = new Set<string>();
			if (source.agentPath && source.agentPath.trim() !== "") agentDirs.add(source.agentPath);
			try
			{
				const claudeDir = resolveClaudeAgentPath(source);
				if (claudeDir.trim() !== "") agentDirs.add(claudeDir);
			} catch { /* no claudeAgentPath resolvable — skip */ }
			for (const codexDir of resolveCodexAgentPaths(source))
			{
				if (codexDir.trim() !== "") agentDirs.add(codexDir);
			}

			for (const dir of agentDirs)
			{
				const agentFiles = collectFiles(dir);
				for (const absPath of agentFiles)
				{
					if (!isAnyAgentDefinitionPath(absPath)) continue;

					if (seen.has(absPath))
					{
						// If this file was seen as content first, promote it to agent origin.
						const idx = indexByPath.get(absPath);
						if (idx !== undefined)
						{
							const existing = this.indexedFiles[idx];
							if (existing && existing.origin !== "agent")
							{
								let stat;
								try { stat = statSync(absPath); } catch { continue; }

								this.indexedFiles[idx] = {
									relativePath: relative(dir, absPath).replace(/\\/g, "/"),
									absolutePath: absPath,
									size: stat.size,
									lastModified: stat.mtime.toISOString(),
									sourceName: source.name,
									sourceType: source.type,
									origin: "agent",
									excerpt: readExcerpt(absPath),
								};
							}
						}
						continue;
					}
					seen.add(absPath);

					let stat;
					try { stat = statSync(absPath); } catch { continue; }

					this.indexedFiles.push({
						relativePath: relative(dir, absPath).replace(/\\/g, "/"),
						absolutePath: absPath,
						size: stat.size,
						lastModified: stat.mtime.toISOString(),
						sourceName: source.name,
						sourceType: source.type,
						origin: "agent",
						excerpt: readExcerpt(absPath),
					});
					indexByPath.set(absPath, this.indexedFiles.length - 1);
				}
			}
		}

		console.log(`[AgentBuilder] Indexed ${this.indexedFiles.length} files across ${this.sources.length} sources`);
	}

	/**
	 * Refreshes only agent entries in the in-memory index by rescanning agent directories.
	 * This keeps /list and /get-agent in sync with external file changes (create/delete/edit)
	 * without re-indexing all content sources.
	 */
	private refreshAgentEntriesFromDisk(): void
	{
		const nonAgentEntries = this.indexedFiles.filter((f) => f.origin !== "agent");
		const agentEntriesByPath = new Map<string, IndexedFile>();
		const uniqueAgentDirs = new Map<string, DataSourceEntry>();

		for (const source of this.sources)
		{
			const dirs: string[] = [];
			if (source.agentPath && source.agentPath.trim() !== "")
			{
				dirs.push(source.agentPath);
			}

			try
			{
				const claudeDir = resolveClaudeAgentPath(source);
				if (claudeDir.trim() !== "")
				{
					dirs.push(claudeDir);
				}
			} catch
			{
				// No resolvable Claude agent path for this source.
			}

			for (const codexDir of resolveCodexAgentPaths(source))
			{
				if (codexDir.trim() !== "") dirs.push(codexDir);
			}

			for (const dir of dirs)
			{
				if (!uniqueAgentDirs.has(dir))
				{
					uniqueAgentDirs.set(dir, source);
				}
			}
		}

		for (const [dir, source] of uniqueAgentDirs)
		{
			const files = collectFiles(dir);
			for (const absPath of files)
			{
				if (!isAnyAgentDefinitionPath(absPath)) continue;
				if (agentEntriesByPath.has(absPath)) continue;

				let stat;
				try { stat = statSync(absPath); } catch { continue; }

				agentEntriesByPath.set(absPath, {
					relativePath: relative(dir, absPath).replace(/\\/g, "/"),
					absolutePath: absPath,
					size: stat.size,
					lastModified: stat.mtime.toISOString(),
					sourceName: source.name,
					sourceType: source.type,
					origin: "agent",
					excerpt: readExcerpt(absPath),
				});
			}
		}

		this.indexedFiles = [...nonAgentEntries, ...agentEntriesByPath.values()];
	}

	/**
	 * Creates a new agent file in the appropriate directory for the requested platform.
	 * - "github": writes .agent.md + .agent.json to source.agentPath
	 * - "claude": writes .md + .agent.json to the resolved claudeAgentPath
	 * - "codex": writes AGENTS.md + AGENTS.json to the resolved codexAgentPath (or source.path fallback)
	 * Both files are immediately added to the in-memory index.
	 * @throws Error with a `status` property (400 | 404) for client-facing errors.
	 */
	create(input: CreateAgentInput): CreateAgentResponse
	{
		const { projectName, agentName, description, tools, agentKnowledge, platform, codexDirectory } = input;
		const argumentHint = input["argument-hint"];

		// Find the first AgentBuilder source matching projectName
		const source = this.sources.find((s) => s.name === projectName);
		if (!source)
		{
			throw Object.assign(
				new Error(`No AgentBuilder source found for project "${projectName}"`),
				{ status: 404 }
			);
		}

		// Resolve output directory and file names based on platform
		let targetDir: string;
		let mdFileName: string;
		if (platform === "codex")
		{
			targetDir = resolveCodexAgentPath(source, codexDirectory);
			mdFileName = CODEX_AGENTS_FILE;
		}
		else if (platform === "claude")
		{
			targetDir = resolveClaudeAgentPath(source);
			mdFileName = `${agentName}.md`;
		}
		else
		{
			if (!source.agentPath)
			{
				throw Object.assign(
					new Error(`Data source "${projectName}" has no agentPath configured`),
					{ status: 400 }
				);
			}
			targetDir = source.agentPath;
			mdFileName = `${agentName}.agent.md`;
		}

		mkdirSync(targetDir, { recursive: true });

		const mdAbsPath = join(targetDir, mdFileName);
		// Companion JSON naming mirrors the agent file: AGENTS.md → AGENTS.json, .agent.md → .agent.json, .md → .json
		const jsonFileName = platform === "codex"
			? CODEX_AGENTS_JSON_FILE
			: platform === "claude" ? `${agentName}.json` : `${agentName}.agent.json`;
		const jsonAbsPath = join(targetDir, jsonFileName);
		let createdCodexEntryId: string | undefined;

		// Build and write agent artifacts.
		let content: string;
		if (platform === "claude")
		{
			content = buildClaudeAgentContent(input);
			writeFileSync(mdAbsPath, content, "utf8");

			const jsonPayload: CreateAgentInput = {
				projectName,
				agentName,
				description,
				"argument-hint": argumentHint,
				tools: tools ?? [],
				agentKnowledge,
				platform,
			};
			writeFileSync(jsonAbsPath, JSON.stringify(jsonPayload, null, 2), "utf8");
		}
		else if (platform === "github")
		{
			const toolsLine = tools && tools.length > 0
				? `tools: [${tools.map((t) => `'${t}'`).join(", ")}]`
				: `# tools: [] # specify the tools this agent can use. If not set, all enabled tools are allowed.`;

			const knowledgeLines = agentKnowledge.length > 0
				? [
					"To get context for your task, you MUST read the following files:",
					"",
					...agentKnowledge.map(formatGithubKnowledgeEntry),
				]
				: [];

			content = [
				"---",
				`name: ${agentName}`,
				`description: ${description}`,
				`argument-hint: ${argumentHint}`,
				toolsLine,
				"---",
				"",
				...knowledgeLines,
				"",
			].join("\n");
			writeFileSync(mdAbsPath, content, "utf8");

			const jsonPayload: CreateAgentInput = {
				projectName,
				agentName,
				description,
				"argument-hint": argumentHint,
				tools: tools ?? [],
				agentKnowledge,
				platform,
			};
			writeFileSync(jsonAbsPath, JSON.stringify(jsonPayload, null, 2), "utf8");
		}
		else
		{
			backupUnmanagedCodexAgentsFileIfNeeded(mdAbsPath);

			const existingCollection = loadCodexCollection(mdAbsPath, source.name);
			const existingIds = new Set(existingCollection.agents.map((a) => a.id));

			let nextId: string;
			if (input.codexEntryId && input.codexEntryId.trim() !== "")
			{
				nextId = slugifyId(input.codexEntryId);
			}
			else
			{
				const existingByName = existingCollection.agents.find((a) => a.agentName === agentName);
				nextId = existingByName ? existingByName.id : makeUniqueCodexEntryId(existingIds, agentName);
			}

			const nextEntry = toCodexEntryFromInput({
				...input,
				projectName: source.name,
				platform: "codex",
			}, nextId);
			createdCodexEntryId = nextEntry.id;

			const upsertIndex = existingCollection.agents.findIndex((a) => a.id === nextEntry.id);
			const nextAgents = [...existingCollection.agents];
			if (upsertIndex >= 0)
			{
				nextAgents[upsertIndex] = nextEntry;
			}
			else
			{
				nextAgents.push(nextEntry);
			}

			const normalizedIds = new Set<string>();
			const normalizedAgents = nextAgents.map((agent) =>
			{
				const id = makeUniqueCodexEntryId(normalizedIds, agent.id || agent.agentName);
				return normalizeCodexEntry({ ...agent, id }, source.name);
			});

			const collection = toCodexCollection(normalizedAgents);
			content = buildCodexCollectionMarkdown(collection);
			writeFileAtomic(mdAbsPath, content);
			writeFileAtomic(jsonAbsPath, JSON.stringify(collection, null, 2));
		}

		// Immediately update the in-memory index (remove stale entries first to handle overwrites).
		// .json companion files are intentionally excluded from the index (internal to CXC).
		this.indexedFiles = this.indexedFiles.filter(
			(f) => f.absolutePath !== mdAbsPath && f.absolutePath !== jsonAbsPath
		);

		let mdStat;
		try { mdStat = statSync(mdAbsPath); } catch { mdStat = null; }

		this.indexedFiles.push({
			relativePath: mdFileName,
			absolutePath: mdAbsPath,
			size: mdStat?.size ?? content.length,
			lastModified: mdStat?.mtime.toISOString() ?? new Date().toISOString(),
			sourceName: source.name,
			sourceType: source.type,
			origin: "agent",
			excerpt: content.slice(0, 1000),
		});

		console.log(`[AgentBuilder] Created ${platform} agent files: ${mdAbsPath}, ${jsonAbsPath}`);
		return { created: true, path: mdAbsPath, agentName, codexEntryId: createdCodexEntryId };
	}

	/** Returns all agent entries consolidated by name across platforms (GitHub, Claude, Codex). */
	list(): AgentListResponse
	{
		this.refreshAgentEntriesFromDisk();

		const mdEntries = this.indexedFiles.filter((f) => f.origin === "agent" && isAnyAgentDefinitionPath(f.absolutePath));

		// Step 1: Build flat intermediate list with per-entry platform info + content fingerprint.
		type FlatEntry = {
			name: string;
			platform: "github" | "claude" | "codex";
			path: string;
			codexEntryId?: string;
			codexDirectory?: string;
			dataLength: number;
			description: string;
			hint: string;
			excerpt: string;
			contentFingerprint: string;
		};
		const flat: FlatEntry[] = [];

		for (const entry of mdEntries)
		{
			if (isCodexAgentsMdPath(entry.absolutePath) || isCodexOverrideMdPath(entry.absolutePath))
			{
				const codexCollection = loadCodexCollection(entry.absolutePath, entry.sourceName);
				if (codexCollection.agents.length > 0)
				{
					for (const codexEntry of codexCollection.agents)
					{
						flat.push({
							name: codexEntry.agentName || codexEntry.id,
							platform: "codex",
							path: entry.absolutePath,
							codexEntryId: codexEntry.id,
							codexDirectory: dirname(entry.absolutePath),
							dataLength: entry.size,
							description: codexEntry.description,
							hint: codexEntry["argument-hint"],
							excerpt: entry.excerpt,
							contentFingerprint: JSON.stringify({
								d: codexEntry.description,
								h: codexEntry["argument-hint"],
								k: codexEntry.agentKnowledge ?? [],
								t: codexEntry.tools ?? [],
							}),
						});
					}
					continue;
				}
			}

			const jsonPath = toAgentJsonPath(entry.absolutePath);
			let description = "";
			let hint = "";
			let fingerprint = "";

			if (existsSync(jsonPath))
			{
				try
				{
					const raw = readFileSync(jsonPath, "utf8");
					const parsed = JSON.parse(raw) as Record<string, unknown>;
					description = typeof parsed.description === "string" ? parsed.description : "";
					hint = typeof parsed["argument-hint"] === "string" ? parsed["argument-hint"] : "";
					const knowledge = Array.isArray(parsed.agentKnowledge) ? parsed.agentKnowledge : [];
					const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
					fingerprint = JSON.stringify({ d: description, h: hint, k: knowledge, t: tools });
				} catch
				{
					// Fall through to frontmatter parsing.
				}
			}

			if (!description && !hint)
			{
				try
				{
					const content = readFileSync(entry.absolutePath, "utf8");
					const frontmatter = parseFrontmatter(content);
					description = frontmatter["description"] ?? "";
					hint = frontmatter["argument-hint"] ?? "";
				} catch
				{
					// Keep defaults when unreadable.
				}
			}

			if (!fingerprint)
			{
				fingerprint = JSON.stringify({ d: description, h: hint, size: entry.size });
			}

			flat.push({
				name: getAgentNameFromPath(entry.absolutePath),
				platform: isClaudeAgentMdPath(entry.absolutePath) ? "claude" : "github",
				path: entry.absolutePath,
				dataLength: entry.size,
				description,
				hint,
				excerpt: entry.excerpt,
				contentFingerprint: fingerprint,
			});
		}

		// Step 2: Group by agent name and consolidate across platforms.
		const grouped = new Map<string, FlatEntry[]>();
		for (const fe of flat)
		{
			const existing = grouped.get(fe.name);
			if (existing) existing.push(fe);
			else grouped.set(fe.name, [fe]);
		}

		const agents: AgentListEntry[] = [];
		for (const [name, entries] of grouped)
		{
			// Pick primary: the platform variant with the biggest dataLength.
			entries.sort((a, b) => b.dataLength - a.dataLength);
			const primary = entries[0];

			// Detect content divergence: if any fingerprint differs from the primary's.
			const contentDiverged = entries.length > 1 &&
				entries.some((e) => e.contentFingerprint !== primary.contentFingerprint);

			const platforms: AgentListPlatformEntry[] = entries.map((e) => ({
				platform: e.platform,
				path: e.path,
				...(e.codexEntryId ? { codexEntryId: e.codexEntryId } : {}),
				...(e.codexDirectory ? { codexDirectory: e.codexDirectory } : {}),
				dataLength: e.dataLength,
			}));

			agents.push({
				name,
				path: primary.path,
				...(primary.codexEntryId ? { codexEntryId: primary.codexEntryId } : {}),
				...(primary.codexDirectory ? { codexDirectory: primary.codexDirectory } : {}),
				platform: primary.platform,
				platforms,
				contentDiverged,
				description: primary.description,
				hint: primary.hint,
				excerpt: primary.excerpt,
			});
		}

		agents.sort((a, b) => a.name.localeCompare(b.name));
		return { totalAgents: agents.length, agents };
	}

	/** Returns one structured agent definition by absolute path (.agent.md for GitHub, .md for Claude, AGENTS*.md for Codex). */
	getAgent(agentPath: string, codexEntryId?: string): GetAgentResponse
	{
		this.refreshAgentEntriesFromDisk();

		if (!agentPath || !isAnyAgentDefinitionPath(agentPath))
		{
			throw Object.assign(new Error("path must point to a .agent.md (GitHub), .claude/agents/*.md (Claude), or AGENTS*.md (Codex) file"), { status: 400 });
		}

		const indexed = this.indexedFiles.find(
			(f) => f.origin === "agent" && f.absolutePath === agentPath &&
				isAnyAgentDefinitionPath(f.absolutePath)
		);
		if (!indexed)
		{
			throw Object.assign(new Error(`Agent not found in index: ${agentPath}`), { status: 404 });
		}

		const isCodexPath = isCodexAgentsMdPath(agentPath) || isCodexOverrideMdPath(agentPath);
		if (isCodexPath)
		{
			const jsonPath = toAgentJsonPath(agentPath);
			let collection: CodexAgentCollection | null = null;
			let fromJson = false;

			if (existsSync(jsonPath))
			{
				try
				{
					collection = parseCodexCollectionFromJson(readFileSync(jsonPath, "utf8"), indexed.sourceName);
					fromJson = !!collection;
				} catch
				{
					collection = null;
					fromJson = false;
				}
			}

			if (!collection)
			{
				try
				{
					collection = parseCodexCollectionFromMarkdown(readFileSync(agentPath, "utf8"), indexed.sourceName);
				} catch
				{
					collection = null;
				}
			}

			if (!collection || collection.agents.length === 0)
			{
				throw Object.assign(new Error(`No Codex agents found in ${agentPath}`), { status: 404 });
			}

			const requestedId = codexEntryId && codexEntryId.trim() !== "" ? slugifyId(codexEntryId) : "";
			const selected = requestedId
				? collection.agents.find((entry) => entry.id === requestedId)
				: collection.agents.length === 1 ? collection.agents[0] : null;

			if (!selected && !requestedId && collection.agents.length > 1)
			{
				throw Object.assign(new Error("codexEntryId is required when AGENTS file contains multiple Codex agents"), { status: 400 });
			}
			if (!selected)
			{
				throw Object.assign(new Error(`Codex agent entry not found in ${agentPath}`), { status: 404 });
			}

			const agent: AgentDefinition = {
				projectName: selected.projectName || indexed.sourceName,
				agentName: selected.agentName || selected.id,
				description: selected.description,
				"argument-hint": selected["argument-hint"],
				tools: selected.tools,
				agentKnowledge: selected.agentKnowledge,
				platform: "codex",
				codexEntryId: selected.id,
				codexDirectory: dirname(agentPath),
				fromJson,
			};
			return { agent };
		}

		const jsonPath = toAgentJsonPath(agentPath);
		if (existsSync(jsonPath))
		{
			try
			{
				const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as Record<string, unknown>;
				const tools = Array.isArray(parsed.tools)
					? parsed.tools.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean)
					: [];
				const agentKnowledge = Array.isArray(parsed.agentKnowledge)
					? parsed.agentKnowledge.filter((k): k is string => typeof k === "string").map((k) => k.trim()).filter(Boolean)
					: [];
				const platform: "github" | "claude" | "codex" =
					parsed.platform === "codex" ? "codex"
						: parsed.platform === "claude" ? "claude"
							: parsed.platform === "github" ? "github"
								: isCodexAgentsMdPath(agentPath) || isCodexOverrideMdPath(agentPath) ? "codex"
									: isClaudeAgentMdPath(agentPath) ? "claude" : "github";

				const agent: AgentDefinition = {
					projectName: typeof parsed.projectName === "string" && parsed.projectName.trim() !== "" ? parsed.projectName : indexed.sourceName,
					agentName: typeof parsed.agentName === "string" && parsed.agentName.trim() !== "" ? parsed.agentName : getAgentNameFromPath(agentPath),
					description: typeof parsed.description === "string" ? parsed.description : "",
					"argument-hint": typeof parsed["argument-hint"] === "string" ? parsed["argument-hint"] : "",
					tools,
					agentKnowledge,
					platform,
					fromJson: true,
				};

				return { agent };
			} catch
			{
				throw Object.assign(new Error(`Failed to read agent JSON: ${jsonPath}`), { status: 500 });
			}
		}

		try
		{
			const content = readFileSync(agentPath, "utf8");
			const reconstructed = reconstructAgentInput(content, indexed.sourceName, agentPath);
			return {
				agent: {
					...reconstructed,
					fromJson: false,
				},
			};
		} catch
		{
			throw Object.assign(new Error(`Failed to read agent file: ${agentPath}`), { status: 500 });
		}
	}

	/**
	 * Returns the full text content of an indexed file.
	 * Validates that the requested path exists in the in-memory index to prevent
	 * arbitrary file reads (path traversal protection).
	 * @throws Error with status 400 when path is missing, 404 when not indexed, 500 on read failure.
	 */
	getFileContent(absolutePath: string): { relativePath: string; absolutePath: string; content: string; size: number; sourceName: string; sourceType: string }
	{
		if (!absolutePath)
		{
			throw Object.assign(new Error("path query parameter is required"), { status: 400 });
		}

		const indexed = this.indexedFiles.find((f) => f.absolutePath === absolutePath);
		if (!indexed)
		{
			throw Object.assign(new Error(`File not found in index: ${absolutePath}`), { status: 404 });
		}

		try
		{
			const content = readFileSync(absolutePath, "utf8");
			return {
				relativePath: indexed.relativePath,
				absolutePath: indexed.absolutePath,
				content,
				size: indexed.size,
				sourceName: indexed.sourceName,
				sourceType: indexed.sourceType,
			};
		} catch
		{
			throw Object.assign(new Error(`Failed to read file: ${absolutePath}`), { status: 500 });
		}
	}

	/**
	 * Returns the indexed file listing, optionally filtered by source name.
	 * @param filterName - When provided, only files from matching source names are returned.
	 */
	prepare(filterName?: string): PrepareResponse
	{
		const files = filterName
			? this.indexedFiles.filter((f) => f.sourceName === filterName)
			: this.indexedFiles;

		// Build per-source summaries for sources that have at least one matching file
		const sourceMap = new Map<string, PrepareSource>();
		for (const file of files)
		{
			if (!sourceMap.has(file.sourceName))
			{
				// Find the original source entry for path/agentPath metadata
				const sourceEntry = this.sources.find((s) => s.name === file.sourceName);
				sourceMap.set(file.sourceName, {
					name: file.sourceName,
					type: file.sourceType,
					path: sourceEntry?.path ?? "",
					agentPath: sourceEntry?.agentPath,
					codexDirectories: sourceEntry ? resolveCodexAgentPaths(sourceEntry) : [],
					codexDefaultDirectory: sourceEntry ? resolveCodexAgentPath(sourceEntry) : undefined,
					fileCount: 0,
				});
			}
			sourceMap.get(file.sourceName)!.fileCount++;
		}

		return {
			totalFiles: files.length,
			sources: Array.from(sourceMap.values()),
			files,
		};
	}

	/**
	 * Creates or overwrites a template JSON file in {storagePath}/.settings/agent-templates/.
	 * @param storagePath - Root storage directory from CCSettings.storage.
	 * @param input - Template definition to persist.
	 */
	addTemplate(storagePath: string, input: CreateTemplateInput): CreateTemplateResponse
	{
		const templatesDir = join(storagePath, ".settings", "agent-templates");
		mkdirSync(templatesDir, { recursive: true });

		const fileName = `${input.templateName}.json`;
		const filePath = join(templatesDir, fileName);

		const payload: CreateTemplateInput = {
			templateName: input.templateName,
			description: input.description,
			"argument-hint": input["argument-hint"],
			tools: input.tools ?? [],
			agentKnowledge: input.agentKnowledge,
		};

		writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
		console.log(`[AgentBuilder] Template written: ${filePath}`);

		return { created: true, templateName: input.templateName, path: filePath };
	}

	/**
	 * Returns all templates from {storagePath}/.settings/agent-templates/.
	 * Malformed JSON files are skipped with a console warning.
	 * @param storagePath - Root storage directory from CCSettings.storage.
	 */
	listTemplates(storagePath: string): TemplateListResponse
	{
		const templatesDir = join(storagePath, ".settings", "agent-templates");

		if (!existsSync(templatesDir))
		{
			return { totalTemplates: 0, templates: [] };
		}

		let fileNames: string[];
		try
		{
			fileNames = readdirSync(templatesDir).filter((f) => f.toLowerCase().endsWith(".json"));
		} catch
		{
			return { totalTemplates: 0, templates: [] };
		}

		const templates: CreateTemplateInput[] = [];
		for (const fileName of fileNames)
		{
			const filePath = join(templatesDir, fileName);
			try
			{
				const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
				if (typeof parsed.templateName !== "string" || !parsed.templateName)
				{
					console.warn(`[AgentBuilder] Skipping malformed template (missing templateName): ${filePath}`);
					continue;
				}
				templates.push({
					templateName: parsed.templateName,
					description: typeof parsed.description === "string" ? parsed.description : "",
					"argument-hint": typeof parsed["argument-hint"] === "string" ? parsed["argument-hint"] : "",
					tools: Array.isArray(parsed.tools)
						? parsed.tools.filter((t): t is string => typeof t === "string")
						: [],
					agentKnowledge: Array.isArray(parsed.agentKnowledge)
						? parsed.agentKnowledge.filter((k): k is string => typeof k === "string")
						: [],
				});
			} catch
			{
				console.warn(`[AgentBuilder] Skipping malformed template JSON: ${filePath}`);
			}
		}

		templates.sort((a, b) => a.templateName.localeCompare(b.templateName));
		return { totalTemplates: templates.length, templates };
	}
}
