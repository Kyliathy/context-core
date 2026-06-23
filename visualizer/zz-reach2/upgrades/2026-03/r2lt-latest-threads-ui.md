# r2lt — Latest Threads UI Upgrade

**Date**: 2026-03-21
**Goal**: Optimize the "Latest Threads" view by removing the unused general search bar and replacing it with a limit selector. Additionally, introduce a fast client-side text filter input available across all views to instantly narrow down visible results.
**Scope**: `visualizer/src/App.tsx`, `visualizer/src/hooks/useSearch.ts`, `visualizer/src/components/searchTools/SearchBar.tsx`, `visualizer/src/components/searchTools/SearchBar.css`

---

## Tasks

{{SIMPLE}}
- [ ] In `App.tsx`, add new localized component states:
  - `latestLimit` (number, default: `100`).
  - `localFilterText` (string, default: `""`).
- [ ] In `hooks/useSearch.ts`, add `limit?: number` to `UseSearchParams`.
- [ ] In `hooks/useSearch.ts` `search()` function, update `fetchLatestThreads` call to use `limit || 100` instead of hardcoded `100`.

{{MEDIUM}}
- [ ] In `components/searchTools/SearchBar.tsx`, update `SearchBarProps` to include:
  - `isLatestView?: boolean`
  - `latestLimit?: number`
  - `onLatestLimitChange?: (val: number) => void`
  - `localFilterText?: string`
  - `onLocalFilterTextChange?: (val: string) => void`
- [ ] In `SearchBar.tsx`, conditionally render the general `<input type="text" className="search-input" ...>` elements only when `!isLatestView`. (This effectively hides the ContextCore Search field for Latest Threads view).
- [ ] In `SearchBar.tsx`, right after the `since-date-input` check (or `time-range-select`), place a conditionally-rendered `<select className="latest-limit-select">` strictly when `isLatestView` is true. Add explicit options `50`, `100`, `150`, `200`, `300`, `400`, `500`.

{{MEDIUM}}
- [x] In `SearchBar.tsx`, immediately proceeding the `Filter` button, insert the client filter `<input type="text" className="local-filter-input" placeholder="Instant filter..." />` driven by `localFilterText` and `onLocalFilterTextChange`. This textbox should stay visible for all views.
- [x] In `SearchBar.css`, introduce and style `.latest-limit-select` and `.local-filter-input` to match adjacent controls (margins, borders, inputs style matching), specifically ensuring `.local-filter-input` has a width of 150px.

{{HARD}}
- [x] In `App.tsx`, pipe `latestLimit`, `setLatestLimit` (for `onLatestLimitChange`), `localFilterText`, and `setLocalFilterText` downward into `<SearchBar>`. Evaluate `isLatestView` by checking `activeView.type === "latest"`. Fix the `<SearchBar>` component injection.
- [x] In `App.tsx`, also pass `limit: latestLimit` through to `useSearch`.
- [x] In `App.tsx`, update client-side filtering memos:
  - Construct a new `locallyFilteredCards` computed via `useMemo` from `filteredCards`. If `localFilterText` contains value, `.filter()` by checking if the query substring exists in `card.title`, `card.excerptShort`, `card.excerptMedium`, or `card.excerptLong` (case-insensitive).
  - Construct a new `filteredThreadCards` computed similarly, reading from `threadCards`. Filter by matching substring in `thread.title` or `thread.project` (case-insensitive).
- [x] In `App.tsx`, feed `locallyFilteredCards` and `filteredThreadCards` to `masterCards` generator logic and downwards into `<ChatMap>` (`cards`, `threadCards`, `masterCards`) and `<StatusBar>` (counts).
- [x] In `App.tsx`, guarantee cleanup by ensuring `setLocalFilterText("")` is invoked whenever `onSwitchView` behaves or active view definition resets.
