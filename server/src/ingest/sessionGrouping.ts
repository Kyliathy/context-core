/**
 * Session grouping helper shared by startup ingest persistence.
 *
 * Architecture: server/zz-reach2/architecture/archi-context-core-level0.md
 * Upgrade plan: server/zz-reach2/upgrades/2026-06/r2so2-startup-optimization2.md
 */

import type { AgentMessage } from "../models/AgentMessage.js";

/**
 * Handles groupBySession behavior for this CXC module.
 * @param messages - Message data processed by groupBySession.
 * @returns Result produced by groupBySession.
 */
export function groupBySession(messages: Array<AgentMessage>): Map<string, Array<AgentMessage>>
{
	const sessions = new Map<string, Array<AgentMessage>>();
	// Business logic: this iteration walks every relevant item so startup ingest planning and bookmark safety reflects the complete source set instead of a partial snapshot.

	for (const message of messages)
	{
		const key = `${message.sessionId}::${message.project || "project"}`;
		if (!sessions.has(key))
		{
			sessions.set(key, []);
		}
		sessions.get(key)!.push(message);
	}
	return sessions;
}
