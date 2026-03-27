import type { Express } from "express";
import type { RouteContext } from "../RouteContext.js";
import { resolveSubject } from "../routeUtils.js";

export function register(app: Express, ctx: RouteContext): void
{
	app.get("/api/sessions/:sessionId", (req, res) =>
	{
		const messages = ctx.messageDB.getBySessionId(req.params.sessionId);
		res.json(messages.map((message) =>
		{
			const serialized = message.serialize();
			serialized.subject = resolveSubject(message.sessionId, message.subject, ctx.topicStore);
			return serialized;
		}));
	});

	app.get("/api/sessions", (_req, res) =>
	{
		res.json(ctx.messageDB.listSessions());
	});
}
