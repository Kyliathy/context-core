import { describe, expect, test } from "bun:test";
import express, { type Express } from "express";
import { register as registerAgentBuilderRoutes } from "../agentBuilderRoutes.js";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { AgentBuilder } from "../../../agentBuilder/AgentBuilder.js";
import type { MachineConfig } from "../../../types.js";

type FakeBuilderInput = {
	projectName: string;
	agentName: string;
	description: string;
	"argument-hint": string;
	tools: string[];
	agentKnowledge: string[];
	codexDirectory?: string;
	codexEntryId?: string;
	platform: string;
};

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
			server.close((err) => err ? reject(err) : resolve());
		});
	}
}

describe("agentBuilderRoutes platform validation", () =>
{
	test("accepts github, claude, and codex platforms", async () =>
	{
		const createCalls: FakeBuilderInput[] = [];
		const fakeBuilder = {
			prepare: () => ({ totalFiles: 0, sources: [], files: [] }),
			create: (input: FakeBuilderInput) =>
			{
				createCalls.push(input);
				return { created: true, path: "/tmp/agent", agentName: input.agentName };
			},
			list: () => ({ totalAgents: 0, agents: [] }),
			getAgent: () => ({ agent: {} }),
			getFileContent: () => ({}),
			addTemplate: () => ({ created: true, templateName: "x", path: "/tmp/x" }),
			listTemplates: () => ({ totalTemplates: 0, templates: [] }),
		};

		const app = express();
		app.use(express.json());
		registerAgentBuilderRoutes(app, { messageDB: {} as never, agentBuilder: fakeBuilder as never });

		const platforms = ["github", "claude", "codex"] as const;
		await withServer(app, async (baseUrl) =>
		{
			for (const platform of platforms)
			{
				const response = await fetch(`${baseUrl}/api/agent-builder/create`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						projectName: "P",
						agentName: `a-${platform}`,
						description: "d",
						"argument-hint": "h",
						tools: [],
						agentKnowledge: ["x"],
						platform,
					}),
				});
				expect(response.status).toBe(201);
			}
		});

		expect(createCalls.length).toBe(3);
		expect(createCalls.map((c) => c.platform)).toEqual(["github", "claude", "codex"]);
	});

	test("rejects invalid platform values with 400", async () =>
	{
		const fakeBuilder = {
			prepare: () => ({ totalFiles: 0, sources: [], files: [] }),
			create: () => ({ created: true, path: "/tmp/agent", agentName: "x" }),
			list: () => ({ totalAgents: 0, agents: [] }),
			getAgent: () => ({ agent: {} }),
			getFileContent: () => ({}),
			addTemplate: () => ({ created: true, templateName: "x", path: "/tmp/x" }),
			listTemplates: () => ({ totalTemplates: 0, templates: [] }),
		};

		const app = express();
		app.use(express.json());
		registerAgentBuilderRoutes(app, { messageDB: {} as never, agentBuilder: fakeBuilder as never });

		await withServer(app, async (baseUrl) =>
		{
			const response = await fetch(`${baseUrl}/api/agent-builder/create`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					projectName: "P",
					agentName: "a",
					description: "d",
					"argument-hint": "h",
					tools: [],
					agentKnowledge: ["x"],
					platform: "invalid-platform",
				}),
			});
			expect(response.status).toBe(400);

			const payload = await response.json() as { error?: string };
			expect(payload.error).toContain("platform must be");
		});
	});

	test("forwards optional codexEntryId in get-agent route", async () =>
	{
		const seen: { path?: string; codexEntryId?: string } = {};
		const fakeBuilder = {
			prepare: () => ({ totalFiles: 0, sources: [], files: [] }),
			create: () => ({ created: true, path: "/tmp/agent", agentName: "x" }),
			list: () => ({ totalAgents: 0, agents: [] }),
			getAgent: (path: string, codexEntryId?: string) =>
			{
				seen.path = path;
				seen.codexEntryId = codexEntryId;
				return { agent: {} };
			},
			getFileContent: () => ({}),
			addTemplate: () => ({ created: true, templateName: "x", path: "/tmp/x" }),
			listTemplates: () => ({ totalTemplates: 0, templates: [] }),
		};

		const app = express();
		app.use(express.json());
		registerAgentBuilderRoutes(app, { messageDB: {} as never, agentBuilder: fakeBuilder as never });

		await withServer(app, async (baseUrl) =>
		{
			const response = await fetch(
				`${baseUrl}/api/agent-builder/get-agent?path=${encodeURIComponent("/tmp/AGENTS.md")}&codexEntryId=knk-home`
			);
			expect(response.status).toBe(200);
		});

		expect(seen.path).toBe("/tmp/AGENTS.md");
		expect(seen.codexEntryId).toBe("knk-home");
	});

	test("forwards optional codexDirectory/codexEntryId in create route", async () =>
	{
		const seen: FakeBuilderInput[] = [];
		const fakeBuilder = {
			prepare: () => ({ totalFiles: 0, sources: [], files: [] }),
			create: (input: FakeBuilderInput) =>
			{
				seen.push(input);
				return { created: true, path: "/tmp/agent", agentName: "x", codexEntryId: input.codexEntryId };
			},
			list: () => ({ totalAgents: 0, agents: [] }),
			getAgent: () => ({ agent: {} }),
			getFileContent: () => ({}),
			addTemplate: () => ({ created: true, templateName: "x", path: "/tmp/x" }),
			listTemplates: () => ({ totalTemplates: 0, templates: [] }),
		};

		const app = express();
		app.use(express.json());
		registerAgentBuilderRoutes(app, { messageDB: {} as never, agentBuilder: fakeBuilder as never });

		await withServer(app, async (baseUrl) =>
		{
			const response = await fetch(`${baseUrl}/api/agent-builder/create`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					projectName: "P",
					agentName: "a",
					description: "d",
					"argument-hint": "h",
					tools: [],
					agentKnowledge: ["x"],
					platform: "codex",
					codexDirectory: "D:/repo/apps/knk",
					codexEntryId: "knk-home",
				}),
			});
			expect(response.status).toBe(201);
		});

		expect(seen.length).toBe(1);
		expect(seen[0]?.codexDirectory).toBe("D:/repo/apps/knk");
		expect(seen[0]?.codexEntryId).toBe("knk-home");
	});

	test("returns 400 when codexDirectory is missing and multiple codexAgentPaths exist", async () =>
	{
		const tempRoot = mkdtempSync(join(tmpdir(), "route-codex-dir-required-"));
		try
		{
			const sourceRoot = join(tempRoot, "repo");
			const dirA = join(sourceRoot, "apps", "a");
			const dirB = join(sourceRoot, "apps", "b");
			mkdirSync(dirA, { recursive: true });
			mkdirSync(dirB, { recursive: true });

			const machine: MachineConfig = {
				machine: "TEST-HOST",
				harnesses: {},
				dataSources: {
					"agent-test": [
						{
							path: sourceRoot,
							name: "Test Project",
							type: "Repo",
							purpose: "AgentBuilder",
							codexAgentPaths: [dirA, dirB],
						},
					],
				},
			};
			const builder = new AgentBuilder(machine);

			const app = express();
			app.use(express.json());
			registerAgentBuilderRoutes(app, { messageDB: {} as never, agentBuilder: builder as never });

			await withServer(app, async (baseUrl) =>
			{
				const response = await fetch(`${baseUrl}/api/agent-builder/create`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						projectName: "Test Project",
						agentName: "knk-home",
						description: "d",
						"argument-hint": "h",
						tools: [],
						agentKnowledge: ["x"],
						platform: "codex",
					}),
				});
				expect(response.status).toBe(400);
				const payload = await response.json() as { error?: string };
				expect(payload.error).toContain("codexDirectory is required");
			});
		}
		finally
		{
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test("returns 400 when codexDirectory is not one of allowed codexAgentPaths", async () =>
	{
		const tempRoot = mkdtempSync(join(tmpdir(), "route-codex-dir-invalid-"));
		try
		{
			const sourceRoot = join(tempRoot, "repo");
			const dirA = join(sourceRoot, "apps", "a");
			mkdirSync(dirA, { recursive: true });

			const machine: MachineConfig = {
				machine: "TEST-HOST",
				harnesses: {},
				dataSources: {
					"agent-test": [
						{
							path: sourceRoot,
							name: "Test Project",
							type: "Repo",
							purpose: "AgentBuilder",
							codexAgentPaths: [dirA],
						},
					],
				},
			};
			const builder = new AgentBuilder(machine);

			const app = express();
			app.use(express.json());
			registerAgentBuilderRoutes(app, { messageDB: {} as never, agentBuilder: builder as never });

			await withServer(app, async (baseUrl) =>
			{
				const response = await fetch(`${baseUrl}/api/agent-builder/create`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						projectName: "Test Project",
						agentName: "knk-home",
						description: "d",
						"argument-hint": "h",
						tools: [],
						agentKnowledge: ["x"],
						platform: "codex",
						codexDirectory: join(sourceRoot, "apps", "z"),
					}),
				});
				expect(response.status).toBe(400);
				const payload = await response.json() as { error?: string };
				expect(payload.error).toContain("codexDirectory must be one of the configured directories");
			});
		}
		finally
		{
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});
});
