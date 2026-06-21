/**
 * Standalone MCP server entry point.
 *
 * Starts ContextCore's MCP server in stdio mode WITHOUT running the full
 * ingestion pipeline or Express HTTP server. Loads the message corpus from
 * persisted JSON storage and initializes the Fuse.js search index, then
 * begins serving MCP requests on stdin/stdout.
 *
 * Usage:
 *   bun run mcp           (via package.json script)
 *   bun run src/mcp/serve.ts
 *
 * MCP client configuration (Claude Code):
 *   {
 *     "context-core": {
 *       "command": "bun",
 *       "args": ["run", "src/mcp/serve.ts"],
 *       "cwd": "<project root>"
 *     }
 *   }
 *
 * Upgrade plan: server/zz-reach2/upgrades/2026-06/r2wl-winston-logging.md (T53)
 */

import { CCSettings } from "../settings/CCSettings.js";
import { createMessageStore } from "../db/IMessageStore.js";
import { TopicStore } from "../settings/TopicStore.js";
import { ScopeStore } from "../settings/ScopeStore.js";
import { initSearchIndex } from "../search/searchEngine.js";
import { getVectorConfig, isQdrantEnabled } from "../vector/VectorConfig.js";
import { EmbeddingService } from "../vector/EmbeddingService.js";
import { QdrantService } from "../vector/QdrantService.js";
import { getHostname } from "../config.js";
import { getStderrLogger, serializeError } from "../logging/logger.js";
import { MCPServer } from "./MCPServer.js";

/** Stderr-safe logger for standalone MCP startup and shutdown diagnostics. */
const logger = getStderrLogger("mcp:serve");

/**
 * Boots the standalone stdio MCP server: load stores, init search, connect transport.
 */
async function main(): Promise<void>
{
	const settings = CCSettings.getInstance();
	if (!settings.MCP_ENABLED)
	{
		logger.info("[MCP] Disabled via MCP_ENABLED=false");
		return;
	}

	// Load message corpus from persisted storage (no ingestion pipeline)
	const db = await createMessageStore(settings);
	const loadedCount = db.loadFromStorage(settings.storage);
	logger.info(`[MCP] Loaded ${loadedCount} messages from storage`);

	// Initialize Fuse.js search index
	let allMessages = db.getAllMessages();
	initSearchIndex(allMessages, (id) => db.getById(id));
	allMessages = [];

	// Load topic store for subject resolution and topic management
	const topicStore = new TopicStore(settings.storage);
	topicStore.load();
	logger.info(`[MCP] Loaded ${topicStore.count} topic entries`);

	// Load scope store for scope-aware search
	const scopeStore = new ScopeStore(settings.storage);
	scopeStore.load();
	logger.info(`[MCP] Loaded ${scopeStore.list().length} scope entries`);

	// Optionally initialize Qdrant/Embedding services (same gate as HTTP server)
	let vectorServices: { embeddingService: EmbeddingService; qdrantService: QdrantService } | undefined;

	if (isQdrantEnabled())
	{
		const vectorConfig = getVectorConfig();
		const hostname = getHostname();
		const embeddingService = new EmbeddingService(vectorConfig.openaiApiKey!);
		const qdrantService = new QdrantService(vectorConfig.qdrantUrl!, vectorConfig.qdrantApiKey, hostname);
		vectorServices = { embeddingService, qdrantService };
		logger.info(`[MCP] Qdrant enabled: ${vectorConfig.qdrantUrl}`);
	}

	// Start MCP server on stdio
	const mcpServer = new MCPServer(db, topicStore, vectorServices, settings.MCP_LOGGING, scopeStore);

	/**
	 * Handles shutdown behavior for this CXC module.
	 * @returns Result produced by shutdown.
	 */


	// Graceful shutdown
	const shutdown = async () =>
	{
		logger.info("[MCP] Shutting down…");
		await mcpServer.close();
		db.close();
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	await mcpServer.start();
}

main().catch((err) =>
{
	logger.error("[MCP] Fatal startup error", { error: serializeError(err) });
	process.exit(1);
});
