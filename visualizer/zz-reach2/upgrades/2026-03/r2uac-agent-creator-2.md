# r2uac2 – Agent Creator Fixes: Save State Preservation, Viewport Inset & Engine Refactor

**Date**: 2026-03-17
**Status**: Done (2026-03-17)
**Scope**: Fix save-resets-state bug, add D3 viewport left inset for panel, refactor chatMapEngine modes
**Depends on**: [r2uab2-ui – Agent Builder UI Phase 2](r2uab2-agent-builder-ui2.md)

---

## 1. Problems

### 1.1 Save Resets Agent Creator State (Bug)

When clicking "Create" or "Save" on the AgentBasket, `handleCreateAgent` in `App.tsx` (line 448) does three things that reset state:

1. `setAgentKnowledgeEntries([])` — clears the knowledge list
2. `setEditingAgentPath(null)` + `setAgentEditInitial(null)` — clears edit mode
3. `search(activeView.query)` — re-fetches cards, which changes the `cards` array, which triggers `useChatMap` to call `zoomToFit()`, resetting the viewport

**Expected behaviour**: Save should show a success popup and leave everything as-is. The user may want to tweak and re-save, or continue adding knowledge.

### 1.2 D3 Viewport Hidden Behind Panel (Bug)

The AgentBasket panel is `position: fixed; left: 10px; width: 420px` — it covers roughly 440px of the left side of the screen. The D3 `<svg>` underneath spans `width: 100%` of `.chat-map-container`, so cards placed in the left ~440px are invisible and unreachable. Panning doesn't help because `zoomToFit()` centres on the full container width.

We need the D3 engine to treat the **visible viewport** as starting from where the panel ends. This means an adjustable "left inset" (margin) on the SVG world, so layout, `zoomToFit`, and `translateExtent` all account for the panel width.

### 1.3 chatMapEngine Modes Growing Complex

The engine currently has two overlapping mode flags (`isAgentBuilderMode`, `cardRenderMode`) plus view-type-dependent button rendering. As we add viewport insets, this will get messier. A small refactor will consolidate mode state into a single `EngineConfig` object.

---

## 2. Design

### 2.1 Save State Preservation

**Fix**: After a successful create/save, do NOT clear knowledge entries or edit state. Only show the success banner (already implemented via `setAgentCreateSuccess`). The form stays populated so the user can continue editing.

Changes to `handleCreateAgent` in `App.tsx`:
- Remove `setAgentKnowledgeEntries([])` from the success path
- Remove `setEditingAgentPath(null)` and `setAgentEditInitial(null)` from the success path
- Remove `search(activeView.query)` from the success path (no re-fetch needed — the agent file will appear when the user next switches view or searches)
- Keep these clearing calls ONLY in `handleClearKnowledge` (the ✕ button) and `handleCancelEdit`

### 2.2 D3 Viewport Left Inset

Introduce a `viewportInset` concept in the engine — a `{ left, top, right, bottom }` rectangle that defines the **unusable** portion of the container (occluded by panels).

The inset affects three places:

1. **`zoomToFit()`** — When computing scale and translation, use the inset-adjusted viewport dimensions:
   ```
   effectiveWidth  = viewportWidth  - inset.left - inset.right
   effectiveHeight = viewportHeight - inset.top  - inset.bottom
   ```
   And offset the translation by `inset.left` / `inset.top`.

2. **`update()` grid layout** — The `width` passed to `computeGridLayout` should be based on effective width, not full container width. This ensures cards don't get laid out behind the panel.

3. **`translateExtent`** — No change needed. The SVG still spans the full container; only the "camera target" shifts.

The inset is set via `engine.setViewportInset({ left, top, right, bottom })`, called from `useChatMap` whenever the panel presence changes.

**Calculating the inset from React side**: When `viewType` is `"agent-builder"` or `"agent-list"`, the AgentBasket panel is present with width `420px + 10px left + 10px gap = 440px`. Pass `panelWidth` as a prop to `ChatMap`, and `useChatMap` calls `engine.setViewportInset({ left: panelWidth, top: 0, right: 0, bottom: 0 })`.

For non-agent views (ClipboardBasket), the basket is smaller (400px wide, 400px tall, positioned bottom-left) and doesn't block much — no inset needed for now.

### 2.3 Engine Refactor: Consolidate Mode into `EngineConfig`

Replace the separate `isAgentBuilderMode`, `cardRenderMode` fields with a single `EngineConfig` object:

```typescript
type ViewportInset = { left: number; top: number; right: number; bottom: number };

type EngineConfig = {
  cardRenderMode: CardRenderMode;    // "default" | "agent-builder" | "agent-list"
  viewportInset: ViewportInset;       // { left, top, right, bottom }
};
```

The engine exposes a single `setConfig(config: Partial<EngineConfig>)` method that merges into the current config. This replaces both `setAgentBuilderMode()` and `setCardRenderMode()` AND adds viewport inset support in one clean API.

**Backward compat**: Remove `setAgentBuilderMode()` entirely since `isAgentBuilderMode` is derivable from `cardRenderMode === "agent-builder"`. Keep the internal `isAgentBuilderMode` variable computed from config for the click handler logic.

### 2.4 Engine API After Refactor

