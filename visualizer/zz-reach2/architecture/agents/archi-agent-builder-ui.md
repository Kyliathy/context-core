# Agent Builder UI — Architectural Review

**Date**: 2026-03-20
**Status**: Current (reflects r2uab Phase 1–4 — all fully implemented, including post-launch UI/Layout polish)
**Scope**: End-to-end architecture of the Agent Builder feature: server indexing, REST API, visualizer data flow, UI components, card rendering, edit flow.

---

## 1. Purpose & Context

The Agent Builder is a full-stack feature that lets a user **curate knowledge files into an AI agent definition** directly from the visualizer UI. The goal is to compose `.agent.md` files (consumed by tools like GitHub Copilot, Kiro, Cursor) from first-class UI within the Context Core visualizer.

The system spans two tiers:

| Tier                                                                          | Role                                                                                                                        |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Server** (`AgentBuilder.ts` + REST endpoints)                               | Scans configured directories, maintains an in-memory file index, writes `.agent.md` / `.agent.json`, lists/retrieves agents |
| **Visualizer** (`App.tsx`, `useSearch`, `useViews`, `AgentBasket`, D3 engine) | Presents indexed files as D3 cards, lets the user drag knowledge into a basket, fills a form, submits to the server         |

---

## 2. System Overview

```mermaid
graph TD
    subgraph "cc.json"
        CFG[MachineConfig\ndataSources block]
    end

    subgraph "Server (ContextCore)"
        AB[AgentBuilder\nclass]
        CS[ContextServer\nREST API]
        CFG -->|reads at startup| AB
        AB -->|registered with| CS
    end

    subgraph "Visualizer SPA"
        APP[App.tsx\norchestrator]
        US[useSearch hook]
        UV[useViews hook]
        SB[SearchBar\n+ two-column dropdown]
        CM[ChatMap\n+ D3 engine]
        BASK[AgentBasket\npanel]
        SFD[SourceFilterDropdown]
        APP --> US
        APP --> UV
        APP --> SB
        APP --> CM
        APP --> BASK
        APP --> SFD
    end

    CS -- "POST /api/agent-builder/prepare" --> APP
    CS -- "GET  /api/agent-builder/list" --> APP
    CS -- "GET  /api/agent-builder/get-agent" --> APP
    CS -- "POST /api/agent-builder/create" --> APP
```

---

## 3. Server Architecture

### 3.1 Configuration: `dataSources` in `cc.json`

Each `MachineConfig` may carry an optional `dataSources` map. Each entry with `purpose: "AgentBuilder"` is picked up by the `AgentBuilder` class.

```jsonc
// cc.json (excerpt)
{
  "machine": "MYBOX",
  "harnesses": { ... },
  "dataSources": {
    "zz-reach2": [
      {
        "name": "Context Core Server",
        "type": "architecture",
        "purpose": "AgentBuilder",
        "path": "D:/Codez/.../server/zz-reach2",
        "agentPath": "D:/Codez/.../.github/agents"
      }
    ]
  }
}
```

Key fields on `DataSourceEntry`:

| Field       | Purpose                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------- |
| `path`      | Root of **content** files to index (recursively scanned)                                           |
| `agentPath` | Root of **agent** files (`.agent.md`, `.agent.json`) — also where newly created agents are written |
| `name`      | Label used as `sourceName` on every `IndexedFile` and as the `projectName` in `CreateAgentInput`   |
| `type`      | Informational string (e.g. `"architecture"`) surfaced in card metadata                             |
| `purpose`   | Must be `"AgentBuilder"` to be included; other purposes are ignored                                |

### 3.2 `AgentBuilder` Class — Lifecycle

