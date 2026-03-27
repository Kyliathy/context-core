/**
 * MCP registry — registers all tools and resources on a Server instance.
 *
 * Handles:
 * - ListTools    → returns tool definitions with JSON Schema inputs
 * - CallTool     → dispatches to the appropriate handler module
 * - ListResources → returns static resource definitions
 * - ReadResource  → dispatches to the resource reader
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
import type { VectorServices } from "./MCPServer.js";
import { MESSAGE_TOOL_DEFINITIONS, handleMessageTool } from "./tools/messages.js";
import { SEARCH_TOOL_DEFINITIONS, handleSearchTool } from "./tools/search.js";
import { TOPIC_TOOL_DEFINITIONS, handleTopicTool } from "./tools/topics.js";
import { RESOURCE_DEFINITIONS, RESOURCE_TEMPLATE_DEFINITIONS, readResource } from "./resources/index.js";
import { PROMPT_DEFINITIONS, handlePrompt } from "./prompts/index.js";
import { logToolRequest, logToolCall, logToolError } from "./mcpLogger.js";

function logMcpRequest(kind: string, detail?: string): void
{
	const suffix = detail ? ` | ${detail}` : "";
	process.stderr.write(`[MCP/Req] ${kind}${suffix}\n`);
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
 * @param server - The low-level MCP Server to register handlers on.
 * @param db - Shared MessageDB instance.
 * @param topicStore - Optional TopicStore (may be undefined when not running AI summarization).
 */
export function registerAll(server: Server, db: IMessageStore, topicStore?: TopicStore, vectorServices?: VectorServices, scopeStore?: ScopeStore): void
{
	registerTools(server, db, topicStore, vectorServices, scopeStore);
	registerResources(server, db, topicStore);
	registerPrompts(server, db, topicStore);
}

// ─── Tool registration ────────────────────────────────────────────────────────

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
