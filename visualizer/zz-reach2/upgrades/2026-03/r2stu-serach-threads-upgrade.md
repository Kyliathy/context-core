# R2STU — Search Threads Upgrade

**Date**: 2026-03-26
**Scope**: `EditResultsView` modal, `SearchBar` dropdown, view type system
**Files touched**: `EditResultsView.tsx`, `EditResultsView.css`, `SearchBar.tsx`

---

## 1. Problem Statement

Three issues:

1. **Favorites type keeps the modal huge.** When the user switches the Type radio to Favorites, the modal still occupies `calc(100vh - 48px)` because all the project scope / scope editor / refresh controls are hidden but the container height is fixed. It should shrink from the bottom, keeping its top Y position stable (no jarring vertical jump).

2. **No way to create user "Search Threads" views.** The built-in `search-threads` view exists, and the server's `POST /api/threads` endpoint supports project filters, but `EditResultsView` only offers two Type radios: Search (messages) and Favorites. Users cannot create custom search-threads views.

3. **Dropdown categories are confusing.** The left column of the `SearchBar` view dropdown groups user views under "Favorites" and "Searches" — but "Built-in" is misleading (it includes Latest, Search Messages, Search Threads, **and** Favorites), and user `search-threads` views (once supported) would land in the catch-all "Searches" bucket with no distinction.

---

## 2. Plan

### Group 1 — CSS & Layout (Favorites height shrink)

{{SIMPLE}}

- [x] In `EditResultsView.css`, change `.edit-results-view` from fixed `height: calc(100vh - 48px)` to `max-height: calc(100vh - 48px)` so it can shrink when content is shorter.
- [x] Keep `align-items: center` on `.edit-results-view-overlay` for horizontal centering, but change vertical to `align-items: flex-start; padding-top: 24px` so the modal stays at its top Y and shrinks upward from the bottom.
- [x] Verify that the Search type still fills the full height (the projects grid has `flex: 1 1 0` and `min-height: 80px`, so it will stretch to fill `max-height`).

### Group 2 — EditResultsView: 3 Type Radios

{{MEDIUM}}

- [x] Add a third radio button "Search Threads" in the Type `<div>` between Search Messages and Favorites. Order: **Search Threads** (first, default for add mode), **Search Messages**, **Favorites**.
- [x] When "Search Threads" is selected, `type` state becomes `"search-threads"`. Apply defaults: emoji `🧵`, color `#8b5cf6` (from `VIEW_TYPE_DEFAULTS["search-threads"]`).
- [x] Show the Search Query input, Auto Refresh controls, and Scope/Projects grid for **both** `search` and `search-threads` types (they both need query + project filters). Only hide them for `favorites`.
- [x] Change the condition `type === "search"` (used to show query, refresh, projects) to `type === "search" || type === "search-threads"` — introduce a local `const isSearchType = type === "search" || type === "search-threads"` for readability.
- [x] Update the `useEffect` that resets form on open: default to `type = "search-threads"` in add mode (first radio).
- [x] Update the edit-mode map: when editing a `search-threads` view, keep the type as-is (currently it maps `latest` → `search`; leave `search-threads` untouched).

### Group 3 — SearchBar Dropdown Category Cleanup

{{MEDIUM}}

- [x] Rename the "Built-in" header from `Built-in` to `Built-in Views`.
- [x] Split user views into **four** categories (replacing the current "Favorites" and "Searches" groupings):
  - **Search Threads** — user views where `type === "search-threads"`
  - **Search Messages** — user views where `type === "search"`
  - **Favorites** — user views where `type === "favorites"` (unchanged)
- [x] Each category header uses the existing `.view-menu-group` class (uppercase CSS). Each is separated by `.view-menu-divider`. Categories with zero items are hidden (no empty headers).
- [x] The grouping order in the left column becomes: Built-in Views → Search Threads → Search Messages → Favorites.
- [x] Update `orderedViews` to reflect new grouping: `[...builtInViews, ...userSearchThreadViews, ...userSearchMessageViews, ...userFavoriteViews]`.
- [x] Verify keyboard navigation (arrow keys, typeahead, highlight index) still works after reordering.

### Group 4 — Dynamic Search-Mode Height (Project Count Aware)

{{MEDIUM}}

- [x] Add dynamic project-grid sizing in `EditResultsView.tsx` so grid height tracks the number of visible project rows and does not keep excess empty space.
- [x] Update `EditResultsView.css` so the projects container can shrink to content for small project sets while still respecting modal `max-height` for large project sets.
- [x] Verify top Y anchor remains stable (no vertical jump), and only the bottom edge contracts/expands.

---

## 3. Files

| File                                            | Changes                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `src/components/searchView/EditResultsView.tsx` | 3 radios, `isSearchType` guard, default type = `search-threads`  |
| `src/components/searchView/EditResultsView.css` | `max-height` instead of `height`, overlay vertical alignment     |
| `src/components/searchTools/SearchBar.tsx`      | Rename header, split user view categories, update `orderedViews` |

No server changes needed — `search-threads` is already a valid `ViewType` and the server endpoints already support thread search with project filters.