```mermaid
sequenceDiagram
    participant CC as ContextCore.ts
    participant AB as AgentBuilder
    participant FS as File System

    CC->>AB: new AgentBuilder(machineConfig)
    Note over AB: Extracts DataSourceEntry[]<br/>with purpose === "AgentBuilder"
    CC->>AB: await agentBuilder.index()
    AB->>FS: collectFiles(source.path) × N sources
    AB->>FS: collectFiles(source.agentPath) × N sources
    FS-->>AB: absolute file paths
    AB->>FS: readExcerpt(filePath) per file
    FS-->>AB: first 1000 chars
    Note over AB: Deduplicates by absolutePath<br/>Stores IndexedFile[]

    CC->>CS: startServer(..., agentBuilder)
    Note over CS: AgentBuilder passed as optional dep<br/>Registered on REST endpoints
```

The `AgentBuilder` is **stateful in-memory** — it holds the indexed file list for the process lifetime and updates it live when `create()` is called (no re-scan needed).

### 3.3 REST API Endpoints

All endpoints live on `ContextServer` (Express). They each guard against `agentBuilder` being undefined (no `dataSources` configured) and return HTTP 404 in that case.

```mermaid
graph LR
    subgraph "POST /api/agent-builder/prepare"
        P1[optional body: name?] --> P2[agentBuilder.prepare\nfilterName?]
        P2 --> P3[PrepareResponse\ntotalFiles · sources[] · files[]]
    end

    subgraph "POST /api/agent-builder/create"
        C1[CreateAgentInput\nprojectName agentName\ndescription hint\ntools[] agentKnowledge[]] --> C2[agentBuilder.create]
        C2 --> C3[writes .agent.md\n+ .agent.json to agentPath]
        C3 --> C4[updates in-memory index]
        C4 --> C5[CreateAgentResponse\ncreated · path · agentName]
    end

    subgraph "GET /api/agent-builder/list"
        L1[no params] --> L2[agentBuilder.list\nreads .agent.md entries]
        L2 --> L3[AgentListResponse\ntotalAgents · agents[]]
    end

    subgraph "GET /api/agent-builder/get-agent"
        G1[?path=absPath] --> G2[agentBuilder.getAgent\nreads .agent.json or parses .agent.md]
        G2 --> G3[GetAgentResponse\nagent: AgentDefinition]
    end
```

**Error status codes from `agentBuilder.create()`:**

| Code | Trigger                                                         |
| ---- | --------------------------------------------------------------- |
| 400  | Validation failure or missing `agentPath` on source             |
| 404  | No `dataSources` configured / `projectName` not found           |
| 409  | Agent already exists at that path (if duplicate check is added) |

### 3.4 `AgentBuilder` Internal Methods

| Method           | Description                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `index()`        | Async; full recursive scan of all sources; deduplicates by abs path; reads excerpts                                                 |
| `prepare(name?)` | Returns `PrepareResponse`; optional `name` filter restricts to one source                                                           |
| `create(input)`  | Writes `.agent.md` (frontmatter + knowledge links) and `.agent.json` (raw input); immediately updates `indexedFiles[]`              |
| `list()`         | Returns all `.agent.md` files from the index; reads description/hint from companion `.agent.json` if present, else from frontmatter |
| `getAgent(path)` | Reads and parses a single agent; prefers `.agent.json` (structured), falls back to frontmatter reconstruction                       |

**`.agent.md` file format written by `create()`:**

```markdown
---
name: my-agent
description: Does X
argument-hint: A task to perform
tools: ['read_file', 'grep_search']
---

To get context for your task, you MUST read the following files:

- [path/to/file.md](path/to/file.md)
- [another/file.ts](another/file.ts)
```

---

## 4. Type System

### 4.1 Shared Types (server `agentBuilder/AgentBuilder.ts` & visualizer `types.ts`)

