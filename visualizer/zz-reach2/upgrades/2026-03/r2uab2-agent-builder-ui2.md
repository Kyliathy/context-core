# r2uab2-ui – Agent Builder UI Phase 2: Source Filter, File Search, Agent List & Edit

**Date**: 2026-03-17
**Status**: All groups done (2026-03-17)
**Scope**: Source-filter dropdown, agent-builder file search, agent listing via cards, card button customisation per mode, agent edit flow
**Depends on**: [r2uab-ui – Agent Builder UI](r2uab-agent-builder-ui.md), [r2uab2 – AgentBuilder Phase 2 (server)](../../server/zz-reach2/upgrades/2026-03/r2uab2-agent-builder-2.md)

---

## 1. Problem

The Agent Builder view is functional for creating agents, but several gaps remain:

1. **No source filtering** — When the user has multiple data sources (e.g. "Context Core Server" + "Context Core Front"), there's no way to filter the file cards to just one source. A multi-select filter dropdown is needed.
2. **Search is disabled** — The search textbox is currently disabled in agent-builder mode, but users need to search file names and excerpts to find specific files quickly.
3. **No agent listing** — There's no way to browse existing agents. The dropdown right column shows data source names, but what we really need is a "List Agents" button that displays agents as cards.
4. **No agent editing** — Once an agent is created, there's no way to edit it. We need cards with an edit button that loads the agent definition into the AgentBasket for modification.
5. **Card button uniformity** — All card types (chat messages, threads, content files, agent files, agent cards) render the same action buttons (💾, ☆, 📋). This is wrong for agent cards where the only relevant action is "✏️ Edit".

---

## 2. Design

### 2.1 Source Filter Dropdown (before search textbox)

A new UI element inserted **before** the search input (after the ✏️ edit button):

```
[+] [▾ View] [✏️] [📁 Sources ▾] [🔍 search input] [Search] [Filter]
```

- Only visible when `activeView.type === "agent-builder"` (both `"agent-builder"` and `"agent-list"` sub-modes)
- Renders as a button with label showing count: "📁 Sources (2/3)" meaning 2 of 3 sources selected
- Clicking opens a checkbox dropdown below the button listing all available source names
- Each checkbox toggles that source on/off
- A "Select All / Deselect All" toggle at the top
- The filter is applied **client-side** to the cards already fetched from `/prepare` — no new server call

### 2.2 File Search in Agent Builder

Currently `isSearchDisabled` is true for agent-builder views. Changes:

- **Enable the search textbox** when in agent-builder or agent-list mode
- The search does **client-side filtering** on the already-loaded cards (not a server round-trip)
- Matches against `card.title` (filename) and `card.excerptLong` (file excerpt) using case-insensitive substring matching
- Filtering is applied in a `useMemo` pipeline: `fetchedCards → sourceFilter → textFilter → renderedCards`
- The search button and Enter key trigger the filter; on every keystroke we also update (live filtering)

### 2.3 Dropdown Right Column Changes

Remove the per-source listing from the dropdown right column. Replace with:

```
┌──────────────────────────────────────────────────────┐
│ VIEWS                       │ AGENT BUILDER           │
│ ──────────────────────────  │ ──────────────────────  │
│ Built-in                    │                         │
│  🕒 ██ Latest Threads       │  ▶ Launch Builder       │
│  🔎 ██ Search Messages      │  📋 List Agents         │
│  🧵 ██ Search Threads       │                         │
│  ⭐ ██ Favorites            │                         │
│ ...                         │                         │
└──────────────────────────────────────────────────────┘
```

- "▶ Launch Builder" — switches to `agent-builder` view (file cards from `/prepare`) — same as today
- "📋 List Agents" — switches to a **new** `agent-list` view (agent cards from `/agent-builder/list`)
- Data source listing is removed from the dropdown (sources are now accessible via the source filter dropdown on the search bar itself)

### 2.4 Agent List View (`agent-list`)

A new `ViewType` value: `"agent-list"`. When active:

- `useSearch` calls `GET /api/agent-builder/list` and converts `AgentListEntry[]` to `CardData[]` via a new `toAgentListCards()` function
- Card mapping:

