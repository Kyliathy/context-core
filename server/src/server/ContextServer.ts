/**
 * ContextServer – Express API bootstrap for ContextCore.
 *
 * Architecture: server/zz-reach2/architecture/archi-context-core-level0.md
 * Logging: server/zz-reach2/upgrades/2026-06/r2wl-winston-logging.md
 */

import express from "express";
import { getLogger } from "../logging/logger.js";

const logger = getLogger("server:ContextServer");
import cors from "cors";
import type { Server } from "http";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { IMessageStore } from "../db/IMessageStore.js";
import type { EmbeddingService } from "../vector/EmbeddingService.js";
import type { QdrantService } from "../vector/QdrantService.js";
import { initSearchIndex } from "../search/searchEngine.js";
import type { TopicStore } from "../settings/TopicStore.js";
import type { AgentBuilder } from "../agentBuilder/AgentBuilder.js";
import type { AgentPublisher } from "../agentPublisher/AgentPublisher.js";
import type { ScopeStore } from "../settings/ScopeStore.js";
import type { FavoriteStore } from "../settings/FavoriteStore.js";
import type { SummaryEmbeddingCache } from "../vector/SummaryEmbeddingCache.js";
import type { RouteContext } from "./RouteContext.js";
import * as topicRoutes from "./routes/topicRoutes.js";
import * as scopeRoutes from "./routes/scopeRoutes.js";
import * as favoriteRoutes from "./routes/favoriteRoutes.js";
import * as sessionRoutes from "./routes/sessionRoutes.js";
import * as projectRoutes from "./routes/projectRoutes.js";
import * as messageRoutes from "./routes/messageRoutes.js";
import * as threadRoutes from "./routes/threadRoutes.js";
import * as agentBuilderRoutes from "./routes/agentBuilderRoutes.js";
import * as agentPublisherRoutes from "./routes/agentPublisherRoutes.js";

/**
 * Builds and starts the ContextCore API server.
 * @param messageDB - In-memory message database instance.
 * @param port - HTTP port to bind.
 * @param vectorServices - Optional vector search services (Qdrant + OpenAI embeddings).
 */
export async function startServer(
	messageDB: IMessageStore,
	port = 3210,
	vectorServices?: {
		embeddingService: EmbeddingService;
		qdrantService: QdrantService;
	},
	topicStore?: TopicStore,
	agentBuilder?: AgentBuilder,
	agentPublisher?: AgentPublisher,
	scopeStore?: ScopeStore,
	favoriteStore?: FavoriteStore,
	summaryEmbeddingCache?: SummaryEmbeddingCache
): Promise<{ server: Server; app: ReturnType<typeof express>; actualPort: number }>
{
	// Initialize search index with all messages
	let allMessages = messageDB.getAllMessages();
	initSearchIndex(allMessages, (id) => messageDB.getById(id));
	allMessages = [];

	const app = express();
	app.use(cors()); // Allow cross-origin requests from any origin
	app.use(express.json());

	// Log all incoming requests
	app.use((req, _res, next) =>
	{
		const hasQuery = Object.keys(req.query).length > 0;
		const hasBody = req.body && Object.keys(req.body).length > 0;

		let logMessage = `${req.method} ${req.path}`;

		if (hasQuery)
		{
			logMessage += ` | query: ${JSON.stringify(req.query)}`;
		}

		if (hasBody)
		{
			logMessage += ` | body: ${JSON.stringify(req.body)}`;
		}

		logger.debug(logMessage);
		next();
	});

	const ctx: RouteContext = {
		messageDB,
		topicStore,
		scopeStore,
		favoriteStore,
		agentBuilder,
		agentPublisher,
		summaryEmbeddingCache,
		vectorServices,
	};

	topicRoutes.register(app, ctx);
	scopeRoutes.register(app, ctx);
	favoriteRoutes.register(app, ctx);
	sessionRoutes.register(app, ctx);
	projectRoutes.register(app, ctx);
	messageRoutes.register(app, ctx);
	threadRoutes.register(app, ctx);
	agentBuilderRoutes.register(app, ctx);
	agentPublisherRoutes.register(app, ctx);

	const visualizerDist = resolve(dirname(fileURLToPath(import.meta.url)), "../../../visualizer/dist");
	app.use(express.static(visualizerDist, {
		/**
		 * Updates the value managed by setHeaders.
		 * @param res - Value consumed by setHeaders.
		 * @param filePath - Path used by setHeaders to locate the relevant CXC resource.
		 * @returns Result produced by setHeaders.
		 */
		setHeaders(res, filePath)
		{
			// Service worker files must never be aggressively cached — browsers re-check
			// on navigation, but a stale sw.js delays update detection.
			const base = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
			// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting HTTP API behavior from partial or invalid state.

			if (base === "sw.js" || base.startsWith("workbox-"))
			{
				res.setHeader("Cache-Control", "no-cache");
			}
		},
	}));

	// Try to bind on `port`, retrying up to PORT+10 on EADDRINUSE.
	const maxPort = port + 10;
	let currentPort = port;
	const { server, actualPort } = await new Promise<{ server: Server; actualPort: number }>((resolve, reject) =>
{
		/**
		 * Handles tryBind behavior for this CXC module.
		 */
		function tryBind(): void
		{
			const s = app.listen(currentPort, () =>
			{
				resolve({ server: s, actualPort: currentPort });
			});
			s.once("error", (err: NodeJS.ErrnoException) =>
			{
				// Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting HTTP API behavior from partial or invalid state.

				if (err.code === "EADDRINUSE" && currentPort < maxPort)
				{
					logger.warn(`Port ${currentPort} in use, trying ${currentPort + 1}...`);
					currentPort++;
					tryBind();
				}
				else if (err.code === "EADDRINUSE")
				{
					reject(new Error(`[Server] All ports ${port}–${maxPort} are in use. Cannot start.`));
				}
				else
				{
					reject(err);
				}
			});
		}
		tryBind();
	});

	if (actualPort !== port)
	{
		logger.info(`Preferred port ${port} was in use; bound to ${actualPort} instead.`);
	}
	logger.info(`ContextCore API listening on http://localhost:${actualPort}`);

	const maybeRef = server as unknown as { ref?: () => void };
	if (typeof maybeRef.ref === "function")
	{
		maybeRef.ref();
	}
	return { server, app, actualPort };
}