```mermaid
classDiagram
    class DataSourceEntry {
        +path: string
        +agentPath?: string
        +name: string
        +type: string
        +purpose: string
    }

    class IndexedFile {
        +relativePath: string
        +absolutePath: string
        +size: number
        +lastModified: string
        +sourceName: string
        +sourceType: string
        +origin: "content" | "agent"
        +excerpt: string
    }

    class PrepareResponse {
        +totalFiles: number
        +sources: PrepareSource[]
        +files: IndexedFile[]
    }

    class CreateAgentInput {
        +projectName: string
        +agentName: string
        +description: string
        +argument-hint: string
        +tools?: string[]
        +agentKnowledge: string[]
        +platform: "github" | "claude"
    }

    class AgentDefinition {
        +fromJson: boolean
    }

    class AgentListEntry {
        +name: string
        +path: string
        +description: string
        +hint: string
        +excerpt: string
    }

    class AgentKnowledgeEntry {
        +id: string
        +value: string
        +kind: "file" | "custom"
        +sourceName?: string
        +addedAt: number
    }

    AgentDefinition --|> CreateAgentInput : extends
    PrepareResponse "1" *-- "N" IndexedFile
```

### 4.2 `ViewType` Extensions

```typescript
type ViewType =
  | "search"          // server-side message search
  | "search-threads"  // server-side thread search
  | "latest"          // server-side latest messages
  | "favorites"       // client-side from saved favorites
  | "agent-builder"   // file cards from /prepare — build mode
  | "agent-list";     // agent cards from /list   — browse+edit mode
```

### 4.3 `CardRenderMode` (internal to `chatMapEngine.ts`)

```typescript
type CardRenderMode = "default" | "agent-builder" | "agent-list";
```

Controls which action buttons appear on each card line (see §7).

---

## 5. Visualizer Architecture

### 5.1 Component Hierarchy

```mermaid
graph TD
    APP[App.tsx]

    APP --> SB[SearchBar]
    APP --> CM[ChatMap]
    APP --> HP[HoverPanel]
    APP --> STB[StatusBar]
    APP --> BASK[AgentBasket]
    APP --> CB[ClipboardBasket]
    APP --> SFD[SourceFilterDropdown]
    APP --> DLGS[Dialogs\nEditResultsView · FilterDialog\nChatViewDialog · FavoritesPickerDialog]

    SB -->|two-column dropdown| DD[ViewMenu\nLeft: Views\nRight: Agent Builder]
    CM --> D3[ChatMapEngine\nD3 zoom · masonry · card render]
```

### 5.2 State Ownership in `App.tsx`

| State                         | Type                     | Purpose                                                     |
| ----------------------------- | ------------------------ | ----------------------------------------------------------- |
| `agentBuilderSources`         | `{ name; fileCount }[]`  | Populated on mount from `/prepare`; passed to `AgentBasket` |
| `agentBuilderSelectedSources` | `Set<string>`            | Which sources are active in the filter dropdown; persisted to localStorage `"cxc-agent-sources"`; empty = **none selected** |
| `agentKnowledgeEntries`       | `AgentKnowledgeEntry[]`  | Files/text added to basket                                  |
| `isCreatingAgent`             | `boolean`                | Submission in-flight flag                                   |
| `agentCreateError/Success`    | `string \| null`         | Status feedback from last create                            |
| `agentFlashId`                | `string \| null`         | Card ID to flash briefly after add-to-basket                |
| `editingAgentPath`            | `string \| null`         | null = create mode; a path = edit mode                      |
| `agentEditInitial`            | `{projectName…} \| null` | Pre-fill values when editing an existing agent              |

### 5.3 Data Flow — Agent Builder View

```mermaid
sequenceDiagram
    participant U as User
    participant SB as SearchBar
    participant APP as App.tsx
    participant US as useSearch
    participant API as api/search.ts
    participant SRV as Server

    U->>SB: Click "▶ Launch Builder"
    SB->>APP: onLaunchAgentBuilder()
    APP->>APP: switchView("built-in-agent-builder")
    APP->>US: search("") [triggered by view change]
    US->>API: fetchAgentBuilderPrepare()
    API->>SRV: POST /api/agent-builder/prepare
    SRV-->>API: PrepareResponse {files[]}
    API-->>US: PrepareResponse
    US->>US: toAgentBuilderCards(files)
    US-->>APP: cards[]
    APP->>APP: agentBuilderFilteredCards useMemo\n(source filter + text search)
    APP->>APP: filteredCards useMemo\n(role + score filter — all pass score:1.0)
    APP->>CM: filteredCards
    CM->>D3: render file cards on D3 map
```

