# ContextCore Visualizer — UI & Hooks Deep Dive

**Date**: 2026-03-20 (updated)
**Relates to**: [`archi-context-core-visualizer.md`](../archi-context-core-visualizer.md)
**Scope**: React component design, hook internals, localStorage contracts, modal flows, Agent Builder system, template system, and project-scoped search.

---

## 1. Overview

The UI layer is a Vite + React SPA. All business logic lives in custom hooks. Components are thin: they receive props, render JSX, and delegate user interactions back to callbacks. The only exception is `SearchBar`, which owns its own input state and history panel open/close logic.

```
App.tsx
 ├─ useViews          — view definitions + active selection (persisted)
 ├─ useFavorites      — per-view starred card snapshots (persisted)
 ├─ useSearch         — view-aware card + thread sourcing (API or localStorage)
 ├─ useSearchHistory  — 100-entry FIFO query history (persisted)
 ├─ useOnlineStatus   — navigator.onLine watcher
 │
 ├─ <SearchBar>               — query input, two-column view dropdown, search history autocomplete
 │   └─ <SourceFilterDropdown>  — multi-select data source filter (agent-builder views only)
 ├─ <AgentBasket>             — agent/template creator side panel (agent-builder/agent-list/template views)
 ├─ <ChatMap>                 — React shell for the D3 engine (via useChatMap)
 ├─ <HoverPanel>              — floating metadata card on mouse-over
 ├─ <StatusBar>               — zoom level, LOD tier, latency, result count
 ├─ <ClipboardBasket>         — collected line snippets (non-agent views)
 ├─ <UpdatePrompt>            — PWA service worker update notification
 ├─ <EditResultsView>         — add/edit view modal (with scopes + project scope checkboxes)
 │   └─ <EditScope>           — inline scope metadata editor (name/emoji/color)
 ├─ <AddFavoriteMessage>      — custom text entry for favorites view
 ├─ <FavoritesPickerDialog>   — star target picker modal
 ├─ <ChatViewDialog>          — full session thread viewer + custom topic editor
 └─ <FilterDialog>            — role + min-score filter panel
```

---

## 2. App.tsx — Orchestration

**File**: [src/App.tsx](../../src/App.tsx)

`App.tsx` is the single integration point. It has no router; the application is a single SPA view. Its responsibilities are:

1. **Mount all hooks** and wire their outputs to components.
2. **Control modal visibility** via local boolean state (`isEditResultsViewOpen`, `editingView`, `isFavoritesPickerOpen`, `pendingStarDetail`, `chatViewTarget`, `isFilterDialogOpen`, `isAddFavoriteMessageOpen`).
3. **Dispatch D3 engine events** received from `useChatMap` (`onHover`, `onViewportChange`, `onLineClick`, `onCardStar`, `onTitleClick`, `onCardAddKnowledge`, `onCardEditAgent`, `onCardUseTemplate`) into the relevant UI state or hook calls.
4. **Run the auto-refresh interval**: when `activeView.autoRefreshSeconds > 0`, fire `search()` on an interval.
5. **Fire auto-query on view switch**: search fires automatically when switching to any non-search built-in view (latest, agent-builder, agent-list, template-list, favorites).
6. **Manage agent builder state**: knowledge entries, edit mode, template mode, source filter, and the create/save lifecycle.
7. **Client-side filtering pipeline**: `agentBuilderFilteredCards` (source + text filter for agent/template views) feeds into `filteredCards` (role + score filter for all views), which goes to the D3 engine.

### 2.1 State owned by App

