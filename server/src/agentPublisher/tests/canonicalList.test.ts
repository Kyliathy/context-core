/**
 * Canonical Agent List mapper and catalog tests.
 *
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ap-agent-publisher-2.md (Part A)
 */

import { describe, expect, test } from "bun:test";
import {
	mapCanonicalAgentList,
	mergeDriftIntoPublishedSummaries,
	toCanonicalListEntry,
	toPublishedTargetSummary,
} from "../canonicalListMapper.js";
import type { CanonicalAgentDefinition, PublishLedgerEntry } from "../types.js";

const baseDef = (overrides: Partial<CanonicalAgentDefinition> = {}): CanonicalAgentDefinition => ({
	id: "proj-my-agent",
	kind: "agent",
	projectName: "proj",
	name: "my-agent",
	description: "desc",
	"argument-hint": "hint",
	knowledge: [],
	...overrides,
});

describe("canonicalListMapper", () =>
{
	test("maps two definitions with no ledger rows as unpublished", () =>
	{
		const defs = [baseDef({ id: "a", name: "a" }), baseDef({ id: "b", name: "b", projectName: "other" })];
		const result = mapCanonicalAgentList(defs, new Map(), false);
		expect(result.totalAgents).toBe(2);
		expect(result.agents.every((a) => a.unpublished)).toBe(true);
		expect(result.agents.every((a) => a.publishedTo.length === 0)).toBe(true);
	});

	test("maps only one definition with ledger rows as published", () =>
	{
		const published = baseDef({ id: "published" });
		const unpublished = baseDef({ id: "draft", name: "draft" });
		const row: PublishLedgerEntry = {
			canonicalId: "published",
			platform: "copilot",
			artifactKind: "agent",
			absolutePath: "D:/repo/.github/agents/my-agent.agent.md",
			canonicalHash: "h1",
			artifactHash: "h2",
			knowledge: [],
			referencedPaths: [],
			publishedAt: "2026-06-21T00:00:00.000Z",
		};
		const byId = new Map([["published", [row]]]);
		const result = mapCanonicalAgentList([published, unpublished], byId, false);
		const pub = result.agents.find((a) => a.canonicalId === "published");
		const draft = result.agents.find((a) => a.canonicalId === "draft");
		expect(pub?.unpublished).toBe(false);
		expect(pub?.publishedTo).toHaveLength(1);
		expect(draft?.unpublished).toBe(true);
	});

	test("codex published summary includes codexEntryId", () =>
	{
		const summary = toPublishedTargetSummary({
			canonicalId: "codex-entry-1",
			platform: "codex",
			artifactKind: "agent",
			absolutePath: "D:/repo/AGENTS.md",
			canonicalHash: "a",
			artifactHash: "b",
			knowledge: [],
			referencedPaths: [],
			publishedAt: "2026-06-21T00:00:00.000Z",
			artifactFormat: "codex-collection",
		});
		expect(summary.codexEntryId).toBe("codex-entry-1");
	});

	test("sorts by projectName then name", () =>
	{
		const defs = [
			baseDef({ id: "z", projectName: "B", name: "z" }),
			baseDef({ id: "a", projectName: "A", name: "z" }),
			baseDef({ id: "m", projectName: "B", name: "a" }),
		];
		const result = mapCanonicalAgentList(defs, new Map(), false);
		expect(result.agents.map((a) => `${a.projectName}:${a.name}`)).toEqual(["A:z", "B:a", "B:z"]);
	});

	test("toCanonicalListEntry derives hint from argument-hint", () =>
	{
		const entry = toCanonicalListEntry(baseDef(), [], false);
		expect(entry.hint).toBe("hint");
		expect(entry.canonicalId).toBe("proj-my-agent");
	});

	test("mergeDriftIntoPublishedSummaries attaches drift state to published rows", () =>
	{
		const published = [{
			platform: "copilot" as const,
			artifactKind: "agent" as const,
			absolutePath: "D:/repo/.github/agents/a.agent.md",
			publishedAt: "2026-06-21T00:00:00.000Z",
		}];
		const merged = mergeDriftIntoPublishedSummaries(published, [{
			platform: "copilot",
			artifactKind: "agent",
			absolutePath: "D:/repo/.github/agents/a.agent.md",
			state: "missing-file",
		}]);
		expect(merged[0]?.state).toBe("missing-file");
	});
});
