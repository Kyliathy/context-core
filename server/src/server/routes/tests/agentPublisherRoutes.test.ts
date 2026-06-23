import { describe, expect, test } from "bun:test";
import express, { type Express } from "express";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { register as registerAgentPublisherRoutes } from "../agentPublisherRoutes.js";
import type { RouteContext } from "../../RouteContext.js";
import type { CanonicalAgentDefinition } from "../../../agentPublisher/types.js";

async function withServer(app: Express, run: (baseUrl: string) => Promise<void>): Promise<void>
{
	const server = app.listen(0, "127.0.0.1");
	try
	{
		await new Promise<void>((resolve) => server.once("listening", () => resolve()));
		const addr = server.address();
		if (!addr || typeof addr === "string") throw new Error("Failed to bind test server");
		const baseUrl = `http://127.0.0.1:${addr.port}`;
		await run(baseUrl);
	}
	finally
	{
		await new Promise<void>((resolve, reject) =>
		{
			server.close((err) => (err ? reject(err) : resolve()));
		});
	}
}

describe("agentPublisherRoutes", () =>
{
	test("preview returns JSON error on unexpected exception", async () =>
	{
		const fakePublisher = {
			getPlatforms: () => [],
			getTree: () => [],
			computeHeat: () => ({}),
			preview: () => { throw Object.assign(new Error("preview boom"), { status: 500 }); },
			publish: () => ({ written: [], warnings: [], errors: [] }),
			detectDrift: () => ({ canonicalId: "x", entries: [] }),
		};

		const app = express();
		app.use(express.json());
		registerAgentPublisherRoutes(app, { messageDB: {} as never, agentPublisher: fakePublisher as never });

		await withServer(app, async (baseUrl) =>
		{
			const response = await fetch(`${baseUrl}/api/agent-publisher/preview`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					definition: { id: "a", kind: "agent", projectName: "P", name: "n", description: "d", knowledge: [] },
					targets: [{ platform: "copilot", artifactKind: "agent", outputDir: "/tmp" }],
				}),
			});
			expect(response.status).toBe(500);
			const data = (await response.json()) as { error: string };
			expect(data.error).toBe("preview boom");
		});
	});

	test("publish returns JSON error on unexpected exception", async () =>
	{
		const fakePublisher = {
			getPlatforms: () => [],
			getTree: () => [],
			computeHeat: () => ({}),
			preview: () => ({ artifacts: [], warnings: [], errors: [] }),
			publish: () => { throw Object.assign(new Error("publish boom"), { status: 500 }); },
			detectDrift: () => ({ canonicalId: "x", entries: [] }),
		};

		const app = express();
		app.use(express.json());
		registerAgentPublisherRoutes(app, { messageDB: {} as never, agentPublisher: fakePublisher as never });

		await withServer(app, async (baseUrl) =>
		{
			const response = await fetch(`${baseUrl}/api/agent-publisher/publish`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					definition: { id: "a", kind: "agent", projectName: "P", name: "n", description: "d", knowledge: [] },
					targets: [{ platform: "copilot", artifactKind: "agent", outputDir: "/tmp" }],
				}),
			});
			expect(response.status).toBe(500);
			const data = (await response.json()) as { error: string };
			expect(data.error).toBe("publish boom");
		});
	});

	test("POST drift accepts optional definition", async () =>
	{
		const def: CanonicalAgentDefinition = {
			id: "test-agent",
			kind: "agent",
			projectName: "P",
			name: "agent",
			description: "changed",
			knowledge: [],
		};
		let capturedDef: CanonicalAgentDefinition | undefined;
		const fakePublisher = {
			getPlatforms: () => [],
			getTree: () => [],
			computeHeat: () => ({}),
			preview: () => ({ artifacts: [], warnings: [], errors: [] }),
			publish: () => ({ written: [], warnings: [], errors: [] }),
			detectDrift: (_id: string, current?: CanonicalAgentDefinition) =>
			{
				capturedDef = current;
				return {
					canonicalId: _id,
					entries: [{ platform: "copilot", artifactKind: "agent", absolutePath: "/a.md", state: "canonical-changed" }],
				};
			},
		};

		const app = express();
		app.use(express.json());
		registerAgentPublisherRoutes(app, { messageDB: {} as never, agentPublisher: fakePublisher as never });

		await withServer(app, async (baseUrl) =>
		{
			const response = await fetch(`${baseUrl}/api/agent-publisher/drift`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ canonicalId: "test-agent", definition: def }),
			});
			expect(response.ok).toBe(true);
			expect(capturedDef?.description).toBe("changed");
			const data = (await response.json()) as { entries: Array<{ state: string }> };
			expect(data.entries[0]?.state).toBe("canonical-changed");
		});
	});
});