| State                         | Type                                                                      | Purpose                                                             |
| ----------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `searchInputValue`            | `string`                                                                  | Current text in search input (synced with view query or local)      |
| `pendingSearch`               | `string \| null`                                                          | Deferred search trigger (set on view save, consumed by useEffect)   |
| `isEditResultsViewOpen`       | `boolean`                                                                 | EditResultsView visibility                                          |
| `dialogMode`                  | `"add" \| "edit"`                                                         | EditResultsView mode                                                |
| `editingView`                 | `ViewDefinition \| undefined`                                             | Which view the EditResultsView edits; undefined = add mode          |
| `isFavoritesPickerOpen`       | `boolean`                                                                 | FavoritesPickerDialog visibility                                    |
| `pendingStarDetail`           | `CardStarEventDetail \| null`                                             | Full star event detail while picker is open                         |
| `chatViewTarget`              | `{ sessionId: string; messageId: string } \| null`                        | Drives `<ChatViewDialog>` open/closed; null = closed                |
| `isFilterDialogOpen`          | `boolean`                                                                 | FilterDialog visibility                                             |
| `filterRoles`                 | `Set<AgentRole>`                                                          | Active role filter (all 4 = no filter)                              |
| `filterMinScore`              | `number`                                                                  | Active minimum score threshold (0 = no filter)                      |
| `basketLines`                 | `BasketLine[]`                                                            | ClipboardBasket collected snippets                                  |
| `agentBuilderSources`         | `{ name: string; fileCount: number }[]`                                   | Data sources fetched on mount for dropdown and source filter        |
| `agentBuilderSelectedSources` | `Set<string>`                                                             | Currently selected sources in the source filter dropdown            |
| `agentKnowledgeEntries`       | `AgentKnowledgeEntry[]`                                                   | Knowledge entries for the AgentBasket                               |
| `isCreatingAgent`             | `boolean`                                                                 | Loading state during agent/template create                          |
| `agentCreateError`            | `string \| null`                                                          | Last error from create attempt                                      |
| `agentCreateSuccess`          | `string \| null`                                                          | Success message (auto-dismissed after 5s)                           |
| `agentFlashId`                | `string \| null`                                                          | ID of knowledge entry to flash (duplicate detection feedback)       |
| `editingAgentPath`            | `string \| null`                                                          | Agent file path when editing; null = create mode                    |
| `agentEditInitial`            | `{ projectName, agentName, description, hint, tools, platform? } \| null` | Pre-fill values for AgentBasket when editing                        |
| `isFromTemplate`              | `boolean`                                                                 | Whether current agent creation was initiated from a template        |
| `activePlaceholderId`         | `string \| null`                                                          | Active placeholder entry in agent-from-template mode                |
| `basketMode`                  | `"agent" \| "template" \| "agent-from-template"`                          | Derived: controls AgentBasket behavior and labelling                |
| `agentBuilderFilteredCards`   | `CardData[]`                                                              | `useMemo` — cards after source + text filter (agent/template views) |
| `filteredCards`               | `CardData[]`                                                              | `useMemo` — cards after role + score filter applied                 |
| `hoverDetail`                 | `HoverEventDetail \| null`                                                | Forwarded to `<HoverPanel>`                                         |
| `viewport`                    | `ViewportChangeDetail`                                                    | `{x, y, k}` for StatusBar                                           |

### 2.2 Client-Side Filtering Pipeline

For agent-builder, agent-list, and template-list views, card filtering is done entirely client-side (no server round-trip):

```
useSearch.cards (full card set from server)
  → agentBuilderFilteredCards (useMemo)
      → source filter: card.project ∈ agentBuilderSelectedSources (agent-builder only)
      → text filter: searchInputValue matches card.title or card.excerptLong
  → filteredCards (useMemo)
      → role filter: card.role ∈ filterRoles
      → score filter: card.score ≥ filterMinScore
  → passed to <ChatMap> and <StatusBar>
```

For search/search-threads views, the search input triggers a server round-trip. `handleSearch` detects the view type and either calls `search()` (server) or just sets `searchInputValue` (client filter).

---

## 3. Hooks

### 3.1 `useViews` — View Definitions

**File**: [src/hooks/useViews.ts](../../src/hooks/useViews.ts)
**Storage key**: `ccv:views`, `ccv:activeViewId`

Owns the complete set of `ViewDefinition` objects and the currently active view. See [src/types.ts](../../src/types.ts) for the `ViewDefinition` and `ViewType` shapes.

#### 3.1.1 Built-in views

Eight views are seeded on first load and can never be deleted:

