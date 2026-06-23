# r2umv — Multiple Views System

**Date**: 2026-03-10
**Status**: Implemented
**Depends on**: `archi-context-core-visualizer.md` (MVP + v1.1 patches)

---

## 1. Goal

Transform the single-search Visualizer into a **multi-view workspace** where each named view persists its own search query, settings, and results. Add two special view types — **Latest Chats** and **Favorites** — alongside the standard search views.

---

## 2. Concepts

### 2.1 View Types

| Type                 | Query                     | Source                          | Card population                            |
| -------------------- | ------------------------- | ------------------------------- | ------------------------------------------ |
| **Search** (default) | User-entered query string | `/api/search?q=...`             | Server search results                      |
| **Latest Chats**     | N/A (built-in)            | `/api/sessions` or new endpoint | Most recent N messages across all sessions |
| **Favorites**        | Disabled                  | Local storage only              | Cards manually starred by the user         |

### 2.2 View Definition (persisted)

```typescript
type ViewType = "search" | "latest" | "favorites";

type ViewDefinition = {
  id: string;              // crypto.randomUUID()
  name: string;            // user-chosen label, e.g. "My Friendly Task"
  type: ViewType;
  emoji: string;           // short icon, e.g. "🔎", "🕒", "⭐"
  color: string;           // hex color, e.g. "#3b82f6"
  query: string;           // search query (only used when type === "search")
  autoQuery: boolean;      // fire query immediately on view switch
  autoRefreshSeconds: number; // 0 = disabled, >0 = re-fire every N seconds
  createdAt: number;       // Date.now()
};
```

### 2.3 Favorites Storage (persisted)

```typescript
type FavoriteEntry = {
  cardId: string;           // original message ID
  viewId: string;           // which favorites view it belongs to
  source: SerializedAgentMessage; // full message snapshot (offline-capable)
  addedAt: number;
};
```

Both `ViewDefinition[]` and `FavoriteEntry[]` are persisted in `localStorage` under keys `ccv:views` and `ccv:favorites`.

---

## 3. UI Changes

### 3.1 New SearchBar Layout

The current SearchBar contains: `[🔍] [input] [Enter button]`

New layout:

```
[+] [▾ View Dropdown] [✏️] [🔍] [input] [Search button]
```

| Element           | Behaviour                                                                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **+ button**      | Opens the "New View" dialog                                                                                                                                                               |
| **View Dropdown** | Custom dropdown (`button` + popover list) listing all views by name. Selecting a view switches to it. Built-in views appear first with a separator, then user views sorted by `createdAt` |
| **✏️ button**      | Opens the "Edit View" dialog for the currently selected view. Disabled for the built-in "Latest Chats" view                                                                               |
| **🔍 icon**        | Existing search icon (cosmetic)                                                                                                                                                           |
| **input**         | Existing search text field. Disabled when active view is type `"favorites"` or `"latest"`                                                                                                 |
| **Search button** | Renamed from "Enter" to "Search". Shows "Searching..." when loading. Disabled for favorites/latest views                                                                                  |

#### 3.1.1 Dropdown view label decoration

Each view option should display:

```
[emoji] [color swatch] [view name]
```

- `emoji` comes from `ViewDefinition.emoji`
- `color swatch` is a small filled rectangle using `ViewDefinition.color`

Implemented as a custom dropdown so swatch rectangles render consistently.

Keyboard support implemented:
- `ArrowDown` / `ArrowUp`: move highlighted view
- `Enter`: select highlighted view
- `Escape`: close dropdown and restore focus to trigger
- Trigger supports keyboard open (`Enter` / `Space` / arrows)
- `Home` / `End`: jump to first/last view
- Typeahead: typing letters/numbers jumps highlight to matching view names
- Transient typeahead hint: brief `Jump: ...` indicator while typing

### 3.2 New View Dialog (Add / Edit)

A modal overlay (not a separate page route — the app is a single SPA with no router). Contains:

