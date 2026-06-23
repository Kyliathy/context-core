# R2FCR - Favorites Card Reorganization Plan



**Date**: 2026-05-13  

**Goal**: Add a new **CustomCardPositioning** mode for Favorites views so cards keep user-defined X/Y positions instead of being automatically reorganized, and fix the small-card action-bar clipping bug at high/low zoom levels.



## Working Contract



- **CustomCardPositioning** is a view-level card positioning mode, not a replacement for `ViewType`. Favorites views remain `type === "favorites"`.

- When a Favorites view uses **CustomCardPositioning**, the D3 engine must **not** reflow/reorganize its cards automatically on zoom, resize, or refresh. Dragging a card moves the card in world coordinates instead of panning the map.

- Card dragging must work for both **message cards** and **thread cards** because Favorites views can contain both.

- Card positions must persist through `ccv:favorites`, `favorites.json`, `GET /api/favorites`, and `POST /api/favorites`.

- Existing Favorites sync behavior must continue: offline cache first, debounced server save, conflict modal, per-view deltas, and server view metadata import.

- The card action column (💾 / ★ / 📋) must remain fully visible for short cards at every relevant zoom / LOD tier.

- Before starting any group below, switch to the Model named in that group tag. Do not continue into a later group until the active Model matches the new tag.



{{SIMPLE}}



## Difficulty Batch 1



- [X] Review `visualizer/src/types.ts`, `visualizer/src/hooks/useViews.ts`, `visualizer/src/hooks/useFavorites.ts`, `visualizer/src/hooks/favoriteSync.ts`, and `visualizer/src/api/search.ts` to identify every serialized Favorites shape that must carry CustomCardPositioning data.

- [X] Review `visualizer/src/hooks/useChatMap.ts`, `visualizer/src/d3/chatMapEngine.ts`, and `visualizer/src/d3/layout.ts` to identify where view-level positioning mode should flow into D3 config and layout.

- [X] Review `visualizer/src/components/searchView/EditResultsView.tsx` and `.css` to decide where the Favorites view editor exposes the CustomCardPositioning toggle.

- [X] Review `server/src/models/FavoriteEntry.ts`, `server/src/settings/FavoriteStore.ts`, `server/src/server/routes/favoriteRoutes.ts`, and `server/zz-reach2/architecture/archi-context-core-level0.md` for backend persistence and API contract updates.

- [X] Define acceptance criteria in this plan for: no auto-reflow in CustomCardPositioning, drag-to-position behavior, persistence round-trip, sync conflict safety, and action-bar min-height visibility.



{{MEDIUM}}



## Difficulty Batch 2



- [X] Add a typed view-level positioning field to `ViewDefinition`, for example `cardPositioningMode?: "Auto" | "CustomCardPositioning"`, defaulting to `Auto` for all existing views.

- [X] Update `normalizeView()` and `safeReadViews()` so legacy `ccv:views` rows without a positioning field remain valid and default to `Auto`.

- [X] Update built-in view constants so every built-in view has an explicit default positioning mode where useful, while only Favorites views can actually select CustomCardPositioning in UI.

- [X] Extend `FavoriteViewSnapshot` on the client and server to carry the view-level positioning mode so cross-machine imports preserve the setting.

- [X] Update `buildFavoriteViewsForSave()` and `mergeFavoriteViewsFromSnapshots()` so the positioning mode is included in server sync and imported into `ccv:views`.

- [X] Update `EditResultsView` to show a Favorites-only control for **Card Positioning** with options `Auto` and `CustomCardPositioning`.

- [X] Ensure `EditResultsView` comments and parameter comments are kept or updated in the local `//Comment` style when touching code around the new control.

- [X] Add UI copy that makes clear `CustomCardPositioning` disables automatic reorganization and enables drag-to-position inside that Favorites view.



{{HARD}}



## Difficulty Batch 3