| id                         | name            | type              | emoji | color     |
| -------------------------- | --------------- | ----------------- | ----- | --------- |
| `built-in-latest`          | Latest Threads  | `latest`          | 🕒     | `#0ea5e9` |
| `built-in-search`          | Search Messages | `search`          | 🔎     | `#3b82f6` |
| `built-in-search-threads`  | Search Threads  | `search-threads`  | 🧵     | `#8b5cf6` |
| `built-in-favorites`       | Favorites       | `favorites`       | ⭐     | `#f59e0b` |
| `built-in-agent-builder`   | Agent Builder   | `agent-builder`   | 🏗️     | `#f97316` |
| `built-in-agent-list`      | Agent List      | `agent-list`      | 📋     | `#f97316` |
| `built-in-template-create` | Create Template | `template-create` | 📝     | `#8b5cf6` |
| `built-in-template-list`   | Template List   | `template-list`   | 📚     | `#8b5cf6` |

The first four appear in the left column of the view dropdown. The agent-builder and template views are accessed via buttons in the right column (see §4.1). All 8 are non-deletable; built-in search/favorites/threads are editable, all others are not.

#### 3.1.2 Initialization

On mount, `safeReadViews()` reads `ccv:views`, strips any built-in IDs from stored data, normalizes user views (`normalizeView()`: clamps `autoRefreshSeconds`, validates hex color, trims emoji, ensures `projects` is an array), then injects built-in constants at the front. Falls back to seed defaults on parse failure.

#### 3.1.3 Public API

`createView`, `updateView`, `deleteView`, `switchView` — see [src/hooks/useViews.ts](../../src/hooks/useViews.ts). `createView` auto-generates a UUID and immediately switches to the new view.

---

### 3.2 `useFavorites` — Per-View Starred Cards & Threads

**File**: [src/hooks/useFavorites.ts](../../src/hooks/useFavorites.ts)
**Storage key**: `ccv:favorites`

Stores a flat `FavoriteEntry[]`. Favorites are keyed by `(cardId, viewId)`, so the same card can appear in multiple favorites views independently. The `FavoriteSource` union holds either a full `SerializedAgentMessage` or `SerializedAgentThread` snapshot (denormalized so favorites survive backend changes).

Legacy entries (missing the `type` discriminator) are transparently migrated to `{ type: "message", data: ... }` on load.

**Star button logic in App**: When a star event arrives, if the card is unfavorited and only one favorites view exists, add directly. Otherwise open `FavoritesPickerDialog` with checkboxes for each favorites view so the user can add/remove from multiple views at once.

---

### 3.3 `useSearch` — View-Aware Card Sourcing

**File**: [src/hooks/useSearch.ts](../../src/hooks/useSearch.ts)

Centralizes all card-population logic. Data source per view type:

| `activeView.type`   | API call                                   | Populates               |
| ------------------- | ------------------------------------------ | ----------------------- |
| `"search"`          | `POST /api/search` (or GET if no projects) | `cards`                 |
| `"search-threads"`  | `POST /api/search/threads` (or GET)        | `threadCards`           |
| `"latest"`          | `GET /api/threads/latest`                  | `threadCards`           |
| `"favorites"`       | Local — from `useFavorites`                | `cards` + `threadCards` |
| `"agent-builder"`   | `POST /api/agent-builder/prepare`          | `cards`                 |
| `"agent-list"`      | `GET /api/agent-builder/list`              | `cards`                 |
| `"template-list"`   | `GET /api/agent-builder/list-templates`    | `cards`                 |
| `"template-create"` | (none — empty canvas)                      | (empty)                 |

**Project-scoped search**: When `activeView.projects` is non-empty, `searchMessages()` / `searchThreads()` switch from GET to POST, sending `{ query, projects: SelectedProject[] }` in the body.

**Card conversion functions** (all in `useSearch.ts`):
- `toCardsFromMessages()` — message search results → `CardData[]`
- `toThreadCards()` — thread results → `ThreadCardData[]`
- `toAgentBuilderCards()` — `IndexedFile[]` → `CardData[]` (id = absolutePath, title = filename, excerptLong = file excerpt)
- `toAgentListCards()` — `AgentListEntry[]` → `CardData[]` (harness = "AgentCard")
- `toTemplateListCards()` — `CreateTemplateInput[]` → `CardData[]` (harness = "TemplateCard", source.message = full JSON for edit/use flows)