| Field                      | Type                  | Default (Add)           | Notes                                                                                            |
| -------------------------- | --------------------- | ----------------------- | ------------------------------------------------------------------------------------------------ |
| **View Name**              | text input            | `""`                    | Required, max 60 chars                                                                           |
| **Type**                   | radio group           | `"search"`              | Options: Search, Favorites. "Latest Chats" cannot be created (built-in singleton)                |
| **Emoji**                  | text input            | type default            | Required, 1–2 glyphs                                                                             |
| **Color**                  | color input           | type default            | Stored as hex string in `ViewDefinition.color`                                                   |
| **Search Query**           | text input            | current SearchBar value | Pre-filled from the active search. Only visible when type = `"search"`                           |
| **Auto Query**             | checkbox              | `true`                  | Only visible when type = `"search"`. When on, switching to this view fires the query immediately |
| **Auto Refresh (seconds)** | number input          | `0`                     | Only visible when type = `"search"`. 0 = disabled                                                |
| **Actions**                | Save / Cancel buttons |                         | Save persists to localStorage and switches to the new view                                       |

Edit mode is identical but pre-fills all fields from the existing `ViewDefinition`. Edit mode additionally shows a **Delete View** button (with confirmation) at the bottom. The built-in "Latest Chats" view cannot be edited or deleted.

### 3.3 Star Button on Cards

In the D3 card renderer (`chatMapEngine.ts`), for LOD tiers `summary` and above, add a **⭐ star button** in the card header area, placed **after** the existing `⬇` basket button on excerpt lines — but this star is a **card-level** action, not a line-level action.

Placement: top-right corner of the card, rendered as an absolutely positioned element inside the `foreignObject` HTML:

```html
<span class="card-star-btn" title="Add to favorites">☆</span>
```

When clicked:
- If the active view is a "favorites" type: the card is already in this favorites view — the star toggles to remove it.
- If the active view is any other type: open a **styled modal picker** asking "Add to which favorites view?" showing all favorites-type views (or offers to create one if none exist). On selection, the card's `source` (full `SerializedAgentMessage`) is saved as a `FavoriteEntry`.

The modal picker includes inline creation of a new favorites view (name input + create action), replacing browser popup prompts.

Starred cards show a filled star `★` instead of the outline `☆`.

### 3.4 Change Basket Emoji

The current `⬇` down-arrow emoji on excerpt lines (the "Add to basket" button) is renamed to a **💾 save icon**.

In `renderExcerptLines()`:
```diff
- <span class="line-add-btn" title="Add to basket">⬇</span>
+ <span class="line-add-btn" title="Add to basket">💾</span>
```

Also update the ClipboardBasket empty-state text:
```diff
- Click ⬇ on card lines to collect them here
+ Click 💾 on card lines to collect them here
```

---

## 4. State Architecture

### 4.1 New Hook: `useViews`

Owns all view-related state and localStorage persistence.

```typescript
function useViews() → {
  views: ViewDefinition[];
  activeViewId: string;
  activeView: ViewDefinition;
  switchView: (id: string) => void;
  createView: (def: Omit<ViewDefinition, "id" | "createdAt">) => string; // returns new ID
  updateView: (id: string, patch: Partial<ViewDefinition>) => void;
  deleteView: (id: string) => void;
}
```

**Initialisation**: on mount, reads `ccv:views` from localStorage. If empty, seeds with one built-in view:

```typescript
const LATEST_CHATS_VIEW: ViewDefinition = {
  id: "built-in-latest",
  name: "Latest Chats",
  type: "latest",
  emoji: "🕒",
  color: "#0ea5e9",
  query: "",
  autoQuery: false,
  autoRefreshSeconds: 0,
  createdAt: 0,
};
```

A default "Search" view is also seeded so the app starts in its familiar search mode:

