/**
 * CLI harness path discovery scanners.
 *
 * Architecture: server/zz-reach2/architecture/archi-context-core-level0.md
 * Logging audit: server/zz-reach2/upgrades/2026-06/r2wl-winston-logging.md (T58 — no runtime logging)
 */

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

/**
 * Detects host state used by detectPlatform.
 * @returns Result produced by detectPlatform.
 */
export function detectPlatform(): Platform
{
	const p = process.platform;
	// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.

	if (p === "win32" || p === "darwin" || p === "linux")
	{
		return p;
	}
	return "linux";
}

/**
 * Detects host state used by detectUsername.
 * @returns Result produced by detectUsername.
 */
export function detectUsername(): string
{
	return process.env.USERNAME ?? process.env.USER ?? process.env.LOGNAME ?? "";
}

/**
 * Handles withTrailingSlash behavior for this CXC module.
 * @param p - Value consumed by withTrailingSlash.
 * @returns Result produced by withTrailingSlash.
 */
export function withTrailingSlash(p: string): string
{
	const slash = process.platform === "win32" ? "\\" : "/";
	return p.endsWith("\\") || p.endsWith("/") ? p : p + slash;
}

/**
 * Formats data for formatBytes.
 * @param bytes - Value consumed by formatBytes.
 * @returns Result produced by formatBytes.
 */
export function formatBytes(bytes: number): string
{
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Handles dirName behavior for this CXC module.
 * @param p - Value consumed by dirName.
 * @returns Result produced by dirName.
 */
export function dirName(p: string): string
{
	return basename(p.replace(/[\\/]$/, ""));
}

/**
 * Returns the value managed by getClaudeCodeBasePath.
 * @param username - Value consumed by getClaudeCodeBasePath.
 * @param platform - Value consumed by getClaudeCodeBasePath.
 * @returns Result produced by getClaudeCodeBasePath.
 */
export function getClaudeCodeBasePath(username: string, platform: Platform): string
{
	switch (platform)
	{
		case "win32": return `C:\\Users\\${username}\\.claude\\projects\\`;
		case "darwin": return `/Users/${username}/.claude/projects/`;
		case "linux": return `/home/${username}/.claude/projects/`;
	}
}

/**
 * Returns the value managed by getCursorDbPath.
 * @param username - Value consumed by getCursorDbPath.
 * @param platform - Value consumed by getCursorDbPath.
 * @returns Result produced by getCursorDbPath.
 */
export function getCursorDbPath(username: string, platform: Platform): string
{
	switch (platform)
	{
		case "win32": return `C:\\Users\\${username}\\AppData\\Roaming\\Cursor\\User\\globalStorage\\state.vscdb`;
		case "darwin": return `/Users/${username}/Library/Application Support/Cursor/User/globalStorage/state.vscdb`;
		case "linux": return `/home/${username}/.config/Cursor/User/globalStorage/state.vscdb`;
	}
}

/**
 * Returns the value managed by getVSCodeStoragePath.
 * @param username - Value consumed by getVSCodeStoragePath.
 * @param platform - Value consumed by getVSCodeStoragePath.
 * @returns Result produced by getVSCodeStoragePath.
 */
export function getVSCodeStoragePath(username: string, platform: Platform): string
{
	switch (platform)
	{
		case "win32": return `C:\\Users\\${username}\\AppData\\Roaming\\Code\\User\\workspaceStorage\\`;
		case "darwin": return `/Users/${username}/Library/Application Support/Code/User/workspaceStorage/`;
		case "linux": return `/home/${username}/.config/Code/User/workspaceStorage/`;
	}
}

/**
 * Returns the value managed by getKiroAgentPaths.
 * @param username - Value consumed by getKiroAgentPaths.
 * @param platform - Value consumed by getKiroAgentPaths.
 * @returns Result produced by getKiroAgentPaths.
 */
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

/**
 * Returns the value managed by getOpenCodeStoragePaths.
 * @param username - Value consumed by getOpenCodeStoragePaths.
 * @param platform - Value consumed by getOpenCodeStoragePaths.
 * @returns Result produced by getOpenCodeStoragePaths.
 */
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

/**
 * Returns the value managed by getCodexSessionPaths.
 * @param username - Value consumed by getCodexSessionPaths.
 * @param platform - Value consumed by getCodexSessionPaths.
 * @returns Result produced by getCodexSessionPaths.
 */
export function getCodexSessionPaths(username: string, platform: Platform): string[]
{
	switch (platform)
	{
		case "win32": return [`C:\\Users\\${username}\\.codex\\sessions\\`];
		case "darwin": return [`/Users/${username}/.codex/sessions/`];
		case "linux": return [`/home/${username}/.codex/sessions/`];
	}
}

/**
 * Handles scanJsonlProjects behavior for this CXC module.
 * @param basePath - Path used by scanJsonlProjects to locate the relevant CXC resource.
 * @returns Result produced by scanJsonlProjects.
 */
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

/**
 * Handles scanChatSessionDirs behavior for this CXC module.
 * @param basePath - Path used by scanChatSessionDirs to locate the relevant CXC resource.
 * @returns Result produced by scanChatSessionDirs.
 */
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

/**
 * Handles scanKiroHexDirs behavior for this CXC module.
 * @param basePath - Path used by scanKiroHexDirs to locate the relevant CXC resource.
 * @returns Result produced by scanKiroHexDirs.
 */
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

/**
 * Handles countCodexRolloutFiles behavior for this CXC module.
 * @param basePath - Path used by countCodexRolloutFiles to locate the relevant CXC resource.
 * @returns Result produced by countCodexRolloutFiles.
 */
export function countCodexRolloutFiles(basePath: string): number
{
	if (!existsSync(basePath))
	{
		return 0;
	}

	let count = 0;
	const stack: string[] = [basePath];
	// Business logic: this iteration walks every relevant item so operator configuration flows reflects the complete source set instead of a partial snapshot.

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
		}		// Business logic: this iteration walks every relevant item so operator configuration flows reflects the complete source set instead of a partial snapshot.


		for (const entry of entries)
		{
			const next = join(current, entry.name);
			if (entry.isDirectory())
			{
				stack.push(next);
			}
			else			// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting operator configuration flows from partial or invalid state.
 if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name))
			{
				count += 1;
			}
		}
	}
	return count;
}

