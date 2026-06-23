# r2su — Scope Management Upgrade

**Date**: 2026-03-26  
**Component**: `EditResultsView.tsx` / `EditResultsView.css`  
**Backend**: `scopeRoutes.ts`  
**Status**: Done

---

## Goal

Upgrade the scope management UI in the **Edit View** dialog to support **multi-selection of scopes**, **scope deletion**, and better visual separation between project-selection buttons and scope-editing buttons.

---

## Current State

- Scope selection is **single-select** — clicking a scope pill sets `selectedScopeId` (one at a time).
- "Select All" / "Select None" and "Create Scope" / "Modify Scope" / "Update Scope Selection" all sit in the same `edit-results-view-project-actions` flex row with no visual grouping.
- There is **no way to delete a scope** — neither from the UI nor from a dedicated API endpoint. Deletion is only possible via manual editing of `scopes.json`.
- Scope pills have no checkbox — selection state is communicated only through `data-active` + `box-shadow`.

---

## Tasks

{{SIMPLE}}

- [x] **1. Add Visual Separator Between Button Groups**: Insert a pipe `|` separator (styled `span`) inside `.edit-results-view-project-actions` between the project-selection buttons ("Select All" / "Select None") and the scope-editor buttons ("Create Scope" / "Update Scope Selection" / "Modify Scope" / "Delete Scope"). Style it as a `1px` vertical line or a dim `|` character with `color: #334155` and `margin: 0 2px`.

