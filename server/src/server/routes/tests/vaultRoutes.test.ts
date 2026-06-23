/**
 * Vault route HTTP tests — browse/info read-only boundary and Save mutation.
 *
 * Architecture: server/zz-reach2/architecture/agents/archi-agent-builder.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ve-vault-explorer.md
 */

import { describe, expect, test } from "bun:test";
import express, { type Express } from "express";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register as registerAgentBuilderRoutes } from "../agentBuilderRoutes.js";
import { makeTestMachineConfig } from "../../../config/testFixtures.js";

/**
 * Binds an ephemeral Express app and runs a callback against its base URL.
 * @param app - Express application under test.
 * @param run - Async test body receiving the bound base URL.
 */
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

describe("vault routes", () =>
{
	test("browse and info routes do not call addVault", async () =>
	{
		let addVaultCalls = 0;
		const machine = makeTestMachineConfig("test-host");
		const fakeRuntime = {
			getMachine: () => machine,
			addVault: async () =>
			{
				addVaultCalls += 1;
				return { entry: {}, category: "vaults", configPath: "", prepare: { totalFiles: 0, sources: [], files: [] } };
			},
		};

		const app = express();
		app.use(express.json());
		registerAgentBuilderRoutes(app, {
			messageDB: {} as never,
			agentBuilderRuntime: fakeRuntime as never,
		});

		const base = mkdtempSync(join(tmpdir(), "cxc-vault-route-"));
		mkdirSync(join(base, "child"), { recursive: true });

		try
		{
			await withServer(app, async (baseUrl) =>
			{
				const roots = await fetch(`${baseUrl}/api/agent-builder/vault-roots`);
				expect(roots.ok).toBe(true);

				const children = await fetch(`${baseUrl}/api/agent-builder/vault-children?path=${encodeURIComponent(base)}`);
				expect(children.ok).toBe(true);
				const childrenBody = await children.json() as { directories: Array<{ name: string }> };
				expect(childrenBody.directories.some((entry) => entry.name === "child")).toBe(true);

				const info = await fetch(`${baseUrl}/api/agent-builder/vault-info?path=${encodeURIComponent(base)}`);
				expect(info.ok).toBe(true);

				expect(addVaultCalls).toBe(0);
			});
		}
		finally
		{
			rmSync(base, { recursive: true, force: true });
		}
	});

	test("vault-children returns JSON error for missing path", async () =>
	{
		const app = express();
		app.use(express.json());
		registerAgentBuilderRoutes(app, { messageDB: {} as never });

		await withServer(app, async (baseUrl) =>
		{
			const response = await fetch(`${baseUrl}/api/agent-builder/vault-children?path=${encodeURIComponent(join(tmpdir(), "missing-vault-dir"))}`);
			expect(response.status).toBe(404);
			const body = await response.json() as { error: string };
			expect(body.error).toContain("does not exist");
		});
	});

	test("vault-info reports alreadyConfigured from runtime machine config", async () =>
	{
		const configuredPath = mkdtempSync(join(tmpdir(), "cxc-vault-dup-"));
		const machine = makeTestMachineConfig("test-host", {
			vaults: [{
				path: configuredPath,
				name: "ExistingVault",
				type: "Vault",
				purpose: "AgentBuilder",
			}],
		});

		const fakeRuntime = { getMachine: () => machine };
		const app = express();
		app.use(express.json());
		registerAgentBuilderRoutes(app, {
			messageDB: {} as never,
			agentBuilderRuntime: fakeRuntime as never,
		});

		try
		{
			await withServer(app, async (baseUrl) =>
			{
				const response = await fetch(`${baseUrl}/api/agent-builder/vault-info?path=${encodeURIComponent(configuredPath)}`);
				expect(response.ok).toBe(true);
				const body = await response.json() as { alreadyConfigured: boolean };
				expect(body.alreadyConfigured).toBe(true);
			});
		}
		finally
		{
			rmSync(configuredPath, { recursive: true, force: true });
		}
	});

	test("POST /vaults invokes addVault and returns prepare payload", async () =>
	{
		const base = mkdtempSync(join(tmpdir(), "cxc-vault-save-"));
		let addVaultInput: { path: string; name?: string } | null = null;
		const machine = makeTestMachineConfig("test-host");

		const fakeRuntime = {
			getMachine: () => machine,
			addVault: async (_machineName: string, input: { path: string; name?: string }) =>
			{
				addVaultInput = input;
				return {
					entry: { path: input.path, name: input.name ?? "Vault", type: "Vault", purpose: "AgentBuilder" },
					category: "vaults",
					configPath: "cc.json",
					prepare: {
						totalFiles: 2,
						sources: [{ name: input.name ?? "Vault", fileCount: 2 }],
						files: [],
					},
				};
			},
		};

		const app = express();
		app.use(express.json());
		registerAgentBuilderRoutes(app, {
			messageDB: {} as never,
			agentBuilderRuntime: fakeRuntime as never,
		});

		try
		{
			await withServer(app, async (baseUrl) =>
			{
				const response = await fetch(`${baseUrl}/api/agent-builder/vaults`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ path: base, name: "TestVault" }),
				});
				expect(response.status).toBe(201);
				const body = await response.json() as { prepare: { sources: Array<{ name: string }> } };
				expect(addVaultInput?.path).toBe(base);
				expect(body.prepare.sources[0]?.name).toBe("TestVault");
			});
		}
		finally
		{
			rmSync(base, { recursive: true, force: true });
		}
	});

	test("PATCH /vaults invokes updateVault and returns prepare payload", async () =>
	{
		const configuredPath = mkdtempSync(join(tmpdir(), "cxc-vault-patch-"));
		let updateVaultInput: { path: string; name: string } | null = null;
		const machine = makeTestMachineConfig("test-host", {
			vaults: [{
				path: configuredPath,
				name: "Codez",
				type: "Vault",
				purpose: "AgentBuilder",
			}],
		});

		const fakeRuntime = {
			getMachine: () => machine,
			updateVault: async (_machineName: string, input: { path: string; name: string }) =>
			{
				updateVaultInput = input;
				return {
					entry: { path: input.path, name: input.name, type: "Vault", purpose: "AgentBuilder" },
					category: "vaults",
					configPath: "cc.json",
					previousName: "Codez",
					prepare: {
						totalFiles: 1,
						sources: [{ name: input.name, type: "Vault", path: input.path, fileCount: 1 }],
						files: [],
					},
				};
			},
		};

		const app = express();
		app.use(express.json());
		registerAgentBuilderRoutes(app, {
			messageDB: {} as never,
			agentBuilderRuntime: fakeRuntime as never,
		});

		try
		{
			await withServer(app, async (baseUrl) =>
			{
				const response = await fetch(`${baseUrl}/api/agent-builder/vaults`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ path: configuredPath, name: "AIUL2", type: "Vault" }),
				});
				expect(response.ok).toBe(true);
				const body = await response.json() as { previousName?: string; entry: { name: string } };
				expect(updateVaultInput?.name).toBe("AIUL2");
				expect(body.previousName).toBe("Codez");
				expect(body.entry.name).toBe("AIUL2");
			});
		}
		finally
		{
			rmSync(configuredPath, { recursive: true, force: true });
		}
	});

	test("PATCH /vaults returns 404 for unknown path", async () =>
	{
		const machine = makeTestMachineConfig("test-host");
		const fakeRuntime = {
			getMachine: () => machine,
			updateVault: async () => { throw Object.assign(new Error("not found"), { status: 404 }); },
		};

		const app = express();
		app.use(express.json());
		registerAgentBuilderRoutes(app, {
			messageDB: {} as never,
			agentBuilderRuntime: fakeRuntime as never,
		});

		const missing = join(tmpdir(), "missing-vault-for-patch");
		await withServer(app, async (baseUrl) =>
		{
			const response = await fetch(`${baseUrl}/api/agent-builder/vaults`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: missing, name: "X", type: "Vault" }),
			});
			expect(response.status).toBe(404);
		});
	});
});
