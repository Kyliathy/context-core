# r2ubv — Better New View Panel

**Date**: 2026-03-20  
**Component**: `EditResultsView.tsx` / `EditResultsView.css`  
**New Component**: `EditScope.tsx`  
**Types**: `types.ts` (new `Scope` type)  
**Status**: Done

---

## Goal

Improve the **New View / Edit View** panel (`EditResultsView`) with better layout, scrollability, a wider dialog, and project scoping support via user-created **Scopes**.

---

## Current State

- The modal is `min(520px, calc(100vw - 24px))` wide.
- Emoji gets the same large text input as other fields.
- Search Query is positioned below the project grid section (when type = search).
- "Perpetual Refresh Rate" is on its own full-width line below "Auto Refresh".
- The projects grid can grow tall (max-height: 500px) but the dialog itself has no vertical scroll — it can overflow the viewport when many projects exist.
- No concept of project scopes/groups.

---

## Tasks

{{SIMPLE}}

- [x] **1. Make DialogScrollable**: Wrap the `edit-results-view` dialog body in a scrollable container. Set `max-height: calc(100vh - 48px)` and `overflow-y: auto` on `.edit-results-view` so it never escapes the viewport.

- [x] **2. Double Dialog Width**: Change `.edit-results-view` width from `min(520px, ...)` to `min(1040px, calc(100vw - 24px))`.

- [x] **3. Move Search Query Up (Same Line as Emoji/Color)**: Restructure the Emoji + Color + Search Query row so all three share one `.edit-results-view-row`. Each has its label on top and input on bottom. Emoji input should be narrow (`width: 60px`), Color stays as-is (`width: 56px`), and Search Query gets `flex: 1` to fill remaining space.

- [x] **4. Move Perpetual Refresh Rate Inline with Auto Refresh**: Put the "Auto Refresh when switched to" checkbox and the "Perpetual Refresh Rate" number input on the same `.edit-results-view-row` line, with the checkbox on the left and the number input on the right.

{{MEDIUM}}

- [x] **5. Add `Scope` Type to `types.ts`**: Define a new `Scope` type: `{ id: string; name: string; emoji: string; color: string; projectIds: SelectedProject[] }`. This is stored locally (state only, no persistence yet).

- [x] **6. Create `EditScope.tsx` Component**: A small inline form (emoji, name, color inputs) that appears when the user clicks "Create Scope". On submit, it produces a `Scope` object. Should have Save and Cancel buttons.

- [x] **7. Add "Create Scope" Button to EditResultsView**: Place a "Create Scope" button on the same row as "Select All" / "Select None". Require at least 2 projects to be currently selected. On click, open the `EditScope` inline form (positioned between the actions row and the projects grid).

- [x] **8. Store Scopes in EditResultsView State**: Maintain a `scopes: Scope[]` state array in `EditResultsView`. When `EditScope` saves, push the new scope (with a generated UUID and the currently-selected projects as its `projectIds`). Scopes are ephemeral (lost on dialog close) for now.

{{MEDIUM}}

- [x] **9. Render Scope Buttons Below Select All / Select None**: For each scope in `scopes[]`, render a pill/button showing `emoji + name` styled with the scope's `color` as border/text color. Clicking a scope button selects exactly its `projectIds` (replaces current selection). Buttons appear in a flex-wrap row below the action buttons.

- [x] **10. Make Scope Buttons Filterable**: The existing "Filter projects…" text input should also filter the visible scope buttons — only show scopes whose name (case-insensitive) matches the filter substring.

- [x] **11. Visual Polish & QA**: Ensure consistent spacing, focus rings, and keyboard accessibility for the new layout, scope button row, and EditScope form. Verify the dialog scrolls correctly when many projects + scopes are present.

---

## Files Changed

| File                                            | Change                                                  |
| ----------------------------------------------- | ------------------------------------------------------- |
| `visualizer/src/components/EditResultsView.tsx` | Layout restructure, scope state, scope button rendering |
| `visualizer/src/components/EditResultsView.css` | Width, scroll, row layout, scope button styles          |
| `visualizer/src/components/EditScope.tsx`       | **New** — inline scope creation form                    |
| `visualizer/src/types.ts`                       | **New** `Scope` type                                    |

---

## Design Notes

- **Scope buttons** use the user's chosen color as `border-color` and `color`, with a transparent/dark background to stay on-theme.
- **"Create Scope"** button is disabled (with tooltip) when fewer than 2 projects are checked.
- The `EditScope` form appears inline (not a separate modal) to keep context visible.
- Scopes are local state only in this iteration — persistence (localStorage or server) is deferred to a future upgrade.
