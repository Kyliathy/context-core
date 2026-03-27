import { DateTime } from "luxon";
import type { ToolCall } from "../types.js";

/** Role values supported by normalized chat messages. */
export type AgentRole = "user" | "assistant" | "tool" | "system";

/** Token usage payload when the source harness includes usage metrics. */
export type TokenUsage = {
	input: number | null;
	output: number | null;
};

/** Constructor payload for creating an AgentMessage instance. */
export type AgentMessageParams = {
	id: string;
	sessionId: string;
	harness: string;
	machine: string;
	role: AgentRole;
	model: string | null;
	message: string;
	subject: string;
	context: string[];
	symbols: string[];
	history: string[];
	tags: string[];
	project: string;
	parentId: string | null;
	tokenUsage: TokenUsage | null;
	toolCalls: ToolCall[];
	rationale: string[];
	source: string;
	dateTime: DateTime;
	length: number;
};

/** Serializable representation of AgentMessage persisted in JSON. */
export type SerializedAgentMessage = Omit<AgentMessageParams, "dateTime"> & {
	dateTime: string;
};

/** Domain model for a normalized user/assistant/tool chat turn. */
export class AgentMessage
{
	id: string;
	sessionId: string;
	harness: string;
	machine: string;
	role: AgentRole;
	model: string | null;
	message: string;
	subject: string;
	context: string[];
	symbols: string[];
	history: string[];
	tags: string[];
	project: string;
	parentId: string | null;
	tokenUsage: TokenUsage | null;
	toolCalls: ToolCall[];
	rationale: string[];
	source: string;
	dateTime: DateTime;
	length: number;

	/**
	 * Creates an AgentMessage from a fully normalized payload.
	 * @param params - All required message fields used by storage and API layers.
	 */
	constructor(params: AgentMessageParams)
	{
		this.id = params.id;
		this.sessionId = params.sessionId;
		this.harness = params.harness;
		this.machine = params.machine;
		this.role = params.role;
		this.model = params.model;
		this.message = params.message;
		this.subject = params.subject;
		this.context = params.context;
		this.symbols = params.symbols;
		this.history = params.history;
		this.tags = params.tags;
		this.project = params.project;
		this.parentId = params.parentId;
		this.tokenUsage = params.tokenUsage;
		this.toolCalls = params.toolCalls;
		this.rationale = params.rationale;
		this.source = params.source;
		this.dateTime = params.dateTime;
		this.length = params.length;
	}

	/**
	 * Converts the in-memory class instance into a JSON-friendly object.
	 * @returns Serializable plain object ready for JSON.stringify.
	 */
	serialize(): SerializedAgentMessage
	{
		return {
			id: this.id,
			sessionId: this.sessionId,
			harness: this.harness,
			machine: this.machine,
			role: this.role,
			model: this.model,
			message: this.message,
			subject: this.subject,
			context: this.context,
			symbols: this.symbols,
			history: this.history,
			tags: this.tags,
			project: this.project,
			parentId: this.parentId,
			tokenUsage: this.tokenUsage,
			toolCalls: this.toolCalls,
			rationale: this.rationale,
			source: this.source,
			dateTime: this.dateTime.toISO() ?? "",
			length: this.length,
		};
	}

	/**
	 * Recreates an AgentMessage instance from serialized JSON data.
	 * @param obj - Unknown JSON payload loaded from disk or API transport.
	 * @returns Rehydrated AgentMessage with DateTime restored from ISO.
	 */
	static deserialize(obj: unknown): AgentMessage
	{
		const value = obj as Partial<SerializedAgentMessage>;
		return new AgentMessage({
			id: value.id ?? "",
			sessionId: value.sessionId ?? "",
			harness: value.harness ?? "",
			machine: value.machine ?? "",
			role: (value.role ?? "user") as AgentRole,
			model: value.model ?? null,
			message: value.message ?? "",
			subject: value.subject ?? "",
			context: value.context ?? [],
			symbols: value.symbols ?? [],
			history: value.history ?? [],
			tags: value.tags ?? [],
			project: value.project ?? "",
			parentId: value.parentId ?? null,
			tokenUsage: value.tokenUsage ?? null,
			toolCalls: value.toolCalls ?? [],
			rationale: value.rationale ?? [],
			source: value.source ?? "",
			dateTime: value.dateTime
				? DateTime.fromISO(value.dateTime)
				: DateTime.now(),
			length: (value as { length?: number }).length ?? (value.message?.length ?? 0),
		});
	}
}
