/**
 * AgentMessageFound – Extended AgentMessage with search scoring metadata.
 * Used by the enhanced /api/search endpoint to return results with multiple scores.
 */

import { AgentMessage, type AgentMessageParams, type SerializedAgentMessage } from "./AgentMessage.js";

/** Constructor parameters for AgentMessageFound (AgentMessage + scores). */
export type AgentMessageFoundParams = AgentMessageParams & {
	/** Qdrant semantic similarity score (0.0-1.0, higher is better), null if Qdrant disabled. */
	qdrantScore: number | null;
	/** Fuse.js fuzzy match score (0.0-1.0, lower is better), null if message only found via Qdrant. */
	fuseScore: number | null;
	/** Combined weighted score (0.0-1.0, higher is better): 50% Qdrant + 50% Fuse, or full Fuse range when Qdrant absent. */
	combinedScore: number;
	/** Total count of query term occurrences found in this message. */
	hits: number;
};

/** Serializable representation of AgentMessageFound. */
export type SerializedAgentMessageFound = SerializedAgentMessage & {
	qdrantScore: number | null;
	fuseScore: number | null;
	combinedScore: number;
	hits: number;
};

/**
 * Extended AgentMessage with search scoring metadata.
 * Represents a message found via hybrid search (Fuse.js + Qdrant).
 */
export class AgentMessageFound extends AgentMessage
{
	/** Qdrant semantic similarity score (null when Qdrant is disabled). */
	qdrantScore: number | null;

	/** Fuse.js fuzzy match score (null when message only found via Qdrant). */
	fuseScore: number | null;

	/** Combined weighted score for ranking. */
	combinedScore: number;

	/** Total count of query term occurrences found in this message. */
	hits: number;

	/**
	 * Creates an AgentMessageFound instance from a full parameter set.
	 * @param params - All AgentMessage fields plus search scores.
	 */
	constructor(params: AgentMessageFoundParams)
	{
		super(params);
		this.qdrantScore = params.qdrantScore;
		this.fuseScore = params.fuseScore;
		this.combinedScore = params.combinedScore;
		this.hits = params.hits;
	}

	/**
	 * Creates an AgentMessageFound from an existing AgentMessage and search scores.
	 * Calculates the combined score using weighted formula:
	 * - With Qdrant: 50% Qdrant + 50% Fuse (inverted since Fuse uses 0=perfect, 1=worst)
	 * - Without Qdrant: Fuse score normalized to full 0–1 range
	 *
	 * @param msg - Base AgentMessage instance.
	 * @param scores - Search scores from Qdrant and/or Fuse.js.
	 * @returns AgentMessageFound with calculated combined score.
	 */
	static fromAgentMessage(
		msg: AgentMessage,
		scores: { qdrantScore?: number; fuseScore?: number; hits?: number }
	): AgentMessageFound
	{
		const qdrantScore = scores.qdrantScore ?? null;
		const fuseScore = scores.fuseScore ?? null;

		// Fuse.js: 0 = perfect match, 1 = worst match → invert it
		const normalizedFuseScore = fuseScore !== null ? 1 - fuseScore : 0;

		let combinedScore: number;
		if (qdrantScore === null)
		{
			// No Qdrant — use full Fuse range (0–1) to avoid score compression
			combinedScore = normalizedFuseScore;
		}
		else
		{
			// Hybrid: 50% Qdrant + 50% Fuse
			const qdrantWeight = qdrantScore * 0.50;
			const fuseWeight = fuseScore !== null ? normalizedFuseScore * 0.50 : 0;
			combinedScore = qdrantWeight + fuseWeight;
		}

		return new AgentMessageFound({
			id: msg.id,
			sessionId: msg.sessionId,
			harness: msg.harness,
			machine: msg.machine,
			role: msg.role,
			model: msg.model,
			message: msg.message,
			subject: msg.subject,
			context: msg.context,
			symbols: msg.symbols,
			history: msg.history,
			tags: msg.tags,
			project: msg.project,
			parentId: msg.parentId,
			tokenUsage: msg.tokenUsage,
			toolCalls: msg.toolCalls,
			rationale: msg.rationale,
			source: msg.source,
			dateTime: msg.dateTime,
			length: msg.length,
			qdrantScore,
			fuseScore,
			combinedScore,
			hits: scores.hits ?? 0,
		});
	}

	/**
	 * Serializes the message with search scores for API response.
	 * @returns Plain object with all fields including scores.
	 */
	override serialize(): SerializedAgentMessageFound
	{
		const base = super.serialize();
		return {
			...base,
			qdrantScore: this.qdrantScore,
			fuseScore: this.fuseScore,
			combinedScore: this.combinedScore,
			hits: this.hits,
		};
	}

	/**
	 * Deserializes an AgentMessageFound from JSON.
	 * @param obj - Unknown JSON payload.
	 * @returns Rehydrated AgentMessageFound instance.
	 */
	static override deserialize(obj: unknown): AgentMessageFound
	{
		const base = AgentMessage.deserialize(obj);
		const value = obj as Partial<SerializedAgentMessageFound>;

		return new AgentMessageFound({
			id: base.id,
			sessionId: base.sessionId,
			harness: base.harness,
			machine: base.machine,
			role: base.role,
			model: base.model,
			message: base.message,
			subject: base.subject,
			context: base.context,
			symbols: base.symbols,
			history: base.history,
			tags: base.tags,
			project: base.project,
			parentId: base.parentId,
			tokenUsage: base.tokenUsage,
			toolCalls: base.toolCalls,
			rationale: base.rationale,
			source: base.source,
			dateTime: base.dateTime,
			length: base.length,
			qdrantScore: value.qdrantScore ?? null,
			fuseScore: value.fuseScore ?? null,
			combinedScore: value.combinedScore ?? 0,
			hits: value.hits ?? 0,
		});
	}
}