- [X] Extend `FavoriteEntry` on the client and server with an optional persisted card position field, for example `position?: { x: number; y: number }`, scoped to `(viewId, cardId)`.

- [X] Update `normalizeFavoriteEntry()` on the server to accept missing positions for legacy rows and validate numeric finite X/Y values when present.

- [ ] Update `safeReadFavorites()` on the client to preserve valid position data and drop/ignore invalid position values without breaking legacy entries.

- [X] Update `buildFavoritesSignature()` so position changes are included in sync comparisons, conflict detection, and server save staleness checks.

- [X] Update `getFavoriteConflictSummary()` and per-view conflict rows so “same card, different snapshot” includes position changes when source/add time are otherwise equal.

- [ ] Update `favoriteRoutes` tests to cover POST/GET persistence of entry positions and legacy rows without positions.

- [X] Update `favoriteSync.test.ts` to prove changing only X/Y produces a different bundle signature and an ask-user conflict.

- [ ] Update Insomnia examples so `POST /api/favorites` shows `position` on an example row and `cardPositioningMode` on `favoriteViews`.



{{HARD}}



## Difficulty Batch 4



- [X] Add a D3 engine config field separate from `cardRenderMode`, for example `cardPositioningMode: "Auto" | "CustomCardPositioning"`, so action-button rendering stays independent from layout behavior.

- [X] Update `useChatMap` to derive `cardPositioningMode` from the active `ViewDefinition` and call `engine.setConfig()` when it changes.

- [X] Update `ChatMap` props and App wiring so the active view’s card positioning mode reaches `useChatMap`.

- [X] Update `chatMapEngine.applyLayout()` so CustomCardPositioning bypasses `computeGridLayout`, `computeThreadGridLayout`, and `computeMixedGridLayout` for Favorites card sets that already have positions.

- [X] Add a deterministic missing-position fallback for newly added Favorites cards in CustomCardPositioning, using the current auto layout once for unpositioned rows without disturbing already positioned rows.

- [X] Ensure zoom bucket reflow (`relayoutForBucketChange`) does not move positioned cards when CustomCardPositioning is active.

- [X] Ensure resize observer relayout does not move positioned cards when CustomCardPositioning is active.

- [X] Update world-bounds calculations so manually positioned cards, including negative or far-away X/Y coordinates if allowed, keep enough panning/zoom-to-fit space.



{{HARD}}



## Difficulty Batch 5



- [X] Add a typed card-position-change event payload, for example `CardPositionChangeEventDetail`, carrying `cardId`, `viewId`, card kind (`message` or `thread`), `x`, and `y`.

- [X] Add D3 `drag` behavior to `g.chat` and `g.thread` only when `cardPositioningMode === "CustomCardPositioning"`.

- [X] During card drag, stop propagation so dragging a card does not trigger SVG pan/zoom drag behavior.

- [X] Convert screen-space drag deltas to world-space deltas using the current zoom scale (`dx / currentTransform.k`, `dy / currentTransform.k`).

- [X] Update the dragged card’s transform optimistically during drag so the UI feels immediate.

- [X] Emit a final card-position-change event on drag end, not on every mousemove, unless live persistence proves necessary.

- [X] In App, route the card-position-change event to a new `useFavorites` action that updates only the matching `(viewId, cardId)` position.

- [X] Ensure drag-to-position works for both normal message favorites and thread favorites without breaking click, double-click zoom, title click, line copy, save, or star buttons.



{{MEDIUM}}



## Difficulty Batch 6



- [X] Add `updateFavoritePosition(cardId, viewId, position)` to `useFavorites`, persisting to `ccv:favorites` immediately and scheduling the normal debounced backend save.

- [X] Ensure `updateFavoritePosition` is blocked or queued consistently when `pendingConflict` exists, matching other mutation behavior.

- [X] Update `getFavoritesForView()` ordering rules so CustomCardPositioning does not rely on auto layout order, while Auto mode preserves the existing `addedAt` sort.