```typescript
const DEFAULT_SEARCH_VIEW: ViewDefinition = {
  id: "built-in-search",
  name: "Search",
  type: "search",
  emoji: "🔎",
  color: "#3b82f6",
  query: "",
  autoQuery: false,
  autoRefreshSeconds: 0,
  createdAt: 1,
};
```

`activeViewId` is also persisted in localStorage (`ccv:activeViewId`) so the user returns to their last view.

Type defaults:

- `search` → emoji `🔎`, color `#3b82f6`
- `favorites` → emoji `⭐`, color `#f59e0b`
- `latest` (built-in) → emoji `🕒`, color `#0ea5e9`

### 4.2 New Hook: `useFavorites`

Owns favorites entries and localStorage persistence.

```typescript
function useFavorites() → {
  favorites: FavoriteEntry[];
  getFavoritesForView: (viewId: string) => FavoriteEntry[];
  addFavorite: (viewId: string, source: SerializedAgentMessage) => void;
  removeFavorite: (cardId: string, viewId: string) => void;
  isFavorited: (cardId: string, viewId: string) => boolean;
  getFavoriteViewIds: (cardId: string) => string[]; // all views where this card appears
}
```

Storage key: `ccv:favorites`.

### 4.3 Modified Hook: `useSearch`

The existing `useSearch` hook gains awareness of the active view type:

- When `type === "search"`: works exactly as today (fetch from `/api/search`).
- When `type === "latest"`: calls a new API endpoint or `/api/sessions` and converts to `CardData[]`.
- When `type === "favorites"`: converts `FavoriteEntry[]` directly to `CardData[]` (no API call). The `score` field is set to a fixed value (e.g., `0.01` for all, preserving insertion order via `addedAt`).

The `search()` function signature stays the same but checks the view type internally.

### 4.4 Auto-Refresh Timer

When a search-type view has `autoRefreshSeconds > 0`, a `setInterval` in `App.tsx` (or inside `useSearch`) re-triggers `search(activeView.query)` every N seconds. The interval is cleared and recreated when:
- The active view changes
- The `autoRefreshSeconds` value is edited
- The view is deleted

### 4.5 State Flow Diagram

```
useViews (localStorage)              useFavorites (localStorage)
    │                                        │
    │ activeView                             │ getFavoritesForView(activeViewId)
    ▼                                        ▼
App.tsx ──────────────────────────────────────────────
    │                                                 │
    │ view.type === "search"                         │ view.type === "favorites"
    │    → useSearch(query)                          │    → toCards(favorites)
    │    → cards from API                            │    → cards from localStorage
    │                                                 │
    ▼                                                 ▼
SearchBar (query from view, disabled if favorites)
ChatMap (cards[], starredCardIds for star rendering)
```

---

## 5. Implementation Plan

### Progress legend
- ✅ Done
- ⬜ Pending

### Phase 1: Infrastructure (no UI changes yet)

**Step 1.1** — ✅ Create `src/hooks/useViews.ts`
- Define `ViewDefinition` type in `types.ts`
- Implement `useViews` hook with localStorage read/write
- Seed built-in views on first load
- Persist `activeViewId`
- ✅ Normalize `emoji` + `color` with type-default fallback on invalid/corrupt data

**Step 1.2** — ✅ Create `src/hooks/useFavorites.ts`
- Define `FavoriteEntry` type in `types.ts`
- Implement `useFavorites` hook with localStorage read/write
- CRUD operations for favorites

**Step 1.3** — ✅ Create `src/components/ViewDialog.tsx` + `ViewDialog.css`
- ✅ Modal component for Add/Edit view
- ✅ Form fields: name, type (radio), emoji, color, query, autoQuery, autoRefreshSeconds
- ✅ Conditionally show/hide fields based on type
- ✅ Save → calls `createView` or `updateView`
- ✅ Delete button in edit mode (with "Are you sure?" inline confirmation)

### Phase 2: SearchBar Expansion

