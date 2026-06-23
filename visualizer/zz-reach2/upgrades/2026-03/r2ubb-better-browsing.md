# r2ubb — MasterCard Per-Project/Scope Grouping

**Date**: 2026-03-21
**Status**: Planned
**Scope**: Add MasterCard grouping to Latest Threads, Search Threads, and Search Messages views. Lift scope state to App level.

---

## Context

The Latest Threads, Search Threads, and Search Messages views currently render results as a flat masonry grid of rectangles with no visual grouping. Users cannot tell at a glance which cards belong to which project or scope. This plan introduces **MasterCards** — full-width container cards that group child Chat/Thread cards by project or scope, providing immediate visual organization.

Additionally, scopes are currently only fetched when the EditResultsView modal opens. This plan lifts scope state to App level so it's available for grouping logic at all times.

---

## Design Decisions

### Grouping: most-specific scope wins, then project fallback
- For each card, check if its `{harness}::{project}` key matches any scope's `projectIds`. When multiple scopes match, the **most specific** scope (fewest `projectIds`) wins.
- Cards not matching any scope are grouped by their raw project.
- A card appears in exactly one MasterCard.

### Grouping logic lives in a new `d3/grouping.ts`
- It's a data-model concern (depends on scopes/business state), not pure geometry — so it's separate from `layout.ts`.
- Called from `App.tsx` via `useMemo` before passing to ChatMap.

