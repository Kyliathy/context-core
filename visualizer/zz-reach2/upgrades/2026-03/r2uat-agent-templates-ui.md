# r2uat-ui – Agent Templates UI

**Date**: 2026-03-18
**Status**: Complete (Groups A–K all done)
**Scope**: Template creation, listing, editing, and "use template to create agent" flow — including placeholder management in the AgentBasket panel
**Depends on**: [r2uat – Agent Templates (server)](../../server/zz-reach2/upgrades/2026-03/r2uat-agent-templates.md) (already implemented)

---

## 1. Problem

Templates are reusable, pre-configured agent scaffolds stored server-side as JSON. The server already has `POST /api/agent-builder/add-template` and `GET /api/agent-builder/list-templates`. The visualizer has no UI for:

1. **Creating a template** — a dedicated "Create Template" mode in the AgentBasket panel with an "Add PLACEHOLDER" button; no D3 cards shown.
2. **Listing templates** — a new `template-list` view displaying template cards on the D3 map, similar to `agent-list`.
3. **Editing a template** — clicking ✏️ on a template card loads it back into template-creation mode.
4. **Using a template to create an agent** — clicking 🎓 on a template card populates the agent-creation form with template data, shows agent-builder `/prepare` file cards, and engages placeholder-fill mode where the user replaces `<PLACEHOLDER>` entries with real files/text before saving.

### Placeholder System

- Templates can contain `<PLACEHOLDER>` tokens in their `agentKnowledge` array.
- In the AgentBasket (template-creation mode), an "Add PLACEHOLDER" button inserts a disabled placeholder entry into the knowledge list.
- In the AgentBasket (agent-from-template mode):
  - Placeholder entries render as coloured buttons: the **first unreplaced** one is **green** (active target), the rest are **blue**.
  - The user can click any placeholder to select it as the active target.
  - When the user adds a file (from D3 card) or custom text, it replaces the active green placeholder. Focus then advances to the next unreplaced placeholder.
  - If a replaced entry is deleted, the placeholder button is **restored**.
  - The agent **cannot be saved** until all placeholders are replaced.

---

## 2. Design

### 2.1 New View Types

```typescript
type ViewType = "search" | "search-threads" | "latest" | "favorites"
              | "agent-builder" | "agent-list"
              | "template-create" | "template-list";
```

- `"template-create"` — Empty D3 canvas (no cards). AgentBasket in template mode.
- `"template-list"` — Template cards on D3 map. AgentBasket visible for creating from template.

### 2.2 Dropdown Right Column (Updated)

```
┌─────────────────────────────────────────────────────────┐
│  VIEWS                        │  AGENT BUILDER           │
│  ─────────────────────────    │  ──────────────────      │
│  Built-in                     │                          │
│   🕒  Latest Threads          │   ▶  Launch Builder      │
│   🔎  Search Messages         │   📋  List Agents        │
│   🧵  Search Threads          │                          │
│   ⭐  Favorites               │  TEMPLATES               │
│                               │   📝  Create Template    │
│  Favorites                    │   📚  List Templates     │
│   ...user views...            │                          │
│                               │                          │
│  Searches                     │                          │
│   ...user views...            │                          │
└─────────────────────────────────────────────────────────┘
```

### 2.3 Template-Create Mode (AgentBasket)

When the user clicks "📝 Create Template":
- View switches to `template-create` (empty D3 canvas — no cards)
- AgentBasket shows in **template mode**:
  - Header: "📝 Template Creator"
  - Form fields: **Name** (template slug), **Desc**, **Hint**, **Tools** — no "Project" field (templates are project-agnostic)
  - Knowledge list: same as agent mode, plus:
    - Below the "Add Custom Text" area, a new button: **"Add PLACEHOLDER"**
    - Clicking it inserts an entry with `kind: "placeholder"`, `value: "<PLACEHOLDER>"`, rendered as a disabled button
  - Save button: "📝 Save Template" — calls `POST /api/agent-builder/add-template`
  - On success, automatically switches to `template-list` view to show the saved template