### 5.4 Data Flow — Agent List View

```mermaid
sequenceDiagram
    participant U as User
    participant SB as SearchBar
    participant APP as App.tsx
    participant US as useSearch
    participant API as api/search.ts
    participant SRV as Server

    U->>SB: Click "📋 List Agents"
    SB->>APP: onListAgents()
    APP->>APP: switchView("built-in-agent-list")
    APP->>US: search("")
    US->>API: fetchAgentBuilderList()
    API->>SRV: GET /api/agent-builder/list
    SRV-->>API: AgentListResponse {agents[]}
    API-->>US: AgentListResponse
    US->>US: toAgentListCards(agents)
    US-->>APP: cards[]
    APP->>CM: filteredCards (text search only)
```

### 5.5 Data Flow — Agent Edit

```mermaid
sequenceDiagram
    participant U as User
    participant CM as ChatMap / D3
    participant APP as App.tsx
    participant API as api/search.ts
    participant SRV as Server
    participant BASK as AgentBasket

    U->>CM: Click ✏️ on agent card
    CM->>APP: onCardEditAgent({cardId, agentPath})
    APP->>API: fetchAgentBuilderGetAgent(agentPath)
    API->>SRV: GET /api/agent-builder/get-agent?path=...
    SRV-->>API: GetAgentResponse {agent: AgentDefinition}
    API-->>APP: AgentDefinition
    APP->>APP: Build agentEditInitial from AgentDefinition
    APP->>APP: Build agentKnowledgeEntries from agent.agentKnowledge
    APP->>APP: setEditingAgentPath(agentPath)
    APP->>APP: switchView("built-in-agent-builder")
    APP->>BASK: editMode=true, initialValues={...}
    Note over BASK: Form pre-populated\nButton label: "💾 Save"
    U->>BASK: Edits form / adds/removes files
    U->>BASK: Click "💾 Save"
    BASK->>APP: onCreateAgent(CreateAgentInput)
    APP->>API: fetchAgentBuilderCreate(input)
    API->>SRV: POST /api/agent-builder/create
    SRV-->>API: CreateAgentResponse
    APP->>APP: clearEditingAgentPath
    APP->>APP: clearAgentEditInitial
```

### 5.6 Data Flow — Knowledge File → AgentBasket

```mermaid
sequenceDiagram
    participant U as User
    participant CM as ChatMap / D3
    participant APP as App.tsx
    participant BASK as AgentBasket

    Note over CM: User is in agent-builder view\nCards render 💾 save button only
    U->>CM: Click 💾 on a file card line
    CM->>APP: onCardAddKnowledge({cardId, lineText, sourceName})
    APP->>APP: Append AgentKnowledgeEntry\n{id, value: lineText, kind:"file", sourceName}
    APP->>BASK: agentKnowledgeEntries (updated)
    APP->>APP: setAgentFlashId(cardId) — card flashes briefly
    Note over BASK: New item appears in list\nUser fills project/name/desc
    U->>BASK: Click "🏗️ Create"
    BASK->>APP: onCreateAgent(CreateAgentInput)
    APP->>API: fetchAgentBuilderCreate(input)
```

---

## 6. View Switching & the Two-Column Dropdown

### 6.1 Dropdown Layout

The `SearchBar` dropdown was extended to a two-column grid layout. The left column retains the classic view list; the right column is the Agent Builder panel.

```
┌────────────────────────────────────────────────────────┐
│  VIEWS                        │  AGENT BUILDER          │
│  ─────────────────────────    │  ──────────────────     │
│  Built-in                     │                         │
│   🕒  Latest Threads          │   ▶  Launch Builder     │
│   🔎  Search Messages         │   📋 List Agents        │
│   🧵  Search Threads          │                         │
│   ⭐  Favorites               │                         │
│                               │                         │
│  Favorites                    │                         │
│   ...user views...            │                         │
│                               │                         │
│  Searches                     │                         │
│   ...user views...            │                         │
└────────────────────────────────────────────────────────┘
```

