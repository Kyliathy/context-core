/**
 * MCP registry — registers all tools and resources on a Server instance.
 *
 * Handles:
 * - ListTools    → returns tool definitions with JSON Schema inputs
 * - CallTool     → dispatches to the appropriate handler module
 * - ListResources → returns static resource definitions
 * - ReadResource  → dispatches to the resource reader
 *
 * Request tracing uses a stderr-safe logger so stdio MCP stdout stays protocol-clean.
 *
 * Upgrade plan: server/zz-reach2/upgrades/2026-06/r2wl-winston-logging.md (T50)
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import
{
	CallToolRequestSchema,
	ErrorCode,
	GetPromptRequestSchema,
	ListPromptsRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	McpError,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { IMessageStore } from "../db/IMessageStore.js";
import type { TopicStore } from "../settings/TopicStore.js";
import type { ScopeStore } from "../settings/ScopeStore.js";
import { getStderrLogger } from "../logging/logger.js";
import type { VectorServices } from "./MCPServer.js";
import { MESSAGE_TOOL_DEFINITIONS, handleMessageTool } from "./tools/messages.js";
import { SEARCH_TOOL_DEFINITIONS, handleSearchTool } from "./tools/search.js";
import { TOPIC_TOOL_DEFINITIONS, handleTopicTool } from "./tools/topics.js";
import { RESOURCE_DEFINITIONS, RESOURCE_TEMPLATE_DEFINITIONS, readResource } from "./resources/index.js";
import { PROMPT_DEFINITIONS, handlePrompt } from "./prompts/index.js";
import { logToolRequest, logToolCall, logToolError } from "./mcpLogger.js";

/** Stderr-safe logger for MCP request dispatch tracing. */
const logger = getStderrLogger("mcp:stdio");

/**
 * Logs an incoming MCP protocol request at debug level to keep stdio diagnostics quiet by default.
 * @param kind – request kind such as `tools/list` or `resources/read`.
 * @param detail – optional extra context (URI, prompt name, etc.).
 */
function logMcpRequest(kind: string, detail?: string): void
{
	const suffix = detail ? ` | ${detail}` : "";
	logger.debug(`[MCP/Req] ${kind}${suffix}`);
}

// ─── All tool definitions ─────────────────────────────────────────────────────

const ALL_TOOL_DEFINITIONS = [
	...MESSAGE_TOOL_DEFINITIONS,
	...SEARCH_TOOL_DEFINITIONS,
	...TOPIC_TOOL_DEFINITIONS,
];

// ─── Tool name sets for dispatch routing ─────────────────────────────────────

const MESSAGE_TOOL_NAMES = new Set(MESSAGE_TOOL_DEFINITIONS.map((t) => t.name));
const SEARCH_TOOL_NAMES = new Set(SEARCH_TOOL_DEFINITIONS.map((t) => t.name));
const TOPIC_TOOL_NAMES = new Set(TOPIC_TOOL_DEFINITIONS.map((t) => t.name));

/**
 * Registers all MCP tools and resources on the given Server instance.
 * @param server – the low-level MCP Server to register handlers on.
 * @param db – shared MessageDB instance.
 * @param topicStore – optional TopicStore (may be undefined when not running AI summarization).
 * @param vectorServices – optional Qdrant + embedding services for hybrid search.
 * @param scopeStore – optional ScopeStore for scope-aware search.
 */
export function registerAll(server: Server, db: IMessageStore, topicStore?: TopicStore, vectorServices?: VectorServices, scopeStore?: ScopeStore): void
{
	registerTools(server, db, topicStore, vectorServices, scopeStore);
	registerResources(server, db, topicStore);
	registerPrompts(server, db, topicStore);
}

// ─── Tool registration ────────────────────────────────────────────────────────

/**
 * Registers ListTools and CallTool handlers with module-based dispatch.
 * @param server – MCP Server instance.
 * @param db – message store for tool handlers.
 * @param topicStore – optional topic store.
 * @param vectorServices – optional vector search services.
 * @param scopeStore – optional scope store.
 */
