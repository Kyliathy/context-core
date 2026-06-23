/**
 * MCPServer — wraps the MCP SDK Server with stdio transport.
 *
 * Usage (integrated with ContextCore):
 *   const mcpServer = new MCPServer(messageDB, topicStore);
 *   await mcpServer.start();   // begins listening on stdio
 *   ...
 *   await mcpServer.close();   // on shutdown
 *
 * Stdio transport uses stdin/stdout for the MCP protocol; all diagnostics
 * go through a stderr-safe Winston logger so stdout stays protocol-clean.
 *
 * Upgrade plan: server/zz-reach2/upgrades/2026-06/r2wl-winston-logging.md (T49)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { join } from "path";
import type { IMessageStore } from "../db/IMessageStore.js";
import type { TopicStore } from "../settings/TopicStore.js";
import type { ScopeStore } from "../settings/ScopeStore.js";
import type { EmbeddingService } from "../vector/EmbeddingService.js";
import type { QdrantService } from "../vector/QdrantService.js";
import { getStderrLogger } from "../logging/logger.js";
import { registerAll } from "./registry.js";
import { initMcpLogger } from "./mcpLogger.js";

/** Stderr-safe logger — never writes MCP diagnostics to stdout. */
const logger = getStderrLogger("mcp:stdio");

/** Optional Qdrant + embedding services for hybrid search. */
export type VectorServices = {
	embeddingService: EmbeddingService;
	qdrantService: QdrantService;
};

export class MCPServer
{
	private readonly server: Server;
	private transport: StdioServerTransport | null = null;

	/**
	 * Builds the MCP Server, registers tools/resources/prompts, and initializes optional file logging.
	 * @param db – shared message store for tool handlers.
	 * @param topicStore – optional topic store for subject resolution.
	 * @param vectorServices – optional Qdrant + embedding pair for hybrid search.
	 * @param mcpLoggingEnabled – when true, enables JSON tool-call file logging.
	 * @param scopeStore – optional scope store for scope-aware search.
	 */
	constructor(
		private readonly db: IMessageStore,
		private readonly topicStore?: TopicStore,
		private readonly vectorServices?: VectorServices,
		mcpLoggingEnabled = false,
		private readonly scopeStore?: ScopeStore
	)
	{
		this.server = new Server(
			{ name: "context-core", version: "0.1.0" },
			{
				capabilities: {
					tools: {},
					resources: {},
					prompts: {},
				},
			}
		);

		registerAll(this.server, db, topicStore, vectorServices, scopeStore);

		const toolCount = 10; // search(2) + messages(5) + topics(3)
		const resourceCount = 3 + 1; // static(3) + template(1)
		const promptCount = 4; // explore_history, summarize_session, find_decisions, debug_history
		logger.info(`[MCP] Registered ${toolCount} tools, ${resourceCount} resources, and ${promptCount} prompts`);

		initMcpLogger(join(process.cwd(), "logs"), mcpLoggingEnabled);
	}

	/**
	 * Connects to stdio and starts the MCP server.
	 * @returns Promise that resolves when the transport closes.
	 */
	async start(): Promise<void>
	{
		this.transport = new StdioServerTransport();
		await this.server.connect(this.transport);
		logger.info("[MCP] Server running on stdio");
	}

	/**
	 * Closes the MCP server and its transport.
	 */
	async close(): Promise<void>
	{
		try
		{
			await this.server.close();
		} catch
		{
			// Ignore close errors during shutdown.
		}
	}
}