### 2.4 Template-List Mode (D3 Cards)

When the user clicks "📚 List Templates":
- `useSearch` calls `GET /api/agent-builder/list-templates`
- Converts `CreateTemplateInput[]` to `CardData[]` via `toTemplateListCards()`
- Card mapping:

| CardData field  | Source                                                                       |
| --------------- | ---------------------------------------------------------------------------- |
| `id`            | `templateName` (unique slug)                                                 |
| `title`         | `templateName`                                                               |
| `excerptShort`  | `description`                                                                |
| `excerptMedium` | `description` + `\nhint: ` + `argument-hint`                                 |
| `excerptLong`   | knowledge entries joined by newlines (placeholders shown as `<PLACEHOLDER>`) |
| `harness`       | `"TemplateCard"`                                                             |
| `score`         | `1.0`                                                                        |

- D3 `CardRenderMode`: `"template-list"` — shows 🎓 (use template) and ✏️ (edit template) buttons, no 💾/☆/📋
- Search textbox enabled — client-side filtering on name + description

### 2.5 Edit Template Flow

When ✏️ is clicked on a template card:
1. Extract template data from the card's `.source` (which carries the full template info)
2. Populate AgentBasket in template mode with the template's fields
3. Knowledge entries with `<PLACEHOLDER>` value become `kind: "placeholder"` entries
4. Switch to `template-create` view (no D3 cards — pure form editing)
5. Save overwrites the existing template (same slug → same file)

### 2.6 Use Template to Create Agent (🎓 Flow)

When 🎓 is clicked on a template card:
1. Extract template data from the card
2. Switch to `agent-builder` view (D3 shows `/prepare` file cards)
3. Populate AgentBasket in **agent-from-template mode**:
   - Header: "🏗️ Agent Creator (from template)"
   - Form fields: **Project** (restored — needed for agents), **Name** (empty — user must choose), **Desc** (pre-filled from template), **Hint** (pre-filled), **Tools** (pre-filled)
   - Knowledge entries: template's `agentKnowledge` array, where:
     - Normal strings become `kind: "file"` entries (pre-populated)
     - `<PLACEHOLDER>` strings become `kind: "placeholder"` entries (rendered as buttons)
   - **Placeholder fill mode** is active:
     - First unreplaced placeholder is **green** (active target)
     - Other unreplaced placeholders are **blue**
     - Clicking a placeholder button makes it the active target (turns it green)
     - Adding a file/text replaces the active placeholder; focus auto-advances
     - Deleting a replaced entry restores the placeholder button
   - Save button: "🏗️ Create" (standard agent create) — **disabled** until all placeholders are replaced
   - Calls `POST /api/agent-builder/create` (standard agent creation)

### 2.7 AgentKnowledgeEntry Extension

```typescript
export type AgentKnowledgeEntry = {
  id: string;
  value: string;
  kind: "file" | "custom" | "placeholder";
  sourceName?: string;
  addedAt: number;
  /** Index in original template agentKnowledge (for placeholder restore). */
  placeholderIndex?: number;
};
```

When `kind === "placeholder"`:
- `value` is `"<PLACEHOLDER>"`
- `placeholderIndex` records the position in the original template so restore works

When a placeholder is replaced:
- `kind` changes to `"file"` or `"custom"` (based on how it was filled)
- `placeholderIndex` is preserved so if the entry is deleted, we know to restore the placeholder

---

## 3. New Types

### 3.1 `ViewType` Extension

```typescript
export type ViewType = ... | "template-create" | "template-list";
```

### 3.2 Client-Side Template Types

```typescript
/** Mirrors server's CreateTemplateInput. */
export type CreateTemplateInput = {
  templateName: string;
  description: string;
  "argument-hint": string;
  tools?: string[];
  agentKnowledge: string[];
};

/** Response from POST /api/agent-builder/add-template. */
export type CreateTemplateResponse = {
  created: boolean;
  templateName: string;
  path: string;
};

/** Response from GET /api/agent-builder/list-templates. */
export type TemplateListResponse = {
  totalTemplates: number;
  templates: CreateTemplateInput[];
};
```

