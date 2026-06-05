# r2sf — Search & Card Sorting/Formatting Fixes

**Date**: 2026-03-21
**Status**: Planned
**Scope**: Fix card sort order inside MasterCards (and flat layout) to show newest-first. Fix date formatting in HoverPanel and on-card date labels to use `YYYY-MM-DD HH:mm` format.

---

## Context

After the MasterCard grouping system (r2ubb) shipped, cards inside MasterCards are sorted **ascending** by date (oldest first). This affects **all views that use MasterCards**: Latest Threads, Search Threads, **and Search Messages**. Users expect **newest first** in every case. Additionally, layout functions (`computeGridLayout`, `computeThreadGridLayout`) sort by score, which is meaningless for Latest Threads (all scores = 1.0), effectively randomizing the server's intended newest-first order.

The hover panel's "Date Range" field currently shows abbreviated locale dates like "Mar 21" (`month: "short", day: "numeric"`). The same abbreviated format is used on thread card date labels in the D3 engine. Users need the full `YYYY-MM-DD HH:mm → YYYY-MM-DD HH:mm` format, and message cards should also show `YYYY-MM-DD HH:mm` for their date.

---

## Root Causes

1. **`grouping.ts`** sorts children ascending: `a.dateTime.localeCompare(b.dateTime)` — should be **descending** (newest first).
2. **`layout.ts`** `computeGridLayout` / `computeThreadGridLayout` / `computeMixedGridLayout` sort by score only, losing date order. For Latest Threads (all score=1.0) this randomizes order. Inside MasterCards, `computeMasterCardLayout` preserves input order (good), but receives ascending-sorted children from grouping.ts (bad).
3. **`formatDateRange()`** in both `chatMapEngine.ts` and `HoverPanel.tsx` uses `toLocaleDateString(undefined, { month: "short", day: "numeric" })` — missing year and time.
4. **Message card date** in `chatMapEngine.ts` uses `toLocaleDateString()` — missing time. In `HoverPanel.tsx` uses `toLocaleString()` — locale-dependent, not the requested format.

---

## Design Decisions

### Sort order: newest-first everywhere
- Inside MasterCards: reverse `grouping.ts` child sort to descending — both `master.cards` (messages) **and** `master.threads` must sort newest-first.
- This single fix covers Latest Threads, Search Threads, and **Search Messages** since all three views flow through `groupIntoMasterCards()`.
- Flat layout: when all scores are equal (or for Latest/Search), the masonry layout should see items in the order they arrive. Rather than changing the layout algorithm's score sort (which is important for search results with varying scores), the fix is to ensure `grouping.ts` outputs newest-first, and for the flat path, `useSearch.ts` should already return them in the server's order (which is newest-first for Latest, best-score-first for Search).

### Date format: `YYYY-MM-DD HH:mm`
- Create a shared `formatDateTime(isoString: string): string` utility returning `YYYY-MM-DD HH:mm`.
- Create a shared `formatDateTimeRange(first: string, last: string): string` returning `YYYY-MM-DD HH:mm → YYYY-MM-DD HH:mm` (or just one datetime if same day+minute).
- Replace all `formatDateRange()` calls in `chatMapEngine.ts` and `HoverPanel.tsx`.
- Replace message card date formatting in both files.

---

## Tasks

{{SIMPLE}}

- [ ] **1. Create shared `formatDateTime` utility** — New file `visualizer/src/d3/dateFormat.ts`. Export `formatDateTime(isoString: string): string` → `"YYYY-MM-DD HH:mm"` using manual `Date` extraction (no locale dependency). Export `formatDateTimeRange(first: string, last: string): string` → `"YYYY-MM-DD HH:mm → YYYY-MM-DD HH:mm"` (collapses to single datetime if both are identical down to the minute).

- [ ] **2. Fix child sort order in `grouping.ts`** — Change both `master.cards.sort(...)` (message cards) and `master.threads.sort(...)` (thread cards) from ascending to **descending** so newest items appear first (top-left) in each MasterCard. This fixes Latest Threads, Search Threads, **and** Search Messages views in one change.

- [ ] **3. HoverPanel: update thread "Date Range" format** — In `HoverPanel.tsx`, replace the inline `formatDateRange()` with imported `formatDateTimeRange()` from `dateFormat.ts`. Remove the old local `formatDateRange` function.

- [ ] **4. HoverPanel: update message card "Date" format** — In `HoverPanel.tsx`, replace `new Date(data.dateTime).toLocaleString()` with `formatDateTime(data.dateTime)`.

- [ ] **5. chatMapEngine: update thread card date label** — In `chatMapEngine.ts`, replace the local `formatDateRange()` with imported `formatDateTimeRange()` from `dateFormat.ts`. Remove the old local `formatDateRange` function.

- [ ] **6. chatMapEngine: update message card date label** — In `chatMapEngine.ts`, replace `new Date(card.dateTime).toLocaleDateString()` with `formatDateTime(card.dateTime)`.

- [ ] **7. Verify end-to-end** — Start server + visualizer. Confirm: (a) Latest Threads shows newest threads first inside each MasterCard, (b) Search Messages shows newest message cards first inside each MasterCard, (c) Search Threads shows newest thread cards first, (d) hover panel shows `YYYY-MM-DD HH:mm → YYYY-MM-DD HH:mm` for thread Date Range, (e) hover panel shows `YYYY-MM-DD HH:mm` for message Date, (f) on-card date labels also display the new format.

---

## Files Changed

| File                                                   | Change                                                |
| ------------------------------------------------------ | ----------------------------------------------------- |
| `visualizer/src/d3/dateFormat.ts`                      | **New** — `formatDateTime()`, `formatDateTimeRange()` |
| `visualizer/src/d3/grouping.ts`                        | Reverse child sort to descending                      |
| `visualizer/src/components/searchTools/HoverPanel.tsx` | Use new date formatters                               |
| `visualizer/src/d3/chatMapEngine.ts`                   | Use new date formatters                               |
