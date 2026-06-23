# R2UCB – Clipboard Basket Feature

**Date**: 2026-03-09
**Status**: Planning
**Scope**: Add line-by-line text collection from chat cards into a clipboard basket panel

---

## 1. Overview

Add the ability for users to collect individual lines from chat card excerpts into a "clipboard basket" for batch copying. This requires:

1. Splitting card text on line breaks into separate `<div>` elements
2. Adding a clickable icon to each line that adds it to the basket
3. Creating a sticky panel (400×400) at bottom-left to display collected lines
4. Providing a "copy all" button to copy the basket contents to clipboard

---

## 2. Current Architecture

### 2.1 Text Rendering Location

Text is rendered in [chatMapEngine.ts](../../../visualizer/src/d3/chatMapEngine.ts) via the `renderCardHtml()` function (lines 74-110). The excerpt is displayed as:

```typescript
<div class="chat-excerpt">${escapeHtml(card.excerptMedium)}</div>
// or at higher LOD:
<div class="chat-excerpt">${escapeHtml(card.source.message)}</div>
```

The text is currently a single block — no line splitting occurs.

### 2.2 App Structure

[App.tsx](../../../visualizer/src/App.tsx) manages the main layout with:
- `SearchBar` — top
- `ChatMap` — main area
- `HoverPanel` — tooltip overlay
- `StatusBar` — bottom status bar

The clipboard basket will be a new sibling component.

### 2.3 Event System

The D3 engine emits events via `emit()` (line 131-135):
- `chat-hover` — pointer enter/move/leave
- `chat-click` — card clicked
- `viewport-change` — zoom/pan

We can leverage this pattern for line-click events.

---

## 3. Implementation Plan

### 3.1 New Types

**File**: `visualizer/src/types.ts`

```typescript
export type BasketLine = {
  id: string;           // unique ID (card.id + line index)
  text: string;         // the line content
  cardId: string;       // source card ID for reference
  addedAt: number;      // timestamp for ordering
};

export type LineClickEventDetail = {
  text: string;
  cardId: string;
  lineIndex: number;
};
```

Add `"line-click"` to the `EngineEventMap` in `chatMapEngine.ts`.

---

### 3.2 Modify Text Rendering

**File**: `visualizer/src/d3/chatMapEngine.ts`

#### 3.2.1 New Function: `renderExcerptLines()`

Create a helper that splits text on `\r\n`, `\n`, or `\r` and wraps each line in a `<div>` with a clickable icon:

```typescript
function renderExcerptLines(text: string, cardId: string): string {
  const lines = text.split(/\r\n|\n|\r/);
  return lines
    .map((line, idx) => {
      if (!line.trim()) return ''; // skip empty lines
      const escaped = escapeHtml(line);
      return `<div class="excerpt-line" data-card-id="${cardId}" data-line-idx="${idx}">
        <span class="line-add-btn" title="Add to basket">⬇</span>
        <span class="line-text">${escaped}</span>
      </div>`;
    })
    .filter(Boolean)
    .join('');
}
```

#### 3.2.2 Update `renderCardHtml()`

Replace:
```typescript
<div class="chat-excerpt">${escapeHtml(card.excerptLong)}</div>
```

With:
```typescript
<div class="chat-excerpt">${renderExcerptLines(card.excerptLong, card.id)}</div>
```

Apply to all LOD levels that show excerpts (summary, detail-1 through detail-5).

For full message at detail-3+:
```typescript
<div class="chat-excerpt">${renderExcerptLines(card.source.message, card.id)}</div>
```

#### 3.2.3 Add Click Handler for Line Icons

In `renderCards()`, after the existing event handlers, add delegation for `.line-add-btn` clicks:

```typescript
cards
  .select<HTMLElement>(".chat-html")
  .on("click", function(event) {
    const target = event.target as HTMLElement;
    if (target.classList.contains("line-add-btn")) {
      event.stopPropagation();
      const lineDiv = target.closest(".excerpt-line") as HTMLElement;
      if (lineDiv) {
        const cardId = lineDiv.dataset.cardId ?? "";
        const lineIdx = parseInt(lineDiv.dataset.lineIdx ?? "0", 10);
        const textSpan = lineDiv.querySelector(".line-text");
        const text = textSpan?.textContent ?? "";
        emit("line-click", { text, cardId, lineIndex: lineIdx });
      }
    }
  });
```