- [X] Update `useSearch` favorites conversion so `CardData` and `ThreadCardData` receive persisted X/Y positions from their `FavoriteEntry` when present.

- [X] Ensure newly created custom text favorites in CustomCardPositioning get an initial position using the same missing-position fallback as imported message/thread favorites.

- [X] Ensure removing a favorite removes only that entry’s position and does not affect the same `cardId` in another favorites view.

- [X] Ensure deleting a Favorites view removes positioned rows via existing `removeFavoritesForView()` behavior.

- [X] Verify server-accepted Favorites imports can create positioned cards in UUID views after `mergeFavoriteViewsFromSnapshots()`.



{{MEDIUM}}



## Difficulty Batch 7



- [X] Audit `renderExcerptLines()`, `.line-actions`, `.excerpt-line`, `.chat-body`, and `estimateHeight()` to identify why short cards clip the vertical 💾 / ★ / 📋 button bar at zoom levels around and beyond 1.3x.

- [X] Define one shared minimum action-column height constant for default message cards that accounts for three vertical buttons plus gaps.

- [X] Update `layout.ts` height estimation so every default-mode card has enough height for the action column even when text is very short.

- [X] Update thread-card height estimation if the thread star button or title/actions can be clipped in equivalent short-content cases.

- [X] Update CSS min-height rules to match the TypeScript estimator so foreignObject content and computed card height stay in sync.

- [X] Confirm the fix does not inflate agent-builder, agent-list, or template-list cards that do not render the same vertical action bar.

- [ ] Add a regression test or focused layout unit test for a short message card whose computed height must exceed the default action-column minimum.

- [ ] Add a visual/manual test note for zooming around 0.7x, 1.0x, 1.3x, and 1.8x with a one-line favorite card.



{{SIMPLE}}



## Difficulty Batch 8



- [X] Update `visualizer/zz-reach2/architecture/ui/archi-favorites-ui.md` with the CustomCardPositioning mode, persisted entry positions, and drag-to-position sequence.

- [ ] Update `visualizer/zz-reach2/architecture/ui/archi-context-core-visualizer-ui.md` with the new `ViewDefinition` field, `ChatMap`/D3 config, and `useFavorites.updateFavoritePosition`.

- [ ] Update `server/zz-reach2/architecture/archi-context-core-level0.md` so `/api/favorites` documents `FavoriteEntry.position` and `FavoriteViewSnapshot.cardPositioningMode`.

- [ ] Add a Mermaid diagram showing CustomCardPositioning data flow from `EditResultsView` → `ViewDefinition` → `ChatMap` → D3 drag → `useFavorites` → server bundle.

- [ ] Add a Mermaid sequence diagram for the drag end persistence path.

- [ ] Update any architecture text that still says Favorites are arranged only by automatic mixed masonry/grid layout.

- [X] Update this plan’s completed checkboxes only after the corresponding code/docs/tests are finished.

- [X] Use `ReadLints` on changed files after implementation and fix introduced diagnostics.



{{MEDIUM}}



## Difficulty Batch 9



- [X] Run focused visualizer tests for `favoriteSync`, `useFavorites` helpers if covered, and layout helper tests.

- [X] Run `npm run build` in `visualizer/` to catch TypeScript and Vite integration errors.

- [X] Run focused server tests for `FavoriteStore` and `favoriteRoutes`.

- [ ] Run `bun test` in `server/` if the broader suite is expected to be stable; otherwise record any unrelated pre-existing failures.

- [ ] Manually verify Auto Favorites views still reflow exactly as before.

- [ ] Manually verify CustomCardPositioning Favorites views preserve positions across refresh, server restart, offline startup, and accept-server conflict resolution.

- [ ] Manually verify dragging a card does not pan the map, while dragging empty map space still pans normally.

- [ ] Manually verify short cards show all vertical action buttons at the target zoom levels.

