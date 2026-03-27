import { CCSettings } from "../settings/CCSettings.js";
import { getHostname } from "../config.js";
import { getHarnessNames } from "../types.js";
import type { TopicStore } from "../settings/TopicStore.js";
import type { ScopeEntry } from "../models/ScopeEntry.js";
import type { SerializedSearchResults } from "../models/SearchResults.js";
import type { RouteContext } from "./RouteContext.js";
import type { QdrantPayloadFilter } from "../vector/QdrantService.js";

export function isNonEmptyString(value: unknown): value is string
{
	return typeof value === "string" && value.trim().length > 0;
}

export function normalizeScopeEntry(raw: unknown): ScopeEntry | null
{
	if (!raw || typeof raw !== "object")
	{
		return null;
	}

	const candidate = raw as {
		id?: unknown;
		name?: unknown;
		emoji?: unknown;
		color?: unknown;
		projectIds?: unknown;
	};

	if (!isNonEmptyString(candidate.id) || !isNonEmptyString(candidate.name))
	{
		return null;
	}

	const emoji = typeof candidate.emoji === "string" ? candidate.emoji.trim() : "";
	if (emoji.length === 0)
	{
		return null;
	}

	if (typeof candidate.color !== "string" || !/^#([0-9a-f]{6})$/i.test(candidate.color.trim()))
	{
		return null;
	}

	if (!Array.isArray(candidate.projectIds))
	{
		return null;
	}

	const projectIds: ScopeEntry["projectIds"] = [];
	for (const project of candidate.projectIds)
	{
		if (!project || typeof project !== "object")
		{
			return null;
		}
		const projectCandidate = project as { harness?: unknown; project?: unknown };
		if (!isNonEmptyString(projectCandidate.harness) || !isNonEmptyString(projectCandidate.project))
		{
			return null;
		}
		projectIds.push({
			harness: projectCandidate.harness.trim(),
			project: projectCandidate.project.trim(),
		});
	}

	return {
		id: candidate.id.trim(),
		name: candidate.name.trim(),
		emoji,
		color: candidate.color.trim().toLowerCase(),
		projectIds,
	};
}

/**
 * Resolves the display subject for a session.
 * Priority: customTopic (if set) → aiSummary (if set) → original subject.
 */
export function resolveSubject(sessionId: string, originalSubject: string, topicStore?: TopicStore): string
{
	if (!topicStore) return originalSubject;
	const entry = topicStore.getBySessionId(sessionId);
	if (!entry) return originalSubject;
	if (entry.customTopic) return entry.customTopic;
	if (entry.aiSummary) return entry.aiSummary;
	return originalSubject;
}

export type ProjectNameRemapRule = {
	projectName?: string;
	path?: string;
	newProjectName: string;
};

/**
 * Loads per-harness project remap rules from cc.json for the active machine.
 * Supports both canonical `newProjectName` and legacy `newPath` field names.
 */
export function loadProjectRemapsByHarness(): Map<string, Array<ProjectNameRemapRule>>
{
	const remapsByHarness = new Map<string, Array<ProjectNameRemapRule>>();
	try
	{
		const settings = CCSettings.getInstance();
		const machine = settings.getMachineConfig(getHostname());
		const harnesses = (machine?.harnesses ?? {}) as Record<string, unknown>;

		for (const [harness, harnessConfigRaw] of Object.entries(harnesses))
		{
			if (!harnessConfigRaw || typeof harnessConfigRaw !== "object")
			{
				continue;
			}
			const harnessConfig = harnessConfigRaw as Record<string, unknown>;
			const rawRules = Array.isArray(harnessConfig.projectMappingRules) ? harnessConfig.projectMappingRules : [];
			const parsedRules: Array<ProjectNameRemapRule> = [];

			for (const rawRule of rawRules)
			{
				if (!rawRule || typeof rawRule !== "object")
				{
					continue;
				}
				const candidate = rawRule as Record<string, unknown>;
				const newProjectName =
					typeof candidate.newProjectName === "string"
						? candidate.newProjectName.trim()
						: typeof candidate.newPath === "string"
							? candidate.newPath.trim()
							: "";
				if (!newProjectName)
				{
					continue;
				}

				const projectName = typeof candidate.projectName === "string" ? candidate.projectName.trim() : undefined;
				const path = typeof candidate.path === "string" ? candidate.path.trim() : undefined;
				if (!projectName && !path)
				{
					continue;
				}

				parsedRules.push({
					projectName,
					path,
					newProjectName,
				});
			}

			if (parsedRules.length > 0)
			{
				remapsByHarness.set(harness, parsedRules);
			}
		}
	} catch
	{
		// Ignore config read failures and return empty remap map.
	}

	return remapsByHarness;
}

/**
 * Applies one harness-scoped project remap to a project label.
 */
export function applyProjectRemap(
	harness: string,
	project: string,
	remapsByHarness: Map<string, Array<ProjectNameRemapRule>>
): string
{
	const rules = remapsByHarness.get(harness) ?? [];
	if (rules.length === 0)
	{
		return project;
	}

	const projectLower = project.toLowerCase();
	for (const rule of rules)
	{
		if (rule.projectName && projectLower === rule.projectName.toLowerCase())
		{
			return rule.newProjectName;
		}
	}

	for (const rule of rules)
	{
		if (rule.path && projectLower.includes(rule.path.toLowerCase()))
		{
			return rule.newProjectName;
		}
	}

	return project;
}

// ── Shared search utilities (moved from searchRoutes.ts) ────────────

export type ProjectFilter = { harness: string; project: string };

export function parseProjectFilters(rawProjects: unknown[]): ProjectFilter[]
{
	return rawProjects.filter(
		(p): p is ProjectFilter =>
			typeof p === "object" && p !== null &&
			typeof (p as Record<string, unknown>).harness === "string" &&
			typeof (p as Record<string, unknown>).project === "string" &&
			((p as Record<string, unknown>).harness as string).trim() !== "" &&
			((p as Record<string, unknown>).project as string).trim() !== ""
	);
}

/**
 * Runs subject-aware dual-channel Qdrant search.
 *
 * Channel routing:
 *   q only         → chunk(embed(q)) + summary(embed(q))
 *   q + subject    → chunk(embed(q)) + summary(embed(subject))
 *   subject only   → summary(embed(subject))  [skip chunk]
 *   symbols only   → skip entirely
 *
 * When symbolsTerm is provided, a Qdrant payload filter is applied to narrow
 * results to points whose symbols[] field contains the term.
 */
export async function runQdrantSearch(
	q: string,
	subjectTerm: string,
	symbolsTerm: string,
	searchResultsCount: number,
	projectFilters: ProjectFilter[],
	ctx: RouteContext
): Promise<Array<{ score: number; payload: any }>>
{
	if (!ctx.vectorServices) return [];
	if (!q && !subjectTerm) return [];

	const settings = CCSettings.getInstance();
	const hostname = getHostname();
	const machine = settings.getMachineConfig(hostname);
	const harnesses = machine ? getHarnessNames(machine.harnesses) : [];
	const limit = Math.max(1, Math.ceil(searchResultsCount * 0.1));
	const minScore = settings.QDRANT_MIN_SCORE;

	// Build optional symbols payload filter
	const symbolsFilter: QdrantPayloadFilter | undefined = symbolsTerm
		? { must: [{ key: "symbols", match: { text: symbolsTerm } }] }
		: undefined;

	let chunkHits: Awaited<ReturnType<typeof ctx.vectorServices.qdrantService.search>> = [];
	let summaryHits: typeof chunkHits = [];

	// Chunk channel: only when q is present (never for subject-only)
	if (q)
	{
		const queryVector = await ctx.vectorServices.embeddingService.embed(q);
		chunkHits = await ctx.vectorServices.qdrantService.search(
			harnesses, queryVector, limit, minScore, "chunk", symbolsFilter
		);

		// Summary channel with query vector only when subject is NOT specified
		if (!subjectTerm)
		{
			try
			{
				summaryHits = await ctx.vectorServices.qdrantService.search(
					harnesses, queryVector, limit, minScore, "summary", symbolsFilter
				);
			} catch (summaryErr)
			{
				void summaryErr;
			}
		}
	}

	// Summary channel with subject vector when subject IS specified
	if (subjectTerm)
	{
		const subjectVector = await ctx.vectorServices.embeddingService.embed(subjectTerm);
		try
		{
			summaryHits = await ctx.vectorServices.qdrantService.search(
				harnesses, subjectVector, limit, minScore, "summary", symbolsFilter
			);
		} catch (summaryErr)
		{
			void summaryErr;
		}
	}

	// Max-score dedup across chunk + summary hits
	const bestByMessage = new Map<string, (typeof chunkHits)[0]>();
	for (const hit of [...chunkHits, ...summaryHits])
	{
		const existing = bestByMessage.get(hit.payload.messageId);
		if (!existing || hit.score > existing.score)
		{
			bestByMessage.set(hit.payload.messageId, hit);
		}
	}
	let qdrantHits = Array.from(bestByMessage.values());

	if (projectFilters.length > 0)
	{
		const patterns = projectFilters.map((p) => p.project);
		qdrantHits = qdrantHits.filter((h) =>
		{
			const proj = String(h.payload.project ?? "").toLowerCase();
			return patterns.some((p) => proj.includes(p.toLowerCase()));
		});
	}

	return qdrantHits;
}

export function applyTopicSubjects(
	data: SerializedSearchResults,
	ctx: RouteContext
): void
{
	if (!ctx.topicStore || !data || !Array.isArray(data.results)) return;

	for (const result of data.results as Array<{
		sessionId?: string;
		subject?: string;
		message?: { sessionId?: string; subject?: string };
	}>)
	{
		if (result.sessionId && result.subject !== undefined)
		{
			result.subject = resolveSubject(result.sessionId, result.subject, ctx.topicStore);
			continue;
		}
		if (result.message?.sessionId && result.message.subject !== undefined)
		{
			result.message.subject = resolveSubject(result.message.sessionId, result.message.subject, ctx.topicStore);
		}
	}
}
