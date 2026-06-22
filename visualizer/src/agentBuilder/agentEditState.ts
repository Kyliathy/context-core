/**
 * Canonical vs legacy Agent Builder edit-mode helpers.
 *
 * Architecture: visualizer/zz-reach2/architecture/agents/archi-agent-builder-ui.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ap-agent-publisher-2.md (Review §33–34)
 */

/**
 * Returns true when the Agent basket should behave as an edit session.
 * @param editingAgentPath - Legacy disk artifact path being edited, if any.
 * @param editingCanonicalId - Canonical catalog id being edited, if any.
 * @param basketMode - Active basket mode from App view state.
 */
export function isAgentBasketEditMode(
	editingAgentPath: string | null,
	editingCanonicalId: string | null,
	basketMode: "agent" | "template" | "agent-from-template",
): boolean
{
	return basketMode === "agent" && (editingAgentPath !== null || editingCanonicalId !== null);
}

/**
 * Resolves the canonical id sent on create/save — only when actively editing a catalog entry.
 * @param editingCanonicalId - Canonical id from an explicit edit session, if any.
 */
export function resolveCreateCanonicalId(editingCanonicalId: string | null): string | undefined
{
	return editingCanonicalId ?? undefined;
}
