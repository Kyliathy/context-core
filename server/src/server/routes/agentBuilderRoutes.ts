/**
 * Agent Builder REST routes — canonical catalog, vault browser, and legacy artifact APIs.
 *
 * Architecture: server/zz-reach2/architecture/agents/archi-agent-builder.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ap-agent-publisher-2.md, r2ve-vault-explorer.md
 */

import type { Express } from "express";
import type { RouteContext } from "../RouteContext.js";
import { CCSettings } from "../../settings/CCSettings.js";
import { getHostname } from "../../config.js";
import {
	inspectVaultPath,
	listVaultChildren,
	listVaultRoots,
} from "../../agentBuilder/vaultBrowser.js";
import { configuredVaultPaths } from "../../agentBuilder/dataSourceMutation.js";
import type { UpdateVaultInput } from "../../agentBuilder/dataSourceMutation.js";
import type { AddVaultInput } from "../../agentBuilder/vaultDefaults.js";

/** Normalizes thrown route errors into HTTP status + message. */
function routeError(error: unknown): { status: number; message: string }
{
	const status = (error as { status?: number }).status ?? 500;
	return { status, message: (error as Error).message || "Internal server error" };
}

/** Resolves live AgentBuilder from runtime (refreshed after Add Vault) or startup snapshot. */
function resolveAgentBuilder(ctx: RouteContext)
{
	return ctx.agentBuilderRuntime?.getAgentBuilder() ?? ctx.agentBuilder;
}