CSS: `.view-menu` uses `display: grid; grid-template-columns: 1fr 1fr`. Max-width increased to `560px`. A vertical divider separates the columns.

### 6.2 Toolbar State Gating per View Type

| Control                | `agent-builder`                      | `agent-list`                   | other views |
| ---------------------- | ------------------------------------ | ------------------------------ | ----------- |
| Search textbox         | ✅ enabled (client-side filter)       | ✅ enabled (client-side filter) | ✅ (varies)  |
| Search button / Enter  | ✅ (sets filter text, no server call) | ✅ (same)                       | normal      |
| ✏️ Edit view button     | ❌ disabled                           | ❌ disabled                     | ✅           |
| Filter button          | ❌ disabled                           | ❌ disabled                     | ✅           |
| `SourceFilterDropdown` | ✅ visible                            | ❌ hidden                       | ❌ hidden    |

---

## 7. D3 Card Rendering

### 7.1 Harness Color Palette (Extensions)

| Harness label | Color            | Used for                                                          |
| ------------- | ---------------- | ----------------------------------------------------------------- |
| `AgentFile`   | `#f97316` orange | Files from `origin: "agent"` sources (`.agent.md`, `.agent.json`) |
| `ContentFile` | `#06b6d4` cyan   | Files from `origin: "content"` sources (docs, markdown, code)     |
| `AgentCard`   | `#f97316` orange | Agent cards in agent-list view                                    |

### 7.2 `CardRenderMode` Button Matrix

The `renderCardHtml` function receives a `CardRenderMode` that controls per-line action buttons:

| Button                         | `"default"`          | `"agent-builder"`          | `"agent-list"`                  |
| ------------------------------ | -------------------- | -------------------------- | ------------------------------- |
| 💾 Save / add-knowledge         | ✅ (add to clipboard) | ✅ (add to agent knowledge) | ❌                               |
| ☆ Star                         | ✅                    | ❌                          | ❌                               |
| 📋 Copy                         | ✅                    | ❌                          | ❌                               |
| 📧 Envelope                     | ✅                    | ❌                          | ❌                               |
| ✏️ Edit agent (`card-edit-btn`) | ❌                    | ❌                          | ✅ (placed at card header level) |

### 7.3 LOD (Level of Detail) Mapping for File Cards

Cards in agent-builder view exploit the existing LOD zoom system to show progressive file content:

| Zoom Level            | LOD     | Field rendered   | Content                               |
| --------------------- | ------- | ---------------- | ------------------------------------- |
| < 0.7×                | minimal | title only       | filename                              |
| 0.7–1.2×              | summary | `excerptShort`   | relative path                         |
| 1.2–2.5×              | medium  | `excerptMedium`  | `sourceName · sourceType · size`      |
| ≥ 2.5×                | full    | `excerptLong`    | First ~1000 chars from server excerpt |
| Card flip / high zoom | detail  | `source.message` | Same excerpt (full card body)         |

### 7.4 Card Render Mode Switching

`ChatMapEngine` holds `config.cardRenderMode`. The engine watches for mode changes in `updateCards()` — if the mode changed, it force-re-renders all card HTML without repositioning. `App.tsx` calls `engine.setCardRenderMode()` whenever `activeView.type` changes:

```
activeView.type === "agent-builder"  →  mode = "agent-builder"
activeView.type === "agent-list"     →  mode = "agent-list"
otherwise                            →  mode = "default"
```

### 7.5 Map Layout & Zoom Strategy (Force Square)

