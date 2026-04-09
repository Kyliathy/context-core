/**
 * SSE transport manager for MCP over HTTP.
 *
 * Mounts two Express routes on the existing :3210 server:
 *   GET  /mcp/sse      — establishes an SSE stream (one per client session)
 *   POST /mcp/messages  — receives JSON-RPC messages from the client
 *
 * Each SSE connection gets its own MCP Server + SSEServerTransport pair,
 * all sharing the same MessageDB and TopicStore (read-heavy, single writer).
 *
 * Optional bearer token authentication via MCP_AUTH_TOKEN env var:
 *   curl -H "Authorization: Bearer <token>" http://localhost:3210/mcp/sse
 *
 * CORS is inherited from the parent Express app's cors() middleware.
 */

import type { Express, Request, Response } from "express";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import chalk from "chalk";
import type { IMessageStore } from "../../db/IMessageStore.js";
import type { TopicStore } from "../../settings/TopicStore.js";
import type { ScopeStore } from "../../settings/ScopeStore.js";
import type { VectorServices } from "../MCPServer.js";
import { registerAll } from "../registry.js";

interface SseSession
{
	transport: SSEServerTransport;
	server: Server;
}

/** Active SSE sessions, keyed by MCP session ID. */
const sessions = new Map<string, SseSession>();

function logMcpSseInfo(message: string): void
{
	console.log(chalk.blue(message));
}

/**
 * Validates bearer token authentication if MCP_AUTH_TOKEN is set.
 * Returns true if the request is authorized, false otherwise (and sends 401).
 */
function checkAuth(req: Request, res: Response): boolean
{
	const token = process.env.MCP_AUTH_TOKEN;
	if (!token) return true; // No auth configured — allow all

	const authHeader = req.headers.authorization;
	if (!authHeader || authHeader !== `Bearer ${token}`)
	{
		res.status(401).json({ error: "Unauthorized: invalid or missing Bearer token" });
		return false;
	}
	return true;
}

/**
 * Mounts MCP SSE transport routes on an existing Express app.
 *
 * This enables network MCP clients (remote agents, web clients) to connect
 * to ContextCore over HTTP/SSE, complementing the stdio transport used by
 * local clients (Claude Code, Cursor).
 *
 * @param app - Express application to mount routes on.
 * @param db - Shared MessageDB instance.
 * @param topicStore - Optional TopicStore for topic resolution.
 * @param vectorServices - Optional Qdrant + embedding services (hybrid search).
 * @param scopeStore - Optional ScopeStore for scope-aware search (`scope` param).
 */
export function mountMcpSse(
	app: Express,
	db: IMessageStore,
	topicStore?: TopicStore,
	vectorServices?: VectorServices,
	scopeStore?: ScopeStore
): void
{
	// GET /mcp/sse — establish SSE stream for a new MCP client session
	app.get("/mcp/sse", async (req: Request, res: Response) =>
	{
		if (!checkAuth(req, res)) return;

		// Create a fresh MCP Server instance for this client session
		const server = new Server(
			{ name: "context-core", version: "0.1.0" },
			{
				capabilities: {
					tools: {},
					resources: {},
					prompts: {},
				},
			}
		);
		registerAll(server, db, topicStore, vectorServices, scopeStore);

		// Create SSE transport pointing to the POST endpoint for messages
		const transport = new SSEServerTransport(
			"/mcp/messages",
			res as unknown as ServerResponse
		);

		const sessionId = transport.sessionId;
		sessions.set(sessionId, { transport, server });

		logMcpSseInfo(`[MCP/SSE] New session: ${sessionId} (${sessions.size} active)`);

		// Cleanup on transport close (client disconnect)
		transport.onclose = () =>
		{
			sessions.delete(sessionId);
			logMcpSseInfo(`[MCP/SSE] Session closed: ${sessionId} (${sessions.size} active)`);
		};

		// Safety net: also clean up if the underlying HTTP connection drops
		res.on("close", () =>
		{
			if (sessions.has(sessionId))
			{
				sessions.delete(sessionId);
				server.close().catch(() => { /* ignore */ });
				logMcpSseInfo(`[MCP/SSE] HTTP connection dropped: ${sessionId} (${sessions.size} active)`);
			}
		});

		try
		{
			await server.connect(transport);
		} catch (err)
		{
			console.error(`[MCP/SSE] Connection error for ${sessionId}:`, err);
			sessions.delete(sessionId);
		}
	});

	// POST /mcp/messages?sessionId=X — receive JSON-RPC messages from client
	app.post("/mcp/messages", async (req: Request, res: Response) =>
	{
		if (!checkAuth(req, res)) return;

		const sessionId = req.query.sessionId as string;
		const method = typeof req.body?.method === "string" ? req.body.method : "unknown";
		const requestId = req.body?.id !== undefined ? String(req.body.id) : "(notification)";
		logMcpSseInfo(`[MCP/SSE] Incoming message: session=${sessionId ?? "missing"} method=${method} id=${requestId}`);
		if (!sessionId)
		{
			res.status(400).json({ error: "Missing sessionId query parameter" });
			return;
		}

		const session = sessions.get(sessionId);
		if (!session)
		{
			res.status(404).json({ error: `Unknown or expired session: ${sessionId}` });
			return;
		}

		try
		{
			await session.transport.handlePostMessage(
				req as unknown as IncomingMessage,
				res as unknown as ServerResponse,
				req.body
			);
		} catch (err)
		{
			console.error(`[MCP/SSE] Message handling error for ${sessionId}:`, err);
			if (!res.headersSent)
			{
				res.status(500).json({ error: "Internal MCP transport error" });
			}
		}
	});

	logMcpSseInfo(`[MCP/SSE] Routes mounted: GET /mcp/sse, POST /mcp/messages`);
	if (process.env.MCP_AUTH_TOKEN)
	{
		logMcpSseInfo(`[MCP/SSE] Bearer token authentication enabled`);
	}
}
