import { describe, expect, test } from "bun:test";
import { resolveInteractiveActionToken } from "../../cxccli.js";

describe("cxccli interactive hotkey mapping", () =>
{
	test("maps supported hotkeys and aliases", () =>
	{
		expect(resolveInteractiveActionToken("l")).toBe("list");
		expect(resolveInteractiveActionToken("A")).toBe("add");
		expect(resolveInteractiveActionToken("edit")).toBe("edit");
		expect(resolveInteractiveActionToken("d")).toBe("delete");
		expect(resolveInteractiveActionToken("r")).toBe("delete");
		expect(resolveInteractiveActionToken("remove")).toBe("delete");
		expect(resolveInteractiveActionToken("q")).toBe("quit");
		expect(resolveInteractiveActionToken("x")).toBe("quit");
		expect(resolveInteractiveActionToken("m")).toBe("menu");
		expect(resolveInteractiveActionToken("")).toBe("menu");
	});

	test("returns null for unsupported tokens", () =>
	{
		expect(resolveInteractiveActionToken("z")).toBeNull();
		expect(resolveInteractiveActionToken("123")).toBeNull();
	});
});