By default, the D3 engine (`computeGridLayout`) creates a masonry grid dynamically bounded by the container's physical width. In standard views, this creates manageable vertical lists spanning a few columns. However, in `agent-builder` mode, where hundreds or thousands of file cards are fetched at once, this caused an unnavigable "infinite vertical scroll" stuck to minimal width.

To fix this, when `config.cardRenderMode === "agent-builder"`, the layout switches to a **force square** algorithm (`Math.ceil(Math.sqrt(cards.length))`). This expands the number of columns to create a roughly proportional square grid regardless of the window bounds. Coupled with the engine's `zoomToFit` logic, this lays out all knowledge files into a massive pseudo-spatial 2D map that the user can seamlessly zoom out from and pan across.

---

## 8. Client-Side Filtering Pipeline

For agent-builder and agent-list views, filtering is entirely client-side. The pipeline in `App.tsx`:

```
useSearch.cards (full fetch from server)
    │
    ▼
agentBuilderFilteredCards (useMemo)
    ├── Source filter: card.project ∈ agentBuilderSelectedSources
    │   (only applied in agent-builder, not agent-list)
    └── Text filter: card.title or card.excerptLong includes searchInputValue
    │
    ▼
filteredCards (useMemo, chained on top)
    └── role filter + minScore filter
        (always passes for file/agent cards since score = 1.0, role = "system")
    │
    ▼
ChatMap (render)
```

The `handleSearch` callback short-circuits for agent-builder and agent-list views — it updates `searchInputValue` (triggering the useMemo) without calling `useSearch.search()` and without making a server request.

---

## 9. AgentBasket Component

`AgentBasket.tsx` is the right-side panel that forms the creation/edit interface.

```mermaid
graph LR
    subgraph "AgentBasket Internal State"
        PN[projectName]
        AN[agentName]
        DESC[description]
        HINT[argumentHint]
        TOOLS[tools]
        CT[customText]
    end

    subgraph "Props In"
        ENT[entries: AgentKnowledgeEntry[]]
        SRC[sources: name+fileCount[]]
        IM[isCreating]
        ERR[createError]
        SUC[createSuccess]
        FID[flashId]
        EM[editMode]
        IV[initialValues]
    end

    subgraph "Props Out (callbacks)"
        OCR[onCreateAgent]
        ORE[onRemoveEntry]
        OMU[onMoveUp]
        OMD[onMoveDown]
        OAC[onAddCustomEntry]
        OUE[onUpdateEntry]
        OCL[onClear]
        OCE[onCancelEdit]
    end

    IV -->|useEffect on editMode flip| PN
    IV -->|useEffect on editMode flip| AN
    IV -->|useEffect on editMode flip| DESC
    IV -->|useEffect on editMode flip| HINT
    IV -->|useEffect on editMode flip| TOOLS
```

**Key behaviours:**
- Auto-selects `projectName` when only one source exists.
- Auto-selects `projectName` when all `kind:"file"` entries share the same `sourceName`.
- Slug-normalises `agentName` (lowercase, hyphens only).
- In edit mode (`editMode === true`): "Create" button becomes "💾 Save"; a "Cancel Edit" button appears.
- `initialValues` are applied via a `useEffect` that fires when `editMode` transitions `false → true`.
- **Platform checkboxes** (GitHub Copilot / Claude Code) appear below the header buttons when `mode !== "template"`. State persisted to localStorage `"cxc-agent-platforms"`. At least one must be checked for Create to be enabled. `onCreateAgent` signature: `(input: Omit<CreateAgentInput, "platform">, platforms: ("github" | "claude")[]) => void` — App.tsx loops and fires one server call per platform. Edit mode pre-populates from `initialValues.platform`.
- **Inline entry editing**: each knowledge entry has an edit (✎) icon. Clicking it loads the entry's text into the textarea, highlights the entry row dark green, and `onUpdateEntry(id, newValue)` replaces it on Ctrl+Enter.

---

## 10. `SourceFilterDropdown` Component

`SourceFilterDropdown.tsx` is a standalone controlled dropdown placed between the ✏️ edit button and the search input when in agent-builder view.