---

### 3.3 CSS Styles

**File**: `visualizer/src/index.css`

```css
/* Excerpt line styling */
.excerpt-line {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-bottom: 2px;
}

.line-add-btn {
  cursor: pointer;
  opacity: 0.4;
  font-size: 10px;
  flex-shrink: 0;
  transition: opacity 0.15s ease;
  user-select: none;
}

.line-add-btn:hover {
  opacity: 1;
}

.line-text {
  flex: 1;
  word-break: break-word;
}

/* Clipboard Basket Panel */
.clipboard-basket {
  position: fixed;
  bottom: 16px;
  left: 16px;
  width: 400px;
  height: 400px;
  background: var(--bg-card);
  border: 1px solid var(--border-card);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  z-index: 1000;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.basket-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-card);
  flex-shrink: 0;
}

.basket-title {
  font-weight: 600;
  font-size: 14px;
  color: var(--text-primary);
}

.basket-actions {
  display: flex;
  gap: 8px;
}

.basket-btn {
  background: var(--bg-hover);
  border: 1px solid var(--border-card);
  border-radius: 6px;
  padding: 6px 10px;
  color: var(--text-primary);
  cursor: pointer;
  font-size: 12px;
  transition: background 0.15s ease;
}

.basket-btn:hover {
  background: var(--accent);
}

.basket-content {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.basket-line {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 8px;
  background: var(--bg-primary);
  border-radius: 6px;
  margin-bottom: 4px;
  font-size: 12px;
  color: var(--text-secondary);
}

.basket-line-text {
  flex: 1;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.basket-line-remove {
  cursor: pointer;
  color: var(--text-muted);
  opacity: 0.6;
  transition: opacity 0.15s ease;
}

.basket-line-remove:hover {
  opacity: 1;
  color: #ef4444;
}

.basket-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-muted);
  font-size: 13px;
}
```

---

### 3.4 ClipboardBasket Component

**File**: `visualizer/src/components/ClipboardBasket.tsx` (new)

```typescript
import { useCallback } from "react";
import type { BasketLine } from "../types";

type Props = {
  lines: BasketLine[];
  onRemove: (id: string) => void;
  onClear: () => void;
};

export default function ClipboardBasket({ lines, onRemove, onClear }: Props) {
  const handleCopyAll = useCallback(async () => {
    const text = lines.map((l) => l.text).join("\n");
    await navigator.clipboard.writeText(text);
    // Optional: show toast feedback
  }, [lines]);

  return (
    <div className="clipboard-basket">
      <div className="basket-header">
        <span className="basket-title">Clipboard Basket</span>
        <div className="basket-actions">
          <button className="basket-btn" onClick={handleCopyAll} title="Copy all to clipboard">
            📋
          </button>
          <button className="basket-btn" onClick={onClear} title="Clear basket">
            🗑️
          </button>
        </div>
      </div>
      <div className="basket-content">
        {lines.length === 0 ? (
          <div className="basket-empty">Click ⬇ on card lines to collect them here</div>
        ) : (
          lines.map((line) => (
            <div key={line.id} className="basket-line">
              <span className="basket-line-text">{line.text}</span>
              <span className="basket-line-remove" onClick={() => onRemove(line.id)} title="Remove">
                ×
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
```

---

### 3.5 State Management in App.tsx

**File**: `visualizer/src/App.tsx`

#### 3.5.1 Add State

```typescript
const [basketLines, setBasketLines] = useState<BasketLine[]>([]);
```

#### 3.5.2 Add Handlers

```typescript
const handleLineClick = useCallback((detail: LineClickEventDetail) => {
  const id = `${detail.cardId}-${detail.lineIndex}-${Date.now()}`;
  setBasketLines((prev) => [
    ...prev,
    { id, text: detail.text, cardId: detail.cardId, addedAt: Date.now() },
  ]);
}, []);

const handleBasketRemove = useCallback((id: string) => {
  setBasketLines((prev) => prev.filter((l) => l.id !== id));
}, []);

const handleBasketClear = useCallback(() => {
  setBasketLines([]);
}, []);
```