### 3.3 `CardRenderMode` Extension

```typescript
type CardRenderMode = "default" | "agent-builder" | "agent-list" | "template-list";
```

### 3.4 `CardUseTemplateEventDetail`

```typescript
export type CardUseTemplateEventDetail = {
  cardId: string;
  templateName: string;
};
```

---

## 4. New API Functions

### 4.1 `fetchAgentBuilderAddTemplate`

```typescript
export async function fetchAgentBuilderAddTemplate(input: CreateTemplateInput): Promise<CreateTemplateResponse> {
  const response = await fetch(`${API_BASE}/api/agent-builder/add-template`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`Add template failed: ${response.status}`);
  return response.json();
}
```

### 4.2 `fetchAgentBuilderListTemplates`

```typescript
export async function fetchAgentBuilderListTemplates(): Promise<TemplateListResponse> {
  const response = await fetch(`${API_BASE}/api/agent-builder/list-templates`);
  if (!response.ok) throw new Error(`List templates failed: ${response.status}`);
  return response.json();
}
```

---

## 5. Implementation Plan

### Group A — Types, API Layer & View Registration

{{SIMPLE}}

- [x] **A1** — Add `"template-create"` and `"template-list"` to the `ViewType` union in `visualizer/src/types.ts`
- [x] **A2** — Add `CreateTemplateInput`, `CreateTemplateResponse`, `TemplateListResponse` types to `visualizer/src/types.ts`
- [x] **A3** — Add `CardUseTemplateEventDetail` type to `visualizer/src/types.ts`
- [x] **A4** — Extend `AgentKnowledgeEntry.kind` union to include `"placeholder"`. Add optional `placeholderIndex?: number` field to `AgentKnowledgeEntry`
- [x] **A5** — Add `fetchAgentBuilderAddTemplate(input)` function to `visualizer/src/api/search.ts`
- [x] **A6** — Add `fetchAgentBuilderListTemplates()` function to `visualizer/src/api/search.ts`

{{SIMPLE}}

- [x] **A7** — Add `TEMPLATE_CREATE_VIEW` built-in view in `useViews.ts`: `{ id: "built-in-template-create", name: "Create Template", emoji: "📝", color: "#8b5cf6", type: "template-create", query: "", autoQuery: false, autoRefreshSeconds: 0, createdAt: 5 }`
- [x] **A8** — Add `TEMPLATE_LIST_VIEW` built-in view in `useViews.ts`: `{ id: "built-in-template-list", name: "Template List", emoji: "📚", color: "#8b5cf6", type: "template-list", query: "", autoQuery: false, autoRefreshSeconds: 0, createdAt: 6 }`
- [x] **A9** — Add `"template-create"` and `"template-list"` entries to `VIEW_TYPE_DEFAULTS` in `useViews.ts`
- [x] **A10** — Export `TEMPLATE_LIST_VIEW` from `useViews.ts` (same pattern as `AGENT_LIST_VIEW`)
- [x] **A11** — Add `"TemplateCard"` entry to `HARNESS_COLORS` in `d3/colors.ts` — purple `"#8b5cf6"`

### Group B — Template List Data Flow

{{SIMPLE}}

- [x] **B1** — Add `toTemplateListCards(templates: CreateTemplateInput[]): CardData[]` conversion function in `useSearch.ts`. Maps template fields to CardData: `id = templateName`, `title = templateName`, `harness = "TemplateCard"`, `excerptShort = description`, `excerptMedium = description + hint`, `excerptLong = agentKnowledge.join("\n")`, stores the full `CreateTemplateInput` in the fake `source.message` as JSON for later extraction
- [x] **B2** — Add a `"template-list"` branch in `useSearch.search()`: call `fetchAgentBuilderListTemplates()`, convert with `toTemplateListCards()`, set cards
- [x] **B3** — Add a `"template-create"` branch in `useSearch.search()`: set empty cards `[]`, set `hasSearched = true` (no server call — view is form-only)