```mermaid
graph LR
    PP[App.tsx\nagentBuilderSelectedSources\nsetAgentBuilderSelectedSources] -->|sources, selected, onChange| SFD[SourceFilterDropdown]
    SFD -->|renders| BTN[Button\n📁 Sources N/M]
    BTN -->|click| POP[Popup\nfilter input + Select All + Select None\ncheckbox list]
    POP --> TOG[toggleSource]
    TOG -->|calls onChange| PP
```

**State convention:** an empty `Set` means **none selected** (zero cards shown). `Select All` sets the full set of source names; `Select None` sets an empty set. On first load (no localStorage), App.tsx reconciles by selecting all server names. Selections persist to localStorage `"cxc-agent-sources"`. The popup includes a live-filter textbox to narrow the source list.

---

## 11. Key Design Decisions

### 11.1 `IndexedFile` vs Direct Server Search

Rather than adding query parameters to `/api/search`, the Agent Builder uses a dedicated `/prepare` endpoint that returns a **bulk flat file list**. All filtering (source, text) happens **client-side**. This was intentional:

- Files don't have relevance scores — they are equal peers.
- Avoid server roundtrips on every keystroke.
- The index is small enough to transmit in one call (typically hundreds to low-thousands of docs).

### 11.2 `CardData` Shape Reuse

Agent Builder files and agent cards reuse the existing `CardData` type by mapping file metadata into the message-centric fields. The `source` field is filled with a `SerializedAgentMessage` "stub" — this means the entire D3 rendering pipeline, hover panel, and chat view dialog work without modification. Only the action buttons (§7.2) and card render mode need view-aware logic.

### 11.3 In-Memory Index Stays Fresh

When `create()` is called, `AgentBuilder` immediately pushes the new `.agent.md` and `.agent.json` entries into `this.indexedFiles[]`. This means a subsequent `/prepare` or `/list` call will include the newly created agent without a server restart or re-index.

### 11.4 Dual File Format: `.agent.md` + `.agent.json`

Every `create()` call produces two files:

- **`.agent.md`** — human-readable frontmatter + knowledge link list; consumed by AI agents (Copilot, Kiro, Cursor).
- **`.agent.json`** — structured JSON copy of `CreateAgentInput`; consumed by `getAgent()` to avoid re-parsing markdown.

When `getAgent()` runs, it prefers `.agent.json` (structured, authoritative). If only `.agent.md` exists (legacy), it reconstructs `CreateAgentInput` by parsing frontmatter + extracting markdown link targets. The `fromJson: boolean` field on `AgentDefinition` signals which path was taken.

### 11.5 Search is Client-Side in Agent-Builder Views

`handleSearch` in `App.tsx` special-cases `agent-builder` and `agent-list` view types — it sets `searchInputValue` only, triggering the `agentBuilderFilteredCards` useMemo rather than calling `useSearch.search()`. This prevents accidental server calls and keeps the UX snappy.

### 11.6 UI Conventions & Polish

Several UI conventions were refined post-launch to reduce friction and noise:
- **No auto-focus on load:** The `SearchBar` does not implicitly request focus to avoid the search history drop-down covering the screen when navigating.
- **Consistent Disabling Cursors:** Unavailable states (e.g. disabled search buttons in specific modes) use `not-allowed` instead of the system `wait` cursor.
- **Icon Integrity:** Agent knowledge empty states strictly use system emojis (💾) rather than character-set dependent glyphs.

---

## 12. File Inventory

### Server

| File                                      | Role                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| `server/src/agentBuilder/AgentBuilder.ts` | Core indexing class; all agent CRUD logic                                               |
| `server/src/server/ContextServer.ts`      | REST endpoint registration (`/prepare`, `/create`, `/list`, `/get-agent`)               |
| `server/src/ContextCore.ts`               | Startup wiring: instantiates `AgentBuilder`, calls `index()`, passes to `startServer()` |
| `server/src/types.ts`                     | `DataSourceEntry`, `DataSources`, `MachineConfig.dataSources`                           |

