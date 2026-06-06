import type { Express } from "express";
import type { RouteContext } from "../RouteContext.js";
import type { CanonicalAgentDefinition, PublishTarget } from "../../agentPublisher/types.js";

/** Normalizes thrown route errors into HTTP status + message. */
function routeError(error: unknown): { status: number; message: string }
{
	const status = (error as { status?: number }).status ?? 500;
	return { status, message: (error as Error).message || "Internal server error" };
}

export function register(app: Express, ctx: RouteContext): void
{
	app.get("/api/agent-publisher/platforms", (req, res) =>
	{
		if (!ctx.agentPublisher)
		{
			res.status(404).json({ error: "AgentPublisher not available" });
			return;
		}
		const projectName = typeof req.query.projectName === "string" ? req.query.projectName.trim() : undefined;
		try
		{
			res.json({ platforms: ctx.agentPublisher.getPlatforms(projectName || undefined) });
		} catch (error)
		{
			const { status, message } = routeError(error);
			res.status(status).json({ error: message });
		}
	});

	app.get("/api/agent-publisher/tree", (req, res) =>
	{
		if (!ctx.agentPublisher)
		{
			res.status(404).json({ error: "AgentPublisher not available" });
			return;
		}
		const projectName = typeof req.query.projectName === "string" ? req.query.projectName.trim() : "";
		if (!projectName)
		{
			res.status(400).json({ error: "projectName query parameter is required" });
			return;
		}
		try
		{
			res.json({ tree: ctx.agentPublisher.getTree(projectName) });
		} catch (error)
		{
			const { status, message } = routeError(error);
			res.status(status).json({ error: message });
		}
	});

	app.post("/api/agent-publisher/heat", (req, res) =>
	{
		if (!ctx.agentPublisher)
		{
			res.status(404).json({ error: "AgentPublisher not available" });
			return;
		}
		const body = req.body as { definition?: CanonicalAgentDefinition };
		if (!body.definition)
		{
			res.status(400).json({ error: "definition is required" });
			return;
		}
		try
		{
			res.json(ctx.agentPublisher.computeHeat(body.definition));
		} catch (error)
		{
			const { status, message } = routeError(error);
			res.status(status).json({ error: message });
		}
	});

	app.post("/api/agent-publisher/preview", (req, res) =>
	{
		if (!ctx.agentPublisher)
		{
			res.status(404).json({ error: "AgentPublisher not available" });
			return;
		}
		const body = req.body as { definition?: CanonicalAgentDefinition; targets?: PublishTarget[] };
		if (!body.definition)
		{
			res.status(400).json({ error: "definition is required" });
			return;
		}
		if (!Array.isArray(body.targets) || body.targets.length === 0)
		{
			res.status(400).json({ error: "targets must be a non-empty array" });
			return;
		}
		try
		{
			res.json(ctx.agentPublisher.preview(body.definition, body.targets));
		} catch (error)
		{
			const { status, message } = routeError(error);
			res.status(status).json({ error: message });
		}
	});

	app.post("/api/agent-publisher/publish", (req, res) =>
	{
		if (!ctx.agentPublisher)
		{
			res.status(404).json({ error: "AgentPublisher not available" });
			return;
		}
		const body = req.body as { definition?: CanonicalAgentDefinition; targets?: PublishTarget[] };
		if (!body.definition)
		{
			res.status(400).json({ error: "definition is required" });
			return;
		}
		if (!Array.isArray(body.targets) || body.targets.length === 0)
		{
			res.status(400).json({ error: "targets must be a non-empty array" });
			return;
		}
		try
		{
			const result = ctx.agentPublisher.publish(body.definition, body.targets);
			const status = result.errors.length > 0 ? 400 : 201;
			res.status(status).json(result);
		} catch (error)
		{
			const { status, message } = routeError(error);
			res.status(status).json({ error: message });
		}
	});

	app.get("/api/agent-publisher/drift", (req, res) =>
	{
		if (!ctx.agentPublisher)
		{
			res.status(404).json({ error: "AgentPublisher not available" });
			return;
		}
		const canonicalId = typeof req.query.canonicalId === "string" ? req.query.canonicalId.trim() : "";
		if (!canonicalId)
		{
			res.status(400).json({ error: "canonicalId query parameter is required" });
			return;
		}
		try
		{
			res.json(ctx.agentPublisher.detectDrift(canonicalId));
		} catch (error)
		{
			const { status, message } = routeError(error);
			res.status(status).json({ error: message });
		}
	});

	app.post("/api/agent-publisher/drift", (req, res) =>
	{
		if (!ctx.agentPublisher)
		{
			res.status(404).json({ error: "AgentPublisher not available" });
			return;
		}
		const body = req.body as { canonicalId?: string; definition?: CanonicalAgentDefinition };
		const canonicalId = typeof body.canonicalId === "string" ? body.canonicalId.trim() : "";
		if (!canonicalId)
		{
			res.status(400).json({ error: "canonicalId is required" });
			return;
		}
		try
		{
			res.json(ctx.agentPublisher.detectDrift(canonicalId, body.definition));
		} catch (error)
		{
			const { status, message } = routeError(error);
			res.status(status).json({ error: message });
		}
	});
}