### Group C — Dropdown Buttons (Create Template + List Templates)

{{MEDIUM}}

- [x] **C1** — Add `onCreateTemplate` and `onListTemplates` props to `SearchBar`
- [x] **C2** — In `SearchBar.tsx` right column, add a "TEMPLATES" sub-header (`view-menu-group` class) and two new buttons below the existing Agent Builder buttons: "📝 Create Template" wired to `onCreateTemplate()` + close dropdown, "📚 List Templates" wired to `onListTemplates()` + close dropdown
- [x] **C3** — Add refs for both new buttons (`createTemplateButtonRef`, `listTemplatesButtonRef`). Update keyboard navigation in right column: ArrowDown/ArrowUp cycles through all 4 buttons (Launch Builder → List Agents → Create Template → List Templates). ArrowLeft returns to left column
- [x] **C4** — In `App.tsx`, create `handleCreateTemplate` callback: calls `switchView("built-in-template-create")`. Pass to `SearchBar` as `onCreateTemplate`
- [x] **C5** — In `App.tsx`, create `handleListTemplates` callback: calls `switchView(TEMPLATE_LIST_VIEW.id)`. Pass to `SearchBar` as `onListTemplates`
- [x] **C6** — Update `isSearchDisabled` in `App.tsx`: `template-create` should be disabled (no search needed); `template-list` should be enabled (client-side filter)
- [x] **C7** — Update `isEditDisabled` in `App.tsx`: add `"built-in-template-create"` and `"built-in-template-list"` to the disabled condition
- [x] **C8** — Update `isFilterDisabled` in `App.tsx`: disable filter for both template views

### Group D — D3 Card Rendering for Template Cards

{{MEDIUM}}

- [x] **D1** — Extend `CardRenderMode` type in `chatMapEngine.ts`: add `"template-list"` variant
- [x] **D2** — Add `CardUseTemplateEventDetail` to the `EngineEventMap` in `chatMapEngine.ts`, keyed as `"card-use-template"`
- [x] **D3** — In `renderCardHtml`, for `mode === "template-list"`: show `<span class="card-use-template-btn" title="Create agent from template">🎓</span>` AND `<span class="card-edit-btn" title="Edit template">✏️</span>` in the header (replace the envelope button)
- [x] **D4** — In `renderExcerptLines`, for `mode === "template-list"`: no per-line action buttons (same as `agent-list` — `btnHtml` is spacer only)
- [x] **D5** — In the D3 click handler, detect `.card-use-template-btn` clicks and emit `"card-use-template"` with `{ cardId: card.id, templateName: card.title }`
- [x] **D6** — In `ChatMap.tsx` / `useChatMap`, forward the new `"card-use-template"` event to App.tsx via a new `onCardUseTemplate` prop. Also forward `"card-edit-agent"` for template editing (reused for ✏️ on template cards)

### Group E — AgentBasket: Template Creation Mode

{{HARD}}

- [x] **E1** — Add new props to AgentBasket to support template mode: `mode: "agent" | "template" | "agent-from-template"` (default `"agent"`), `onCreateTemplate?: (input: CreateTemplateInput) => void`, `onAddPlaceholder?: () => void`, `templateMode` flags
- [x] **E2** — When `mode === "template"`: hide the "Project" select field; change header to "📝 Template Creator"; change save button to "📝 Save Template"; on submit, call `onCreateTemplate` instead of `onCreateAgent`
- [x] **E3** — When `mode === "template"`: below the custom-text textarea/confirm area, add an "Add PLACEHOLDER" button. Clicking it calls `onAddPlaceholder()`, which is handled in App.tsx to insert a `kind: "placeholder"` entry
- [x] **E4** — In the knowledge list rendering, when `entry.kind === "placeholder"`: render as a **disabled button** styled distinctly (blue background, "PLACEHOLDER" label, not deletable/reorderable like normal entries — but still shows ✕ to remove)
- [x] **E5** — Template validation: in template mode, `canCreate` requires `templateName !== ""` and valid slug and `description !== ""` — entries can be empty (templates with zero knowledge are valid, though unusual). Override the `handleCreate` to build `CreateTemplateInput` and call `onCreateTemplate`
- [x] **E6** — Style the "Add PLACEHOLDER" button in `AgentBasket.css`: full-width, dashed border, purple-ish accent (`#8b5cf6`), with "PLACEHOLDER" text in capslock

