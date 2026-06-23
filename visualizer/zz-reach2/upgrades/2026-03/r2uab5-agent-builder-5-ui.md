# r2uab5 — Agent Builder UI Improvements (Phase 5)

**Date**: 2026-03-20
**Status**: Planned
**Scope**: Four targeted improvements to Agent Builder mode: project-first card labels with per-project colors, HoverPanel "File Type" relabelling, content file viewer (replacing Chat Session dialog), and agent "explode" on add-to-basket.

---

## Context

The Agent Builder mode renders indexed files as D3 cards. Several UX friction points remain:

- **A. Project Labels on Cards**: Cards show a `harness` badge (mapped to File Type: `AgentFile`/`ContentFile`). In Agent Builder mode the primary identity axis is the **project** (data source name), not file type. Project should be the prominent coloured label on each card, with File Type secondary.
- **B. HoverPanel "File Type"**: The `HoverPanel` popup shows "Harness" as the metadata label. In Agent Builder mode this is misleading — the value comes from `origin` (`agent`/`content`) and should be labelled "File Type".
- **C. Content File Viewer**: Clicking a card title opens the Chat Session dialog, which calls `fetchSessionMessages`. For Agent Builder cards there *is* no session — the dialog should become a **Content File** viewer that fetches full file content from the server via a new endpoint.
- **D. Agent Explode on Add**: When the user clicks 💾 on an **agent card** in Agent Builder mode, the system currently adds the agent's `.agent.md` path as a single knowledge entry. Instead, it should fetch the agent's definition via `GET /api/agent-builder/get-agent` and merge all of its constituent knowledge entries individually into the basket.

---

## Design Notes

### A — Project-First Card Labels with Per-Project Colors

Cards show a single `harness-badge` coloured by file type (`AgentFile` = orange, `ContentFile` = cyan). In Agent Builder mode the user is working across multiple data-source **projects** — the project is the primary grouping dimension, but it gets no visual treatment on the card itself.

1. **New `project-badge`**: A coloured badge rendered **before** the harness badge in `renderCardHtml` when `CardRenderMode === "agent-builder"`.
2. **Per-project colour palette**: Extend `colors.ts` with a `getProjectColor(projectName)` function. Use a deterministic hash (same approach as `getSymbolColor`) into a distinct palette so each project gets a stable, unique colour.
3. **Project badge HTML**: `<span class="project-badge" style="background-color:${getProjectColor(card.project)}">${escapeHtml(card.project)}</span>`.
4. **Project colour is the card's primary colour**: In agent-builder mode, the card background accent (the left-border or header stripe — if there is one keyed off harness colour) should use the project colour, not the harness colour. This means `renderCardHtml` should pass `getProjectColor(card.project)` instead of `getHarnessColor(card.harness)` for the card's dominant colour in agent-builder mode.
5. **Harness badge stays** but becomes secondary — it appears after the project badge and keeps its existing file-type colours.

### B — HoverPanel "File Type" Label

The `HoverPanel` shows a row labelled **"Harness"** for all card types. In Agent Builder mode the value is the file origin (`AgentFile` / `ContentFile`), which has nothing to do with harnesses. The label should read **"File Type"**.

`HoverPanel` receives `data: CardData` via `hoverDetail`. Pass `viewType: ViewType` as a new prop to `HoverPanel` for view-aware labelling.

### C — Content File Viewer (replacing Chat Session Dialog)

#### C.1 New server endpoint

**`GET /api/agent-builder/get-file-content?path=<absolutePath>`**

Returns the full text content of an indexed file. The `AgentBuilder` class already holds the file index — this endpoint validates that the requested path exists in the index (preventing arbitrary file reads) and returns the content.

**Request**: `GET /api/agent-builder/get-file-content?path=/abs/path/to/file.md`

**Response** (200):
```json
{
  "relativePath": "architecture/archi-context-core-ui.md",
  "absolutePath": "/abs/path/to/file.md",
  "content": "# Full file text...",
  "size": 12345,
  "sourceName": "zz-reach2",
  "sourceType": "architecture"
}
```

**Error responses**:
- 400: `path` query parameter missing
- 404: `AgentBuilder` not available, or file not found in index
- 500: File read failure

