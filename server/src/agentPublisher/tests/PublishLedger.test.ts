import { describe, expect, test } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { PublishLedger } from "../PublishLedger.js";

describe("PublishLedger", () =>
{
	test("load returns warning on corrupt JSON", () =>
	{
		const dir = mkdtempSync(join(tmpdir(), "ledger-corrupt-"));
		const storage = join(dir, "storage");
		const settings = join(storage, ".settings");
		const ledgerPath = join(settings, "agent-publish.json");
		try
		{
			mkdirSync(settings, { recursive: true });
			writeFileSync(ledgerPath, "{not json", "utf8");
			const ledger = new PublishLedger(storage);
			const warning = ledger.load();
			expect(warning).toContain("Corrupt");
			expect(ledger.getAll()).toEqual([]);
		}
		finally
		{
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("upsert replaces same key", () =>
	{
		const dir = mkdtempSync(join(tmpdir(), "ledger-upsert-"));
		const storage = join(dir, "storage");
		try
		{
			const ledger = new PublishLedger(storage);
			ledger.load();
			const base = {
				canonicalId: "a",
				platform: "copilot" as const,
				artifactKind: "agent" as const,
				absolutePath: "D:\\repo\\a.agent.md",
				canonicalHash: "h1",
				artifactHash: "f1",
				knowledge: [],
				referencedPaths: [],
				publishedAt: "2026-01-01T00:00:00.000Z",
			};
			ledger.upsert(base);
			ledger.upsert({ ...base, artifactHash: "f2" });
			expect(ledger.getAll()).toHaveLength(1);
			expect(ledger.getAll()[0]?.artifactHash).toBe("f2");
			ledger.save();
			const raw = JSON.parse(readFileSync(join(storage, ".settings", "agent-publish.json"), "utf8")) as { entries: unknown[] };
			expect(raw.entries).toHaveLength(1);
		}
		finally
		{
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
