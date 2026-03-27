import { createHash } from "crypto";

/**
 * Creates a deterministic short message identifier for deduplication.
 * @param sessionId - Conversation/session identifier from the source harness.
 * @param role - Message role (user, assistant, tool, system).
 * @param timestamp - Timestamp string/number used to make IDs time-stable.
 * @param messagePrefix - First part of message content to avoid whole-text hashing.
 * @returns First 16 hex chars of a SHA-256 digest.
 */
export function generateMessageId(
  sessionId: string,
  role: string,
  timestamp: string | number,
  messagePrefix: string
): string {
  const payload = `${sessionId}|${role}|${String(timestamp)}|${messagePrefix}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}
