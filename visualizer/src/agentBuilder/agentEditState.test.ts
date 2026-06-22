/**
 * Agent Builder edit-mode helper tests.
 *
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ap-agent-publisher-2.md (Review §33–34)
 */

import { describe, expect, test } from "bun:test";
import { isAgentBasketEditMode, resolveCreateCanonicalId } from "./agentEditState";

describe("agentEditState", () =>
{
	test("canonical edit enters basket edit mode without legacy agent path", () =>
	{
		expect(isAgentBasketEditMode(null, "agent-a", "agent")).toBe(true);
		expect(isAgentBasketEditMode(null, null, "agent")).toBe(false);
	});

	test("legacy path edit still enters basket edit mode", () =>
	{
		expect(isAgentBasketEditMode("D:/repo/.github/agents/foo.agent.md", null, "agent")).toBe(true);
	});

	test("template mode never enters agent edit mode", () =>
	{
		expect(isAgentBasketEditMode(null, "agent-a", "template")).toBe(false);
	});

	test("resolveCreateCanonicalId only sends id during explicit edit session", () =>
	{
		expect(resolveCreateCanonicalId("agent-a")).toBe("agent-a");
		expect(resolveCreateCanonicalId(null)).toBeUndefined();
	});

	test("stale canonical id regression: after clear, new save does not upsert prior agent", () =>
	{
		const editingAgentA = "agent-a";
		expect(resolveCreateCanonicalId(editingAgentA)).toBe("agent-a");
		const afterClear = null;
		expect(resolveCreateCanonicalId(afterClear)).toBeUndefined();
	});
});