- [x] **2. Convert `selectedScopeId` to Multi-Select `selectedScopeIds: Set<string>`**: Replace `const [selectedScopeId, setSelectedScopeId] = useState<string | null>(null)` with `const [selectedScopeIds, setSelectedScopeIds] = useState<Set<string>>(new Set())`. Update all reads:
  - `selectedScope` → `selectedScopes` (array derived from set).
  - `selectedScopeId === scope.id` checks → `selectedScopeIds.has(scope.id)`.
  - Toggle logic: clicking a scope pill toggles its membership in the set.
  - When exactly one scope is selected, `setProjects(scope.projectIds)` still applies (load that scope's projects). When multiple are selected, take the **union** of all selected scopes' `projectIds` (deduped by `harness:::project` key).
  - Clear the set on dialog open/reset (already done for `setSelectedScopeId(null)` → `setSelectedScopeIds(new Set())`).

- [x] **3. Add Checkbox to Each Scope Pill**: Inside each `.edit-results-view-scope-btn`, prepend a small checkbox `<input type="checkbox" />` before `{scope.emoji} {scope.name}`. The checkbox reflects `selectedScopeIds.has(scope.id)`. Clicking the pill (or checkbox) toggles selection. Style the checkbox small (`accent-color` matching `scope.color`, `margin-right: 4px`).

{{MEDIUM}}

- [x] **4. Add "Delete Scope" Button (FE)**: Add a `Delete Scope` button in the scope-editor button group (after "Modify Scope"). Conditions:
  - **Visible** when `selectedScopeIds.size >= 1`.
  - **Label**: `"Delete Scope"` when 1 selected, `"Delete N Scopes"` when N > 1.
  - **Styled** with `edit-results-view-btn-danger` (red) appearance — reuse the existing danger color from the delete-view button or add a matching style to `edit-results-view-project-action-btn-danger`.
  - On click: filter out the selected scope IDs from `scopes`, call `persistScopes(filtered)`, and clear `selectedScopeIds`.

- [x] **5. Disable "Modify Scope" When Multiple Selected**: The existing "Modify Scope" button should be `disabled` unless **exactly one** scope is selected (`selectedScopeIds.size === 1`). Update the `disabled` prop and `title` tooltip accordingly:
  - 0 selected: `"Select a scope first"` (existing).
  - 1 selected: enabled, `"Modify selected scope"` (existing).
  - 2+ selected: `"Select exactly one scope to modify"`.

- [x] **6. Adjust "Update Scope Selection"**: This button currently shows when `selectedScope && hasScopeProjectChanges`. Adapt for multi-select:
  - **Visible** when exactly 1 scope is selected AND projects differ from that scope's `projectIds`.
  - **Hidden** when 0 or 2+ scopes are selected (updating projectIds for multiple scopes at once is ambiguous).
  - No logic change needed beyond adjusting the guard from `selectedScope` to `selectedScopes.length === 1 && selectedScopes[0]`.

{{SIMPLE}}

- [x] **7. Update `archi-scopes.md`**: Add a note in section 10 (Design Notes) that delete is now supported and describe the multi-select UX.

---

## Implementation Notes

### State Migration

```
BEFORE:
  selectedScopeId: string | null
  selectedScope: Scope | null     (derived)

AFTER:
  selectedScopeIds: Set<string>
  selectedScopes: Scope[]         (derived, array)
  singleSelectedScope: Scope | null  (convenience: selectedScopes[0] when length === 1)
```

### Derived Values (Updated)

| Name                     | Formula                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| `selectedScopes`         | `scopes.filter(s => selectedScopeIds.has(s.id))`                                               |
| `singleSelectedScope`    | `selectedScopes.length === 1 ? selectedScopes[0] : null`                                       |
| `canCreateScope`         | `projects.length >= 2` (unchanged)                                                             |
| `hasScopeProjectChanges` | `singleSelectedScope ? !areProjectSetsEqual(projects, singleSelectedScope.projectIds) : false` |
| `canModifyScope`         | `selectedScopeIds.size === 1`                                                                  |
| `canDeleteScope`         | `selectedScopeIds.size >= 1`                                                                   |

### Scope Pill Toggle Logic

```typescript
onClick={() => {
  setSelectedScopeIds(prev => {
    const next = new Set(prev);
    if (next.has(scope.id)) next.delete(scope.id);
    else next.add(scope.id);
    return next;
  });
  // Project loading: union of all selected scopes' projectIds
}
```

### Delete Flow

```
User clicks "Delete Scope" (or "Delete N Scopes")
  → const idsToDelete = selectedScopeIds
  → const nextScopes = scopes.filter(s => !idsToDelete.has(s.id))
  → persistScopes(nextScopes)  // saves full array minus deleted
  → setSelectedScopeIds(new Set())
```

No backend changes needed — the existing `POST /api/scopes` already does full-replacement. The delete is implemented purely by sending the array without the deleted scopes. The BE `replaceAll()` + `save()` handles it.

### Button Row Layout

```
[ Select All ] [ Select None ] | [ Create Scope ] [ Update Scope Selection ] [ Modify Scope ] [ Delete Scope ]
                               ↑
                          separator
```

---

## Files Changed

| File                                                       | Change                                                                        |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `visualizer/src/components/searchView/EditResultsView.tsx` | Multi-select state, pill checkboxes, delete button, separator, derived values |
| `visualizer/src/components/searchView/EditResultsView.css` | Separator style, danger button style for action row, checkbox-in-pill spacing |
| `server/zz-reach2/architecture/search/archi-scopes.md`     | Document delete support + multi-select UX                                     |

---

## Design Notes

- **No new API endpoint**: Delete is a client-side filter → full-replacement `POST`. This keeps the API surface unchanged and matches the existing "full-replacement" persistence model.
- **Union project loading on multi-select**: When 2+ scopes are checked, projects = deduplicated union of all selected scopes' `projectIds`. This gives a "show me everything in these scopes" behavior.
- **"Update Scope Selection" hidden on multi-select**: Updating project lists for N scopes at once would be confusing — which scope gets the new list? Keeping it single-scope-only avoids ambiguity.
- **Checkbox in pill**: The checkbox gives immediate visual feedback for multi-select and makes the affordance obvious. `accent-color` is set to the scope's color for visual consistency.