#### 3.5.3 Wire Up Event from ChatMap

Pass `onLineClick={handleLineClick}` to `ChatMap`, which forwards it to the D3 engine.

#### 3.5.4 Render Component

Add to JSX:
```typescript
<ClipboardBasket
  lines={basketLines}
  onRemove={handleBasketRemove}
  onClear={handleBasketClear}
/>
```

---

### 3.6 ChatMap Component Update

**File**: `visualizer/src/components/ChatMap.tsx`

Add the `onLineClick` prop and wire it into the engine's event handler:

```typescript
type Props = {
  // ... existing props
  onLineClick?: (detail: LineClickEventDetail) => void;
};

// In the onEvent callback:
if (type === "line-click") {
  onLineClick?.(detail as LineClickEventDetail);
}
```

---

## 4. File Change Summary

| File | Action | Description |
|------|--------|-------------|
| `visualizer/src/types.ts` | Modify | Add `BasketLine`, `LineClickEventDetail` types |
| `visualizer/src/d3/chatMapEngine.ts` | Modify | Add `renderExcerptLines()`, update `renderCardHtml()`, add line-click event |
| `visualizer/src/index.css` | Modify | Add `.excerpt-line`, `.clipboard-basket` and related styles |
| `visualizer/src/components/ClipboardBasket.tsx` | Create | New React component for the basket panel |
| `visualizer/src/components/ChatMap.tsx` | Modify | Add `onLineClick` prop |
| `visualizer/src/App.tsx` | Modify | Add basket state, handlers, render `ClipboardBasket` |

---

## 5. Implementation Tasks

Tasks are organized chronologically by difficulty. Model recommendations are specified above each group.

### Phase 1: Type Definitions & CSS Foundation

{{SIMPLE}}

- [ ] Add `BasketLine` type to `visualizer/src/types.ts` with fields: `id`, `text`, `cardId`, `addedAt`
- [ ] Add `LineClickEventDetail` type to `visualizer/src/types.ts` with fields: `text`, `cardId`, `lineIndex`
- [ ] Add `.excerpt-line` CSS styles to `visualizer/src/index.css` (flex layout, gap, margin)
- [ ] Add `.line-add-btn` CSS styles to `visualizer/src/index.css` (cursor, opacity transitions, hover state)
- [ ] Add `.line-text` CSS styles to `visualizer/src/index.css` (flex, word-break)
- [ ] Add `.clipboard-basket` CSS styles to `visualizer/src/index.css` (fixed position, dimensions, z-index)
- [ ] Add `.basket-header`, `.basket-title`, `.basket-actions` CSS styles to `visualizer/src/index.css`
- [ ] Add `.basket-btn` CSS styles with hover states to `visualizer/src/index.css`

{{SIMPLE}}

- [ ] Add `.basket-content`, `.basket-line`, `.basket-line-text`, `.basket-line-remove` CSS to `visualizer/src/index.css`
- [ ] Add `.basket-empty` CSS styles to `visualizer/src/index.css`

### Phase 2: D3 Rendering Modifications

{{MEDIUM}}

- [ ] Add `"line-click": LineClickEventDetail` to `EngineEventMap` type in `chatMapEngine.ts`
- [ ] Create `renderExcerptLines()` function in `chatMapEngine.ts` that splits text on `/\r\n|\n|\r/`
- [ ] In `renderExcerptLines()`, filter out empty lines and escape HTML for each line
- [ ] In `renderExcerptLines()`, wrap each line in `<div class="excerpt-line">` with `data-card-id` and `data-line-idx` attributes
- [ ] In `renderExcerptLines()`, add `<span class="line-add-btn">⬇</span>` and `<span class="line-text">` for each line
- [ ] Update `renderCardHtml()` for `lod === "summary"` to use `renderExcerptLines(card.excerptMedium, card.id)`
- [ ] Update `renderCardHtml()` for `lod === "detail-1"` to use `renderExcerptLines(card.excerptLong, card.id)`
- [ ] Update `renderCardHtml()` for `lod === "detail-2"` to use `renderExcerptLines(card.excerptLong, card.id)`