---

### 3.4 `useSearchHistory` — Query FIFO Queue

**File**: [src/hooks/useSearchHistory.ts](../../src/hooks/useSearchHistory.ts)
**Storage key**: `ccv:searchHistory`

Max 100 entries, newest first. Deduplicates by case-insensitive match (moves to front). `getMatches(input, limit=10)` returns substring-matched entries. History is only written by App (on successful search), never by SearchBar.

---

### 3.5 `useChatMap` — React ↔ D3 Bridge

**File**: [src/hooks/useChatMap.ts](../../src/hooks/useChatMap.ts)

Manages the lifecycle of the imperative D3 engine declaratively. Key behaviours:

- **Ref-stabilised callbacks**: All event callbacks (`onHover`, `onCardStar`, `onCardAddKnowledge`, etc.) are mirrored into refs so the engine closure never needs recreation on re-render.
- **Engine created once**: The init `useEffect` depends only on `containerRef` (stable object), so the engine mounts exactly once.
- **`setConfig()`**: Called when `viewType` changes (to set `cardRenderMode`) and when `panelWidth` changes (to set `viewportInset.left`). Replaces the old `setAgentBuilderMode()` / `setCardRenderMode()` methods.
- **Signature-gated zoom-to-fit**: Only fires when the card set identity actually changes (checked via a `cards.length + ids` signature string), so hover changes and resize events don't trigger a viewport reset.
- **ResizeObserver**: Re-runs layout on container size change using latest card refs (no stale closures).

#### Card Render Modes

| Mode              | 📎 Add Knowledge | 💾 Save Line | ☆ Star | ✏️ Edit | 🔨 Use Template |
| ----------------- | --------------- | ----------- | ------ | ------ | -------------- |
| `"default"`       | ❌               | ✅           | ✅      | ❌      | ❌              |
| `"agent-builder"` | ✅               | ❌           | ❌      | ❌      | ❌              |
| `"agent-list"`    | ❌               | ❌           | ❌      | ✅      | ❌              |
| `"template-list"` | ❌               | ❌           | ❌      | ✅      | ✅              |

#### Viewport Inset

When the AgentBasket panel is visible (agent-builder, agent-list, template-create, template-list views), `panelWidth = 440` is passed to `ChatMap` → `useChatMap` → `engine.setConfig({ viewportInset: { left: 440, ... } })`. This adjusts `zoomToFit()` centering and grid layout to avoid placing cards behind the panel.

---

### 3.6 `useOnlineStatus`

**File**: [src/hooks/useOnlineStatus.ts](../../src/hooks/useOnlineStatus.ts)

Watches `navigator.onLine` / `online` / `offline` events. Returns `{ isOnline: boolean }`. Used by `StatusBar` for the connectivity indicator and by `useSearch` to tailor error messages.

---

## 4. Components

### 4.1 `SearchBar`

**Files**: [src/components/searchTools/SearchBar.tsx](../../src/components/searchTools/SearchBar.tsx), [src/components/searchTools/SearchBar.css](../../src/components/searchTools/SearchBar.css)

Layout (left to right):

```
[+]  [▾ View Dropdown]  [✏️]  [📁 Sources ▾]  [🔍]  [Since]  [Limit]  [input + history panel]  [Search]  [Filter]  [Instant filter]
```

The `📁 Sources` filter is only visible when `activeView.type === "agent-builder"`.

#### Two-Column View Dropdown

```
┌──────────────────────────────────────────────────────┐
│ VIEWS                       │ AGENT BUILDER           │
│ ──────────────────────────  │ ──────────────────────  │
│ Built-in                    │  ▶ Launch Builder       │
│  🕒 ██ Latest Threads       │  📋 List Agents         │
│  🔎 ██ Search Messages      │ ──────────────────────  │
│  🧵 ██ Search Threads       │ TEMPLATES               │
│  ⭐ ██ Favorites            │  📝 Create Template     │
│                             │  📚 List Templates      │
│ Favorites / Searches        │                         │
│  ...user views...           │                         │
└──────────────────────────────────────────────────────┘
```

