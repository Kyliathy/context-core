import type { Express } from "express";
import type { RouteContext } from "../RouteContext.js";
import { CCSettings } from "../../settings/CCSettings.js";

export function register(app: Express, ctx: RouteContext): void
{
	app.post("/api/agent-builder/prepare", (req, res) =>
	{
		if (!ctx.agentBuilder)
		{
			res.json({ error: "No data sources defined" });
			return;
		}

		const body = req.body as { name?: unknown };
		const filterName = typeof body.name === "string" && body.name.trim() !== ""
			? body.name.trim()
			: undefined;

		const response = ctx.agentBuilder.prepare(filterName);
		res.json(response);
	});

	app.post("/api/agent-builder/create", (req, res) =>
	{
		if (!ctx.agentBuilder)
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

		if (!projectName) { res.status(400).json({ error: "projectName is required" }); return; }
		if (!agentName) { res.status(400).json({ error: "agentName is required" }); return; }
		if (!description) { res.status(400).json({ error: "description is required" }); return; }
		if (!argumentHint) { res.status(400).json({ error: "argument-hint is required" }); return; }
		if (!platform) { res.status(400).json({ error: "platform is required" }); return; }
		if (platform !== "github" && platform !== "claude" && platform !== "codex")
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
			const result = ctx.agentBuilder.create({
				projectName,
				agentName,
				description,
				"argument-hint": argumentHint,
				tools,
				agentKnowledge,
				codexDirectory: codexDirectory || undefined,
				codexEntryId: codexEntryId || undefined,
				platform,
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
		if (!ctx.agentBuilder)
		{
			res.status(404).json({ error: "AgentBuilder not available (no dataSources configured)" });
			return;
		}

		res.json(ctx.agentBuilder.list());
	});

	app.get("/api/agent-builder/get-agent", (req, res) =>
	{
		if (!ctx.agentBuilder)
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
			res.json(ctx.agentBuilder.getAgent(agentPath, codexEntryId || undefined));
		} catch (error)
		{
			const status = (error as { status?: number }).status ?? 500;
			res.status(status).json({ error: (error as Error).message });
		}
	});

	app.get("/api/agent-builder/get-file-content", (req, res) =>
	{
		if (!ctx.agentBuilder)
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
			res.json(ctx.agentBuilder.getFileContent(filePath));
		} catch (error)
		{
			const status = (error as { status?: number }).status ?? 500;
			res.status(status).json({ error: (error as Error).message });
		}
	});

	app.post("/api/agent-builder/add-template", (req, res) =>
	{
		if (!ctx.agentBuilder)
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
		const result = ctx.agentBuilder.addTemplate(settings.storage, {
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
		if (!ctx.agentBuilder)
		{
			res.status(404).json({ error: "AgentBuilder not available (no dataSources configured)" });
			return;
		}

		const settings = CCSettings.getInstance();
		res.json(ctx.agentBuilder.listTemplates(settings.storage));
	});
}
