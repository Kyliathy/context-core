import type { CardData, ThreadCardData, MasterCardData, Scope, SelectedProject } from "../types";
import { getMasterCardColor } from "./colors";

function makeProjectKey(harness: string, project: string): string
{
	return `${harness}::${project}`;
}

/**
 * Finds the most-specific scope matching a given harness+project pair.
 * "Most specific" means fewest projectIds (narrowest scope wins).
 */
function findBestScope(harness: string, project: string, scopes: Scope[]): Scope | null
{
	const key = makeProjectKey(harness, project);
	let best: Scope | null = null;

	for (const scope of scopes)
	{
		const matches = scope.projectIds.some(
			(pid: SelectedProject) => makeProjectKey(pid.harness, pid.project) === key
		);
		if (!matches) continue;

		if (!best || scope.projectIds.length < best.projectIds.length)
		{
			best = scope;
		}
	}

	return best;
}

/**
 * Groups CardData and ThreadCardData into MasterCardData containers.
 * Each card/thread lands in exactly one MasterCard — either matched by scope
 * (most-specific scope wins) or by raw project as a fallback.
 * MasterCards are sorted by most-recent child dateTime descending.
 */
export function groupIntoMasterCards(
	cards: CardData[],
	threads: ThreadCardData[],
	scopes: Scope[]
): MasterCardData[]
{
	// Map from mastercard id → MasterCardData (accumulator)
	const masterMap = new Map<string, MasterCardData>();

	const getMaster = (id: string, label: string, emoji: string, color: string, kind: "scope" | "project"): MasterCardData =>
	{
		let master = masterMap.get(id);
		if (!master)
		{
			master = { id, label, emoji, color, kind, cards: [], threads: [], x: 0, y: 0, w: 0, h: 0 };
			masterMap.set(id, master);
		}
		return master;
	};

	for (const card of cards)
	{
		const scope = findBestScope(card.harness, card.project, scopes);
		if (scope)
		{
			getMaster(scope.id, scope.name, scope.emoji, scope.color, "scope").cards.push(card);
		}
		else
		{
			const projectLabel = card.project || "Miscellaneous";
			const projectId = `project::${card.harness}::${projectLabel}`;
			getMaster(projectId, projectLabel, "", getMasterCardColor(projectId), "project").cards.push(card);
		}
	}

	for (const thread of threads)
	{
		const scope = findBestScope(thread.harness, thread.project, scopes);
		if (scope)
		{
			getMaster(scope.id, scope.name, scope.emoji, scope.color, "scope").threads.push(thread);
		}
		else
		{
			const projectLabel = thread.project || "Miscellaneous";
			const projectId = `project::${thread.harness}::${projectLabel}`;
			getMaster(projectId, projectLabel, "", getMasterCardColor(projectId), "project").threads.push(thread);
		}
	}

	// Sort children within each master by dateTime descending (newest first)
	for (const master of masterMap.values())
	{
		master.cards.sort((a, b) => b.dateTime.localeCompare(a.dateTime));
		master.threads.sort((a, b) => b.lastDateTime.localeCompare(a.lastDateTime));
	}

	// Sort masters by most-recent child dateTime descending
	const masters = Array.from(masterMap.values());
	masters.sort((a, b) =>
	{
		const latestA = getLatestDateTime(a);
		const latestB = getLatestDateTime(b);
		return latestB.localeCompare(latestA);
	});

	return masters;
}

function getLatestDateTime(master: MasterCardData): string
{
	let latest = "";
	for (const card of master.cards)
	{
		if (card.dateTime > latest) latest = card.dateTime;
	}
	for (const thread of master.threads)
	{
		if (thread.lastDateTime > latest) latest = thread.lastDateTime;
	}
	return latest;
}
