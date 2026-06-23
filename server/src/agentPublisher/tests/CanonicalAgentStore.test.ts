import { describe, expect, test } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { CanonicalAgentStore, CXC_CANONICAL_SOURCE_KEY } from "../CanonicalAgentStore.js";
import { toCanonicalAgentDefinition } from "../canonical.js";

describe("CanonicalAgentStore", () =>
{
	test("load returns warning on corrupt JSON", () =>
	{
		const dir = mkdtempSync(join(tmpdir(), "canonical-store-corrupt-"));
		const storage = join(dir, "storage");
		const settings = join(storage, ".settings");
		const storePath = join(settings, "agent-definitions.json");
		try
		{
			mkdirSync(settings, { recursive: true });
			writeFileSync(storePath, "{not json", "utf8");
			const store = new CanonicalAgentStore(storage);
			const warning = store.load();
			expect(warning).toContain("Corrupt");
			expect(store.list()).toEqual([]);
		}
		finally
		{
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("upsert replaces same id and stamps generated metadata", () =>
	{
		const dir = mkdtempSync(join(tmpdir(), "canonical-store-upsert-"));
		const storage = join(dir, "storage");
		try
		{
			const store = new CanonicalAgentStore(storage);
			store.load();
			const def = toCanonicalAgentDefinition({
				projectName: "Test Project",
				agentName: "worker",
				description: "d",
				"argument-hint": "h",
				agentKnowledge: [],
			});
			store.upsert(def);
			store.upsert({ ...def, description: "updated" });
			expect(store.list()).toHaveLength(1);
			expect(store.get(def.id)?.description).toBe("updated");
			expect(store.get(def.id)?.metadata?.[CXC_CANONICAL_SOURCE_KEY]).toBeDefined();
			store.save();
			const raw = JSON.parse(readFileSync(join(storage, ".settings", "agent-definitions.json"), "utf8")) as { definitions: unknown[] };
			expect(raw.definitions).toHaveLength(1);
		}
		finally
		{
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("missing store starts empty", () =>
	{
		const dir = mkdtempSync(join(tmpdir(), "canonical-store-missing-"));
		const storage = join(dir, "storage");
		try
		{
			const store = new CanonicalAgentStore(storage);
			expect(store.load()).toBeUndefined();
			expect(store.list()).toEqual([]);
		}
		finally
		{
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