### Group F — AgentBasket: Agent-From-Template Mode (Placeholder Fill)

{{HARD}}

- [x] **F1** — When `mode === "agent-from-template"`: header shows "🏗️ Agent Creator (from template)"; restore Project field; Save button is "🏗️ Create" (standard agent creation via `onCreateAgent`); "Add PLACEHOLDER" button is hidden
- [x] **F2** — Add internal state to AgentBasket: `activePlaceholderIndex: number | null` — tracks which placeholder entry is the current green target. Initialise on mount (or when mode flips to `agent-from-template`) by finding the first entry where `kind === "placeholder"`
- [x] **F3** — Render placeholder entries as coloured buttons: the entry at `activePlaceholderIndex` is **green** (CSS class `.placeholder-active`), other unreplaced placeholders are **blue** (CSS class `.placeholder-pending`). Clicking a placeholder button sets it as the active target
- [x] **F4** — Intercept `onAddCustomEntry` and file-add events when in `agent-from-template` mode: if `activePlaceholderIndex` is set, instead of appending a new entry, **replace** the entry at that index — change its `kind` from `"placeholder"` to `"file"` or `"custom"`, update its `value`. Then auto-advance: set `activePlaceholderIndex` to the next unreplaced placeholder (or `null` if all replaced)
- [x] **F5** — Intercept `onRemoveEntry` in `agent-from-template` mode: if the removed entry has a `placeholderIndex` defined AND the entry was a replaced placeholder (kind is `"file"` or `"custom"` but `placeholderIndex` is set), **restore** the placeholder: re-insert a `kind: "placeholder"` entry at the same position in the list with the original `placeholderIndex`. Update `activePlaceholderIndex` if needed
- [x] **F6** — Save button gating: in `agent-from-template` mode, `canCreate` additionally requires that **no entries have `kind === "placeholder"`** remaining. If unreplaced placeholders exist, disable the save button with a tooltip "Replace all placeholders before saving"
- [x] **F7** — Style placeholder buttons in `AgentBasket.css`: `.placeholder-active` (green `#22c55e` background, white text, slight glow), `.placeholder-pending` (blue `#3b82f6` background, white text), cursor pointer on both, disabled look on pending (slightly dimmed)

### Group G — App.tsx Orchestration: Template Create + Save

{{MEDIUM}}

- [x] **G1** — Add state: `basketMode: "agent" | "template" | "agent-from-template"` (default `"agent"`). Derive from view type: `template-create` → `"template"`, `agent-builder` with template initial → `"agent-from-template"`, otherwise `"agent"`
- [x] **G2** — Add `handleCreateTemplate` callback: calls `fetchAgentBuilderAddTemplate(input)`, shows success banner, then switches to `template-list` view to display the saved template
- [x] **G3** — Add `handleAddPlaceholder` callback: inserts a new `AgentKnowledgeEntry` with `kind: "placeholder"`, `value: "<PLACEHOLDER>"`, unique id. Appended to `agentKnowledgeEntries`
- [x] **G4** — Wire `onCreateTemplate`, `onAddPlaceholder` props from App.tsx to AgentBasket when in template mode
- [x] **G5** — Add state for template creation: `isCreatingTemplate: boolean`, `templateCreateError: string | null`, `templateCreateSuccess: string | null`. Wire into AgentBasket's `isCreating`, `createError`, `createSuccess` when `basketMode === "template"`
- [x] **G6** — Auto-dismiss template success banner after 3 seconds

