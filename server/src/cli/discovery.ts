import { existsSync, readdirSync, statSync } from "fs";
import { basename, join } from "path";

export type Platform = "win32" | "darwin" | "linux";

export type HarnessScannerContext = {
	username: string;
	platform: Platform;
};

export type HarnessScannerCandidate = {
	harness: string;
	path: string;
	evidence: string;
	exists: boolean;
	meta?: Record<string, unknown>;
};

/**
 * Extension contract for scanner modules.
 * - getCandidates: returns filesystem roots/targets to inspect.
 * - scan: converts discovered evidence into flat candidate rows.
 * - describe: formats one candidate for table/preview UX.
 */
export interface HarnessScanner
{
	harness: string;
	getCandidates(context: HarnessScannerContext): string[];
	scan(context: HarnessScannerContext): HarnessScannerCandidate[];
	describe(candidate: HarnessScannerCandidate): string;
}

export const KIRO_HEX_HASH = /^[0-9a-f]{32}$/i;

export function detectPlatform(): Platform
{
	const p = process.platform;
	if (p === "win32" || p === "darwin" || p === "linux")
	{
		return p;
	}
	return "linux";
}

export function detectUsername(): string
{
	return process.env.USERNAME ?? process.env.USER ?? process.env.LOGNAME ?? "";
}

export function withTrailingSlash(p: string): string
{
	const slash = process.platform === "win32" ? "\\" : "/";
	return p.endsWith("\\") || p.endsWith("/") ? p : p + slash;
}

export function formatBytes(bytes: number): string
{
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function dirName(p: string): string
{
	return basename(p.replace(/[\\/]$/, ""));
}

export function getClaudeCodeBasePath(username: string, platform: Platform): string
{
	switch (platform)
	{
		case "win32": return `C:\\Users\\${username}\\.claude\\projects\\`;
		case "darwin": return `/Users/${username}/.claude/projects/`;
		case "linux": return `/home/${username}/.claude/projects/`;
	}
}

export function getCursorDbPath(username: string, platform: Platform): string
{
	switch (platform)
	{
		case "win32": return `C:\\Users\\${username}\\AppData\\Roaming\\Cursor\\User\\globalStorage\\state.vscdb`;
		case "darwin": return `/Users/${username}/Library/Application Support/Cursor/User/globalStorage/state.vscdb`;
		case "linux": return `/home/${username}/.config/Cursor/User/globalStorage/state.vscdb`;
	}
}

export function getVSCodeStoragePath(username: string, platform: Platform): string
{
	switch (platform)
	{
		case "win32": return `C:\\Users\\${username}\\AppData\\Roaming\\Code\\User\\workspaceStorage\\`;
		case "darwin": return `/Users/${username}/Library/Application Support/Code/User/workspaceStorage/`;
		case "linux": return `/home/${username}/.config/Code/User/workspaceStorage/`;
	}
}

export function getKiroAgentPaths(username: string, platform: Platform): string[]
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

export function getOpenCodeStoragePaths(username: string, platform: Platform): string[]
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

export function getCodexSessionPaths(username: string, platform: Platform): string[]
{
	switch (platform)
	{
		case "win32": return [`C:\\Users\\${username}\\.codex\\sessions\\`];
		case "darwin": return [`/Users/${username}/.codex/sessions/`];
		case "linux": return [`/home/${username}/.codex/sessions/`];
	}
}

export function scanJsonlProjects(basePath: string): Array<{ path: string; count: number }>
{
	try
	{
		return readdirSync(basePath, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.flatMap((entry) =>
			{
				const dirPath = join(basePath, entry.name);
				try
				{
					const count = readdirSync(dirPath).filter((name) => name.endsWith(".jsonl")).length;
					return count > 0 ? [{ path: withTrailingSlash(dirPath), count }] : [];
				}
				catch
				{
					return [];
				}
			});
	}
	catch
	{
		return [];
	}
}

export function scanChatSessionDirs(basePath: string): string[]
{
	try
	{
		return readdirSync(basePath, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && existsSync(join(basePath, entry.name, "chatSessions")))
			.map((entry) => withTrailingSlash(join(basePath, entry.name)));
	}
	catch
	{
		return [];
	}
}

export function scanKiroHexDirs(basePath: string): string[]
{
	try
	{
		return readdirSync(basePath, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && KIRO_HEX_HASH.test(entry.name))
			.map((entry) => withTrailingSlash(join(basePath, entry.name)));
	}
	catch
	{
		return [];
	}
}

export function countCodexRolloutFiles(basePath: string): number
{
	if (!existsSync(basePath))
	{
		return 0;
	}

	let count = 0;
	const stack: string[] = [basePath];
	while (stack.length > 0)
	{
		const current = stack.pop()!;
		const entries = (() =>
		{
			try
			{
				return readdirSync(current, {
					withFileTypes: true,
					encoding: "utf8",
				});
			}
			catch
			{
				return null;
			}
		})();
		if (!entries)
		{
			continue;
		}

		for (const entry of entries)
		{
			const next = join(current, entry.name);
			if (entry.isDirectory())
			{
				stack.push(next);
			}
			else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name))
			{
				count += 1;
			}
		}
	}
	return count;
}

