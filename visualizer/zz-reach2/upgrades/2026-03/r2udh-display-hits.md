# R2UDH — Display Hits Bar on Cards

**Date**: 2026-03-17
**Status**: Planning
**Scope**: Visualizer — types, API adapter, useSearch, D3 engine (chatMapEngine), CSS

---

## 1. Goal

Show a **vertical bar on the right edge** of each message card that visualises the `hits` count (number of query-term occurrences the server found in the message). The bar uses a **gradient from red (bottom / low hits) to green (top / high hits)**, filled proportionally to the card's normalised hit ratio. The message with the highest hits in the result set fills the bar to 100% (full green). Zero-hit cards show no bar.

This mirrors the existing harness-stripe bar on the **left** edge, but conveys relevance density instead of harness identity.

---

## 2. Server Contract (already done)

The server's `SerializedAgentMessageFound` already carries a `hits: number` field:

```jsonc
// /api/search response item (embedded on message)
{
  "id": "abc123",
  "message": "...",
  "combinedScore": 0.82,
  "hits": 7,            // ← query-term occurrence count
  ...
}
```

No server changes are needed.

---

## 3. Changes

### 3.1 `SearchHit` type — add `hits` (`types.ts`)

```ts
export type SearchHit = {
  score: number;
  hits: number;          // ← NEW — defaults to 0 for legacy/fallback
  message: SerializedAgentMessage;
};
```

### 3.2 `search.ts` adapter — extract `hits` from response

In the `searchMessages()` normaliser, extract `hits` alongside the other score fields:

```ts
if ("combinedScore" in item) {
  const { qdrantScore, fuseScore, combinedScore, hits, ...message } = item;
  return { score: combinedScore, hits: hits ?? 0, message } as SearchHit;
}
// Legacy / fallback → hits: 0
return { score: 0, hits: 0, message: item } as SearchHit;
```

### 3.3 `CardData` type — add `hits` (`types.ts`)

```ts
export type CardData = {
  // ... existing fields ...
  hits: number;          // ← NEW — raw hits from server
};
```

### 3.4 `useSearch.ts` — propagate `hits` through `toCards`

`toCards` and `toCardsFromMessages` need an extra parameter channel. Since both funcs flatten `SearchHit[]` into `CardData[]`, the `hits` field will be threaded through:

```ts
function toCards(results: SearchHit[]): CardData[] {
  return toCardsFromMessages(
    results.map(r => ({ score: r.score, hits: r.hits, message: r.message }))
  );
}

function toCardsFromMessages(
  results: Array<{ score: number; hits: number; message: SerializedAgentMessage }>
): CardData[] {
  return results.map(result => ({
    // ... existing fields ...
    hits: result.hits,
  }));
}
```

For non-search views (latest, favorites) that don't have meaningful hits, pass `hits: 0`.

### 3.5 D3 engine — render the hits bar (`chatMapEngine.ts`)

#### 3.5.1 Normalisation

Inside `renderCards()`, compute `maxHits` from the current card dataset:

```ts
const maxHits = d3.max(currentCards, c => c.hits) ?? 0;
```

#### 3.5.2 Enter selection — add a `rect.hits-bar`

In the enter callback, after the harness stripe:

```ts
group.append("rect").attr("class", "hits-bar");
```

#### 3.5.3 Update selection — size and fill

```ts
const hitsBarWidth = 4;   // same width as harness stripe

cards
  .select<SVGRectElement>("rect.hits-bar")
  .attr("x", card => card.w - hitsBarWidth)         // right edge
  .attr("y", card => {
    if (maxHits === 0) return card.h;                // hide: push below card
    const ratio = card.hits / maxHits;
    return card.h * (1 - ratio);                     // bar grows upward
  })
  .attr("width", hitsBarWidth)
  .attr("height", card => {
    if (maxHits === 0) return 0;
    return card.h * (card.hits / maxHits);
  })
  .attr("rx", 0)                                     // flat edges (inside card radius)
  .attr("fill", card => {
    if (maxHits === 0) return "transparent";
    const ratio = card.hits / maxHits;
    // Interpolate from red (0) through yellow (0.5) to green (1)
    return d3.interpolateRgb("#ef4444", "#22c55e")(ratio);
  })
  .attr("opacity", card => card.hits > 0 ? 0.85 : 0);
```

The bar is **bottom-anchored**: `y` starts at the top of the filled region and `height` extends down to the bottom of the card. Ratio 1.0 → full-height green bar. Ratio 0.5 → half-height yellow-ish bar. Ratio 0 → no bar visible.

### 3.6 Thread cards — same treatment (`renderThreadCards`)

Apply the same `rect.hits-bar` pattern inside `renderThreadCards()`. Thread cards don't currently carry `hits`, but `ThreadCardData` could be extended. For now scope this to **message cards only** and skip threads (threads aggregate over multiple messages so a single hits number is less meaningful). If the thread card should show it later, `SerializedAgentThread` already has a `bestMatchScore` but would need a `totalHits` field added server-side.

**Decision**: Message cards only in this upgrade. Thread cards can be added later.

---

## 4. Visual Specification

```
┌──────────────────────────────┐
│▌                           ▐█│  ← harness (left), hits bar (right, green = high)
│▌  Card Title               ▐█│
│▌  excerpt …                ▐ │  ← bar only fills proportionally
│▌  symbols                  ▐ │
│▌                           ▐ │
└──────────────────────────────┘
```

- **Width**: 4px (matches harness stripe)
- **Position**: right edge of the card (`x = card.w - 4`)
- **Height**: `card.h × (hits / maxHits)` — anchored to bottom
- **Color**: continuous gradient via `d3.interpolateRgb("#ef4444", "#22c55e")(ratio)`
  - 0.0 → `#ef4444` (red-500)
  - 0.5 → blend (~amber)
  - 1.0 → `#22c55e` (green-500)
- **Opacity**: 0.85 when hits > 0; hidden when hits = 0 or maxHits = 0

---

## 5. File Checklist

| # | File | Change |
|---|------|--------|
| 1 | `visualizer/src/types.ts` | Add `hits: number` to `SearchHit` and `CardData` |
| 2 | `visualizer/src/api/search.ts` | Extract `hits` from server response; default `0` for legacy |
| 3 | `visualizer/src/hooks/useSearch.ts` | Thread `hits` through `toCards` / `toCardsFromMessages`; `0` for latest/favorites |
| 4 | `visualizer/src/d3/chatMapEngine.ts` | Add `rect.hits-bar` enter + update in `renderCards()`; normalise via `maxHits` |

---

## 6. Non-Goals

- Thread card hits bar (deferred — needs server `totalHits` on `SerializedAgentThread`)
- Tooltip on the hits bar (can be added later)
- HoverPanel display of raw hits count (can be added later)
- Adjusting card layout/width for the bar (bar overlaps card edge, same as harness stripe)