**Step 2.1** — ✅ Modify `SearchBar.tsx` and `SearchBar.css`
- ✅ Add `+` button (left-most)
- ✅ Add dropdown for view switching
- ✅ Render each view with emoji + color indicator + name
- ✅ Use custom popover dropdown for consistent color swatches
- ✅ Add `✏️` edit button (after dropdown)
- ✅ Rename button text from "Enter" to "Search"
- ✅ New props: `views`, `activeViewId`, `onSwitchView`, `onAddView`, `onEditView`, `isSearchDisabled`
- ✅ Disable input + search button when view type is `"favorites"` or `"latest"`

**Step 2.2** — ✅ Wire into `App.tsx`
- Integrate `useViews` hook
- Pass view props down to SearchBar
- Manage dialog open/close state (`showViewDialog`, `editingView`)
- On view switch: update `activeViewId`, restore query into SearchBar, optionally auto-fire search

### Phase 3: View-Aware Search

**Step 3.1** — ✅ Extend `useSearch` to accept a `viewType` parameter
- `"search"` → existing behaviour
- `"latest"` → fetch from `/api/latest` or `/api/sessions` (convert to SearchHit-compatible format)
- `"favorites"` → bypass fetch entirely, convert `FavoriteEntry[]` to `CardData[]`

**Step 3.2** — ✅ Implement auto-refresh timer in `App.tsx`
- `useEffect` watching `activeView.autoRefreshSeconds`
- `setInterval` → `search(activeView.query)` every N×1000 ms
- Clean up on view change or unmount

**Step 3.3** — ✅ On view switch with `autoQuery === true`:
- Call `search(view.query)` immediately

### Phase 4: Star Button & Favorites Interaction

**Step 4.1** — ✅ Add star button to D3 card rendering
- In `chatMapEngine.ts`, add `☆` / `★` button to the card `foreignObject` HTML at LOD ≥ summary
- Position: top-right of card body
- New CSS class: `.card-star-btn`
- Emit a new event type: `"card-star"` with `{ cardId, source }` payload

**Step 4.2** — ✅ Handle star click in App.tsx
- ✅ If only one favorites view exists: add/remove directly
- ✅ If multiple favorites views exist: show a **styled modal picker** (not `window.prompt`)
- ✅ If no favorites views exist: show inline action in the same modal to create one first
- ✅ Toggle filled/outline star based on `isFavorited(cardId, activeViewId)` or `getFavoriteViewIds(cardId).length > 0`

**Step 4.3** — ✅ Pass starred card IDs into the D3 engine
- `engine.setStarredIds(Set<string>)` — a new method on the engine
- On `update()`, the engine uses this set to decide `★` vs `☆` for each card
- When favorites change, App calls `engine.setStarredIds(...)` without a full re-render

### Phase 5: Emoji & Polish

**Step 5.1** — ✅ Change `⬇` to `💾` in `chatMapEngine.ts` → `renderExcerptLines()`

**Step 5.2** — ✅ Update ClipboardBasket empty-state text: `⬇` → `💾`

**Step 5.3** — ✅ Ensure "Latest Chats" view is not editable/deletable

**Step 5.4** — ✅ Ensure "Default Search" view cannot be deleted (but can be edited)

**Step 5.5** — ✅ Dropdown formatting: group built-in views at top, then user views, with a visual separator in the custom menu

**Step 5.6** — ✅ Verify emoji/color rendering
- ✅ Confirm each view retains emoji and color after reload
- ✅ Confirm dropdown shows visual color marker beside each view
- ✅ Confirm edit flow updates emoji/color immediately in dropdown label

**Step 5.7** — ✅ Add keyboard navigation for custom dropdown
- ✅ Arrow navigation for option traversal
- ✅ Enter to select
- ✅ Escape to close and restore focus
- ✅ Home/End jump navigation
- ✅ Typeahead navigation by view label
- ✅ Transient typeahead hint while typing

