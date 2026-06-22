/**
 * Vault Manager form helper tests.
 *
 * Architecture: visualizer/zz-reach2/architecture/agents/archi-agent-builder-ui.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ve-vault-explorer.md (§20–22)
 */

import { describe, expect, test } from "bun:test";
import {
	applyUseVaultNameSuggestion,
	applyVaultNameOnPathChange,
	suggestSourceNameIfEmpty,
} from "./vaultFormUtils";

describe("vaultFormUtils", () =>
{
	test("suggestSourceNameIfEmpty preserves user-typed name", () =>
	{
		expect(suggestSourceNameIfEmpty("My Vault", "basename")).toBe("My Vault");
	});

	test("applyVaultNameOnPathChange updates name when not touched", () =>
	{
		const result = applyVaultNameOnPathChange({
			currentName: "Codez",
			suggestedBasename: "zz-reach2",
			nameTouched: false,
		});
		expect(result.nextName).toBe("zz-reach2");
		expect(result.showSuggestionHint).toBe(false);
	});

	test("applyVaultNameOnPathChange keeps touched name and shows hint when basename differs", () =>
	{
		const result = applyVaultNameOnPathChange({
			currentName: "Codez",
			suggestedBasename: "zz-reach2",
			nameTouched: true,
		});
		expect(result.nextName).toBe("Codez");
		expect(result.showSuggestionHint).toBe(true);
		expect(result.suggestionBasename).toBe("zz-reach2");
	});

	test("applyUseVaultNameSuggestion resets touched and applies basename", () =>
	{
		const applied = applyUseVaultNameSuggestion("zz-reach2");
		expect(applied.nextName).toBe("zz-reach2");
		expect(applied.nameTouched).toBe(false);
	});

	test("hint visibility contract: touched + differing basename shows suggestion", () =>
	{
		const result = applyVaultNameOnPathChange({
			currentName: "Codez",
			suggestedBasename: "zz-reach2",
			nameTouched: true,
		});
		expect(result.showSuggestionHint).toBe(true);
		expect(result.suggestionBasename).toBe("zz-reach2");
	});
});