| CardData field   | Source                                            |
| ---------------- | ------------------------------------------------- |
| `id`             | `path` (absolute path to .agent.md)               |
| `title`          | `name` (the agent slug, e.g. "cxc-server-worker") |
| `excerptShort`   | `description`                                     |
| `excerptMedium`  | `description` + `\nhint: ` + `hint`               |
| `excerptLong`    | `excerpt` (first 1000 chars of .agent.md)         |
| `harness`        | `"AgentFile"` (uses the existing orange colour)   |
| `project`        | extracted from excerpt frontmatter or `name`      |
| `score`          | `1.0` (no ranking)                                |
| `role`           | `"system"`                                        |
| `source.message` | `excerpt` (for detail-3+ LOD rendering)           |

- Search textbox is **enabled** for this view — filters agents by name/description client-side
- Source filter is **hidden** for agent-list (agents don't have multiple sources in the same way)
- AgentBasket panel still shows (so user can see the form — useful when transitioning to edit mode)

### 2.5 Card Button Customisation (Card Rendering Modes)

The `renderCardHtml` function currently renders the same buttons for every card type. We need mode-aware rendering:

**Introduce a `CardRenderMode`** passed to `renderCardHtml`:

```typescript
type CardRenderMode = "default" | "agent-builder" | "agent-list";
```

| Mode            | 💾 Save/Add        | ☆ Star | 📋 Copy | ✏️ Edit | 📧 Envelope |
| --------------- | ----------------- | ------ | ------ | ------ | ---------- |
| `default`       | ✅ (line-click)    | ✅      | ✅      | ❌      | ✅          |
| `agent-builder` | ✅ (add-knowledge) | ❌      | ❌      | ❌      | ❌          |
| `agent-list`    | ❌                 | ❌      | ❌      | ✅      | ❌          |

For `agent-list` mode, the `renderExcerptLines` function either omits action buttons entirely or shows only the ✏️ edit button. A simpler approach: render a single **card-level** edit button (not per-line) in `renderCardHtml` for agent-list mode, e.g. next to the harness badge:

```html
<span class="card-edit-btn" title="Edit agent">✏️</span>
```

This replaces the 📧 envelope button position. The D3 click handler detects `.card-edit-btn` and emits a new `"card-edit-agent"` event.

### 2.6 Agent Edit Flow

When the user clicks ✏️ on an agent card:

1. **D3 emits** `"card-edit-agent"` with `{ cardId, agentPath: card.id }` (card.id = absolute path to .agent.md)
2. **App.tsx handler** `handleEditAgent`:
   a. Calls `GET /api/agent-builder/get-agent?path=<agentPath>` (new API function in `search.ts`)
   b. On success, receives `{ agent: AgentDefinition }` — the `AgentDefinition` has exactly the same shape as `CreateAgentInput` plus `fromJson: boolean`
   c. **Populates AgentBasket** state:
      - `projectName` → `agent.projectName`
      - `agentName` → `agent.agentName`
      - `description` → `agent.description`
      - `argumentHint` → `agent["argument-hint"]`
      - `tools` → `agent.tools?.join(", ") ?? ""`
      - `agentKnowledgeEntries` → `agent.agentKnowledge.map(path => AgentKnowledgeEntry)` — each path becomes a `kind: "file"` entry
   d. **Switches view** to `"agent-builder"` (the file card view from `/prepare`) so the user can add/remove knowledge files
   e. Sets an `editingAgentPath` state that indicates we're in edit mode (re-save will overwrite, not create)

3. **AgentBasket** shows the pre-populated form. The "🏗️ Create" button label changes to "💾 Save" when in edit mode. Submission still calls `POST /api/agent-builder/create` (the server endpoint handles overwrite via the agent name — or we can later add a dedicated update endpoint, but create with the same name+project is sufficient for now since the server already writes to `{agentPath}/{agentName}.agent.md` deterministically).

### 2.7 AgentBasket Edit Mode Props

New props on `AgentBasket`:

| Prop             | Type                  | Description                             |
| ---------------- | --------------------- | --------------------------------------- |
| `editMode`       | `boolean`             | Whether we're editing an existing agent |
| `initialProject` | `string \| undefined` | Pre-fill project name                   |
| `initialName`    | `string \| undefined` | Pre-fill agent name                     |
| `initialDesc`    | `string \| undefined` | Pre-fill description                    |
| `initialHint`    | `string \| undefined` | Pre-fill argument hint                  |
| `initialTools`   | `string \| undefined` | Pre-fill tools (comma-separated)        |

When `editMode` flips from false→true with initial values, the component calls its `useState` setters to populate the form. The "Create" button says "Save" in edit mode.

---

## 3. New Types

### 3.1 `ViewType` extension

```typescript
export type ViewType = "search" | "search-threads" | "latest" | "favorites" | "agent-builder" | "agent-list";
```

### 3.2 `AgentListEntry` (client-side mirror)

```typescript
export type AgentListEntry = {
  name: string;
  path: string;
  description: string;
  hint: string;
  excerpt: string;
};

export type AgentListResponse = {
  totalAgents: number;
  agents: AgentListEntry[];
};
```

### 3.3 `AgentDefinition` (client-side mirror)

```typescript
export type AgentDefinition = CreateAgentInput & {
  fromJson: boolean;
};

export type GetAgentResponse = {
  agent: AgentDefinition;
};
```

### 3.4 `CardRenderMode`

```typescript
type CardRenderMode = "default" | "agent-builder" | "agent-list";
```

(Internal to `chatMapEngine.ts`, not exported to types.ts.)

### 3.5 `CardEditAgentEventDetail`

```typescript
export type CardEditAgentEventDetail = {
  cardId: string;
  agentPath: string;
};
```

### 3.6 Source Filter State

```typescript
// In App.tsx state:
agentBuilderSelectedSources: Set<string>  // source names that are "checked"
```

---

## 4. New API Functions

### 4.1 `fetchAgentBuilderList`

```typescript
export async function fetchAgentBuilderList(): Promise<AgentListResponse> {
  const response = await fetch("/api/agent-builder/list");
  if (!response.ok) {
    throw new Error(`Agent list failed: ${response.status}`);
  }
  return response.json();
}
```

### 4.2 `fetchAgentBuilderGetAgent`

```typescript
export async function fetchAgentBuilderGetAgent(path: string): Promise<GetAgentResponse> {
  const response = await fetch(`/api/agent-builder/get-agent?path=${encodeURIComponent(path)}`);
  if (!response.ok) {
    throw new Error(`Get agent failed: ${response.status}`);
  }
  return response.json();
}
```

---

## 5. Client-Side Filtering Pipeline

For agent-builder view, the card pipeline becomes:

```
fetchAgentBuilderPrepare() → allAgentBuilderCards (stored in state)
  → filter by selectedSources (source filter dropdown)
  → filter by searchInput (text search on title + excerptLong)
  → filteredCards (rendered on map)
```

This replaces the current flow where `useSearch` produces `cards` directly. The source filter and text filter are applied in `App.tsx` via `useMemo` on the cards returned by `useSearch`, similar to how `filteredCards` already applies role/score filters.

**Implementation approach**: Keep `useSearch` producing the full card set from the server. Add filtering in `App.tsx`:

```typescript
const agentBuilderFilteredCards = useMemo(() => {
  if (activeView.type !== "agent-builder") return cards;
  return cards.filter(card => {
    // Source filter
    if (agentBuilderSelectedSources.size > 0 && !agentBuilderSelectedSources.has(card.project)) {
      return false;
    }
    // Text search
    if (searchInputValue.trim()) {
      const q = searchInputValue.trim().toLowerCase();
      return card.title.toLowerCase().includes(q) || card.excerptLong.toLowerCase().includes(q);
    }
    return true;
  });
}, [activeView.type, cards, agentBuilderSelectedSources, searchInputValue]);
```

The existing `filteredCards` (role/score filter) is then applied on top of `agentBuilderFilteredCards` instead of raw `cards`.

---

## 6. Implementation Plan

### Group A — Types & API Layer

{{SIMPLE}}

- [x] **A1** — Add `"agent-list"` to `ViewType` union in `types.ts`
- [x] **A2** — Add `AgentListEntry`, `AgentListResponse`, `AgentDefinition`, `GetAgentResponse` types to `types.ts`
- [x] **A3** — Add `CardEditAgentEventDetail` type to `types.ts`
- [x] **A4** — Add `fetchAgentBuilderList()` function to `api/search.ts`
- [x] **A5** — Add `fetchAgentBuilderGetAgent(path)` function to `api/search.ts`

### Group B — View Registration & Data Flow

{{SIMPLE}}

- [x] **B1** — Add `AGENT_LIST_VIEW` built-in view in `useViews.ts`: `{ id: "built-in-agent-list", name: "Agent List", emoji: "📋", color: "#f97316", type: "agent-list", query: "", autoQuery: false, autoRefreshSeconds: 0, createdAt: 5 }`
- [x] **B2** — Add `toAgentListCards(agents: AgentListEntry[]): CardData[]` conversion function in `useSearch.ts`
- [x] **B3** — Add `agent-list` branch in `useSearch.search()`: call `fetchAgentBuilderList()`, convert with `toAgentListCards()`, set cards
- [x] **B4** — Add `"AgentCard"` harness entry to `HARNESS_COLORS` in `d3/colors.ts` — same orange `"#f97316"` but distinguishable label

### Group C — Dropdown Changes (Launch Builder + List Agents)

{{SIMPLE}}

- [x] **C1** — Remove `agentBuilderSources` prop and source listing from `SearchBar.tsx` right column
- [x] **C2** — Add `onListAgents` prop to `SearchBar`. Add "📋 List Agents" button below "▶ Launch Builder" in right column, wired to `onListAgents()` + close dropdown
- [x] **C3** — In `App.tsx`, create `handleListAgents` callback: calls `switchView("built-in-agent-list")`. Pass to `SearchBar` as `onListAgents`
- [x] **C4** — Update `isSearchDisabled` in `App.tsx`: agent-builder and agent-list views should NOT be disabled (remove them from disabled condition)
- [x] **C5** — Update `isEditDisabled` in `App.tsx`: add `"built-in-agent-list"` to the disabled condition
- [x] **C6** — Update `isFilterDisabled` in `App.tsx`: disable filter for agent-builder and agent-list (role/score filters don't apply)
- [x] **C7** — Keyboard nav: ArrowRight from left column can land on either button. ArrowDown/ArrowUp inside right column moves between the two buttons.

### Group D — Source Filter Dropdown

{{MEDIUM}}

- [x] **D1** — Add `agentBuilderSelectedSources` state (type `Set<string>`) to `App.tsx`, initialised to empty set (= all selected)
- [x] **D2** — When agent-builder sources are fetched on mount, initialise `agentBuilderSelectedSources` with all source names (empty set means "all")
- [x] **D3** — Create `SourceFilterDropdown` component: button + checkbox popup. Props: `sources: string[]`, `selected: Set<string>`, `onChange: (selected: Set<string>) => void`, `visible: boolean`. Renders: button labeled "📁 Sources (N/M)", click toggles popup, each source has a checkbox, "All" toggle at top
- [x] **D4** — Place `SourceFilterDropdown` in the search bar area (between ✏️ and 🔍), conditionally rendered when `activeView.type === "agent-builder"`
- [x] **D5** — Style `SourceFilterDropdown`: `.source-filter-btn`, `.source-filter-popup`, `.source-filter-item`, checkbox styling consistent with existing dropdown theme (dark bg, light text)
- [x] **D6** — Wire the filter into `App.tsx`: pass source names from `agentBuilderSources`, pass `agentBuilderSelectedSources` state + setter

### Group E — Client-Side File Search & Filtering

{{MEDIUM}}

- [x] **E1** — In `App.tsx`, change `isSearchDisabled` so agent-builder and agent-list views are search-enabled
- [x] **E2** — Add `agentBuilderFilteredCards` useMemo in `App.tsx` that applies source filter + text search on `cards` when in agent-builder mode
- [x] **E3** — For `agent-list` mode, add text filter useMemo: filter agent cards by `searchInputValue` against `card.title` (agent name) and `card.excerptShort` (description)
- [x] **E4** — Thread the new filtered cards into the existing `filteredCards` pipeline so role/score filters chain on top. Pass the result to `<ChatMap>`
- [x] **E5** — The search button / Enter key in agent-builder mode should not trigger `handleSearch` (which calls useSearch.search + server round-trip). Instead, it should be a no-op or just set the filter text. Modify `handleSearch` to skip the server call for agent-builder/agent-list views.

### Group F — Card Render Mode & Agent Card Buttons

{{MEDIUM}}

- [x] **F1** — Add `CardRenderMode` type to `chatMapEngine.ts`
- [x] **F2** — Add `setCardRenderMode(mode: CardRenderMode)` to `ChatMapEngine` interface and implementation. Store as engine-local state alongside `isAgentBuilderMode`
- [x] **F3** — Pass `cardRenderMode` into `renderCardHtml`. Modify `renderExcerptLines`:
  - `"default"` → current behaviour (💾 ☆ 📋)
  - `"agent-builder"` → only 💾 (add to knowledge)
  - `"agent-list"` → no per-line buttons
- [x] **F4** — In `renderCardHtml`, for `"agent-list"` mode: replace the 📧 envelope button with `<span class="card-edit-btn" title="Edit agent">✏️</span>`
- [x] **F5** — Add `"card-edit-agent"` to `EngineEventMap` with type `CardEditAgentEventDetail`
- [x] **F6** — In the D3 click handler, detect `.card-edit-btn` clicks and emit `"card-edit-agent"` with `{ cardId: card.id, agentPath: card.id }`
- [x] **F7** — In `ChatMap.tsx` / `useChatMap`, forward the `"card-edit-agent"` event to App.tsx via a new `onCardEditAgent` prop
- [x] **F8** — Wire `setCardRenderMode` calls: when `viewType` changes to `"agent-builder"` set mode `"agent-builder"`, `"agent-list"` set mode `"agent-list"`, otherwise `"default"`

### Group G — Agent Edit Flow

{{HARD}}

- [x] **G1** — In `App.tsx`, add state: `editingAgentPath: string | null` (null = create mode, string = edit mode)
- [x] **G2** — Add `agentEditInitial` state object: `{ projectName, agentName, description, hint, tools } | null`
- [x] **G3** — Implement `handleEditAgent` callback:
  1. Call `fetchAgentBuilderGetAgent(agentPath)`
  2. Build `agentKnowledgeEntries` from `agent.agentKnowledge` array (each string → `AgentKnowledgeEntry` with `kind: "file"`)
  3. Set `agentEditInitial` with form values
  4. Set `editingAgentPath` to the agent's path
  5. Switch view to `"agent-builder"` (file card view)
- [x] **G4** — Pass new props to `AgentBasket`: `editMode`, `initialProject`, `initialName`, `initialDesc`, `initialHint`, `initialTools`
- [x] **G5** — In `AgentBasket`, add `useEffect` that populates form fields when `editMode` becomes true with initial values
- [x] **G6** — Change `AgentBasket` button label: "🏗️ Create" → "💾 Save" when `editMode === true`
- [x] **G7** — In `handleCreateAgent` (App.tsx), after successful create in edit mode, clear `editingAgentPath` and `agentEditInitial`
- [x] **G8** — Add a "Cancel Edit" button in AgentBasket (only visible in edit mode) that clears edit state and resets the form

### Group H — HoverPanel & StatusBar

{{SIMPLE}}

- [x] **H1** — In `HoverPanel.tsx`, add handling for agent-list cards (harness === "AgentFile" from agent-list): show Agent Name, Description, Hint metadata rows
- [x] **H2** — In `StatusBar`, handle agent-list view: show "X agents" instead of "X results"

### Group I — CSS & Polish

{{SIMPLE}}

- [x] **I1** — Style `.source-filter-btn`, `.source-filter-popup`, `.source-filter-item` in `SearchBar.css`
- [x] **I2** — Style `.card-edit-btn` in `ChatMap.css`: positioned same as envelope btn, orange color on hover
- [x] **I3** — Adjust `AgentBasket.css` for edit mode: "Save" button uses blue accent instead of green, "Cancel Edit" button styling

---

## 7. File Inventory

### New Files

| File                                                 | Description                                   |
| ---------------------------------------------------- | --------------------------------------------- |
| `visualizer/src/components/SourceFilterDropdown.tsx` | Multi-select source filter dropdown component |
| `visualizer/src/components/SourceFilterDropdown.css` | Styles for source filter dropdown             |

### Modified Files

| File                                        | Changes                                                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `visualizer/src/types.ts`                   | `ViewType` extended with `"agent-list"`, new types: `AgentListEntry`, `AgentListResponse`, `AgentDefinition`, `GetAgentResponse`, `CardEditAgentEventDetail` |
| `visualizer/src/api/search.ts`              | `fetchAgentBuilderList()`, `fetchAgentBuilderGetAgent()`                                                                                                     |
| `visualizer/src/hooks/useViews.ts`          | `AGENT_LIST_VIEW` built-in view                                                                                                                              |
| `visualizer/src/hooks/useSearch.ts`         | `toAgentListCards()`, `"agent-list"` branch in `search()`                                                                                                    |
| `visualizer/src/components/SearchBar.tsx`   | Remove source listing, add "List Agents" button, add `SourceFilterDropdown` slot, updated props                                                              |
| `visualizer/src/components/SearchBar.css`   | List Agents button style, source filter positioning                                                                                                          |
| `visualizer/src/d3/chatMapEngine.ts`        | `CardRenderMode`, `setCardRenderMode()`, mode-aware `renderCardHtml`/`renderExcerptLines`, `"card-edit-agent"` event                                         |
| `visualizer/src/d3/colors.ts`               | `"AgentCard"` harness color                                                                                                                                  |
| `visualizer/src/components/ChatMap.tsx`     | Forward `card-edit-agent` event, pass `viewType` for render mode                                                                                             |
| `visualizer/src/hooks/useChatMap.ts`        | Call `setCardRenderMode` on view type change                                                                                                                 |
| `visualizer/src/components/AgentBasket.tsx` | Edit mode support: `editMode` prop, initial values, "Save"/"Cancel Edit" buttons                                                                             |
| `visualizer/src/components/AgentBasket.css` | Edit mode button styles                                                                                                                                      |
| `visualizer/src/components/HoverPanel.tsx`  | Agent-list card metadata layout                                                                                                                              |
| `visualizer/src/components/StatusBar.tsx`   | Agent count label                                                                                                                                            |
| `visualizer/src/App.tsx`                    | Source filter state, agent edit state, `handleEditAgent`, `handleListAgents`, wiring for all new props, client-side filtering pipeline                       |

---

## 8. Edge Cases & Notes

1. **Empty source filter** — If the user deselects all sources, show 0 cards with a subtle message "No sources selected" (don't re-fetch).
2. **Agent name collision on save** — The server's `/create` endpoint returns `409 Conflict` if the `.agent.md` already exists. In edit mode we expect this; the endpoint should overwrite. If it doesn't, we may need a server-side change to accept an `overwrite: true` flag — but per the current server code, `writeFileSync` always overwrites, so this should be fine.
3. **Legacy agents without .agent.json** — `getAgent()` reconstructs from `.agent.md`. The reconstructed data may be missing some fields (e.g. `tools` if commented out). The edit flow should handle missing/empty values gracefully.
4. **View switch during edit** — If the user switches away from agent-builder while editing, the edit state should be preserved. Switching back should restore the form. Explicit "Cancel Edit" clears it.
5. **Search debounce** — For client-side file search, filtering is applied via `useMemo` on every keystroke (no debounce needed since it's a simple string match on already-loaded data). No server calls are made.

---

## 9. Future Extensions (not in this iteration)

- **Inline agent preview**: Click agent card → expand to show full .agent.md content
- **Delete agent**: ✕ button on agent cards → confirm dialog → DELETE endpoint
- **Duplicate agent**: Clone an existing agent as starting point for a new one
- **Agent diff**: Show what changed between saves (would need version history on server)
- **Server-side file search**: For large data sources, push search to the server via a query param on `/prepare`
