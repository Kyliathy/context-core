# r2uab-ui – Agent Builder UI

**Date**: 2026-03-17
**Status**: Implemented
**Scope**: Add an "Agent Builder" column to the view dropdown and a new Agent Builder view that displays indexed files as cards
**Depends on**: `r2uab-agent-builder.md` (server-side — must be implemented first or in parallel)

---

## 1. Motivation

CXC's `cc.json` now supports a `dataSources` block per machine, allowing us to register external directories (like `zz-reach2` repos) as indexed knowledge bases. The server's AgentBuilder indexes these files and exposes them via `POST /api/agent-builder/prepare`. The visualizer needs a way to:

1. Surface Agent Builder as a distinct section in the view dropdown (a **second column**)
2. Let the user click "Launch Builder" to enter a builder view
3. Display each indexed file as a card on the familiar D3 map canvas

---

## 2. Current Dropdown Architecture (for context)

The dropdown is a **custom-drawn div** (`div.view-menu` with `role="listbox"`, absolutely positioned below the trigger button). It renders a single vertical list of view items grouped under "Built-in", "Favorites", and "Searches" headers. The container is ~230–320px wide (`min-width: 230px`, `max-width: 320px` on `.view-dropdown`).

Adding a second column requires:
- Changing `.view-menu` to a two-column CSS layout (grid or flex)
- The left column keeps the existing view groups
- The right column contains the "Agent Builder" section with a "Launch Builder" button and data source listing

---

## 3. Design Decisions

### 3.1 Two-Column Dropdown

```
┌──────────────────────────────────────────────────────┐
│ VIEWS                       │ AGENT BUILDER           │
│ ──────────────────────────  │ ──────────────────────  │
│ Built-in                    │                         │
│  🕒 ██ Latest Threads       │  ▶ Launch Builder       │
│  🔎 ██ Search Messages      │                         │
│  🧵 ██ Search Threads       │  Sources:               │
│  ⭐ ██ Favorites            │   📁 Context Core Server│
│                             │   📁 Context Core Front │
│ Favorites                   │                         │
│  ...user views...           │                         │
│                             │                         │
│ Searches                    │                         │
│  ...user views...           │                         │
└──────────────────────────────────────────────────────┘
```

### 3.2 Agent Builder View

When "Launch Builder" is clicked:
- A new built-in view of type `"agent-builder"` becomes the active view
- `useSearch` (or a new hook) calls `POST /api/agent-builder/prepare`
- The response's `files[]` are converted to `CardData[]` and rendered on the D3 map
- Each card shows: file name (as title), relative path, source name, size, last modified, origin ("content" or "agent")
- No search input needed (search bar disabled, like the "Latest" view)

### 3.3 Card Mapping (IndexedFile → CardData)

| CardData field    | Source                                           |
|-------------------|--------------------------------------------------|
| `id`              | `absolutePath` (unique per file)                 |
| `title`           | filename from `relativePath` (e.g. `archi-mcp.md`) |
| `excerptShort`    | `relativePath`                                   |
| `excerptMedium`   | `sourceName · sourceType · formatted size` (summary LOD) |
| `excerptLong`     | server `excerpt` field — first ~1000 chars of file content (detail-1/2 LOD) |
| `score`           | `1.0` (all equal — no ranking for files)         |
| `harness`         | `origin === "agent" ? "AgentFile" : "ContentFile"` |
| `symbols`         | extracted from file extension + source name      |
| `project`         | `sourceName`                                     |
| `dateTime`        | `lastModified`                                   |
| `role`            | `"system"`                                       |
| `model`           | `sourceType`                                     |
| `sessionId`       | `sourceName` (group by source)                   |
| `source.message`  | server `excerpt` field (detail-3+ LOD — real content fills card) |

**LOD-aware excerpt display:**
- Summary zoom → `excerptMedium` (meta: source · type · size)
- Detail-1/2 zoom → `excerptLong` (real file content, up to ~1000 chars)
- Detail-3+ zoom → `source.message` (same content, fills full card)

---

## 4. Implementation Plan

### Group A — Types & API Adapter

{{SIMPLE}}

- [x] **A1** — Add `IndexedFile` and `PrepareResponse` types to `visualizer/src/types.ts`, matching the server response shape from `r2uab-agent-builder.md §3.2`:
  ```typescript
  export type IndexedFile = {
    relativePath: string;
    absolutePath: string;
    size: number;
    lastModified: string;
    sourceName: string;
    sourceType: string;
    origin: "content" | "agent";
    excerpt?: string;  // first ~1000 chars of file content
  };
  export type PrepareResponse = {
    totalFiles: number;
    sources: { name: string; type: string; path: string; agentPath?: string; fileCount: number }[];
    files: IndexedFile[];
  };
  ```
