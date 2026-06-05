# r2us — Persisted Scopes (Server + Visualizer)

**Date**: 2026-03-20  
**Status**: Planned  
**Scope**: Add backend scope persistence in `.settings/scopes.json` and wire visualizer `New View` dialog to load persisted scopes.

---

## Goal

Add server endpoints to save/list scopes and integrate the visualizer so `New View` fetches available scopes on open.

Persisted file target:
- `{storage}/.settings/scopes.json`
- JSON array of scope objects including: text/name, emoji, color, and selected projects.

---

## API Contracts (proposed)

1. `GET /api/list-scopes`
- Returns: `ScopeDefinition[]`
- `200` with `[]` when file does not exist yet.

2. `POST /api/scopes`
- Body: `{ scopes: ScopeDefinition[] }`
- Persists full scope list to `.settings/scopes.json`.
- Returns: `{ saved: number }` (count).
- Validation errors return `400`.

`ScopeDefinition` shape:

```ts
type ScopeDefinition = {
	id: string;
	name: string;   // scope text
	emoji: string;
	color: string;  // #RRGGBB
	projectIds: Array<{ harness: string; project: string }>;
};
```

---

## Tasks

{{SIMPLE}}

- [ ] **1. Add shared server scope type**: Create/extend a server model/type for persisted scopes (`id`, `name`, `emoji`, `color`, `projectIds`) to avoid ad-hoc `any` payloads.

- [ ] **2. Add `ScopeStore` settings service**: Implement `src/settings/ScopeStore.ts` mirroring `TopicStore` patterns:
load from `.settings/scopes.json`, create `.settings` if missing, safe parse fallback to empty list, and save with 2-space JSON formatting.

- [ ] **3. Bootstrap ScopeStore in runtime**: Initialize and `load()` the new `ScopeStore` in the same startup flow where `TopicStore` is prepared (ContextCore composition).

- [ ] **4. Register `GET /api/list-scopes`**: In `src/server/ContextServer.ts`, add endpoint returning all persisted scopes from `ScopeStore`.

- [ ] **5. Register `POST /api/scopes`**: In `src/server/ContextServer.ts`, validate body shape (`scopes` array + field validation), save through `ScopeStore`, return `{ saved }`.

- [ ] **6. Add validation helpers**: Add narrow validation for name/emoji/color/project pairs to prevent malformed `scopes.json` writes.

{{MEDIUM}}

- [ ] **7. Add visualizer API methods**: In `visualizer/src/api/search.ts`, add `fetchScopes()` and `saveScopes(scopes)` wrappers for `/api/list-scopes` and `/api/scopes`.

- [ ] **8. Load scopes on New View open**: In `visualizer/src/components/EditResultsView.tsx`, call `fetchScopes()` in the open lifecycle (same place where projects are prepared), then hydrate local `scopes` state from server.

- [ ] **9. Persist scope changes on create/update/modify**: After local scope mutations (create scope, update selected projects, modify emoji/name/color), call `saveScopes(nextScopes)` so server storage stays current.

- [ ] **10. Add missing-scope error logging**: When UI actions depend on a selected scope ID that cannot be resolved from loaded scopes, log a console error:
`console.error("[Scopes] Selected scope not found", { selectedScopeId })`.

- [ ] **11. Keep graceful fallback UX**: If load/save fails, keep local in-memory behavior intact and log actionable console errors; do not block the dialog.

{{MEDIUM}}

- [ ] **12. Add endpoint docs**: Update server architecture/upgrade docs with the two new endpoints and `scopes.json` contract.

- [ ] **13. Add server tests (or lightweight assertions)**: Add coverage for `GET /api/list-scopes` empty/file-present cases and `POST /api/scopes` valid/invalid payload cases.

- [ ] **14. Validate end-to-end manually**: Verify flow:
open New View -> scopes load -> create/modify/update scope -> close/reopen New View -> scopes are restored from `.settings/scopes.json`.

---

## Files Expected To Change

Server:
- `server/src/server/ContextServer.ts`
- `server/src/settings/ScopeStore.ts` (new)
- `server/src/ContextCore.ts` (or composition root where stores are wired)
- `server/src/models/*` or `server/src/types.ts` (scope type)

Visualizer:
- `visualizer/src/api/search.ts`
- `visualizer/src/components/EditResultsView.tsx`
- `visualizer/src/types.ts` (reuse/align with server shape if needed)

Docs:
- `server/zz-reach2/upgrades/2026-03/r2us-scopes.md` (this file)
- optionally `server/zz-reach2/architecture/archi-context-core-level0.md` (endpoint table update)

---

## Notes

- Endpoint naming follows current API style with `/api/*` prefix.
- `GET /api/list-scopes` is intentionally list-specific per request.
- Persistence format is full-list overwrite for simplicity in v1 (client sends full scope array).