const claudeScanner: HarnessScanner = {
	harness: "ClaudeCode",
	/**
	 * Returns the value managed by getCandidates.
	 * @param context - Value consumed by getCandidates.
	 * @returns Result produced by getCandidates.
	 */
	getCandidates(context)
	{
		return [getClaudeCodeBasePath(context.username, context.platform)];
	},
	/**
	 * Handles scan behavior for this CXC module.
	 * @param context - Value consumed by scan.
	 * @returns Result produced by scan.
	 */
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
	/**
	 * Handles describe behavior for this CXC module.
	 * @param candidate - Value consumed by describe.
	 * @returns Result produced by describe.
	 */
	describe(candidate)
	{
		return candidate.evidence;
	},
};

const cursorScanner: HarnessScanner = {
	harness: "Cursor",
	/**
	 * Returns the value managed by getCandidates.
	 * @param context - Value consumed by getCandidates.
	 * @returns Result produced by getCandidates.
	 */
	getCandidates(context)
	{
		return [getCursorDbPath(context.username, context.platform)];
	},
	/**
	 * Handles scan behavior for this CXC module.
	 * @param context - Value consumed by scan.
	 * @returns Result produced by scan.
	 */
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
	/**
	 * Handles describe behavior for this CXC module.
	 * @param candidate - Value consumed by describe.
	 * @returns Result produced by describe.
	 */
	describe(candidate)
	{
		return candidate.evidence;
	},
};

const vscodeScanner: HarnessScanner = {
	harness: "VSCode",
	/**
	 * Returns the value managed by getCandidates.
	 * @param context - Value consumed by getCandidates.
	 * @returns Result produced by getCandidates.
	 */
	getCandidates(context)
	{
		return [getVSCodeStoragePath(context.username, context.platform)];
	},
	/**
	 * Handles scan behavior for this CXC module.
	 * @param context - Value consumed by scan.
	 * @returns Result produced by scan.
	 */
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
	/**
	 * Handles describe behavior for this CXC module.
	 * @param candidate - Value consumed by describe.
	 * @returns Result produced by describe.
	 */
	describe(candidate)
	{
		return candidate.evidence;
	},
};