const claudeScanner: HarnessScanner = {
	harness: "ClaudeCode",
	getCandidates(context)
	{
		return [getClaudeCodeBasePath(context.username, context.platform)];
	},
	scan(context)
	{
		const basePath = getClaudeCodeBasePath(context.username, context.platform);
		if (!existsSync(basePath))
		{
			return [];
		}
		return scanJsonlProjects(basePath).map((project) => ({
			harness: "ClaudeCode",
			path: project.path,
			evidence: `${project.count} session${project.count === 1 ? "" : "s"} (.jsonl)`,
			exists: true,
			meta: { count: project.count, sourceBase: basePath },
		}));
	},
	describe(candidate)
	{
		return candidate.evidence;
	},
};

const cursorScanner: HarnessScanner = {
	harness: "Cursor",
	getCandidates(context)
	{
		return [getCursorDbPath(context.username, context.platform)];
	},
	scan(context)
	{
		const dbPath = getCursorDbPath(context.username, context.platform);
		if (!existsSync(dbPath))
		{
			return [];
		}
		let size = 0;
		try
		{
			size = statSync(dbPath).size;
		}
		catch
		{
			size = 0;
		}
		return [{
			harness: "Cursor",
			path: dbPath,
			evidence: `state.vscdb (${formatBytes(size)})`,
			exists: true,
			meta: { size },
		}];
	},
	describe(candidate)
	{
		return candidate.evidence;
	},
};

const vscodeScanner: HarnessScanner = {
	harness: "VSCode",
	getCandidates(context)
	{
		return [getVSCodeStoragePath(context.username, context.platform)];
	},
	scan(context)
	{
		const basePath = getVSCodeStoragePath(context.username, context.platform);
		if (!existsSync(basePath))
		{
			return [];
		}
		return scanChatSessionDirs(basePath).map((path) => ({
			harness: "VSCode",
			path,
			evidence: `chatSessions/ in ${dirName(path)}`,
			exists: true,
			meta: { sourceBase: basePath },
		}));
	},
	describe(candidate)
	{
		return candidate.evidence;
	},
};

const kiroScanner: HarnessScanner = {
	harness: "Kiro",
	getCandidates(context)
	{
		return getKiroAgentPaths(context.username, context.platform);
	},
	scan(context)
	{
		const baseCandidates = getKiroAgentPaths(context.username, context.platform);
		const results: HarnessScannerCandidate[] = [];
		for (const basePath of baseCandidates)
		{
			if (!existsSync(basePath))
			{
				continue;
			}
			for (const path of scanKiroHexDirs(basePath))
			{
				results.push({
					harness: "Kiro",
					path,
					evidence: `hash workspace (${dirName(path)})`,
					exists: true,
					meta: { sourceBase: basePath },
				});
			}
		}
		return results;
	},
	describe(candidate)
	{
		return candidate.evidence;
	},
};

const openCodeScanner: HarnessScanner = {
	harness: "OpenCode",
	getCandidates(context)
	{
		return getOpenCodeStoragePaths(context.username, context.platform);
	},
	scan(context)
	{
		const results: HarnessScannerCandidate[] = [];
		for (const dirPath of getOpenCodeStoragePaths(context.username, context.platform))
		{
			const dbPath = join(dirPath.replace(/[\\/]+$/, ""), "opencode.db");
			if (!existsSync(dbPath))
			{
				continue;
			}
			let size = 0;
			try
			{
				size = statSync(dbPath).size;
			}
			catch
			{
				size = 0;
			}
			results.push({
				harness: "OpenCode",
				path: dirPath,
				evidence: `opencode.db (${formatBytes(size)})`,
				exists: true,
				meta: { dbPath, size },
			});
		}
		return results;
	},
	describe(candidate)
	{
		return candidate.evidence;
	},
};

const codexScanner: HarnessScanner = {
	harness: "Codex",
	getCandidates(context)
	{
		return getCodexSessionPaths(context.username, context.platform);
	},
	scan(context)
	{
		const results: HarnessScannerCandidate[] = [];
		for (const sessionsPath of getCodexSessionPaths(context.username, context.platform))
		{
			const rolloutCount = countCodexRolloutFiles(sessionsPath);
			if (rolloutCount <= 0)
			{
				continue;
			}
			results.push({
				harness: "Codex",
				path: sessionsPath,
				evidence: `${rolloutCount} rollout file${rolloutCount === 1 ? "" : "s"}`,
				exists: true,
				meta: { rolloutCount },
			});
		}
		return results;
	},
	describe(candidate)
	{
		return candidate.evidence;
	},
};

export const DEFAULT_HARNESS_SCANNERS: HarnessScanner[] = [
	claudeScanner,
	cursorScanner,
	vscodeScanner,
	kiroScanner,
	openCodeScanner,
	codexScanner,
];

export function scanHarnessCandidates(
	context: HarnessScannerContext,
	scanners: HarnessScanner[] = DEFAULT_HARNESS_SCANNERS
): HarnessScannerCandidate[]
{
	const candidates: HarnessScannerCandidate[] = [];
	for (const scanner of scanners)
	{
		for (const candidate of scanner.scan(context))
		{
			candidates.push(candidate);
		}
	}
	return candidates;
}