export function register(app: Express, ctx: RouteContext): void
{
	app.post("/api/agent-builder/prepare", (req, res) =>
	{
		const agentBuilder = resolveAgentBuilder(ctx);
		if (!agentBuilder)
		{
			res.json({ error: "No data sources defined" });
			return;
		}

		const body = req.body as { name?: unknown };
		const filterName = typeof body.name === "string" && body.name.trim() !== ""
			? body.name.trim()
			: undefined;

		const response = agentBuilder.prepare(filterName);
		res.json(response);
	});

	app.post("/api/agent-builder/create", (req, res) =>
	{
		const agentBuilder = resolveAgentBuilder(ctx);
		if (!agentBuilder)
		{
			res.status(404).json({ error: "AgentBuilder not available (no dataSources configured)" });
			return;
		}

		const body = req.body as Record<string, unknown>;
		const projectName = typeof body.projectName === "string" ? body.projectName.trim() : "";
		const agentName = typeof body.agentName === "string" ? body.agentName.trim() : "";
		const description = typeof body.description === "string" ? body.description.trim() : "";
		const argumentHint = typeof body["argument-hint"] === "string" ? body["argument-hint"].trim() : "";
		const platform = typeof body.platform === "string" ? body.platform.trim() : "";
		const codexDirectory = typeof body.codexDirectory === "string" ? body.codexDirectory.trim() : "";
		const codexEntryId = typeof body.codexEntryId === "string" ? body.codexEntryId.trim() : "";
		const canonicalId = typeof body.canonicalId === "string" ? body.canonicalId.trim() : "";

		if (!projectName) { res.status(400).json({ error: "projectName is required" }); return; }
		if (!agentName) { res.status(400).json({ error: "agentName is required" }); return; }
		if (!description) { res.status(400).json({ error: "description is required" }); return; }
		if (!argumentHint) { res.status(400).json({ error: "argument-hint is required" }); return; }
		if (platform && platform !== "github" && platform !== "claude" && platform !== "codex")
		{
			res.status(400).json({ error: "platform must be \"github\", \"claude\", or \"codex\"" });
			return;
		}

		const rawTools = Array.isArray(body.tools) ? body.tools : [];
		const tools: string[] = rawTools.filter((t): t is string => typeof t === "string" && t.trim() !== "").map((t) => t.trim());

		const rawKnowledge = Array.isArray(body.agentKnowledge) ? body.agentKnowledge : [];
		const agentKnowledge: string[] = rawKnowledge.filter((k): k is string => typeof k === "string").map((k) => k.trim()).filter(Boolean);

		try
		{
			const result = agentBuilder.create({
				projectName,
				agentName,
				description,
				"argument-hint": argumentHint,
				tools,
				agentKnowledge,
				codexDirectory: codexDirectory || undefined,
				codexEntryId: codexEntryId || undefined,
				canonicalId: canonicalId || undefined,
				platform: platform ? (platform as "github" | "claude" | "codex") : undefined,
			});
			res.status(201).json(result);
		} catch (error)
		{
			const status = (error as { status?: number }).status ?? 500;
			res.status(status).json({ error: (error as Error).message });
		}
	});

	app.get("/api/agent-builder/list", (_req, res) =>
	{
		if (!ctx.agentBuilderRuntime)
		{
			res.status(404).json({ error: "AgentBuilder runtime not available" });
			return;
		}

		res.json(ctx.agentBuilderRuntime.listCanonicalAgents());
	});

	app.get("/api/agent-builder/get-definition", (req, res) =>
	{
		const canonicalId = typeof req.query.canonicalId === "string" ? req.query.canonicalId.trim() : "";
		if (!canonicalId)
		{
			res.status(400).json({ error: "canonicalId query parameter is required" });
			return;
		}

		const definition = ctx.agentBuilderRuntime?.getCanonicalDefinition(canonicalId)
			?? ctx.agentBuilder?.getCanonicalDefinition(canonicalId);
		if (!definition)
		{
			res.status(404).json({ error: `No canonical definition found for id "${canonicalId}"` });
			return;
		}

		res.json({ definition });
	});

	app.get("/api/agent-builder/get-agent", (req, res) =>
	{
		const agentBuilder = resolveAgentBuilder(ctx);
		if (!agentBuilder)
		{
			res.status(404).json({ error: "AgentBuilder not available (no dataSources configured)" });
			return;
		}

		const agentPath = typeof req.query.path === "string" ? req.query.path.trim() : "";
		const codexEntryId = typeof req.query.codexEntryId === "string" ? req.query.codexEntryId.trim() : "";
		if (!agentPath)
		{
			res.status(400).json({ error: "path query parameter is required" });
			return;
		}

		try
		{
			res.json(agentBuilder.getAgent(agentPath, codexEntryId || undefined));
		} catch (error)
		{
			const status = (error as { status?: number }).status ?? 500;
			res.status(status).json({ error: (error as Error).message });
		}
	});

	app.get("/api/agent-builder/get-file-content", (req, res) =>
	{
		const agentBuilder = resolveAgentBuilder(ctx);
		if (!agentBuilder)
		{
			res.status(404).json({ error: "AgentBuilder not available (no dataSources configured)" });
			return;
		}

		const filePath = typeof req.query.path === "string" ? req.query.path.trim() : "";
		if (!filePath)
		{
			res.status(400).json({ error: "path query parameter is required" });
			return;
		}

		try
		{
			res.json(agentBuilder.getFileContent(filePath));
		} catch (error)
		{
			const status = (error as { status?: number }).status ?? 500;
			res.status(status).json({ error: (error as Error).message });
		}
	});

	app.get("/api/agent-builder/vault-roots", (_req, res) =>
	{
		try
		{
			res.json(listVaultRoots());
		} catch (error)
		{
			const { status, message } = routeError(error);
			res.status(status).json({ error: message });
		}
	});

	app.get("/api/agent-builder/vault-children", (req, res) =>
	{
		const path = typeof req.query.path === "string" ? req.query.path : "";
		try
		{
			res.json(listVaultChildren(path));
		} catch (error)
		{
			const { status, message } = routeError(error);
			res.status(status).json({ error: message });
		}
	});

	app.get("/api/agent-builder/vault-info", (req, res) =>
	{
		const path = typeof req.query.path === "string" ? req.query.path : "";
		try
		{
			const machine = ctx.agentBuilderRuntime?.getMachine();
			const configured = machine ? configuredVaultPaths(machine) : new Set<string>();
			res.json(inspectVaultPath(path, configured));
		} catch (error)
		{
			const { status, message } = routeError(error);
			res.status(status).json({ error: message });
		}
	});

	app.post("/api/agent-builder/vaults", async (req, res) =>
	{
		if (!ctx.agentBuilderRuntime)
		{
			res.status(503).json({ error: "AgentBuilder runtime not available" });
			return;
		}

		const body = req.body as AddVaultInput;
		const machineName = ctx.agentBuilderRuntime.getMachine().machine || getHostname();

		try
		{
			const result = await ctx.agentBuilderRuntime.addVault(machineName, body);
			res.status(201).json(result);
		} catch (error)
		{
			const { status, message } = routeError(error);
			res.status(status).json({ error: message });
		}
	});

	app.patch("/api/agent-builder/vaults", async (req, res) =>
	{
		if (!ctx.agentBuilderRuntime)
		{
			res.status(503).json({ error: "AgentBuilder runtime not available" });
			return;
		}

		const body = req.body as UpdateVaultInput;
		const machineName = ctx.agentBuilderRuntime.getMachine().machine || getHostname();

		try
		{
			const result = await ctx.agentBuilderRuntime.updateVault(machineName, body);
			res.json(result);
		} catch (error)
		{
			const { status, message } = routeError(error);
			res.status(status).json({ error: message });
		}
	});

	app.post("/api/agent-builder/add-template", (req, res) =>
	{
		const agentBuilder = resolveAgentBuilder(ctx);
		if (!agentBuilder)
		{
			res.status(404).json({ error: "AgentBuilder not available (no dataSources configured)" });
			return;
		}

		const body = req.body as Record<string, unknown>;
		const templateName = typeof body.templateName === "string" ? body.templateName.trim() : "";
		const description = typeof body.description === "string" ? body.description.trim() : "";
		const argumentHint = typeof body["argument-hint"] === "string" ? body["argument-hint"].trim() : "";

		if (!templateName) { res.status(400).json({ error: "templateName is required" }); return; }
		if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(templateName)) { res.status(400).json({ error: "templateName must be a valid slug (lowercase letters, numbers, hyphens)" }); return; }
		if (!description) { res.status(400).json({ error: "description is required" }); return; }
		if (!argumentHint) { res.status(400).json({ error: "argument-hint is required" }); return; }
		if (!Array.isArray(body.agentKnowledge)) { res.status(400).json({ error: "agentKnowledge must be an array" }); return; }

		const rawTools = Array.isArray(body.tools) ? body.tools : [];
		const tools: string[] = rawTools.filter((t): t is string => typeof t === "string" && t.trim() !== "").map((t) => t.trim());
		const agentKnowledge: string[] = (body.agentKnowledge as unknown[]).filter((k): k is string => typeof k === "string").map((k) => k.trim()).filter(Boolean);

		const settings = CCSettings.getInstance();
		const result = agentBuilder.addTemplate(settings.storage, {
			templateName,
			description,
			"argument-hint": argumentHint,
			tools,
			agentKnowledge,
		});
		res.status(201).json(result);
	});

	app.get("/api/agent-builder/list-templates", (_req, res) =>
	{
		const agentBuilder = resolveAgentBuilder(ctx);
		if (!agentBuilder)
		{
			res.status(404).json({ error: "AgentBuilder not available (no dataSources configured)" });
			return;
		}

		const settings = CCSettings.getInstance();
		res.json(agentBuilder.listTemplates(settings.storage));
	});
}
