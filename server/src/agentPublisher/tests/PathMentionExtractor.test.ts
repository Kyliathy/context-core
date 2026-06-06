import { describe, expect, test } from "bun:test";
import { extractPathMentions } from "../PathMentionExtractor.js";

describe("PathMentionExtractor", () =>
{
	test("extracts markdown links", () =>
	{
		const mentions = extractPathMentions("See [doc](docs/archi.md) for details.");
		expect(mentions).toContain("docs/archi.md");
	});

	test("drops URLs and anchors", () =>
	{
		const mentions = extractPathMentions("[site](https://example.com) [#anchor](#top)");
		expect(mentions).toEqual([]);
	});

	test("extracts inline code paths", () =>
	{
		const mentions = extractPathMentions("Read `server/src/App.tsx` next.");
		expect(mentions.some((m) => m.includes("App.tsx"))).toBe(true);
	});
});