- [x] **A2** — Add `"agent-builder"` to the `ViewType` union in `types.ts`
- [x] **A3** — Add `fetchAgentBuilderPrepare(name?: string): Promise<PrepareResponse>` to `visualizer/src/api/search.ts` — POST to `/api/agent-builder/prepare` with optional `{ name }` body; on 404, throw a descriptive error
- [x] **A4** — Add `"AgentFile"` and `"ContentFile"` harness entries to `HARNESS_COLORS` in `d3/colors.ts` (AgentFile: `"#f97316"` orange, ContentFile: `"#06b6d4"` cyan)

### Group B — Built-in View & Data Flow

{{SIMPLE}}

- [x] **B1** — Add a built-in Agent Builder view definition in `useViews.ts`: `{ id: "built-in-agent-builder", name: "Agent Builder", emoji: "🏗️", color: "#f97316", type: "agent-builder", query: "", autoQuery: false, autoRefreshSeconds: 0, createdAt: 4 }`
- [x] **B2** — Add a `toAgentBuilderCards(files: IndexedFile[]): CardData[]` conversion function in `useSearch.ts` implementing the mapping from §3.3. Uses server `excerpt` for `excerptLong` and `source.message` so real file content renders at high zoom.
- [x] **B3** — In `useSearch.ts`, add a branch for `activeView.type === "agent-builder"`: call `fetchAgentBuilderPrepare()`, convert with `toAgentBuilderCards()`, set `cards`, `hasSearched = true`, manage `isLoading`
- [x] **B4** — Wire `isSearchDisabled` in `App.tsx` — add `activeView.type === "agent-builder"` to the disabled condition
- [x] **B5** — Wire `isEditDisabled` in `App.tsx` — add `activeView.id === "built-in-agent-builder"` to the disabled condition
- [x] **B6** — Wire `isFilterDisabled` in `App.tsx` — disable the filter button when agent-builder view is active (role/score filtering doesn't apply to file cards)

### Group C — Two-Column Dropdown (CSS + Structure)

{{MEDIUM}}

- [x] **C1** — Update `.view-dropdown` in `SearchBar.css`: increase `max-width` to `560px` so the dropdown is wide enough for two columns
- [x] **C2** — Update `.view-menu` CSS: add `display: grid; grid-template-columns: 1fr 1fr; gap: 0;` so the menu splits into left/right. Add a vertical divider between columns via border or pseudo-element
- [x] **C3** — In `SearchBar.tsx`, wrap the existing view groups (Built-in / Favorites / Searches) inside a `<div className="view-menu-column view-menu-left">`
- [x] **C4** — Add a `<div className="view-menu-column view-menu-right">` as the second grid child, containing: a "AGENT BUILDER" header (`view-menu-group` class) and a "Launch Builder" button
- [x] **C5** — Style the "Launch Builder" button (`agent-builder-launch-btn`) — full-width, accent-colored (`#f97316`), rounded, with `▶` prefix text, hover/active states
- [x] **C6** — Add a new `onLaunchAgentBuilder` prop to `SearchBar`. When "Launch Builder" is clicked: call `onLaunchAgentBuilder()`, close the dropdown, clear typeahead

### Group D — Data Source Listing in Dropdown

{{MEDIUM}}

- [x] **D1** — Add a `agentBuilderSources` prop to `SearchBar` (type: `{ name: string; fileCount: number }[]`). Render each source as a read-only item under "Launch Builder" in the right column with 📁 icon, name, and file count badge
- [x] **D2** — In `App.tsx`, fetch the agent-builder sources on mount (call `fetchAgentBuilderPrepare()` once, extract `sources` array, store in state). Pass `agentBuilderSources` to `SearchBar`. Handle 404 gracefully (empty array)
- [x] **D3** — Style source items (`.agent-builder-source-item`) — muted text, smaller font, not clickable (informational only for now)
- [x] **D4** — Handle the case of 0 data sources — show "No data sources configured" text in the right column

### Group E — App Integration & Launch Wiring

{{SIMPLE}}

- [x] **E1** — In `App.tsx`, create `handleLaunchAgentBuilder` callback: calls `switchView("built-in-agent-builder")`. Pass to `SearchBar` as `onLaunchAgentBuilder`
- [x] **E2** — In the agent-builder fetch effect in `App.tsx`, handle errors: if server returns 404, show an error banner "Agent Builder endpoint not available — is the server updated?"
- [x] **E3** — Ensure the `StatusBar` displays a sensible label when in agent-builder view (e.g. result count says "X files" instead of "X results")

### Group F — Card Rendering Verification & HoverPanel

{{MEDIUM}}

- [x] **F1** — Verify `renderCardHtml` in `chatMapEngine.ts` handles agent-builder cards correctly: `excerptMedium` and `symbols` should render as expected since `CardData` shape is the same. Fix any edge cases (e.g. empty `toolCalls` array, null `model`)
- [x] **F2** — In `HoverPanel.tsx`, add/verify the metadata-only layout at medium/full zoom shows file-specific info: "Origin" row ("content" or "agent"), "Path" row (relativePath). Uses the existing `.hover-meta-row` pattern.
- [x] **F3** — Test that the D3 masonry layout works correctly when all cards have identical `score: 1.0` (no score-based sorting differentiation — cards should lay out in alphabetical or insertion order)

### Group G — Keyboard Navigation & Accessibility (Two-Column)

{{HARD}}

- [x] **G1** — Update keyboard navigation in `SearchBar.tsx` to handle the two-column layout: Arrow Up/Down navigates within the left column (views). ArrowRight moves focus to the "Launch Builder" button in the right column. ArrowLeft returns to the left column. Enter on "Launch Builder" triggers the launch.
- [x] **G2** — Ensure ARIA attributes are correct for the two-column layout: the left column keeps `role="listbox"`, the right column uses `role="group"` with `aria-label="Agent Builder"`
- [x] **G3** — Test full keyboard flow: open dropdown → arrow to desired view → right arrow to right column → enter on Launch Builder → dropdown closes, agent-builder view activates

### Group H — Server-Side Prerequisite (if not yet done)

{{MEDIUM}}

- [x] **H1** — Add `DataSourceEntry` and `DataSources` types to `server/src/types.ts`; extend `MachineConfig` with optional `dataSources`
- [x] **H2** — Create `server/src/agentBuilder/AgentBuilder.ts` with constructor (extracts AgentBuilder-purpose entries), `index()` (recursive file walk, deduplication, reads first 1000 chars as `excerpt`), and `prepare(filterName?)` (returns `PrepareResponse`)
- [x] **H3** — Register `POST /api/agent-builder/prepare` in `ContextServer.ts` — reads optional `{ name }` from body, calls `agentBuilder.prepare(name)`
- [x] **H4** — Wire `AgentBuilder` into `ContextCore.ts` startup: instantiate after loading machine config, call `await agentBuilder.index()`, pass instance to `startServer()`
- [x] **H5** — Test: start server, `curl -X POST http://localhost:3210/api/agent-builder/prepare` → verify JSON response with files and excerpts listed

---

## 5. File Inventory

### New Files
| File | Description |
|------|-------------|
| `server/src/agentBuilder/AgentBuilder.ts` | AgentBuilder class (server-side) |

### Modified Files
| File | Changes |
|------|---------|
| `visualizer/src/types.ts` | `IndexedFile` (+ `excerpt?`), `PrepareResponse`, `ViewType` extended |
| `visualizer/src/api/search.ts` | `fetchAgentBuilderPrepare()` function |
| `visualizer/src/hooks/useViews.ts` | Built-in agent-builder view definition |
| `visualizer/src/hooks/useSearch.ts` | Agent-builder data flow + card conversion with excerpt |
| `visualizer/src/components/SearchBar.tsx` | Two-column dropdown, Launch Builder button, source listing |
| `visualizer/src/components/SearchBar.css` | Grid layout, column styles, launch button styles |
| `visualizer/src/d3/colors.ts` | `AgentFile` + `ContentFile` harness colors |
| `visualizer/src/d3/chatMapEngine.ts` | Verify/fix card rendering for file cards |
| `visualizer/src/components/HoverPanel.tsx` | File-specific metadata rows |
| `visualizer/src/App.tsx` | Launch wiring, source fetch, disable states |
| `server/src/types.ts` | `DataSourceEntry`, `DataSources` types |
| `server/src/server/ContextServer.ts` | Agent-builder endpoint registration |
| `server/src/ContextCore.ts` | AgentBuilder startup wiring |

---

## 6. Future Extensions (not in this iteration)

- **File content preview**: Click a file card → modal showing the markdown rendered
- **Source filtering**: Click a source name in the dropdown to filter the builder view to just that source
- **Agent execution**: Select files → "Build Agent" button → generates an agent definition from selected docs
- **Live reload**: FileWatcher integration to auto-refresh builder cards when indexed files change
- **Drag & drop ordering**: Reorder file cards to define priority order for agent context
- **File content retrieval**: `POST /api/agent-builder/read` to load file contents on demand