### Group H — App.tsx Orchestration: Use Template (🎓) + Edit Template (✏️)

{{HARD}}

- [x] **H1** — Add `handleUseTemplate` callback: receives `CardUseTemplateEventDetail`. Extracts the template data from the matching card's `source.message` (JSON-encoded `CreateTemplateInput`). Populates `agentKnowledgeEntries` — normal strings as `kind: "file"`, `<PLACEHOLDER>` strings as `kind: "placeholder"` with `placeholderIndex` set to their array index. Sets `agentEditInitial` with description/hint/tools from template (name and project left empty for user). Sets `basketMode` to `"agent-from-template"`. Switches view to `"agent-builder"` (triggers `/prepare` fetch → D3 file cards)
- [x] **H2** — Add `handleEditTemplate` callback: receives `CardEditAgentEventDetail` (reused type). Extracts template data from the card. Populates `agentKnowledgeEntries` — normal strings as `kind: "file"` or `"custom"`, `<PLACEHOLDER>` strings as `kind: "placeholder"`. Sets `agentEditInitial` with templateName/description/hint/tools. Sets `basketMode` to `"template"`. Switches view to `"template-create"`
- [x] **H3** — Wire `onCardUseTemplate` and `onCardEditAgent` (for template-list cards) on the ChatMap component. The existing `onCardEditAgent` handler needs to distinguish between agent cards and template cards — check `detail.cardId` / harness to determine which handler to call
- [x] **H4** — When saving an agent in `agent-from-template` mode, after success: clear the template-related state (`basketMode` back to `"agent"`, clear `agentEditInitial`). Switch to `agent-list` view to show the new agent
- [x] **H5** — When saving a template in edit mode (re-save with same name), after success: switch to `template-list` view. Allow continued editing by keeping form populated

### Group I — Template-Create View: Empty D3 Canvas

{{SIMPLE}}

- [x] **I1** — In `App.tsx`, render `AgentBasket` panel when `activeView.type === "template-create"` or `activeView.type === "template-list"` (in addition to existing agent-builder/agent-list conditions)
- [x] **I2** — In `ChatMap.tsx`, when `viewType === "template-create"` and cards are empty, render a centered message: "Use the Template Creator panel to build a template" (or just show the empty D3 canvas with no cards — it naturally shows nothing)
- [x] **I3** — Set `cardRenderMode` to `"template-list"` when `viewType === "template-list"`, `"default"` for `"template-create"` (no cards to render)
- [x] **I4** — Client-side text filter for `template-list`: in `App.tsx`, extend `agentBuilderFilteredCards` useMemo to also handle `template-list` type (filter on card.title and card.excerptShort by `searchInputValue`)

### Group J — StatusBar, HoverPanel & Source Filter Adjustments

{{SIMPLE}}

