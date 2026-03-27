/**
 * ContextCore – HarnessMatcher: per-session + per-project symbol frequency maps.
 * Operates only on messages belonging to explicitly rule-matched projects.
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import chalk from "chalk";
import { AgentMessage } from "../models/AgentMessage.js";
import { extractMessageSymbols } from "../analysis/SubjectGenerator.js";
import { buildYYYYMM, sanitizeFilename } from "../utils/pathHelpers.js";

const SYM = chalk.hex("#9B59B6")("[SymbolMap]");

/** Serialized symbol frequency entry for JSON output. */
type SymbolEntry = { symbol: string; count: number };

export class HarnessMatcher
{
	private readonly messages: Array<AgentMessage>;
	private readonly ruleMatchedProjects: ReadonlySet<string>;

	/** Filtered messages grouped by sessionId. */
	private readonly sessionMessages: Map<string, Array<AgentMessage>>;

	/** Filtered messages grouped by project. */
	private readonly projectMessages: Map<string, Array<AgentMessage>>;

	/** Computed per-session symbol frequency maps (built lazily). */
	private sessionSymbolMaps: Map<string, Map<string, number>> | null = null;

	/** Computed per-project symbol frequency maps (built lazily). */
	private projectSymbolMaps: Map<string, Map<string, number>> | null = null;

	constructor(messages: Array<AgentMessage>, ruleMatchedProjects: string[])
	{
		this.ruleMatchedProjects = new Set(ruleMatchedProjects);
		this.messages = messages.filter((m) => this.ruleMatchedProjects.has(m.project));

		this.sessionMessages = new Map();
		this.projectMessages = new Map();

		for (const msg of this.messages)
		{
			if (!this.sessionMessages.has(msg.sessionId))
			{
				this.sessionMessages.set(msg.sessionId, []);
			}
			this.sessionMessages.get(msg.sessionId)!.push(msg);

			if (!this.projectMessages.has(msg.project))
			{
				this.projectMessages.set(msg.project, []);
			}
			this.projectMessages.get(msg.project)!.push(msg);
		}
	}

	/**
	 * Builds per-session symbol frequency maps.
	 * For each session, iterates all messages, extracts symbols, accumulates counts.
	 */
	buildSessionSymbolMaps(): Map<string, Map<string, number>>
	{
		if (this.sessionSymbolMaps)
		{
			return this.sessionSymbolMaps;
		}

		const result = new Map<string, Map<string, number>>();

		for (const [sessionId, msgs] of this.sessionMessages.entries())
		{
			const counts = new Map<string, number>();

			for (const msg of msgs)
			{
				const symbols = extractMessageSymbols(msg.message);
				for (const sym of symbols)
				{
					counts.set(sym, (counts.get(sym) ?? 0) + 1);
				}
			}

			result.set(sessionId, counts);
		}

		this.sessionSymbolMaps = result;
		return result;
	}

	/**
	 * Aggregates session-level symbol maps into per-project totals.
	 * Sums frequencies across all sessions belonging to each project.
	 */
	buildProjectSymbolMaps(): Map<string, Map<string, number>>
	{
		if (this.projectSymbolMaps)
		{
			return this.projectSymbolMaps;
		}

		const sessionMaps = this.buildSessionSymbolMaps();
		const result = new Map<string, Map<string, number>>();

		for (const [sessionId, symbolMap] of sessionMaps.entries())
		{
			const firstMsg = this.sessionMessages.get(sessionId)?.[0];
			if (!firstMsg) { continue; }
			const project = firstMsg.project;

			if (!result.has(project))
			{
				result.set(project, new Map<string, number>());
			}
			const projectCounts = result.get(project)!;

			for (const [sym, count] of symbolMap.entries())
			{
				projectCounts.set(sym, (projectCounts.get(sym) ?? 0) + count);
			}
		}

		this.projectSymbolMaps = result;
		return result;
	}

	/**
	 * Writes per-session symbol files: `sym_{sessionId}.json` in `{YYYY-MM}/`.
	 * Determines YYYY-MM from the session's first message dateTime.
	 */
	writeSessionSymbolFiles(storageRoot: string, machine: string, harness: string): number
	{
		const sessionMaps = this.buildSessionSymbolMaps();
		let written = 0;

		for (const [sessionId, symbolMap] of sessionMaps.entries())
		{
			if (symbolMap.size === 0) { continue; }

			const firstMsg = this.sessionMessages.get(sessionId)?.[0];
			if (!firstMsg) { continue; }

			const project = sanitizeFilename(firstMsg.project || "project");
			const monthFolder = buildYYYYMM(firstMsg.dateTime);
			const outputDir = join(storageRoot, machine, harness, project, monthFolder);
			const fileName = `sym_${sanitizeFilename(sessionId)}.json`;
			const outputPath = join(outputDir, fileName);

			mkdirSync(outputDir, { recursive: true });

			const entries = sortedEntries(symbolMap);
			writeFileSync(outputPath, JSON.stringify(entries, null, 2), "utf-8");
			written += 1;
		}

		return written;
	}

	/**
	 * Writes per-project symbol files: `sym_{PROJECT_NAME}.json` in project root.
	 */
	writeProjectSymbolFiles(storageRoot: string, machine: string, harness: string): number
	{
		const projectMaps = this.buildProjectSymbolMaps();
		let written = 0;

		for (const [project, symbolMap] of projectMaps.entries())
		{
			if (symbolMap.size === 0) { continue; }

			const safeProject = sanitizeFilename(project || "project");
			const outputDir = join(storageRoot, machine, harness, safeProject);
			const fileName = `sym_${safeProject}.json`;
			const outputPath = join(outputDir, fileName);

			mkdirSync(outputDir, { recursive: true });

			const entries = sortedEntries(symbolMap);
			writeFileSync(outputPath, JSON.stringify(entries, null, 2), "utf-8");
			written += 1;
		}

		return written;
	}

	/**
	 * Logs chalk-colored diagnostic stats: per-project symbol count, top-5 symbols, session count.
	 */
	logDiagnostics(): void
	{
		const sessionMaps = this.buildSessionSymbolMaps();
		const projectMaps = this.buildProjectSymbolMaps();

		const totalSessions = sessionMaps.size;
		const totalMessages = this.messages.length;

		console.log(`${SYM} Matched ${chalk.green(totalMessages + "")} messages across ${chalk.green(totalSessions + "")} sessions in ${chalk.green(this.ruleMatchedProjects.size + "")} projects`);

		for (const [project, symbolMap] of projectMaps.entries())
		{
			const projectSessionCount = this.projectMessages.get(project)?.length ?? 0;
			const sessionCount = new Set(
				(this.projectMessages.get(project) ?? []).map((m) => m.sessionId)
			).size;
			const symbolCount = symbolMap.size;
			const top5 = sortedEntries(symbolMap)
				.slice(0, 5)
				.map((e) => `${chalk.cyan(e.symbol)}(${e.count})`)
				.join(chalk.dim(", "));

			console.log(
				`${SYM}   ${chalk.green.bold(project)}: ${chalk.magenta(symbolCount + "")} symbols, ${chalk.magenta(sessionCount + "")} sessions, ${chalk.magenta(projectSessionCount + "")} messages`
			);
			if (top5)
			{
				console.log(`${SYM}     top-5: ${top5}`);
			}
		}
	}
}

/** Sorts a symbol frequency map into descending-count entries. */
function sortedEntries(symbolMap: Map<string, number>): Array<SymbolEntry>
{
	return Array.from(symbolMap.entries())
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([symbol, count]) => ({ symbol, count }));
}