function registerTools(server: Server, db: IMessageStore, topicStore?: TopicStore, vectorServices?: VectorServices, scopeStore?: ScopeStore): void
{
	// List tools: return all tool definitions with their schemas
	server.setRequestHandler(ListToolsRequestSchema, async () =>
	{
		logMcpRequest("tools/list");
		return { tools: ALL_TOOL_DEFINITIONS };
	});

	// Call tool: route to the correct handler module
	server.setRequestHandler(CallToolRequestSchema, async (request) =>
	{
		const { name, arguments: args } = request.params;
		const safeArgs = (args ?? {}) as Record<string, unknown>;
		const start = Date.now();

		logToolRequest(name, safeArgs);

		try
		{
			let text: string;

			if (MESSAGE_TOOL_NAMES.has(name))
			{
				text = handleMessageTool(name, safeArgs, db, topicStore);
			} else if (SEARCH_TOOL_NAMES.has(name))
			{
				text = await handleSearchTool(name, safeArgs, db, topicStore, vectorServices, scopeStore);
			} else if (TOPIC_TOOL_NAMES.has(name))
			{
				if (!topicStore)
				{
					logToolError(name, Date.now() - start, safeArgs, "TopicStore not available");
					return {
						content: [{ type: "text", text: "Topic store is not available." }],
						isError: true,
					};
				}
				text = handleTopicTool(name, safeArgs, topicStore);
			} else
			{
				throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
			}

			logToolCall({ tool: name, durationMs: Date.now() - start, request: safeArgs, responseText: text });
			return { content: [{ type: "text", text }] };
		} catch (error)
		{
			const duration = Date.now() - start;
			if (error instanceof McpError)
			{
				logToolError(name, duration, safeArgs, error.message, true);
				throw error;
			}
			const message = error instanceof Error ? error.message : String(error);
			logToolError(name, duration, safeArgs, message);
			return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
		}
	});
}

// ─── Resource registration ────────────────────────────────────────────────────

/**
 * Registers ListResources and ReadResource handlers.
 * @param server – MCP Server instance.
 * @param db – message store for resource readers.
 * @param topicStore – optional topic store.
 */
function registerResources(server: Server, db: IMessageStore, topicStore?: TopicStore): void
{
	// List resources: return static + template definitions
	server.setRequestHandler(ListResourcesRequestSchema, async () =>
	{
		logMcpRequest("resources/list");
		return {
			resources: RESOURCE_DEFINITIONS,
			resourceTemplates: RESOURCE_TEMPLATE_DEFINITIONS,
		};
	});

	// Read resource: route URI to the resource reader
	server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
	{
		const { uri } = request.params;
		logMcpRequest("resources/read", uri);

		try
		{
			const text = readResource(uri, db, topicStore);
			if (text === null)
			{
				throw new McpError(ErrorCode.InvalidRequest, `Unknown resource URI: ${uri}`);
			}

			return {
				contents: [{ uri, mimeType: "text/plain", text }],
			};
		} catch (error)
		{
			if (error instanceof McpError) throw error;
			const message = error instanceof Error ? error.message : String(error);
			throw new McpError(ErrorCode.InternalError, `Resource read failed: ${message}`);
		}
	});
}

// ─── Prompt registration ─────────────────────────────────────────────────────

/**
 * Registers ListPrompts and GetPrompt handlers.
 * @param server – MCP Server instance.
 * @param db – message store for prompt data.
 * @param topicStore – optional topic store.
 */
function registerPrompts(server: Server, db: IMessageStore, topicStore?: TopicStore): void
{
	// List prompts: return all prompt definitions
	server.setRequestHandler(ListPromptsRequestSchema, async () =>
	{
		logMcpRequest("prompts/list");
		return { prompts: PROMPT_DEFINITIONS };
	});

	// Get prompt: fetch fresh data and build structured context messages
	server.setRequestHandler(GetPromptRequestSchema, async (request) =>
	{
		const { name, arguments: args } = request.params;
		const safeArgs = (args ?? {}) as Record<string, string>;
		logMcpRequest("prompts/get", name);

		const result = handlePrompt(name, safeArgs, db, topicStore);
		// Cast to satisfy MCP SDK's index-signature requirement on the result type
		return result as typeof result & Record<string, unknown>;
	});
}