Left column (`role="listbox"`): Built-in, Favorites, Searches groups. Right column (`role="group"`): Agent Builder and Templates action buttons. `ArrowRight` from left column moves focus to right column; `ArrowLeft` returns. `ArrowDown/Up` cycles buttons within the right column. Typeahead works in the left column only.

#### Search/Edit disabled states

| View type         | Search input  | ✏️ Edit | Source filter |
| ----------------- | ------------- | ------ | ------------- |
| `search`          | ✅ server      | ✅      | ❌             |
| `search-threads`  | ✅ server      | ✅      | ❌             |
| `latest`          | ❌             | ❌      | ❌             |
| `favorites`       | ❌             | ✅      | ❌             |
| `agent-builder`   | ✅ client-side | ❌      | ✅             |
| `agent-list`      | ✅ client-side | ❌      | ❌             |
| `template-create` | ❌             | ❌      | ❌             |
| `template-list`   | ✅ client-side | ❌      | ❌             |

The Filter button is disabled for agent-builder, agent-list, template-create, and template-list views.

Additional SearchBar controls:
- `Since:` preset dropdown with optional custom date input.
- `Limit:` dropdown used by `latest` and `search-threads` views.
- `Instant filter...` text input for client-side filtering of already-fetched cards.

---

### 4.2 `EditResultsView`

**File**: [src/components/searchView/EditResultsView.tsx](../../src/components/searchView/EditResultsView.tsx)

Add/edit modal for user-created views. In edit mode shows a Delete button with inline confirmation. Fields: Name, Type (radio: Search/Favorites), Emoji, Color, Query, Auto Query, Auto Refresh, and (for search/search-threads) a **scopes + project scope grid**.

**Scopes** (search type only): Fetches persisted scopes from `GET /api/list-scopes` on modal open. Scopes are displayed as clickable buttons (emoji + name + color swatch); selecting a scope loads its `projectIds` into the project checkbox grid. Three scope actions are available:
- **Create Scope**: saves currently selected projects as a new named scope (requires ≥ 2 projects). Opens an inline `EditScope` editor for name/emoji/color (name max 40 chars, emoji defaults to "📦", color validated as `#RRGGBB`).
- **Modify Scope**: edits the selected scope's metadata via the same inline editor.
- **Update Scope Selection**: overwrites the selected scope's `projectIds` with the current checkbox state.

All scope mutations call `saveScopes()` → `POST /api/scopes` to persist the full list to `zeSettings/scopes.json`.

**Project scope grid** (below scopes): fetches `GET /api/projects` on mount, renders a `PROJECT [HARNESS]` checkbox per combination in two columns (max 500px scrollable), with a live search filter above. Checked projects are saved as `ViewDefinition.projects: SelectedProject[]`. Empty projects array = global (unfiltered) search.

All agent-builder/template built-in views have the ✏️ button disabled.

---

### 4.3 `FavoritesPickerDialog`

**File**: [src/components/favorites/FavoritesPickerDialog.tsx](../../src/components/favorites/FavoritesPickerDialog.tsx)

Shown when the star button is clicked. Displays checkboxes for each favorites view (pre-checked if the card is already in that view) plus an inline "New view" row. Applies all additions/removals in one batch on Save.

---

### 4.4 `HoverPanel`

**File**: [src/components/searchTools/HoverPanel.tsx](../../src/components/searchTools/HoverPanel.tsx)

Floating panel near the cursor. Distinguishes card type via `"messageCount" in data`. Thread cards show a fixed stats layout (messages, total length, date range, matches, score, excerpt). Message cards switch between full-content layout (zoom < 1.2) and metadata-only layout (zoom ≥ 1.2). Agent-list cards (harness = "AgentCard") show Agent Name, Description, and Hint rows.

---

### 4.5 `ClipboardBasket`

**File**: [src/components/searchView/ClipboardBasket.tsx](../../src/components/searchView/ClipboardBasket.tsx)