### Visualizer

| File                                                 | Role                                                                                                                                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `visualizer/src/types.ts`                            | `ViewType`, `IndexedFile`, `PrepareResponse`, `AgentKnowledgeEntry`, `CreateAgentInput`, `AgentListEntry`, `AgentDefinition`, `GetAgentResponse`, `CardEditAgentEventDetail` |
| `visualizer/src/api/search.ts`                       | `fetchAgentBuilderPrepare`, `fetchAgentBuilderCreate`, `fetchAgentBuilderList`, `fetchAgentBuilderGetAgent`                                                                  |
| `visualizer/src/hooks/useViews.ts`                   | `AGENT_BUILDER_VIEW`, `AGENT_LIST_VIEW` built-in view definitions                                                                                                            |
| `visualizer/src/hooks/useSearch.ts`                  | `toAgentBuilderCards()`, `toAgentListCards()`, agent-builder/agent-list branches in `search()`                                                                               |
| `visualizer/src/App.tsx`                             | State ownership, filter pipeline, `handleEditAgent`, all callback wiring                                                                                                     |
| `visualizer/src/components/searchTools/SearchBar.tsx`            | Two-column dropdown, `onLaunchAgentBuilder`, `onListAgents` props                                                                                                            |
| `visualizer/src/components/searchTools/SearchBar.css`            | Grid layout, right-column styles, launch button                                                                                                                              |
| `visualizer/src/components/agentBuilder/AgentBuilder.tsx`        | Form + knowledge list panel; create + edit modes                                                                                                                             |
| `visualizer/src/components/agentBuilder/AgentBuilder.css`        | Panel styles; edit mode variants                                                                                                                                             |
| `visualizer/src/components/agentBuilder/SourceFilterDropdown.tsx` | Multi-select source filter                                                                                                                                                  |
| `visualizer/src/components/agentBuilder/SourceFilterDropdown.css` | Filter dropdown styles                                                                                                                                                      |
| `visualizer/src/d3/chatMapEngine.ts`                 | `CardRenderMode`, `renderCardHtml` mode-aware buttons, `card-edit-btn` click handler, `setCardRenderMode()`                                                                  |
| `visualizer/src/d3/colors.ts`                        | `AgentFile: "#f97316"`, `ContentFile: "#06b6d4"`, `AgentCard: "#f97316"`                                                                                                     |
| `visualizer/src/components/searchTools/HoverPanel.tsx`           | Agent-list card metadata: Agent Name, Description, Hint rows                                                                                                                |
| `visualizer/src/components/searchTools/StatusBar.tsx`            | "X agents" label in agent-list view                                                                                                                                         |

---

## 13. Known Constraints & Future Considerations

| Item                                           | Detail                                                                                                                                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No incremental re-index**                    | `AgentBuilder.index()` runs only at startup. Changes to the scanned directories (new files added externally) are not detected until server restart. A `FileWatcher`-backed incremental pipeline could be added.           |
| **Overwrite on re-create**                     | `create()` with the same `agentName` + `projectName` silently overwrites existing files. A confirmation step could be added when `editingAgentPath` differs from the derived output path.                                 |
| **No template support in UI**                  | The server has `/add-template` and `/list-templates` endpoints (types exist in `AgentBuilder.ts`) but the visualizer has no UI for templates yet.                                                                         |
| **CORS open**                                  | `ContextServer` uses `cors()` with no origin restriction. Fine for localhost development; should be locked down if exposed on a network.                                                                                  |
| **Excerpt is first 1000 chars**                | The excerpt read at index time is a fixed 1000-char head. Large files have rich previews; for binary files this will be noisy. Filtering by extension before reading could improve quality.                               |
| **Agent knowledge paths are relative strings** | The `agentKnowledge` array stores relative paths passed in from the UI. These are relative to the data source `path` root. There is no server-side validation that the referenced paths still exist at the time of write. |
