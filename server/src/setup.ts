#!/usr/bin/env bun
/**
 * ContextCore Interactive Setup Script
 *
 * Discovers IDE chat data on the host machine and generates a machine config
 * block in cc.json. Run with: bun run setup
 */

import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, copyFileSync } from "fs";
import { join, basename, resolve as resolvePath } from "path";
import { hostname } from "os";
import * as readline from "readline";
import chalk from "chalk";

// ─── Types ────────────────────────────────────────────────────────────────────

type Platform = "win32" | "darwin" | "linux";

type ProjectMappingRule = {
	path: string;
	newProjectName: string;
};

type GenericProjectMappingRule = {
	path: string;
	rule: "byFirstDir";
};

type DataSourceEntry = {
	path: string;
	agentPath?: string;
	name: string;
	type: string;
	purpose: string;
};

type DataSources = Record<string, DataSourceEntry[]>;

type MachineConfig = {
	machine: string;
	harnesses: Record<string, unknown>;
	dataSources?: DataSources;
};

type KiroDiscovery = {
	paths: string[];
	rules: ProjectMappingRule[];
};

type ContextCoreConfig = {
	storage: string;
	machines: MachineConfig[];
};

// ─── Readline Wrapper ─────────────────────────────────────────────────────────

let rl: readline.Interface;

function initReadline(): void
{
	rl = readline.createInterface({ input: process.stdin, output: process.stdout });
}

function closeReadline(): void
{
	rl.close();
}

/** Ask a free-text question. Returns the trimmed answer, or defaultValue if blank. */
async function promptUser(question: string, defaultValue = ""): Promise<string>
{
	const displayDefault = defaultValue !== "" ? chalk.dim(` [${defaultValue}]`) : "";
	const prompt = `${chalk.cyan("?")} ${question}${displayDefault}: `;
	return new Promise((resolve) =>
	{
		try
		{
			rl.question(prompt, (answer) =>
			{
				const trimmed = answer.trim();
				resolve(trimmed !== "" ? trimmed : defaultValue);
			});
		}
		catch
		{
			resolve(defaultValue);
		}
	});
}

/** Ask a yes/no question. Pressing Enter accepts the default. */
async function promptYesNo(question: string, defaultYes = true): Promise<boolean>
{
	const hint = chalk.dim(defaultYes ? " (Y/n)" : " (y/N)");
	return new Promise((resolve) =>
	{
		try
		{
			rl.question(`${chalk.cyan("?")} ${question}${hint}: `, (answer) =>
			{
				const lower = answer.trim().toLowerCase();
				if (lower === "") resolve(defaultYes);
				else resolve(lower.startsWith("y"));
			});
		}
		catch
		{
			resolve(defaultYes);
		}
	});
}

// ─── Version Notice ───────────────────────────────────────────────────────────

function printVersionNotice(): void
{
	const lines = [
		"  IMPORTANT — Version 1.1  (Claude Code · Cursor · VS Code · Kiro · OpenCode)  ",
		"                                                                                  ",
		"  This setup wizard configures the five currently supported harnesses.            ",
		"  Support for additional agentic environments is planned for future releases:     ",
		"                                                                                  ",
		"    • JetBrains AI Assistant                                                      ",
		"    • Other agentic IDEs and CLI tools                                            ",
		"                                                                                  ",
		"  If your Harness/Assistant is not listed, get in touch                           ",
		"  and let's code an adapter for it.                                               ",
	];
	const width = Math.max(...lines.map((l) => l.length));
	console.log(chalk.cyan("┌" + "─".repeat(width + 2) + "┐"));
	for (const line of lines)
	{
		console.log(chalk.cyan("│ ") + chalk.cyan(line.padEnd(width)) + chalk.cyan(" │"));
	}
	console.log(chalk.cyan("└" + "─".repeat(width + 2) + "┘"));
	console.log();
}

// ─── Platform & Identity Detection ───────────────────────────────────────────

function detectPlatform(): Platform
{
	const p = process.platform;
	if (p === "win32" || p === "darwin" || p === "linux") return p;
	return "linux";
}

function detectMachineName(): string
{
	if (process.platform === "win32" && process.env.COMPUTERNAME)
		return process.env.COMPUTERNAME;
	return hostname();
}