Side panel for collecting message excerpt lines via the `💾` button in D3. Only visible when the active view is **not** an agent-builder/template view (those show `AgentBasket` instead). Entries can be reordered, removed individually, or copied as a JSON blob.

---

### 4.6 `StatusBar`

**File**: [src/components/searchTools/StatusBar.tsx](../../src/components/searchTools/StatusBar.tsx)

Fixed bottom bar. Result count label is context-aware: "X messages", "X threads", "X messages, Y threads" (favorites), "X agents", "X templates", or "Template Creator". Also shows zoom level, LOD tier, latency, loading indicator, and online/offline status.

---

### 4.7 `ChatMap`

**File**: [src/components/searchView/ChatMap.tsx](../../src/components/searchView/ChatMap.tsx)

Thin React shell rendering `<div ref={containerRef}>` passed to `useChatMap`. The D3 engine mutates the SVG DOM inside. Forwards `viewType` and all event callbacks. Shows empty-state and loading overlays.

---

### 4.8 `ChatViewDialog`

**File**: [src/components/searchView/ChatViewDialog.tsx](../../src/components/searchView/ChatViewDialog.tsx)

Full-screen modal showing a chat session as a chat-bubble thread. Opened on card title click. Fetches `GET /api/sessions/:sessionId` on mount. Supports inline topic editing (POST /api/topics). Text selection inside the dialog shows a floating `💾` button to add selected text to the ClipboardBasket. Sub-components: `MessageBubble` (scroll-to + blink animation for target message), `ToolCallBlock` (expand/collapse per tool call).

---

### 4.9 `FilterDialog`

**File**: [src/components/searchTools/FilterDialog.tsx](../../src/components/searchTools/FilterDialog.tsx)

Modal for role + minimum score filtering. Initializes from `currentFilters` each time it opens (non-destructive cancel). `availableRoles` comes from App as the union of roles in the current card set. Apply → updates `filterRoles` + `filterMinScore` in App → `filteredCards` recomputes → D3 engine receives updated set.

---

### 4.10 `AgentBasket`

**Files**: [src/components/agentBuilder/AgentBuilder.tsx](../../src/components/agentBuilder/AgentBuilder.tsx), [src/components/agentBuilder/AgentBuilder.css](../../src/components/agentBuilder/AgentBuilder.css)

Tall side panel for building agents and templates. Visible when active view is agent-builder, agent-list, template-create, or template-list. `ClipboardBasket` is hidden while AgentBasket is shown.

#### Modes

| Mode                    | Header title                      | Create button     |
| ----------------------- | --------------------------------- | ----------------- |
| `"agent"`               | "🏗️ Agent Creator"                 | "🏗️ Create"        |
| `"agent"` (edit)        | "✏️ Edit Agent"                    | "💾 Save"          |
| `"template"`            | "📝 Template Creator"              | "📝 Save Template" |
| `"agent-from-template"` | "🏗️ Agent Creator (from template)" | "🏗️ Create"        |

#### Panel layout

```
┌─────────────────────────────────────────┐
│ 🏗️ Agent Creator  [Cancel] [Create] [✕] │
│  [ ☑ GitHub Copilot ]  [ ☐ Claude Code ]│  ← platform checkboxes (not in template mode)
│  ⚠ error / ✓ success banners           │
│  Project  [▾ select ]                   │  ← not in template mode
│  Name     [slug-input    ]              │  ← auto-slugified on blur
│  Desc / Hint / Tools  [...]             │
│  Knowledge (N entries)                  │
│  ┌ ⬆✕⬇ 📄 path/to/file.md ──────────── ┐│
│  │ ⬆✕⬇ ✏️ custom text ──────────────── ││
│  │ ⬆✕⬇ 🔲 ▶ PLACEHOLDER (active) ───── ││
│  └─────────────────────────────────────┘│
│  [custom textarea…               ✓]     │
│  [ Add PLACEHOLDER ]  ← template mode only
└─────────────────────────────────────────┘
```

#### Key behaviours