- [x] **J1** — In `StatusBar`, handle `template-list` view: show "X templates" instead of "X results". Handle `template-create`: show "Template Creator" label
- [x] **J2** — In `HoverPanel.tsx`, add handling for template cards (harness === "TemplateCard"): show Template Name, Description, Hint, Tools, Knowledge Count as metadata rows
- [x] **J3** — Hide `SourceFilterDropdown` for `template-create` and `template-list` views (source filter doesn't apply to templates)
- [x] **J4** — Hide `ClipboardBasket` for `template-create` and `template-list` views (same logic as agent-builder/agent-list)

### Group K — CSS & Polish

{{SIMPLE}}

- [x] **K1** — Style the "📝 Create Template" and "📚 List Templates" dropdown buttons in `SearchBar.css`: same pattern as existing agent-builder buttons, but with purple accent `#8b5cf6`
- [x] **K2** — Style `.agent-basket-add-placeholder-btn` in `AgentBasket.css`: full-width, dashed border, purple background, capslock "PLACEHOLDER" label
- [x] **K3** — Style `.agent-basket-entry-placeholder` in `AgentBasket.css`: disabled-button appearance for template-mode (neutral blue, not clickable)
- [x] **K4** — Style `.placeholder-active` and `.placeholder-pending` in `AgentBasket.css`: green and blue button styles with transitions
- [x] **K5** — Style `.agent-basket-template-header` in `AgentBasket.css`: distinct header styling for template mode (purple accent instead of orange)
- [x] **K6** — Adjust the "Create Template" / "Save Template" buttons to use purple accent (`#8b5cf6`) instead of green (create agent) or blue (edit agent)

---

## 6. File Inventory

### New Files

None (all changes fit into existing files).

### Modified Files

| File                                        | Changes                                                                                                                                                                                                        |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `visualizer/src/types.ts`                   | `ViewType` extended, `CreateTemplateInput`, `CreateTemplateResponse`, `TemplateListResponse`, `CardUseTemplateEventDetail`, `AgentKnowledgeEntry.kind` extended with `"placeholder"`, `placeholderIndex` field |
| `visualizer/src/api/search.ts`              | `fetchAgentBuilderAddTemplate()`, `fetchAgentBuilderListTemplates()`                                                                                                                                           |
| `visualizer/src/hooks/useViews.ts`          | `TEMPLATE_CREATE_VIEW`, `TEMPLATE_LIST_VIEW`, `VIEW_TYPE_DEFAULTS` extended                                                                                                                                    |
| `visualizer/src/hooks/useSearch.ts`         | `toTemplateListCards()`, `template-list` + `template-create` branches                                                                                                                                          |
| `visualizer/src/App.tsx`                    | `basketMode` state, template state, `handleCreateTemplate`, `handleAddPlaceholder`, `handleUseTemplate`, `handleEditTemplate`, filter/disable gating for template views                                        |
| `visualizer/src/components/SearchBar.tsx`   | Two new dropdown buttons + props + keyboard nav                                                                                                                                                                |
| `visualizer/src/components/SearchBar.css`   | Template button styles                                                                                                                                                                                         |
| `visualizer/src/components/AgentBasket.tsx` | `mode` prop, template creation form, placeholder add button, placeholder fill mode, placeholder rendering/styling, conditional canCreate logic                                                                 |
| `visualizer/src/components/AgentBasket.css` | Placeholder button styles, template-mode header styles, active/pending placeholder colours                                                                                                                     |
| `visualizer/src/d3/chatMapEngine.ts`        | `CardRenderMode` extended, `"card-use-template"` event, template-list card header buttons, click handler for 🎓                                                                                                 |
| `visualizer/src/d3/colors.ts`               | `TemplateCard: "#8b5cf6"`                                                                                                                                                                                      |
| `visualizer/src/components/ChatMap.tsx`     | Forward `"card-use-template"` event, `setCardRenderMode("template-list")`                                                                                                                                      |
| `visualizer/src/components/HoverPanel.tsx`  | Template card metadata rows                                                                                                                                                                                    |
| `visualizer/src/components/StatusBar.tsx`   | Template-specific labels                                                                                                                                                                                       |

---

## 7. Task Dependency Graph

```
A (types+api+views) ──→ B (list data flow)
         │                    │
         ├──→ C (dropdown)    │
         │                    │
         ▼                    ▼
    D (D3 rendering) ◄──── B
         │
         ▼
    E (basket: template mode) ──→ G (App.tsx: create+save)
         │                              │
         ▼                              ▼
    F (basket: placeholder fill) ──→ H (App.tsx: use+edit template)
                                        │
                                        ▼
                                   I (empty canvas) + J (status/hover) + K (CSS)
```

Groups A–C and D are largely independent and can run in parallel. E and F are sequential (F builds on E). G and H integrate in App.tsx after the basket is ready. I, J, K are polish that can follow last.