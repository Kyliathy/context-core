import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
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
	/** Target platform for the generated agent file. "github" writes .agent.md; "claude" writes a Claude Code sub-agent .md. */
	platform: "github" | "claude";
}

/** Response shape for POST /api/agent-builder/create. */
export interface CreateAgentResponse
{
	created: boolean;
	path: string;
	agentName: string;
}

/** Summary entry for GET /api/agent-builder/list. */
export interface AgentListEntry
{
	/** Agent name (filename stem, e.g. cxc-ui-worker). */
	name: string;
	/** Absolute path to the .agent.md file. */
	path: string;
	/** Agent description from JSON or frontmatter. */
	description: string;
	/** Argument hint from JSON or frontmatter. */
	hint: string;
	/** First 1000 characters of .agent.md content. */
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

/**
 * Derives the companion JSON file path from an agent file path.
 * GitHub (.agent.md) → .agent.json
 * Claude (.md)       → .json
 */
function toAgentJsonPath(agentMdPath: string): string
{
	if (agentMdPath.toLowerCase().endsWith(".agent.md"))
	{
		return `${agentMdPath.slice(0, -".agent.md".length)}.agent.json`;
	}
	return `${agentMdPath.slice(0, -".md".length)}.json`;
}

/** Returns filename stem for a .agent.md (GitHub) or .md (Claude) agent path. */
function getAgentNameFromPath(agentMdPath: string): string
{
	const normalized = agentMdPath.replace(/\\/g, "/");
	const fileName = normalized.split("/").pop() ?? normalized;
	if (fileName.endsWith(".agent.md")) return fileName.slice(0, -".agent.md".length);
	if (fileName.endsWith(".md")) return fileName.slice(0, -".md".length);
	return fileName;
}

/** Parses frontmatter key/value pairs from a markdown file. */
function parseFrontmatter(content: string): Record<string, string>
{
	const result: Record<string, string> = {};
	const lines = content.split("\n");
	if (lines[0]?.trim() !== "---") return result;

	for (let i = 1; i < lines.length; i++)
	{
		const line = lines[i]?.trim() ?? "";
		if (line === "---") break;
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
	if (lines[0]?.trim() !== "---") return [];

	for (let i = 1; i < lines.length; i++)
	{
		const line = lines[i]?.trim() ?? "";
		if (line === "---") break;

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
	let fenceCount = 0;

	for (const line of lines)
	{
		if (line.trim() === "---")
		{
			fenceCount++;
			continue;
		}
		if (fenceCount < 2) continue;

		const match = line.match(/\[[^\]]*\]\(([^)]+)\)/);
		if (match && match[1])
		{
			links.push(match[1].trim());
		}
	}

	return links;
}

/** Reconstructs CreateAgentInput from a legacy agent file without companion JSON. */
function reconstructAgentInput(content: string, sourceName: string, agentMdPath: string): CreateAgentInput
{
	const frontmatter = parseFrontmatter(content);
	const parsedName = frontmatter["name"]?.trim();
	const platform: "github" | "claude" = isClaudeAgentMdPath(agentMdPath) ? "claude" : "github";

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
			}

			// Index agent files from agentPath and claudeAgentPath (if present)
			const agentDirs: { dir: string }[] = [];
			if (source.agentPath) agentDirs.push({ dir: source.agentPath });
			try
			{
				const claudeDir = resolveClaudeAgentPath(source);
				if (claudeDir !== source.agentPath) agentDirs.push({ dir: claudeDir });
			} catch { /* no claudeAgentPath resolvable — skip */ }

			for (const { dir } of agentDirs)
			{
				const agentFiles = collectFiles(dir);
				for (const absPath of agentFiles)
				{
					// Skip .json files — CXC-internal companion files, not agent knowledge
					if (absPath.toLowerCase().endsWith(".json")) continue;
					if (seen.has(absPath)) continue;
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
				if (absPath.toLowerCase().endsWith(".json")) continue;
				if (!isAgentMdPath(absPath) && !isClaudeAgentMdPath(absPath)) continue;
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
	 * Both files are immediately added to the in-memory index.
	 * @throws Error with a `status` property (400 | 404) for client-facing errors.
	 */
	create(input: CreateAgentInput): CreateAgentResponse
	{
		const { projectName, agentName, description, tools, agentKnowledge, platform } = input;
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
		if (platform === "claude")
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
		// Companion JSON naming mirrors the agent file: .agent.md → .agent.json, .md → .json
		const jsonFileName = platform === "claude" ? `${agentName}.json` : `${agentName}.agent.json`;
		const jsonAbsPath = join(targetDir, jsonFileName);

		// Build agent file content
		let content: string;
		if (platform === "claude")
		{
			content = buildClaudeAgentContent(input);
		}
		else
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
		}

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
		return { created: true, path: mdAbsPath, agentName };
	}

	/** Returns all agent entries (.agent.md for GitHub, .md for Claude) in a compact list response. */
	list(): AgentListResponse
	{
		this.refreshAgentEntriesFromDisk();

		const mdEntries = this.indexedFiles.filter((f) => f.origin === "agent" && (isAgentMdPath(f.absolutePath) || isClaudeAgentMdPath(f.absolutePath)));
		const agentsByPath = new Map<string, AgentListEntry>();

		for (const entry of mdEntries)
		{
			const jsonPath = toAgentJsonPath(entry.absolutePath);
			let description = "";
			let hint = "";

			if (existsSync(jsonPath))
			{
				try
				{
					const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as Record<string, unknown>;
					description = typeof parsed.description === "string" ? parsed.description : "";
					hint = typeof parsed["argument-hint"] === "string" ? parsed["argument-hint"] : "";
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

			agentsByPath.set(entry.absolutePath, {
				name: getAgentNameFromPath(entry.absolutePath),
				path: entry.absolutePath,
				description,
				hint,
				excerpt: entry.excerpt,
			});
		}

		const agents = Array.from(agentsByPath.values());

		agents.sort((a, b) => a.name.localeCompare(b.name));
		return { totalAgents: agents.length, agents };
	}

	/** Returns one structured agent definition by absolute path (.agent.md for GitHub, .md for Claude). */
	getAgent(agentPath: string): GetAgentResponse
	{
		this.refreshAgentEntriesFromDisk();

		if (!agentPath || (!isAgentMdPath(agentPath) && !isClaudeAgentMdPath(agentPath)))
		{
			throw Object.assign(new Error("path must point to a .agent.md (GitHub) or .claude/agents/*.md (Claude) file"), { status: 400 });
		}

		const indexed = this.indexedFiles.find(
			(f) => f.origin === "agent" && f.absolutePath === agentPath &&
				(isAgentMdPath(f.absolutePath) || isClaudeAgentMdPath(f.absolutePath))
		);
		if (!indexed)
		{
			throw Object.assign(new Error(`Agent not found in index: ${agentPath}`), { status: 404 });
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
				const platform: "github" | "claude" =
					parsed.platform === "claude" ? "claude"
						: parsed.platform === "github" ? "github"
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