- **Platform checkboxes**: Default is GitHub only. Both can be checked — fires two sequential `POST /api/agent-builder/create` calls (one per platform). Not shown in template mode.
- **Knowledge entries**: Three kinds: `"file"` (from 📎 on card), `"custom"` (from textarea), `"placeholder"` (template slots). Each has ⬆/✕/⬇ controls.
- **Duplicate detection**: Adding a file already in the list flashes the existing entry instead of duplicating.
- **Agent-from-template mode**: File additions replace the active placeholder rather than appending. The next unreplaced placeholder becomes active automatically. Removing a filled placeholder restores it to placeholder status. All placeholders must be replaced before Create is enabled.
- **Save state preservation**: After a successful save, the form is **not** cleared — the user can tweak and re-save. Only the explicit ✕ button or Cancel Edit clears the form.
- **Auto-select project**: If all file entries share the same `sourceName`, the Project dropdown is auto-selected to that source.
- **Slug validation**: `agentName` must match `^[a-z0-9]+(?:-[a-z0-9]+)*$`. Invalid characters are stripped on blur.

---

### 4.11 `SourceFilterDropdown`

**Files**: [src/components/agentBuilder/SourceFilterDropdown.tsx](../../src/components/agentBuilder/SourceFilterDropdown.tsx), [src/components/agentBuilder/SourceFilterDropdown.css](../../src/components/agentBuilder/SourceFilterDropdown.css)

Multi-select dropdown for agent-builder source filtering. Button label shows "📁 Sources (N/M)". Popup has a "All" toggle plus one checkbox per source name. Deselecting all sources shows 0 cards. Positioned between ✏️ and the search input in SearchBar, visible only when `activeView.type === "agent-builder"`.

---

### 4.12 `AddFavoriteMessage`

**File**: [src/components/favorites/AddFavoriteMessage.tsx](../../src/components/favorites/AddFavoriteMessage.tsx)

Dialog for adding or editing a custom text entry in the favorites view. Shown only when active view type is `"favorites"`.

Collected fields:
- Title
- Message body
- Emoji (optional)
- Color (defaults to `#6b7280`)

Creates a synthetic `SerializedAgentMessage` with `harness: "custom"` and adds it as a message-type favorite entry. Emoji and color are persisted in tags as `customEmoji:*` and `customColor:*`.

---

## 5. View System — Detailed Flows

### 5.1 Switching Views

On view switch, `useViews.switchView()` persists `ccv:activeViewId`. A `useEffect` in App fires `search()` for all view types (non-search views auto-load their data). AgentBasket and ClipboardBasket visibility flip based on view type. D3 engine receives updated `cardRenderMode` and `viewportInset` via `setConfig()`.

### 5.2 Starring a Card or Thread

D3 emits `"line-star"` (message) or `"thread-star"` (thread). If unfavorited and exactly 1 favorites view exists → add directly. Otherwise → open `FavoritesPickerDialog` with checkboxes per favorites view. `FavoritesPickerDialog` applies all additions/removals in one batch. `starredCardIds` set recalculates → engine re-renders ★/☆ without full relayout.

### 5.3 Auto-Refresh

For search views with `autoRefreshSeconds > 0`, a `setInterval` in App calls `search(activeView.query)` on the configured interval. Cleared and re-established when the view or refresh rate changes.

### 5.4 Launching Agent Builder

"▶ Launch Builder" in dropdown right column → `switchView("built-in-agent-builder")` → `fetchAgentBuilderPrepare()` → file cards rendered → AgentBasket visible (mode = "agent") → D3 `cardRenderMode = "agent-builder"` → viewport inset applied.

### 5.5 Adding Knowledge from File Cards

User clicks 📎 on a file card → D3 emits `"card-add-knowledge"` with `{ cardId, relativePath, sourceName }`. In normal mode: deduplication check, then append as `kind: "file"`. In agent-from-template mode: replaces the active placeholder, then advances to the next unreplaced placeholder.

### 5.6 Creating an Agent

AgentBasket calls `onCreateAgent(input, platforms)`. App loops over platforms, firing `POST /api/agent-builder/create` for each. On success: shows a success banner (auto-dismisses in 5s). Form state is preserved. In agent-from-template mode: auto-switches to agent-list after success.