---

## 6. File Change Summary

| File                                       | Action   | Description                                                                                                             |
| ------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `src/types.ts`                             | **Edit** | Add `ViewType`, `ViewDefinition`, `FavoriteEntry`, `CardStarEventDetail`; include `emoji` + `color` in `ViewDefinition` |
| `src/hooks/useViews.ts`                    | **New**  | View CRUD + localStorage persistence                                                                                    |
| `src/hooks/useFavorites.ts`                | **New**  | Favorites CRUD + localStorage persistence                                                                               |
| `src/hooks/useSearch.ts`                   | **Edit** | Accept `viewType` param, handle `"latest"` and `"favorites"` code paths                                                 |
| `src/components/ViewDialog.tsx`            | **New**  | Add/Edit view modal                                                                                                     |
| `src/components/ViewDialog.css`            | **New**  | Modal styling                                                                                                           |
| `src/components/SearchBar.tsx`             | **Edit** | Add `+`, dropdown, `✏️`, rename button, emoji/color view labels                                                          |
| `src/components/SearchBar.css`             | **Edit** | Layout for new controls, dropdown color marker styling, and keyboard highlight states                                   |
| `src/App.tsx`                              | **Edit** | Integrate `useViews`, `useFavorites`, wire dialog, auto-refresh, star handling                                          |
| `src/components/FavoritesPickerDialog.tsx` | **New**  | Styled modal picker for selecting/creating target favorites view on star action                                         |
| `src/components/FavoritesPickerDialog.css` | **New**  | Modal picker styling                                                                                                    |
| `src/d3/chatMapEngine.ts`                  | **Edit** | Add `☆`/`★` star button, emit `"card-star"` event, `setStarredIds()` method, change `⬇` → `💾`                           |
| `src/components/ClipboardBasket.tsx`       | **Edit** | Update empty-state text (`⬇` → `💾`)                                                                                     |
| `src/hooks/useChatMap.ts`                  | **Edit** | Forward new `"card-star"` event to App                                                                                  |

---

## 7. localStorage Schema

| Key                | Type               | Description                                    |
| ------------------ | ------------------ | ---------------------------------------------- |
| `ccv:views`        | `ViewDefinition[]` | All view definitions (built-in + user)         |
| `ccv:activeViewId` | `string`           | ID of currently selected view                  |
| `ccv:favorites`    | `FavoriteEntry[]`  | All favorited cards across all favorites views |

All values are `JSON.stringify`'d. On read failure (corrupt data), fall back to default seed values and log a warning.

---

## 8. Edge Cases

| Scenario                                                | Handling                                                                                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delete the currently active view                        | Switch to the default "Search" view                                                                                                                                  |
| Delete a favorites view that has entries                | Remove the view AND its `FavoriteEntry` records                                                                                                                      |
| Star a card that's already in the target favorites view | No-op (or show a brief toast "Already in X")                                                                                                                         |
| Rename a view to an empty string                        | Validation error, Save button disabled                                                                                                                               |
| Emoji is blank or invalid                               | Fallback to type default emoji                                                                                                                                       |
| Color is invalid/missing                                | Fallback to type default color                                                                                                                                       |
| `autoRefreshSeconds` set to < 5 (but > 0)               | Clamp minimum to 5 seconds to avoid API spam                                                                                                                         |
| localStorage quota exceeded                             | Catch the error, show an error banner, don't crash                                                                                                                   |
| "Latest Chats" with no backend endpoint yet             | Phase 3.1 can stub this with a TODO or use `/api/sessions` if it returns message data; if not, this view shows a "Coming soon" message until the backend supports it |

---

## 9. Out of Scope (for this upgrade)

- URL-encoded view/query state (deep linking)
- Export/import views as JSON
- Drag-and-drop view reordering in the dropdown
- Server-side view persistence (everything is localStorage for now)
- Favorites search/filter within a favorites view
- Sharing views between machines