const kiroScanner: HarnessScanner = {
	harness: "Kiro",
	/**
	 * Returns the value managed by getCandidates.
	 * @param context - Value consumed by getCandidates.
	 * @returns Result produced by getCandidates.
	 */
	getCandidates(context)
	{
		return getKiroAgentPaths(context.username, context.platform);
	},
	/**
	 * Handles scan behavior for this CXC module.
	 * @param context - Value consumed by scan.
	 * @returns Result produced by scan.
	 */
	scan(context)
	{
		const baseCandidates = getKiroAgentPaths(context.username, context.platform);
		const results: HarnessScannerCandidate[] = [];
		// Business logic: this iteration walks every relevant item so operator configuration flows reflects the complete source set instead of a partial snapshot.

		for (const basePath of baseCandidates)
		{
			if (!existsSync(basePath))
			{
				continue;
			}			// Business logic: this iteration walks every relevant item so operator configuration flows reflects the complete source set instead of a partial snapshot.

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
	/**
	 * Handles describe behavior for this CXC module.
	 * @param candidate - Value consumed by describe.
	 * @returns Result produced by describe.
	 */
	describe(candidate)
	{
		return candidate.evidence;
	},
};

const openCodeScanner: HarnessScanner = {
	harness: "OpenCode",
	/**
	 * Returns the value managed by getCandidates.
	 * @param context - Value consumed by getCandidates.
	 * @returns Result produced by getCandidates.
	 */
	getCandidates(context)
	{
		return getOpenCodeStoragePaths(context.username, context.platform);
	},
	/**
	 * Handles scan behavior for this CXC module.
	 * @param context - Value consumed by scan.
	 * @returns Result produced by scan.
	 */
	scan(context)
	{
		const results: HarnessScannerCandidate[] = [];
		// Business logic: this iteration walks every relevant item so operator configuration flows reflects the complete source set instead of a partial snapshot.

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
	/**
	 * Handles describe behavior for this CXC module.
	 * @param candidate - Value consumed by describe.
	 * @returns Result produced by describe.
	 */
	describe(candidate)
	{
		return candidate.evidence;
	},
};

const codexScanner: HarnessScanner = {
	harness: "Codex",
	/**
	 * Returns the value managed by getCandidates.
	 * @param context - Value consumed by getCandidates.
	 * @returns Result produced by getCandidates.
	 */
	getCandidates(context)
	{
		return getCodexSessionPaths(context.username, context.platform);
	},
	/**
	 * Handles scan behavior for this CXC module.
	 * @param context - Value consumed by scan.
	 * @returns Result produced by scan.
	 */
	scan(context)
	{
		const results: HarnessScannerCandidate[] = [];
		// Business logic: this iteration walks every relevant item so operator configuration flows reflects the complete source set instead of a partial snapshot.

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
	/**
	 * Handles describe behavior for this CXC module.
	 * @param candidate - Value consumed by describe.
	 * @returns Result produced by describe.
	 */
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

/**
 * Handles scanHarnessCandidates behavior for this CXC module.
 * @param context - Value consumed by scanHarnessCandidates.
 * @param scanners - Value consumed by scanHarnessCandidates.
 * @returns Result produced by scanHarnessCandidates.
 */
export function scanHarnessCandidates(
	context: HarnessScannerContext,
	scanners: HarnessScanner[] = DEFAULT_HARNESS_SCANNERS
): HarnessScannerCandidate[]
{
	const candidates: HarnessScannerCandidate[] = [];
	// Business logic: this iteration walks every relevant item so operator configuration flows reflects the complete source set instead of a partial snapshot.

	for (const scanner of scanners)
	{
		// Business logic: this iteration walks every relevant item so operator configuration flows reflects the complete source set instead of a partial snapshot.

		for (const candidate of scanner.scan(context))
		{
			candidates.push(candidate);
		}
	}
	return candidates;
}