{{MEDIUM}}

- [ ] Update `renderCardHtml()` for `lod === "detail-3"` to use `renderExcerptLines(card.source.message, card.id)`
- [ ] Update `renderCardHtml()` for `lod === "detail-4"` to use `renderExcerptLines(card.source.message, card.id)`
- [ ] Update `renderCardHtml()` for `lod === "detail-5"` to use `renderExcerptLines(card.source.message, card.id)`
- [ ] Add click event handler in `renderCards()` that delegates to `.line-add-btn` clicks
- [ ] In click handler, implement `event.stopPropagation()` to prevent card click from triggering
- [ ] Extract `cardId`, `lineIndex`, and `text` from clicked line element's data attributes and text content
- [ ] Call `emit("line-click", { text, cardId, lineIndex })` in the click handler

### Phase 3: React Component & State Management

{{MEDIUM}}

- [ ] Create new file `visualizer/src/components/ClipboardBasket.tsx`
- [ ] Define `Props` type with `lines: BasketLine[]`, `onRemove: (id: string) => void`, `onClear: () => void`
- [ ] Implement `ClipboardBasket` component with basket header, title, and action buttons
- [ ] Implement `handleCopyAll` callback that joins all line texts with `\n` and calls `navigator.clipboard.writeText()`
- [ ] Render basket content with empty state message when `lines.length === 0`
- [ ] Map over `lines` to render `.basket-line` divs with text and remove button
- [ ] Wire up remove button click to call `onRemove(line.id)`
- [ ] Wire up copy button (📋) to `handleCopyAll` and clear button (🗑️) to `onClear`

{{MEDIUM}}

- [ ] Update `visualizer/src/components/ChatMap.tsx` Props type to include `onLineClick?: (detail: LineClickEventDetail) => void`
- [ ] In `ChatMap.tsx`, forward `onLineClick` to the D3 engine's `onEvent` callback
- [ ] Add check in `ChatMap` event handler: `if (type === "line-click") { onLineClick?.(detail as LineClickEventDetail); }`
- [ ] Import `ClipboardBasket` component in `visualizer/src/App.tsx`
- [ ] Add `const [basketLines, setBasketLines] = useState<BasketLine[]>([]);` state in `App.tsx`
- [ ] Implement `handleLineClick` callback in `App.tsx` that creates new `BasketLine` and appends to state
- [ ] Implement `handleBasketRemove` callback in `App.tsx` that filters out line by id
- [ ] Implement `handleBasketClear` callback in `App.tsx` that sets state to empty array

{{MEDIUM}}

- [ ] Pass `onLineClick={handleLineClick}` prop to `ChatMap` component in `App.tsx`
- [ ] Render `<ClipboardBasket lines={basketLines} onRemove={handleBasketRemove} onClear={handleBasketClear} />` in `App.tsx` JSX

### Phase 4: Testing & Validation

{{SIMPLE}}

- [ ] Test that lines split correctly on `\n`, `\r\n`, and `\r` line endings
- [ ] Verify empty lines are skipped in rendering
- [ ] Test clicking ⬇ adds line to basket without triggering card click
- [ ] Verify basket panel is visible at 400×400px in bottom-left corner
- [ ] Test basket displays collected lines in the order they were added
- [ ] Test remove button (×) removes individual lines from basket
- [ ] Test clear button (🗑️) empties the entire basket
- [ ] Test copy button (📋) copies all basket lines joined by newlines to clipboard

{{SIMPLE}}

- [ ] Verify feature works at LOD level "summary" (k < 1.2)
- [ ] Verify feature works at LOD levels "detail-1" through "detail-5" (k >= 1.2)
- [ ] Test that hover behavior on cards is not affected by line click handlers
- [ ] Test that card click behavior is not affected by line icon clicks

---

## 6. Future Enhancements

- **Drag reordering** — Allow reordering lines in the basket
- **Persistence** — Store basket in localStorage across sessions
- **Toast feedback** — Show confirmation when copying to clipboard
- **Collapse/expand** — Allow minimizing the basket panel
- **Export formats** — JSON, markdown list, numbered list options