function detectUsername(): string
{
	return process.env.USERNAME ?? process.env.USER ?? process.env.LOGNAME ?? "";
}

// ─── Path Utilities ───────────────────────────────────────────────────────────

/** Ensure a directory path ends with the platform separator. */
function withTrailingSlash(p: string): string
{
	const slash = process.platform === "win32" ? "\\" : "/";
	return p.endsWith("\\") || p.endsWith("/") ? p : p + slash;
}

function formatBytes(bytes: number): string
{
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Strip trailing slash and return the last path segment. */
function dirName(p: string): string
{
	return basename(p.replace(/[\\/]$/, ""));
}

// ─── Claude Code ──────────────────────────────────────────────────────────────

function getClaudeCodeBasePath(username: string, platform: Platform): string
{
	switch (platform)
	{
		case "win32": return `C:\\Users\\${username}\\.claude\\projects\\`;
		case "darwin": return `/Users/${username}/.claude/projects/`;
		case "linux": return `/home/${username}/.claude/projects/`;
	}
}

function scanJsonlProjects(basePath: string): Array<{ path: string; count: number }>
{
	try
	{
		return readdirSync(basePath, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.flatMap((e) =>
			{
				const dirPath = join(basePath, e.name);
				try
				{
					const count = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl")).length;
					return count > 0 ? [{ path: withTrailingSlash(dirPath), count }] : [];
				}
				catch { return []; }
			});
	}
	catch { return []; }
}

async function discoverClaudeCode(username: string, platform: Platform): Promise<string[]>
{
	console.log(chalk.bold("\n──── Claude Code ────"));
	try
	{
		const basePath = getClaudeCodeBasePath(username, platform);
		console.log(chalk.dim(`Scanning: ${basePath}`));

		if (!existsSync(basePath))
		{
			console.log(chalk.yellow("  ⚠ Directory not found — skipping"));
			console.log(chalk.dim("    Tip: Install Claude Code or check ~/.claude/projects/"));
			return [];
		}

		const projects = scanJsonlProjects(basePath);
		if (projects.length === 0)
		{
			console.log(chalk.yellow("  ⚠ No project directories with .jsonl files found"));
			console.log(chalk.dim("    Start a conversation in Claude Code first, then re-run setup"));
			return [];
		}

		const plural = projects.length === 1;
		console.log(chalk.green(`Found ${projects.length} project ${plural ? "directory" : "directories"} with .jsonl files:`));
		for (const p of projects)
		{
			console.log(`  ${chalk.green("✓")} ${dirName(p.path)}  ${chalk.dim(`(${p.count} session${p.count === 1 ? "" : "s"})`)}`);
		}

		const include = await promptYesNo(`Include all ${projects.length} path${plural ? "" : "s"}?`);
		if (!include)
		{
			console.log(chalk.dim("  Skipping Claude Code"));
			return [];
		}
		return projects.map((p) => p.path);
	}
	catch (err: unknown)
	{
		console.log(chalk.red(`  ✗ Error scanning Claude Code: ${err instanceof Error ? err.message : String(err)}`));
		console.log(chalk.dim("    Add ClaudeCode paths manually to cc.json later"));
		return [];
	}
}

// ─── Cursor ───────────────────────────────────────────────────────────────────

function getCursorDbPath(username: string, platform: Platform): string
{
	switch (platform)
	{
		case "win32": return `C:\\Users\\${username}\\AppData\\Roaming\\Cursor\\User\\globalStorage\\state.vscdb`;
		case "darwin": return `/Users/${username}/Library/Application Support/Cursor/User/globalStorage/state.vscdb`;
		case "linux": return `/home/${username}/.config/Cursor/User/globalStorage/state.vscdb`;
	}
}

async function discoverCursor(username: string, platform: Platform): Promise<string | null>
{
	console.log(chalk.bold("\n──── Cursor ────"));
	try
	{
		const dbPath = getCursorDbPath(username, platform);
		console.log(chalk.dim(`Scanning: ${dbPath}`));

		if (!existsSync(dbPath))
		{
			console.log(chalk.yellow("  ⚠ state.vscdb not found — skipping"));
			console.log(chalk.dim("    Tip: Install Cursor, open it at least once, then re-run setup"));
			return null;
		}

		const size = statSync(dbPath).size;
		console.log(`  ${chalk.green("✓")} state.vscdb found ${chalk.dim(`(${formatBytes(size)})`)}`);

		const include = await promptYesNo("Include Cursor?");
		return include ? dbPath : null;
	}
	catch (err: unknown)
	{
		console.log(chalk.red(`  ✗ Error scanning Cursor: ${err instanceof Error ? err.message : String(err)}`));
		console.log(chalk.dim("    Add the Cursor path manually to cc.json later"));
		return null;
	}
}

// ─── VS Code ──────────────────────────────────────────────────────────────────

function getVSCodeStoragePath(username: string, platform: Platform): string
{
	switch (platform)
	{
		case "win32": return `C:\\Users\\${username}\\AppData\\Roaming\\Code\\User\\workspaceStorage\\`;
		case "darwin": return `/Users/${username}/Library/Application Support/Code/User/workspaceStorage/`;
		case "linux": return `/home/${username}/.config/Code/User/workspaceStorage/`;
	}
}

function scanChatSessionDirs(basePath: string): string[]
{
	try
	{
		return readdirSync(basePath, { withFileTypes: true })
			.filter((e) => e.isDirectory() && existsSync(join(basePath, e.name, "chatSessions")))
			.map((e) => withTrailingSlash(join(basePath, e.name)));
	}
	catch { return []; }
}

async function discoverVSCode(username: string, platform: Platform): Promise<string[]>
{
	console.log(chalk.bold("\n──── VS Code ────"));
	try
	{
		const basePath = getVSCodeStoragePath(username, platform);
		console.log(chalk.dim(`Scanning: ${basePath}`));

		if (!existsSync(basePath))
		{
			console.log(chalk.yellow("  ⚠ workspaceStorage directory not found — skipping"));
			console.log(chalk.dim("    Tip: Install VS Code with GitHub Copilot and open at least one workspace"));
			return [];
		}

		const dirs = scanChatSessionDirs(basePath);
		if (dirs.length === 0)
		{
			console.log(chalk.yellow("  ⚠ No workspace directories with chatSessions/ found"));
			console.log(chalk.dim("    Tip: Open Copilot Chat in at least one VS Code workspace first"));
			return [];
		}

		const plural = dirs.length === 1;
		console.log(chalk.green(`Found ${dirs.length} workspace ${plural ? "directory" : "directories"} with chatSessions/:`));
		for (const d of dirs)
		{
			console.log(`  ${chalk.green("✓")} ${chalk.dim(dirName(d))}`);
		}

		const include = await promptYesNo(`Include all ${dirs.length} path${plural ? "" : "s"}?`);
		if (!include)
		{
			console.log(chalk.dim("  Skipping VS Code"));
			return [];
		}
		return dirs;
	}
	catch (err: unknown)
	{
		console.log(chalk.red(`  ✗ Error scanning VS Code: ${err instanceof Error ? err.message : String(err)}`));
		console.log(chalk.dim("    Add VSCode paths manually to cc.json later"));
		return [];
	}
}

// ─── Kiro ─────────────────────────────────────────────────────────────────────

const KIRO_HEX_HASH = /^[0-9a-f]{32}$/;

function getKiroAgentPaths(username: string, platform: Platform): string[]
{
	switch (platform)
	{
		case "win32": return [`C:\\Users\\${username}\\AppData\\Roaming\\Kiro\\User\\globalStorage\\kiro.kiroagent\\`];
		case "darwin": return [`/Users/${username}/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/`];
		case "linux": return [
			`/home/${username}/.kiro-server/data/User/globalStorage/kiro.kiroagent/`,
			`/home/${username}/.config/Kiro/User/globalStorage/kiro.kiroagent/`,
		];
	}
}

function scanKiroHexDirs(basePath: string): string[]
{
	try
	{
		return readdirSync(basePath, { withFileTypes: true })
			.filter((e) => e.isDirectory() && KIRO_HEX_HASH.test(e.name))
			.map((e) => withTrailingSlash(join(basePath, e.name)));
	}
	catch { return []; }
}

function printKiroMappingAdvice(basePath: string): void
{
	console.log(chalk.bold("\n  Kiro mapping advice"));
	console.log(chalk.dim("  Kiro session folders are hash-like IDs, so project names should be mapped explicitly."));
	console.log(chalk.dim(`  1) Open: ${basePath}`));
	console.log(chalk.dim("  2) Identify which hash folder belongs to which project"));
	console.log(chalk.dim("  3) Add rules under Kiro.projectMappingRules in cc.json"));
	console.log(chalk.dim("  Example:"));
	console.log(chalk.dim(`    "Kiro": {`));
	console.log(chalk.dim(`      "paths": [`));
	console.log(chalk.dim("        \"C:\\\\Users\\\\<user>\\\\AppData\\\\Roaming\\\\Kiro\\\\User\\\\globalStorage\\\\kiro.kiroagent\\\\1582a63a37f5cbc148e58da75716b816\\\\\""));
	console.log(chalk.dim("      ],"));
	console.log(chalk.dim(`      "projectMappingRules": [`));
	console.log(chalk.dim("        { \"path\": \"1582a63a37f5cbc148e58da75716b816\", \"newProjectName\": \"AXON\" },"));
	console.log(chalk.dim("        { \"path\": \"87db373831ef373c73f787d1470d35a6\", \"newProjectName\": \"Chooser\" }"));
	console.log(chalk.dim("      ]"));
	console.log(chalk.dim("    }"));
}

/**
 * Minimal .chat parser — reads-only, no pipeline logic, no storage writes.
 * Returns up to 3 truncated user messages for display purposes.
 */
function browseKiroUserMessages(dirPath: string): string[]
{
	const messages: string[] = [];
	try
	{
		const files = readdirSync(dirPath).filter((f) => f.endsWith(".chat"));
		for (const file of files)
		{
			if (messages.length >= 3) break;
			try
			{
				const raw = readFileSync(join(dirPath, file), "utf-8");
				const parsed = JSON.parse(raw) as {
					chat?: Array<{ role?: string; content?: string }>;
				};
				const chat = Array.isArray(parsed.chat) ? parsed.chat : [];

				// Skip system prompt: first human entry containing <identity>
				let startIdx = 0;
				if (
					chat.length > 0 &&
					chat[0].role === "human" &&
					typeof chat[0].content === "string" &&
					chat[0].content.includes("<identity>")
				) startIdx = 1;

				for (let i = startIdx; i < chat.length && messages.length < 3; i++)
				{
					const entry = chat[i];
					if (entry.role === "human" && typeof entry.content === "string" && entry.content.trim())
					{
						const text = entry.content.trim().replace(/\s+/g, " ");
						messages.push(text.length > 120 ? text.slice(0, 120) + "…" : text);
					}
				}
			}
			catch { /* skip malformed files */ }
		}
	}
	catch { /* skip unreadable dirs */ }
	return messages;
}

async function promptKiroMappings(dirs: string[]): Promise<ProjectMappingRule[]>
{
	const rules: ProjectMappingRule[] = [];
	for (const dirPath of dirs)
	{
		const hash = dirName(dirPath);
		console.log(chalk.dim(`\n  Browsing ${hash}...`));

		const messages = browseKiroUserMessages(dirPath);
		if (messages.length === 0)
		{
			console.log(chalk.dim("    No user messages found"));
		}
		else
		{
			console.log("  First user messages:");
			messages.forEach((msg, i) =>
				console.log(`    ${chalk.dim(`${i + 1}.`)} "${msg}"`)
			);
		}

		const projectName = await promptUser(`  Project name for ${chalk.dim(hash)} (blank to skip)`);
		if (projectName.trim())
		{
			rules.push({ path: hash, newProjectName: projectName.trim() });
			console.log(chalk.green(`    ✓ Mapped → ${projectName.trim()}`));
		}
		else
		{
			console.log(chalk.dim("    Skipped"));
		}
	}
	return rules;
}

async function discoverKiro(username: string, platform: Platform): Promise<KiroDiscovery>
{
	console.log(chalk.bold("\n──── Kiro ────"));
	const empty: KiroDiscovery = { paths: [], rules: [] };
	try
	{
		const candidates = getKiroAgentPaths(username, platform);
		let basePath: string | null = null;
		for (const candidate of candidates)
		{
			console.log(chalk.dim(`Scanning: ${candidate}`));
			if (existsSync(candidate))
			{
				basePath = candidate;
				break;
			}
		}

		if (!basePath)
		{
			console.log(chalk.yellow("  ⚠ kiro.kiroagent directory not found — skipping"));
			console.log(chalk.dim("    Tip: Install Kiro IDE and open at least one workspace"));
			return empty;
		}

		const dirs = scanKiroHexDirs(basePath);
		if (dirs.length === 0)
		{
			console.log(chalk.yellow("  ⚠ No session directories (32-char hex hash) found"));
			return empty;
		}

		const plural = dirs.length === 1;
		console.log(chalk.green(`Found ${dirs.length} session ${plural ? "directory" : "directories"} (hex hash):`));
		for (const d of dirs) console.log(`  ${chalk.dim("•")} ${dirName(d)}`);

		const include = await promptYesNo(`Include all ${dirs.length} path${plural ? "" : "s"}?`);
		if (!include)
		{
			console.log(chalk.dim("  Skipping Kiro"));
			return empty;
		}

		printKiroMappingAdvice(basePath);

		const configureRules = await promptYesNo("Configure project mapping rules for Kiro?", false);
		const rules = configureRules ? await promptKiroMappings(dirs) : [];

		return { paths: dirs, rules };
	}
	catch (err: unknown)
	{
		console.log(chalk.red(`  ✗ Error scanning Kiro: ${err instanceof Error ? err.message : String(err)}`));
		console.log(chalk.dim("    Add Kiro paths manually to cc.json later"));
		return empty;
	}
}

// ─── OpenCode ─────────────────────────────────────────────────────────────────

function getOpenCodeStoragePaths(username: string, platform: Platform): string[]
{
	switch (platform)
	{
		case "win32": return [
			`C:\\Users\\${username}\\.local\\share\\opencode\\`,
			`C:\\Users\\${username}\\AppData\\Roaming\\opencode\\`,
		];
		case "darwin": return [`/Users/${username}/.local/share/opencode/`];
		case "linux": return [`/home/${username}/.local/share/opencode/`];
	}
}

async function discoverOpenCode(username: string, platform: Platform): Promise<string | null>
{
	console.log(chalk.bold("\n──── OpenCode ────"));
	try
	{
		const candidates = getOpenCodeStoragePaths(username, platform);
		let dirPath: string | null = null;
		let dbPath: string | null = null;
		for (const candidate of candidates)
		{
			const candidateDb = join(candidate.replace(/[\\/]+$/, ""), "opencode.db");
			console.log(chalk.dim(`Scanning: ${candidateDb}`));
			if (existsSync(candidateDb))
			{
				dirPath = candidate;
				dbPath = candidateDb;
				break;
			}
		}

		if (!dirPath || !dbPath)
		{
			console.log(chalk.yellow("  ⚠ opencode.db not found — skipping"));
			console.log(chalk.dim("    Tip: Install OpenCode, run it at least once, then re-run setup"));
			return null;
		}

		const size = statSync(dbPath).size;
		console.log(`  ${chalk.green("✓")} opencode.db found ${chalk.dim(`(${formatBytes(size)})`)}`);

		const include = await promptYesNo("Include OpenCode?");
		return include ? dirPath : null;
	}
	catch (err: unknown)
	{
		console.log(chalk.red(`  ✗ Error scanning OpenCode: ${err instanceof Error ? err.message : String(err)}`));
		console.log(chalk.dim("    Add the OpenCode path manually to cc.json later"));
		return null;
	}
}

// ─── Generic Project Mapping Rules ────────────────────────────────────────────

async function promptGenericRules(): Promise<GenericProjectMappingRule[]>
{
	console.log(chalk.bold("\n──── Generic Project Mapping Rules ────"));
	console.log(chalk.dim("  Applies to Cursor and Kiro: given a path prefix, use the first"));
	console.log(chalk.dim("  directory after that prefix as the project name (byFirstDir)."));
	console.log(chalk.dim('  Example: path "Codez\\\\Nexus" → extracts first dir after that prefix'));

	const add = await promptYesNo("Add generic rules (byFirstDir)?", false);
	if (!add) return [];

	const rules: GenericProjectMappingRule[] = [];
	let addMore = true;
	while (addMore)
	{
		const path = await promptUser("  Path prefix");
		if (path.trim())
		{
			rules.push({ path: path.trim(), rule: "byFirstDir" });
			console.log(chalk.green(`    ✓ Added: "${path.trim()}"`));
		}
		addMore = await promptYesNo("  Add another?", false);
	}
	return rules;
}

// ─── Data Sources ────────────────────────────────────────────────────────────

async function promptDataSources(): Promise<DataSources>
{
	console.log(chalk.bold("\n──── Data Sources (AgentBuilder) ────"));
	console.log(chalk.dim("  Optionally register an initial data source path for AgentBuilder."));
	console.log(chalk.dim("  Leave blank to keep dataSources empty."));

	const addNow = await promptYesNo("Add an AgentBuilder data source path now?", false);
	if (!addNow) return { "zz-reach2": [] };

	const path = await promptUser("  Data source path (blank to skip)");
	if (!path.trim())
	{
		console.log(chalk.dim("  No path provided — dataSources will remain empty."));
		return { "zz-reach2": [] };
	}

	return {
		"zz-reach2": [
			{
				path: path.trim(),
				agentPath: "",
				name: "",
				type: "",
				purpose: "AgentBuilder",
			},
		],
	};
}

// ─── Config Assembly ──────────────────────────────────────────────────────────

function buildMachineConfig(
	machineName: string,
	claudePaths: string[],
	cursorPath: string | null,
	vscodePaths: string[],
	kiro: KiroDiscovery,
	openCodePath: string | null,
	genericRules: GenericProjectMappingRule[],
	dataSources: DataSources
): MachineConfig
{
	const harnesses: Record<string, unknown> = {};

	if (claudePaths.length > 0)
		harnesses["ClaudeCode"] = { paths: claudePaths };

	if (cursorPath !== null)
		harnesses["Cursor"] = { paths: [cursorPath] };

	if (vscodePaths.length > 0)
		harnesses["VSCode"] = { paths: vscodePaths };

	if (kiro.paths.length > 0)
	{
		const kiroConfig: Record<string, unknown> = { paths: kiro.paths };
		if (kiro.rules.length > 0) kiroConfig["projectMappingRules"] = kiro.rules;
		harnesses["Kiro"] = kiroConfig;
	}

	if (openCodePath !== null)
		harnesses["OpenCode"] = { paths: [openCodePath] };

	if (genericRules.length > 0)
		harnesses["genericProjectMappingRules"] = genericRules;

	return {
		machine: machineName,
		harnesses,
		dataSources,
	};
}

// ─── Storage Dir ──────────────────────────────────────────────────────────────

function ensureStorageDir(storagePath: string): void
{
	try
	{
		if (!existsSync(storagePath))
		{
			mkdirSync(storagePath, { recursive: true });
			console.log(chalk.green(`  ✓ Created: ${storagePath}`));
		}
		else
		{
			console.log(chalk.dim(`  Exists: ${storagePath}`));
		}
	}
	catch (err: unknown)
	{
		console.log(chalk.yellow(`  ⚠ Could not create storage dir: ${err instanceof Error ? err.message : String(err)}`));
		console.log(chalk.dim(`    Create it manually: mkdir "${storagePath}"`));
	}
}

function ensureEnvFile(baseDir: string): void
{
	const envPath = join(baseDir, ".env");
	const envExamplePath = join(baseDir, ".env.example");

	if (existsSync(envPath))
	{
		console.log(chalk.dim(`  Exists: ${envPath}`));
		return;
	}

	if (!existsSync(envExamplePath))
	{
		console.log(chalk.yellow("  ⚠ .env.example not found — skipping .env bootstrap"));
		return;
	}

	try
	{
		copyFileSync(envExamplePath, envPath);
		console.log(chalk.green(`  ✓ Created ${envPath} from .env.example`));
	}
	catch (err: unknown)
	{
		console.log(chalk.yellow(`  ⚠ Could not create .env: ${err instanceof Error ? err.message : String(err)}`));
		console.log(chalk.dim(`    Copy manually: ${envExamplePath} -> ${envPath}`));
	}
}

// ─── cc.json Write ────────────────────────────────────────────────────────────

async function writeConfig(
	machineConfig: MachineConfig,
	storage: string,
	ccJsonPath: string
): Promise<void>
{
	let config: ContextCoreConfig = { storage, machines: [] };

	// Load existing cc.json if present
	if (existsSync(ccJsonPath))
	{
		try
		{
			config = JSON.parse(readFileSync(ccJsonPath, "utf-8")) as ContextCoreConfig;
		}
		catch (err: unknown)
		{
			console.log(chalk.yellow(`  ⚠ Could not parse cc.json: ${err instanceof Error ? err.message : String(err)}`));
			const overwrite = await promptYesNo("  Start fresh with a new cc.json?", false);
			if (!overwrite)
			{
				console.log(chalk.dim("  Aborted. Fix cc.json manually and re-run setup."));
				return;
			}
			config = { storage, machines: [] };
		}
	}

	// Resolve storage field
	if (config.storage && config.storage !== storage)
	{
		console.log(chalk.yellow(`\n  ⚠ Existing cc.json storage: "${config.storage}"`));
		console.log(`     New proposed storage:   "${storage}"`);
		const keepExisting = await promptYesNo("  Keep existing storage path?");
		if (!keepExisting) config.storage = storage;
	}
	else
	{
		config.storage = storage;
	}

	if (!Array.isArray(config.machines)) config.machines = [];

	// Handle duplicate machine name
	const existingIdx = config.machines.findIndex((m) => m.machine === machineConfig.machine);
	if (existingIdx >= 0)
	{
		console.log(chalk.yellow(`\n  ⚠ Machine "${machineConfig.machine}" already exists in cc.json`));
		const replace = await promptYesNo(`  Replace existing config for "${machineConfig.machine}"?`, false);
		if (!replace)
		{
			console.log(chalk.dim("  Keeping existing config. No changes written."));
			return;
		}
		config.machines[existingIdx] = machineConfig;
	}
	else
	{
		config.machines.push(machineConfig);
	}

	try
	{
		writeFileSync(ccJsonPath, JSON.stringify(config, null, "\t"), "utf-8");
		console.log(chalk.green(`  ✓ Written to ${ccJsonPath}`));
	}
	catch (err: unknown)
	{
		console.log(chalk.red(`  ✗ Failed to write cc.json: ${err instanceof Error ? err.message : String(err)}`));
		console.log(chalk.dim("    Check file permissions and try again."));
	}
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void>
{
	initReadline();
	try
	{
		console.log(chalk.bold("\n═══════════════════════════════════════════"));
		console.log(chalk.bold("  ContextCore Setup"));
		console.log(chalk.bold("═══════════════════════════════════════════\n"));

		printVersionNotice();

		// Identity
		const machineName = await promptUser("Machine name", detectMachineName());
		const platform = detectPlatform();
		const username = await promptUser("Username", detectUsername());

		// Storage
		const defaultStorage = resolvePath(join(process.cwd(), "cxc-storage"));
		const storagePath = await promptUser("Storage directory", defaultStorage);

		// cc.json lives next to package.json (server/)
		const ccJsonPath = join(process.cwd(), "cc.json");

		// Harness discovery — each section is fully independent
		const claudePaths = await discoverClaudeCode(username, platform);
		const cursorPath = await discoverCursor(username, platform);
		const vscodePaths = await discoverVSCode(username, platform);
		const kiro = await discoverKiro(username, platform);
		const openCodePath = await discoverOpenCode(username, platform);
		const genericRules = await promptGenericRules();
		const dataSources = await promptDataSources();

		// Assemble
		const machineConfig = buildMachineConfig(
			machineName, claudePaths, cursorPath, vscodePaths, kiro, openCodePath, genericRules, dataSources
		);

		// Preview
		console.log(chalk.bold("\n═══════════════════════════════════════════"));
		console.log(chalk.bold("  Configuration Preview"));
		console.log(chalk.bold("═══════════════════════════════════════════\n"));
		console.log(chalk.dim(JSON.stringify({ storage: storagePath, machines: [machineConfig] }, null, "\t")));

		const proceed = await promptYesNo("\nWrite to cc.json?");
		if (!proceed)
		{
			console.log(chalk.dim("  Aborted. No changes written."));
			return;
		}

		console.log();
		ensureStorageDir(storagePath);
		await writeConfig(machineConfig, storagePath, ccJsonPath);
		ensureEnvFile(process.cwd());

		console.log(chalk.bold("\n✓ Setup complete. You may now run the start script and we wish you will say good things about what happens next :D\n"));
	}
	finally
	{
		closeReadline();
	}
}

main().catch((err) =>
{
	console.error(chalk.red("\nFatal error:"), err);
	process.exit(1);
});
