# r2uab4 — Agent Builder UI Improvements (Phase 4)

**Date**: 2026-03-20
**Status**: Done
**Scope**: Three targeted UI improvements to Agent Builder: localStorage persistence for checkboxes, knowledge entry inline editing, and enhanced source filtering.

---

## Context

- **A. Platform Checkboxes**: GitHub/Claude Code checkboxes reset to `["github"]` on every mount. Goal: persist to localStorage.
- **B. Knowledge Entry Editing**: No way to edit an entry once added. Goal: click edit icon → text in textarea → dark green bg → checkmark saves.
- **C. Source Filter Enhancements**: No "Select None", no filter textbox, empty set means "all selected" (unwanted auto-select). Goal: invert semantic, add Select None, add filter textbox, persist to localStorage.

---

## Tasks

### Group 1 — Simple localStorage & CSS additions

{{SIMPLE}}

- [x] A1. In `AgentBasket.tsx`: add `const PLATFORMS_KEY = "cxc-agent-platforms";` constant
- [x] A2. In `AgentBasket.tsx`: change `platforms` useState initializer to read from localStorage with JSON.parse, validate entries are "github"|"claude", fallback to `new Set(["github"])`
- [x] A3. In `AgentBasket.tsx`: add `useEffect` that writes `platforms` to localStorage via `JSON.stringify(Array.from(platforms))` on every change
- [x] A4. In `AgentBasket.css`: add `.agent-basket-entry-editing` style — `background: #14532d !important; border: 1px solid #22c55e;`
- [x] A5. In `AgentBasket.css`: add `.agent-basket-entry-editing .agent-basket-entry-value` style — `color: #86efac;`
- [x] A6. In `AgentBasket.css`: add `.agent-basket-edit-btn` style — small icon button, transparent bg, hover color #22c55e, same sizing as existing control buttons
- [x] C1. In `SourceFilterDropdown.css`: add `.source-filter-search` style — full-width input, dark bg (`#0f172a`), border `#334155`, border-radius 6px, padding 6px 8px, font-size 12px, margin-bottom 6px, focus border `#f97316`
- [x] C2. In `SourceFilterDropdown.css`: add `.source-filter-select-none` style — same as `.source-filter-select-all` but with color `#f87171` and border `#991b1b`, hover bg `#5f1d1d`

### Group 2 — Source filter logic changes (SourceFilterDropdown.tsx + App.tsx)

{{MEDIUM}}

- [x] C3. In `SourceFilterDropdown.tsx`: remove `isAllSelected = selected.size === 0` convention — `isChecked` becomes simply `selected.has(name)`
- [x] C4. In `SourceFilterDropdown.tsx`: simplify `toggleSource` — just add/remove from set, no "all others" logic, no "reset to empty if all selected" logic
- [x] C5. In `SourceFilterDropdown.tsx`: change `selectAll` to `onChange(new Set(sources))` (set of all names, not empty set)
- [x] C6. In `SourceFilterDropdown.tsx`: add `selectNone` handler: `onChange(new Set())`; add "Select None" button in header next to "Select All"
- [x] C7. In `SourceFilterDropdown.tsx`: add `filterText` state + `<input>` at top of popup for live filtering; derive `visibleSources` by filtering `sources` array by `filterText.toLowerCase()`
- [x] C8. In `SourceFilterDropdown.tsx`: update button label to `📁 Sources (${selected.size}/${sources.length})` (no more `isAllSelected` ternary)

{{MEDIUM}}

- [x] C9. In `App.tsx`: change `agentBuilderSelectedSources` useState initializer to read from localStorage key `"cxc-agent-sources"` via JSON.parse into a Set; fallback to `new Set()`
- [x] C10. In `App.tsx`: add `useEffect` that reconciles `agentBuilderSelectedSources` when `agentBuilderSources` arrives from server — if prev is empty (fresh/no localStorage), select all server names; otherwise intersect with valid server names
- [x] C11. In `App.tsx`: add `useEffect` that persists `agentBuilderSelectedSources` to localStorage on every change
- [x] C12. In `App.tsx`: update `agentBuilderFilteredCards` source filter — remove the `agentBuilderSelectedSources.size > 0 &&` guard so empty set = none pass (not all)

### Group 3 — Knowledge entry inline editing (AgentBasket.tsx + App.tsx)

{{MEDIUM}}

- [x] B1. In `AgentBasket.tsx` Props type: add `onUpdateEntry: (id: string, newValue: string) => void`
- [x] B2. In `AgentBasket.tsx`: add `editingEntryId` state (`string | null`, default `null`)
- [x] B3. In `AgentBasket.tsx`: add edit icon button (✎) next to each entry's existing icon (between icon and value span). On click: set `editingEntryId`, populate `customText` with entry's `value`, focus textarea
- [x] B4. In `AgentBasket.tsx`: when `editingEntryId` is set, add class `agent-basket-entry-editing` to that entry's div
- [x] B5. In `AgentBasket.tsx`: modify `handleCommitCustom` — if `editingEntryId` is set, call `onUpdateEntry(editingEntryId, trimmed)` instead of `onAddCustomEntry`; then clear `editingEntryId` and `customText`
- [x] B6. In `AgentBasket.tsx`: modify Escape handler in `handleTextareaKeyDown` — also clear `editingEntryId`
- [x] B7. In `AgentBasket.tsx`: when `editingEntryId` is set, change textarea placeholder to `"Editing entry… (Ctrl+Enter to save)"`
- [x] B8. In `App.tsx`: add `handleUpdateKnowledge` callback using `setAgentKnowledgeEntries(prev => prev.map(…))` and pass as `onUpdateEntry` prop to `<AgentBasket>`

---

## Verification

1. **Platforms**: Toggle platforms → refresh page → checkboxes retain state. Edit an existing agent → platforms override from agent data.
2. **Knowledge editing**: Add a file entry → click ✎ → text appears in textarea, entry turns dark green → modify text → Ctrl+Enter → entry updates in place. Escape cancels edit.
3. **Source filter**: Open dropdown → filter textbox + Select All + Select None. Select None → 0 cards shown. Type in filter → list narrows. Refresh → selections persist. No more auto-select-all when empty.

---

## Files Modified

| File | Changes |
|------|---------|
| `visualizer/src/components/AgentBasket.tsx` | A (localStorage) + B (edit state, edit icon, confirm logic) |
| `visualizer/src/components/AgentBasket.css` | A (editing styles) + B (edit button style) |
| `visualizer/src/App.tsx` | B (handleUpdateKnowledge) + C (semantic change, localStorage, reconcile) |
| `visualizer/src/components/SourceFilterDropdown.tsx` | C (Select None, filter textbox, simplified logic) |
| `visualizer/src/components/SourceFilterDropdown.css` | C (new element styles) |