```typescript
export type ChatMapEngine = {
  update(cards: CardData[], threadCards?: ThreadCardData[]): void;
  setStarredIds(starredIds: Set<string>): void;
  setConfig(config: Partial<EngineConfig>): void;   // NEW — replaces setAgentBuilderMode + setCardRenderMode
  setTransform(transform: d3.ZoomTransform): void;
  zoomToFit(padding?: number): void;
  destroy(): void;
};
```

---

## 3. Implementation Plan

### Group A — Fix Save State Reset

{{SIMPLE}}

- [x] **A1** — In `handleCreateAgent` (App.tsx ~line 448), remove `setAgentKnowledgeEntries([])`, `setEditingAgentPath(null)`, `setAgentEditInitial(null)`, and `search(activeView.query)` from the success path. Keep only `setAgentCreateSuccess(result.path)`.
- [x] **A2** — Verify that `handleClearKnowledge` (the ✕ button) still clears everything (it already does).
- [x] **A3** — Verify that `handleCancelEdit` still clears edit state (it already does).

### Group B — Engine Refactor: Consolidate Config

{{MEDIUM}}

- [x] **B1** — Add `ViewportInset` type and `EngineConfig` type to `chatMapEngine.ts`
- [x] **B2** — Replace `isAgentBuilderMode` + `cardRenderMode` internal variables with a single `config: EngineConfig` variable (default: `{ cardRenderMode: "default", viewportInset: { left: 0, top: 0, right: 0, bottom: 0 } }`)
- [x] **B3** — Implement `setConfig(partial: Partial<EngineConfig>)`: merges into current config, derives `isAgentBuilderMode` from `config.cardRenderMode`, re-renders cards if `cardRenderMode` changed, re-layouts if `viewportInset` changed
- [x] **B4** — Remove `setAgentBuilderMode()` and `setCardRenderMode()` from the engine's public API and return object
- [x] **B5** — Update `ChatMapEngine` type definition to expose `setConfig` instead of the two removed methods
- [x] **B6** — Update all internal references: `updateLod` and `setStarredIds` use `config.cardRenderMode` instead of `cardRenderMode` variable
- [x] **B7** — Update click handler: derive `isAgentBuilderMode` from `config.cardRenderMode === "agent-builder"` inline

### Group C — Viewport Inset in Engine

{{MEDIUM}}

- [x] **C1** — In `zoomToFit()`: compute `effectiveWidth = viewportWidth - config.viewportInset.left - config.viewportInset.right`, same for height. Offset translation: `tx += config.viewportInset.left / 2 - config.viewportInset.right / 2` (center within the visible area, not the full container)
- [x] **C2** — In `update()`: compute `width = Math.max(container.clientWidth - config.viewportInset.left - 24, 320)` so grid layout avoids the panel area
- [x] **C3** — In `setConfig()`: if `viewportInset` changed, call `update(currentCards, currentThreads)` to re-layout and then `zoomToFit()` to re-center

### Group D — Wire Inset from React

{{SIMPLE}}

- [x] **D1** — Add `panelWidth?: number` prop to `ChatMap` component
- [x] **D2** — In `App.tsx`, compute `agentPanelWidth` as `440` when `activeView.type === "agent-builder" || activeView.type === "agent-list"`, else `0`. Pass to `<ChatMap panelWidth={agentPanelWidth} />`
- [x] **D3** — In `useChatMap`, accept `panelWidth` param. Add `useEffect` that calls `engine.setConfig({ viewportInset: { left: panelWidth ?? 0, top: 0, right: 0, bottom: 0 } })` when `panelWidth` changes
- [x] **D4** — In `useChatMap`, update the existing `viewType` effect: call `engine.setConfig({ cardRenderMode: mode })` instead of `engine.setAgentBuilderMode(...)` + `engine.setCardRenderMode(...)`

### Group E — Prevent zoomToFit on save re-fetch

{{SIMPLE}}

- [x] **E1** — Since we removed `search(activeView.query)` from `handleCreateAgent`, the cards array won't change on save, so `useChatMap`'s signature check won't trigger `zoomToFit`. Verify this is the case (no code change needed, just validation).

---

## 4. File Inventory

### Modified Files

| File | Changes |
| --- | --- |
| `visualizer/src/App.tsx` | Fix `handleCreateAgent` success path; compute + pass `panelWidth` to ChatMap |
| `visualizer/src/d3/chatMapEngine.ts` | `EngineConfig`, `ViewportInset` types; `setConfig()` method; remove `setAgentBuilderMode` + `setCardRenderMode`; viewport inset in `zoomToFit` + `update` |
| `visualizer/src/hooks/useChatMap.ts` | Accept `panelWidth`; use `setConfig()` instead of old methods |
| `visualizer/src/components/ChatMap.tsx` | Accept + forward `panelWidth` prop |

### No New Files

---

## 5. Edge Cases & Notes

1. **Window resize with panel open** — The `ResizeObserver` in `useChatMap` already calls `engine.update()`. After the refactor, `update()` uses `config.viewportInset`, so resizes will correctly account for the panel.
2. **Panel close transition** — When switching away from agent-builder view, `panelWidth` drops to 0, `setConfig` triggers re-layout + zoom. Cards snap to fill the full width.
3. **Multiple saves** — User can save, see success banner, modify knowledge, save again. Each save overwrites the same file (server `writeFileSync`).
4. **AgentBasket form after save** — All form fields and knowledge entries remain intact. Only the success banner appears. The ✕ clear button is the explicit way to reset.
5. **ClipboardBasket unaffected** — It's much smaller and positioned at the bottom-left. No viewport inset applied for non-agent views.