### MasterCards render as flat `g.mastercard` groups in D3
- Background rect + border + header foreignObject, rendered BEFORE child `g.chat`/`g.thread` groups.
- Child cards keep absolute x/y (offset into their MasterCard's interior). No SVG nesting needed.
- Existing `renderCards()` / `renderThreadCards()` reused without modification.

### Layout: one MasterCard per row, vertical stacking
- MasterCard width = full container width.
- Interior uses the same column-packing algorithm for child cards.
- MasterCard height grows by card-rows as needed.

### Scope state lifted to App via `useScopes()` hook
- Fetches once on mount. `EditResultsView` receives scopes as props instead of fetching internally.

---

## Tasks

{{SIMPLE}}

- [x] **1. Server: add `project` field to `AgentThread`** — In `server/src/models/AgentThread.ts`, add `project: string` to the `AgentThread` type.

- [x] **2. Server: emit `project` in thread aggregator** — In `server/src/search/threadAggregator.ts`, add `project: firstMessage.project` to the thread object in both `aggregateToThreads()` (line ~96-108) and `getLatestThreads()` (line ~163-175).

- [x] **3. Client types: add `project` to thread types** — In `visualizer/src/types.ts`, add `project: string` to `SerializedAgentThread` (line 36-48) and `ThreadCardData` (line 256-274).

- [x] **4. Client types: add `MasterCardData` type** — In `visualizer/src/types.ts`, add the new type:
```ts
export type MasterCardData = {
  id: string;                 // scope id or "project::{harness}::{project}"
  label: string;              // display name
  emoji: string;              // scope emoji or ""
  color: string;              // border color (scope color or palette)
  kind: "scope" | "project";
  cards: CardData[];
  threads: ThreadCardData[];
  x: number;
  y: number;
  w: number;
  h: number;
};
```

- [x] **5. Map `thread.project` in `useSearch`** — In `visualizer/src/hooks/useSearch.ts`, in the `toThreadCards()` function, map `thread.project ?? ""` into `ThreadCardData.project`.

- [x] **6. Create 50-color MasterCard palette** — In `visualizer/src/d3/colors.ts`, add a `MASTERCARD_PALETTE` array of 50 high-contrast colors for dark backgrounds. Add `getMasterCardColor(key: string): string` using the existing hash approach against this palette. Used for per-project MasterCard borders when no scope color applies.

- [x] **7. Create `useScopes()` hook** — New file `visualizer/src/hooks/useScopes.ts`. Fetch via `fetchScopes()` on mount, return `{ scopes, setScopes, isLoaded }`. Error-safe with empty array fallback.

- [x] **8. Wire `useScopes()` in `App.tsx`** — Call `useScopes()` in App, pass `scopes` and `setScopes` down to `EditResultsView` as props.

{{SIMPLE}}

- [x] **9. Refactor `EditResultsView` to use lifted scope state** — In `visualizer/src/components/searchView/EditResultsView.tsx`, remove the internal `fetchScopes()` useEffect (line ~82-95). Accept `scopes` / `onScopesChange` props instead, wire to existing scope UI (scope buttons, create/modify/update).

- [x] **10. Add MasterCard CSS** — In `visualizer/src/index.css`, add styles: `.mastercard-header` (pill-style, `border-radius: 12px`, `padding: 4px 12px`, semi-transparent bg), `.mastercard-label` (white text, 13px, bold), `.mastercard-count` (muted text, card count badge).

{{MEDIUM}}

- [x] **11. Create grouping logic** — New file `visualizer/src/d3/grouping.ts`. Implement `groupIntoMasterCards(cards: CardData[], threads: ThreadCardData[], scopes: Scope[]): MasterCardData[]`. Algorithm: build scope lookup `Map<"{harness}::{project}", Scope[]>`, for each card/thread pick the most-specific matching scope (fewest `projectIds`), fallback to per-project group. Sort children by dateTime ascending. Sort MasterCards by most-recent child dateTime descending. Edge cases: empty project → "Miscellaneous", scope tie → first in array wins.

- [x] **12. Create MasterCard layout algorithm** — In `visualizer/src/d3/layout.ts`, add `computeMasterCardLayout(masterCards: MasterCardData[], containerWidth: number): MasterCardData[]`. Constants: `MASTER_PADDING = 12`, `MASTER_HEADER_HEIGHT = 36`, `MASTER_GAP_Y = 24`. Per MasterCard: `w = containerWidth`, inner width = `w - 2 * MASTER_PADDING`, compute columns from inner width using `CARD_WIDTH + GAP_X`, run masonry on children, `h = MASTER_HEADER_HEIGHT + maxColumnHeight + MASTER_PADDING`. Stack vertically. Also add `computeMasterCardWorldBounds()` for zoom-to-fit.

{{HARD}}

- [x] **13. D3 engine: render MasterCard containers** — In `visualizer/src/d3/chatMapEngine.ts`, extend `update()` to accept optional `masterCards?: MasterCardData[]`. When non-empty: call `computeMasterCardLayout()`, render `g.mastercard` groups via D3 data join (key = `masterCard.id`) with `rect.mastercard-bg` (rounded corners, colored 2px border, dark fill #0d1117) and `foreignObject` header (pill label with emoji + name + child count). MasterCard header LOD: `k < 0.7` border only, `k >= 0.7` show pill. Use master card bounds for world bounds. When empty/undefined: existing flat layout path unchanged.

- [x] **14. D3 engine: integrate child cards inside MasterCards** — Ensure `renderCards()` and `renderThreadCards()` work correctly with child cards whose x/y have been offset into MasterCard interiors. Verify the `computeWorldBounds` path uses MasterCard dimensions instead of individual card dimensions when MasterCards are active.

- [x] **15. Wire `masterCards` through ChatMap** — In `visualizer/src/components/searchView/ChatMap.tsx`, accept `masterCards?: MasterCardData[]` prop, forward to `useChatMap`.

- [x] **16. Wire `masterCards` through `useChatMap`** — In `visualizer/src/hooks/useChatMap.ts`, accept `masterCards` parameter. Store in `latestMasterCardsRef` for resize handler. Pass to `engine.update(cards, threadCards, masterCards)`. Include MasterCard count/IDs in signature for zoom-to-fit gating.

- [x] **17. Compute `masterCards` in `App.tsx`** — Add `useMemo` computing `masterCards` from `filteredCards`, `threadCards`, `scopes`, `activeView.type`. Only group for `"latest"`, `"search-threads"`, `"search"` view types; return `[]` otherwise. Pass `masterCards` prop to `<ChatMap>`.

{{MEDIUM}}

- [ ] **18. Verify end-to-end** — Start server + visualizer dev. Create 2+ scopes with different project selections. Test: Search Messages shows grouped MasterCards, Search Threads groups thread cards, Latest Threads groups by project/scope, Agent Builder remains flat. Test zoom/LOD, zoom-to-fit, hover panel, star, and title-click all work on cards inside MasterCards.

---

## Files Changed

| File | Change |
|------|--------|
| `server/src/models/AgentThread.ts` | Add `project: string` |
| `server/src/search/threadAggregator.ts` | Emit `project` in both functions |
| `visualizer/src/types.ts` | `MasterCardData` type, `project` on thread types |
| `visualizer/src/hooks/useSearch.ts` | Map `thread.project` |
| `visualizer/src/d3/colors.ts` | 50-color `MASTERCARD_PALETTE` + `getMasterCardColor()` |
| `visualizer/src/hooks/useScopes.ts` | **New** — `useScopes()` hook |
| `visualizer/src/App.tsx` | `useScopes()`, grouping `useMemo`, pass `masterCards` |
| `visualizer/src/components/searchView/EditResultsView.tsx` | Accept scope props, remove internal fetch |
| `visualizer/src/d3/grouping.ts` | **New** — `groupIntoMasterCards()` |
| `visualizer/src/d3/layout.ts` | `computeMasterCardLayout()` + world bounds |
| `visualizer/src/d3/chatMapEngine.ts` | Render `g.mastercard`, extend `update()` |
| `visualizer/src/components/searchView/ChatMap.tsx` | Accept + forward `masterCards` prop |
| `visualizer/src/hooks/useChatMap.ts` | Accept + forward `masterCards`, ref + signature |
| `visualizer/src/index.css` | MasterCard styles |