### 5.7 Editing an Existing Agent

User clicks ✏️ on an agent-list card → D3 emits `"card-edit-agent"` → App calls `GET /api/agent-builder/get-agent?path=<path>` → populates `agentKnowledgeEntries` and `agentEditInitial` → switches to agent-builder view. AgentBasket shows "✏️ Edit Agent" header and "💾 Save" button.

### 5.8 Template Lifecycle

- **Create**: Switch to template-create view → AgentBasket in template mode (no Project, no platform checkboxes) → `POST /api/agent-builder/add-template` → auto-switch to template-list.
- **Use**: User clicks 🔨 on a template-list card → template JSON parsed from `card.source.message` → knowledge entries pre-populated with files + placeholders → `isFromTemplate = true` → switch to agent-builder in "agent-from-template" mode.
- **Edit**: User clicks ✏️ on a template-list card → detected via `card.harness === "TemplateCard"` → template JSON parsed → AgentBasket populated → switch to template-create view.

---

## 6. localStorage Contract

| Key                 | Owner hook         | Format                  | Notes                                                                                                  |
| ------------------- | ------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `ccv:views`         | `useViews`         | `ViewDefinition[]` JSON | Built-ins stripped on read; re-injected from constants. Includes `projects` field for scoped searches. |
| `ccv:activeViewId`  | `useViews`         | string                  | Validated against loaded views on mount; falls back to `built-in-latest`                               |
| `ccv:favorites`     | `useFavorites`     | `FavoriteEntry[]` JSON  | Polymorphic `FavoriteSource`; legacy entries auto-migrated                                             |
| `ccv:searchHistory` | `useSearchHistory` | `string[]` JSON         | Max 100 entries, newest first                                                                          |

All reads are `try/catch`-guarded with safe fallbacks. Write failures surface as `storageError` in App.

---

## 7. Type Reference

All shared types live in [src/types.ts](../../src/types.ts). Key shapes:

- **`ViewType`**: `"search" | "search-threads" | "latest" | "favorites" | "agent-builder" | "agent-list" | "template-create" | "template-list"`
- **`ViewDefinition`**: includes `projects?: SelectedProject[]` for scoped searches
- **`ProjectGroup` / `SelectedProject`**: harness:project pairs for filtered search
- **`Scope`**: persisted project grouping (`id`, `name`, `emoji`, `color`, `projectIds: SelectedProject[]`); managed via `GET /api/list-scopes` and `POST /api/scopes`
- **`IndexedFile` / `PrepareResponse`**: agent-builder file data from server
- **`AgentKnowledgeEntry`**: basket entry with `kind: "file" | "custom" | "placeholder"` and optional `placeholderIndex`
- **`CreateAgentInput`**: includes `platform: "github" | "claude"`
- **`AgentListEntry` / `AgentDefinition` / `GetAgentResponse`**: agent list and edit types
- **`CreateTemplateInput` / `TemplateListResponse`**: template types
- **`CardAddKnowledgeEventDetail` / `CardEditAgentEventDetail` / `CardUseTemplateEventDetail`**: new D3 engine event payloads

---

## 8. D3 Engine — Key Concepts

### 8.1 Harness Colors

Defined in [src/d3/colors.ts](../../src/d3/colors.ts). Notable entries added for agent builder:

| Harness          | Color     | Used for                                        |
| ---------------- | --------- | ----------------------------------------------- |
| `"AgentFile"`    | `#f97316` | File cards where `origin === "agent"`           |
| `"ContentFile"`  | `#06b6d4` | File cards where `origin === "content"`         |
| `"AgentCard"`    | `#f97316` | Agent definition cards in agent-list view       |
| `"TemplateCard"` | `#8b5cf6` | Template definition cards in template-list view |

### 8.2 Engine Config API

The D3 engine (`src/d3/chatMapEngine.ts`) exposes `setConfig(partial: Partial<EngineConfig>)` which merges into the current engine state. Two fields:
- `cardRenderMode`: controls which action buttons appear on cards (see §3.5 table)
- `viewportInset`: adjusts `zoomToFit()` centering and grid layout width to account for side panels