#### C.2 Visualizer changes

- `App.tsx` intercepts `title-click` and checks the current view type. If `activeView.type === "agent-builder"`, instead of setting `chatViewTarget`, it sets a new **`contentFileTarget`** state (holding the absolute path, plus card metadata for display).
- A new **`ContentFileDialog`** component renders the file content in a read-only panel styled similarly to `ChatViewDialog` but with:
  - Title: the file's relative path (not "Chat Session")
  - Header metadata: project name, file type, file size
  - Body: full file content rendered as monospace preformatted text (with line numbers optional)
  - Same Escape-to-close, overlay-click-to-close behaviour
  - A 💾 "Add to Agent" button in the header (calls `handleAddKnowledgeFromCard`)
- The new `fetchAgentBuilderGetFileContent(absolutePath)` fetch wrapper goes in `api/search.ts`.

### D — Agent "Explode" on Add-to-Basket

When the 💾 button is clicked on an **agent-origin card** (harness `"AgentFile"`), the visualizer should:

1. **Detect** it's an agent file: check `card.harness === "AgentFile"`.
2. **Fetch** the agent definition via `fetchAgentBuilderGetAgent(absolutePath)`.
3. **Explode**: iterate over `agent.agentKnowledge[]` and add each entry individually to `agentKnowledgeEntries`, deduplicating against existing entries.
4. **Also import metadata**: copy `agent.tools` into the basket form fields (only if the current basket fields are empty — don't overwrite user input).

**Flow:**
```
User clicks 💾 on "AgentFile" card
  → D3 engine emits "card-add-knowledge" { cardId, relativePath, sourceName, harness }
  → App.tsx handleAddKnowledgeFromCard checks detail.harness
  → IF harness === "AgentFile":
      → call fetchAgentBuilderGetAgent(cardId)  // cardId = absolutePath
      → on success:
          → for each entry in agent.agentKnowledge:
              → add as kind:"file" entry (skip if duplicate)
          → import agent.tools into basket tools field
      → on failure: fall back to adding as single file reference
  → ELSE: existing behaviour (add as single file entry)
```

---

## Tasks

### Group 1 — Type definitions, palette, CSS, and no-op confirmations

{{SIMPLE}}

- [ ] 1. In `visualizer/src/d3/colors.ts`: add a `PROJECT_PALETTE` array of 12 distinct colours (different tints than `SYMBOL_PALETTE` — earthy/warm tones to visually separate from symbol colours).
- [ ] 2. In `visualizer/src/d3/colors.ts`: add and export `getProjectColor(project: string): string` — same hash-to-palette approach as `getSymbolColor`, using `PROJECT_PALETTE`.
- [ ] 3. In `visualizer/src/index.css` (or wherever `.harness-badge` lives): add `.project-badge` style — same shape/sizing as `.harness-badge`, with `margin-right: 4px`.
- [ ] 4. In `visualizer/src/types.ts`: add `FileContentResponse` type: `{ relativePath: string; absolutePath: string; content: string; size: number; sourceName: string; sourceType: string }`.
- [ ] 5. In `visualizer/src/types.ts` `CardAddKnowledgeEventDetail`: add optional field `harness?: string`.
- [ ] 6. In `chatMapEngine.ts`: confirm `title-click` event already emits `{ sessionId, messageId }` with `sessionId` = data source name and `messageId` = absolute path. No change needed — App.tsx interprets these contextually.

### Group 2 — HoverPanel relabelling + simple API/event wiring

{{SIMPLE}}

- [ ] 7. In `HoverPanel.tsx` props: add `viewType: ViewType` (import from `types.ts`).
- [ ] 8. In `HoverPanel.tsx`: derive `isAgentBuilderView = viewType === "agent-builder"`.
- [ ] 9. In `HoverPanel.tsx`: in the metadata-only layout (medium/full LOD), change the "Harness" label to `"File Type"` when `isAgentBuilderView` is true.
- [ ] 10. In `HoverPanel.tsx`: in agent-builder view, display a friendlier value — map `"AgentFile"` → `"Agent"`, `"ContentFile"` → `"Content"`.
- [ ] 11. In `HoverPanel.tsx`: in agent-builder view, add a **"Project"** metadata row (using `data.project`) above the File Type row, with a coloured badge using `getProjectColor`.
- [ ] 12. In `App.tsx`: pass `viewType={activeView.type}` to `<HoverPanel>`.
- [ ] 13. In `visualizer/src/api/search.ts`: add `fetchAgentBuilderGetFileContent(absolutePath: string): Promise<FileContentResponse>` — `GET /api/agent-builder/get-file-content?path=${encodeURIComponent(absolutePath)}`.
- [ ] 14. In `chatMapEngine.ts`: when emitting `card-add-knowledge` in agent-builder mode, include `harness: card.harness` in the detail object.

### Group 3 — Server endpoint + card rendering logic

{{MEDIUM}}

- [ ] 15. In `AgentBuilder.ts`: add method `getFileContent(absolutePath: string): { relativePath: string; absolutePath: string; content: string; size: number; sourceName: string; sourceType: string }`. Validate the path exists in `this.indexedFiles`. Read the file with `readFileSync(absolutePath, "utf8")`. Throw 404 if not indexed, 500 on read failure.
- [ ] 16. In `ContextServer.ts`: register `GET /api/agent-builder/get-file-content`. Guard against `agentBuilder` being undefined. Extract `path` from query. Call `agentBuilder.getFileContent(path)`. Return JSON response. Error handling same pattern as other endpoints.
- [ ] 17. In `chatMapEngine.ts` `renderCardHtml`: when `mode === "agent-builder"`, construct a `projectBadge` HTML string using `getProjectColor(card.project)` and `escapeHtml(card.project)`.
- [ ] 18. In `chatMapEngine.ts` `renderCardHtml`: in agent-builder mode, insert `projectBadge` before `harnessBadge` in the `summary`, `medium`, `full`, and `detail` LOD tiers. In non-agent-builder modes, rendering is unchanged.
- [ ] 19. In `chatMapEngine.ts` `renderCardHtml`: in agent-builder mode, rename the `harnessBadge` label text from the raw harness value (e.g. `"ContentFile"`) to a friendlier form: `"Content"` / `"Agent"` (strip the `File`/`Card` suffix). This is the File Type shown on the card.

### Group 4 — ContentFileDialog component (new files)

{{MEDIUM}}

- [ ] 20. Create `visualizer/src/components/ContentFileDialog.tsx`. Props: `{ absolutePath: string; relativePath: string; sourceName: string; onClose: () => void; onAddToAgent?: (detail: CardAddKnowledgeEventDetail) => void }`. On mount, call `fetchAgentBuilderGetFileContent(absolutePath)`. Render: overlay + dialog with title (relative path), metadata row (project · file type · size), body (`<pre>` with full content), 💾 button, Escape/overlay close.
- [ ] 21. Create `visualizer/src/components/ContentFileDialog.css`. Style consistently with `ChatViewDialog` — use `.cf-` prefix (e.g. `.cf-overlay`, `.cf-dialog`, `.cf-header`, `.cf-body`), dark theme, monospace body, same overlay/dialog sizing pattern.

### Group 5 — App.tsx wiring: content file viewer + agent explode + tools import

{{MEDIUM}}

- [ ] 22. In `App.tsx`: add state `contentFileTarget: { absolutePath: string; relativePath: string; sourceName: string } | null` (default `null`).
- [ ] 23. In `App.tsx` `handleTitleClick`: check `activeView.type === "agent-builder"`. If yes, find card by `detail.messageId` in `cards`, read `excerptShort` for `relativePath`, and set `contentFileTarget` with `{ absolutePath: detail.messageId, relativePath, sourceName: detail.sessionId }` instead of `chatViewTarget`. Else, existing behaviour.
- [ ] 24. In `App.tsx`: render `<ContentFileDialog>` when `contentFileTarget` is set, passing `onClose={() => setContentFileTarget(null)}` and `onAddToAgent={handleAddKnowledgeFromCard}`.
- [ ] 25. In `App.tsx` `handleAddKnowledgeFromCard`: after the template-mode check, add an agent-explode branch: if `detail.harness === "AgentFile"`, call `fetchAgentBuilderGetAgent(detail.cardId)`. On success, iterate `agent.agentKnowledge` — for each entry, check if it already exists in `agentKnowledgeEntries` (by value); if not, create a new `AgentKnowledgeEntry` with `kind: "file"`, `value: entry`, `sourceName: detail.sourceName`.
- [ ] 26. In the agent-explode branch: on fetch failure, fall back to existing single-entry add behaviour (add the `.agent.md` itself as a file reference). On success, set `agentCreateSuccess` to `"Imported N knowledge entries from <agentName>"` (auto-dismissed after 5s).
- [ ] 27. In `App.tsx`: add `importedTools` state (`string[]`, default `[]`) and `clearImportedTools` callback. In the agent-explode success branch, if `agent.tools.length > 0`, set `importedTools` to `agent.tools`. Pass `importedTools` and `onClearImportedTools={clearImportedTools}` to `<AgentBasket>`.
- [ ] 28. In `AgentBasket.tsx` props: add `importedTools?: string[]` and `onClearImportedTools?: () => void`.
- [ ] 29. In `AgentBasket.tsx`: add `useEffect` watching `importedTools` — when non-empty, merge each tool into the current `tools` Set (dedup), then call `onClearImportedTools()`.

---

## Verification

1. **Project badges**: Open Agent Builder → cards show two badges: coloured project badge (left) + file type badge (right). Each project has a distinct stable colour. Colour doesn't change on refresh.
2. **HoverPanel**: Hover over a card in Agent Builder mode → popup shows "Project" row with coloured badge + "File Type" row (not "Harness"). Switch to a non-agent view → "Harness" label returns.
3. **Content File Viewer**: Click a card title in Agent Builder → "Content File" dialog opens with full file content (not "Chat Session"). Click 💾 → file added to basket. Press Escape → dialog closes. Click title in normal search view → Chat Session dialog opens as before.
4. **Agent Explode**: Click 💾 on an AgentFile card → agent's knowledge entries are individually added to basket (not the `.agent.md` itself). Duplicate entries are skipped. Agent's tools merged into basket tool list. Success toast shows "Imported N knowledge entries from agent-name".

---

## Files Modified

| File                                              | Changes                                                                                                                                       |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `visualizer/src/d3/colors.ts`                     | A (`PROJECT_PALETTE`, `getProjectColor`)                                                                                                      |
| `visualizer/src/d3/chatMapEngine.ts`              | A (project badge rendering), D (harness in event detail)                                                                                      |
| `visualizer/src/index.css`                        | A (`.project-badge` style)                                                                                                                    |
| `visualizer/src/components/HoverPanel.tsx`        | B (`viewType` prop, "File Type" label, "Project" row)                                                                                         |
| `visualizer/src/App.tsx`                          | B (pass viewType), C (contentFileTarget state, title-click branching, render ContentFileDialog), D (agent explode logic, importedTools state) |
| `visualizer/src/types.ts`                         | C (`FileContentResponse`), D (`harness` on `CardAddKnowledgeEventDetail`)                                                                     |
| `visualizer/src/api/search.ts`                    | C (`fetchAgentBuilderGetFileContent`)                                                                                                         |
| `visualizer/src/components/ContentFileDialog.tsx` | C (new component)                                                                                                                             |
| `visualizer/src/components/ContentFileDialog.css` | C (new styles)                                                                                                                                |
| `visualizer/src/components/AgentBasket.tsx`       | D (`importedTools` prop, useEffect merge)                                                                                                     |
| `server/src/agentBuilder/AgentBuilder.ts`         | C (`getFileContent` method)                                                                                                                   |
| `server/src/server/ContextServer.ts`              | C (`GET /api/agent-builder/get-file-content` endpoint)                                                                                        |

---

## Dependency Order

```
Group 1 (types, palette, CSS)        — no deps, all independent
Group 2 (HoverPanel, API wrapper)    — depends on Group 1 (types, palette)
Group 3 (server endpoint, card render) — depends on Group 1 (palette, types)
Group 4 (ContentFileDialog)          — depends on Group 1 (types) + Group 2 (API wrapper)
Group 5 (App.tsx wiring, explode)    — depends on all above
```