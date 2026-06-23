# Chat View Modal — Implementation Plan

**Date**: 2026-03-10
**Status**: Approved, ready for implementation
**Scope**: Add clickable card titles that open a modal showing the full chat session

---

## Context

When clicking a card title on the D3 map, a **Chat View** modal opens showing the full session thread fetched from the server. This lets users read the complete conversation surrounding any search result without leaving the visualizer. The modal displays messages chronologically with role badges, collapsed tool calls, auto-scrolls to the clicked message, and blinks it 3 times for easy spotting.

---

## Files to Modify (7) and Create (2)

| # | File | Action |
|---|------|--------|
| 1 | `visualizer/src/types.ts` | Add `TitleClickEventDetail` type |
| 2 | `visualizer/src/api/search.ts` | Add `fetchSessionMessages()` function |
| 3 | `visualizer/src/d3/chatMapEngine.ts` | Add `"title-click"` to event map + click handler clause |
| 4 | `visualizer/src/hooks/useChatMap.ts` | Add `onTitleClick` param + ref + event routing |
| 5 | `visualizer/src/components/ChatMap.tsx` | Add `onTitleClick` prop, pass to hook |
| 6 | `visualizer/src/components/ChatViewDialog.tsx` | **CREATE** — modal component with fetch, message list, tool call collapsing, scroll-to, blink |
| 7 | `visualizer/src/components/ChatViewDialog.css` | **CREATE** — all styling + `@keyframes` blink animation |
| 8 | `visualizer/src/index.css` | Add `.chat-title:hover` affordance (underline + accent color + cursor:pointer) |
| 9 | `visualizer/src/App.tsx` | State, handler, prop passing, conditional render |

---

## Step-by-step Changes

### 1. `visualizer/src/types.ts` — new type (after line 118)

```ts
export type TitleClickEventDetail = {
    sessionId: string;
    messageId: string;
};
```

**Rationale**: Carries both the session to fetch and the specific message to scroll to. The `sessionId` comes from `CardData.sessionId` and `messageId` from `CardData.id`.

---

### 2. `visualizer/src/api/search.ts` — new fetch function (append at end)

```ts
export async function fetchSessionMessages(sessionId: string): Promise<SerializedAgentMessage[]>
{
    const response = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}`);
    if (!response.ok)
        throw new Error(`Session fetch failed: ${response.status} ${response.statusText}`);
    const data = (await response.json()) as SerializedAgentMessage[];
    return Array.isArray(data) ? data : [];
}
```

**Uses**: Existing `GET /api/sessions/:sessionId` endpoint (ContextServer.ts line 78-82) which returns `SerializedAgentMessage[]` sorted by dateTime ASC.

**Pattern**: Follows the same error-handling and fetch pattern as `fetchLatestMessages` and `searchMessages`.

---

### 3. `visualizer/src/d3/chatMapEngine.ts` — three changes

#### Change A: Add to `EngineEventMap` (line 6-14)

```ts
type EngineEventMap = {
    "chat-hover": HoverEventDetail;
    "chat-click": { data: CardData };
    "viewport-change": ViewportChangeDetail;
    "line-click": LineClickEventDetail;
    "card-star": CardStarEventDetail;
    "line-star": { cardId: string; source: any };
    "copy-json": { cardId: string; source: any };
    "title-click": { sessionId: string; messageId: string };  // <-- NEW
};
```

#### Change B: Add title-click handler in `.on("click")` (line 296-328)

Add this `else if` block **before** the final `else` that emits `"chat-click"`:

```ts
else if (target.classList.contains("chat-title"))
{
    event.stopPropagation();
    emit("title-click", { sessionId: card.sessionId, messageId: card.id });
}
```

**Critical location**: Must be placed after the `line-add-btn` handler and before the fallthrough `else` block.

**Why this works**: The existing HTML already uses `class="chat-title"` at every LOD tier except minimal (lines 117, 122, 127, 132, 137, 140). No HTML template changes needed. The event delegation pattern with `classList.contains()` ensures clicks on the title div specifically trigger this handler, not clicks on surrounding elements.

---

### 4. `visualizer/src/hooks/useChatMap.ts` — wire the callback

**Import**: Add `TitleClickEventDetail` to the import from `../types`

**Update `UseChatMapParams` type** (line 5-13):
```ts
type UseChatMapParams = {
    containerRef: RefObject<HTMLDivElement | null>;
    cards: CardData[];
    starredCardIds?: Set<string>;
    onHover?: (detail: HoverEventDetail) => void;
    onViewportChange?: (detail: ViewportChangeDetail) => void;
    onLineClick?: (detail: LineClickEventDetail) => void;
    onCardStar?: (detail: CardStarEventDetail) => void;
    onTitleClick?: (detail: TitleClickEventDetail) => void;  // <-- NEW
};
```

**Destructure** (line 15):
```ts
export function useChatMap({
    containerRef, cards, starredCardIds,
    onHover, onViewportChange, onLineClick, onCardStar, onTitleClick  // <-- add onTitleClick
}: UseChatMapParams)
```

**Create ref** (after line 22):
```ts
const onTitleClickRef = useRef<typeof onTitleClick>(onTitleClick);
```

**Sync ref in useEffect** (following the pattern at lines 30-48):
```ts
useEffect(() => {
    onTitleClickRef.current = onTitleClick;
}, [onTitleClick]);
```

**Handle event in `onEvent` dispatcher** (lines 58-83, add after the `"copy-json"` handler):
```ts
if (type === "title-click" && onTitleClickRef.current)
{
    onTitleClickRef.current(detail as TitleClickEventDetail);
}
```

**Follows pattern**: Identical to how `onLineClick`, `onCardStar` are wired through refs.

---

### 5. `visualizer/src/components/ChatMap.tsx` — pass prop through

**Import**: Add `TitleClickEventDetail` to imports from `../types`

**Update `ChatMapProps`** (lines 6-16):
```ts
type ChatMapProps = {
    cards: CardData[];
    hasSearched: boolean;
    query: string;
    isLoading: boolean;
    onHover: (detail: HoverEventDetail) => void;
    onViewportChange: (detail: ViewportChangeDetail) => void;
    onLineClick?: (detail: LineClickEventDetail) => void;
    onCardStar?: (detail: CardStarEventDetail) => void;
    onTitleClick?: (detail: TitleClickEventDetail) => void;  // <-- NEW
    starredCardIds?: Set<string>;
};
```

**Destructure** (line 18):
```ts
export default function ChatMap({
    cards, hasSearched, query, isLoading,
    onHover, onViewportChange, onLineClick, onCardStar, onTitleClick,  // <-- add onTitleClick
    starredCardIds,
}: ChatMapProps) {
```

**Pass to hook** (lines 31-39):
```ts
useChatMap({
    containerRef,
    cards,
    starredCardIds,
    onHover,
    onViewportChange,
    onLineClick,
    onCardStar,
    onTitleClick,  // <-- NEW
});
```

---

### 6. `visualizer/src/components/ChatViewDialog.tsx` — **CREATE**

Complete new file:

```tsx
import { useEffect, useRef, useState } from "react";
import { fetchSessionMessages } from "../api/search";
import type { SerializedAgentMessage, ToolCall } from "../types";
import "./ChatViewDialog.css";

type ChatViewDialogProps = {
    sessionId: string;
    messageId: string;
    onClose: () => void;
};

function ToolCallBlock({ tool }: { tool: ToolCall }) {
    const [expanded, setExpanded] = useState(false);

    return (
        <div className="cv-toolcall">
            <button
                type="button"
                className="cv-toolcall-toggle"
                onClick={() => setExpanded((prev) => !prev)}
                aria-expanded={expanded}
            >
                <span className="cv-toolcall-chevron">{expanded ? "▾" : "▸"}</span>
                <span className="cv-toolcall-name">{tool.name}</span>
            </button>
            {expanded && (
                <div className="cv-toolcall-body">
                    {tool.context.length > 0 && (
                        <div className="cv-toolcall-section">
                            <div className="cv-toolcall-section-label">Context</div>
                            <pre className="cv-toolcall-pre">{tool.context.join("\n")}</pre>
                        </div>
                    )}
                    {tool.results.length > 0 && (
                        <div className="cv-toolcall-section">
                            <div className="cv-toolcall-section-label">Results</div>
                            <pre className="cv-toolcall-pre">{tool.results.join("\n")}</pre>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function MessageBubble({
    message,
    isTarget,
}: {
    message: SerializedAgentMessage;
    isTarget: boolean;
}) {
    const bubbleRef = useRef<HTMLDivElement>(null);
    const roleLabel =
        message.role === "assistant"
            ? `Assistant (${message.model ?? "unknown"})`
            : message.role.charAt(0).toUpperCase() + message.role.slice(1);

    useEffect(() => {
        if (isTarget && bubbleRef.current) {
            bubbleRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
            bubbleRef.current.classList.add("cv-blink");
            const timer = setTimeout(() => {
                bubbleRef.current?.classList.remove("cv-blink");
            }, 2400);
            return () => clearTimeout(timer);
        }
    }, [isTarget]);

    return (
        <div
            ref={bubbleRef}
            className={`cv-message cv-message-${message.role}`}
            data-message-id={message.id}
        >
            <div className="cv-message-header">
                <span className="cv-message-role">{roleLabel}</span>
                <span className="cv-message-time">
                    {message.dateTime
                        ? new Date(message.dateTime).toLocaleString()
                        : ""}
                </span>
            </div>
            {message.message && (
                <div className="cv-message-body">{message.message}</div>
            )}
            {message.toolCalls.length > 0 && (
                <div className="cv-toolcalls">
                    {message.toolCalls.map((tool, index) => (
                        <ToolCallBlock key={`${message.id}-tool-${index}`} tool={tool} />
                    ))}
                </div>
            )}
        </div>
    );
}

export default function ChatViewDialog({
    sessionId,
    messageId,
    onClose,
}: ChatViewDialogProps) {
    const [messages, setMessages] = useState<SerializedAgentMessage[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);

        fetchSessionMessages(sessionId)
            .then((data) => {
                if (!cancelled) {
                    setMessages(data);
                    setLoading(false);
                }
            })
            .catch((err) => {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : "Failed to load session");
                    setLoading(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [sessionId]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                onClose();
            }
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [onClose]);

    return (
        <div
            className="cv-overlay"
            role="presentation"
            onClick={onClose}
        >
            <div
                className="cv-dialog"
                role="dialog"
                aria-modal="true"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="cv-header">
                    <h2 className="cv-title">
                        Chat Session
                        <span className="cv-session-id">{sessionId.slice(0, 12)}...</span>
                    </h2>
                    <button
                        type="button"
                        className="cv-close-btn"
                        onClick={onClose}
                        aria-label="Close"
                    >
                        &times;
                    </button>
                </div>
                <div className="cv-body">
                    {loading && (
                        <div className="cv-loading">Loading session...</div>
                    )}
                    {error && (
                        <div className="cv-error">{error}</div>
                    )}
                    {!loading && !error && messages.length === 0 && (
                        <div className="cv-empty">No messages in this session.</div>
                    )}
                    {!loading &&
                        !error &&
                        messages.map((msg) => (
                            <MessageBubble
                                key={msg.id}
                                message={msg}
                                isTarget={msg.id === messageId}
                            />
                        ))}
                </div>
            </div>
        </div>
    );
}
```

**Key design decisions**:

1. **ToolCallBlock**: Collapsible block showing tool name. Clicking expands to show `context[]` and `results[]` arrays in `<pre>` tags for readability.

2. **MessageBubble**:
   - Role-colored left border via CSS classes (`cv-message-user`, `cv-message-assistant`, etc.)
   - `isTarget` prop triggers `scrollIntoView({ behavior: "smooth", block: "center" })` and adds `cv-blink` CSS class
   - Blink class removed after 2400ms (3 blinks @ 0.8s per cycle)

3. **Fetch lifecycle**: Uses `cancelled` flag to prevent state updates after unmount

4. **Escape key**: Closes dialog via `keydown` listener

5. **Scroll-to-message**: The `useEffect` in `MessageBubble` fires when `isTarget` is true. Since React renders all bubbles at once after `setMessages`, the target bubble calls `scrollIntoView` in its effect. The `block: "center"` places the message vertically centered.

---

### 7. `visualizer/src/components/ChatViewDialog.css` — **CREATE**

Complete stylesheet:

```css
/* Overlay -- z-index 1300, above FavoritesPickerDialog (1250) */
.cv-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1300;
}

/* Dialog -- 75% of viewport */
.cv-dialog {
  width: 75vw;
  height: 75vh;
  background: var(--bg-card);
  border: 1px solid var(--border-card);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
}

/* Header row */
.cv-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border-card);
  flex-shrink: 0;
}

.cv-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 10px;
}

.cv-session-id {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.cv-close-btn {
  background: transparent;
  border: 1px solid var(--border-card);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 20px;
  width: 32px;
  height: 32px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s ease;
}

.cv-close-btn:hover {
  background: var(--bg-hover);
}

/* Scrollable body */
.cv-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* Loading / error / empty states */
.cv-loading,
.cv-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-muted);
  font-size: 14px;
}

.cv-error {
  background: #7f1d1d;
  color: #fee2e2;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 13px;
}

/* Message bubble */
.cv-message {
  border-left: 3px solid var(--border-card);
  border-radius: 8px;
  padding: 10px 14px;
  background: var(--bg-primary);
}

.cv-message-user {
  border-left-color: #22c55e;
}

.cv-message-assistant {
  border-left-color: var(--accent);
}

.cv-message-system {
  border-left-color: #a855f7;
}

.cv-message-tool {
  border-left-color: #f59e0b;
}

.cv-message-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.cv-message-role {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
}

.cv-message-time {
  font-size: 11px;
  color: var(--text-muted);
}

.cv-message-body {
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}

/* Tool call collapsible */
.cv-toolcalls {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cv-toolcall {
  border: 1px solid var(--border-card);
  border-radius: 6px;
  overflow: hidden;
}

.cv-toolcall-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--bg-hover);
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
  text-align: left;
  transition: background 0.15s ease;
}

.cv-toolcall-toggle:hover {
  background: #1e293b;
}

.cv-toolcall-chevron {
  font-size: 10px;
  width: 12px;
  flex-shrink: 0;
}

.cv-toolcall-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-weight: 600;
}

.cv-toolcall-body {
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cv-toolcall-section-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 4px;
}

.cv-toolcall-pre {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-primary);
  border-radius: 4px;
  padding: 8px;
  margin: 0;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 300px;
  overflow-y: auto;
}

/* Blink animation -- 3 blinks over 2.4s */
@keyframes cv-blink-anim {
  0%   { background: var(--bg-primary); }
  10%  { background: rgba(59, 130, 246, 0.25); }
  20%  { background: var(--bg-primary); }
  30%  { background: rgba(59, 130, 246, 0.25); }
  40%  { background: var(--bg-primary); }
  50%  { background: rgba(59, 130, 246, 0.25); }
  60%  { background: var(--bg-primary); }
  100% { background: var(--bg-primary); }
}

.cv-blink {
  animation: cv-blink-anim 2.4s ease-in-out;
}
```

**Design notes**:

- **z-index 1300**: Sits above FavoritesPickerDialog (1250) and ViewDialog (1200)
- **75vw × 75vh**: Exactly 75% of screen as specified
- **Blink animation**: 3 full cycles over 2.4s (background transitions between `var(--bg-primary)` and semitransparent blue)
- **cv-body**: `overflow-y: auto` provides the scrollbar for long chats
- **Role colors**: user=green (#22c55e), assistant=blue (--accent), system=purple (#a855f7), tool=amber (#f59e0b)
- **Tool call pre blocks**: `max-height: 300px` with their own scrollbar to prevent massive outputs from consuming viewport

---

### 8. `visualizer/src/index.css` — title hover affordance

**Modify existing `.chat-title` rule** (lines 107-114):

```css
.chat-title {
  font-weight: 600;
  font-size: 14px;
  margin: 4px 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;            /* NEW */
  transition: color 0.15s ease;  /* NEW */
}

.chat-title:hover {          /* NEW RULE */
  color: var(--accent);
  text-decoration: underline;
}
```

**Rationale**: Gives visual affordance (cursor + underline + color change) so users know the title is clickable. No new CSS class needed — the existing `.chat-title` class is sufficient since the D3 click handler differentiates via `classList.contains()`.

---

### 9. `visualizer/src/App.tsx` — orchestration

#### A. Add imports (lines 1-22)

Add `ChatViewDialog` to component imports:
```ts
import ChatViewDialog from "./components/ChatViewDialog";
```

Add `TitleClickEventDetail` to type imports:
```ts
import type {
    HoverEventDetail,
    ViewportChangeDetail,
    LineClickEventDetail,
    BasketLine,
    CardStarEventDetail,
    ViewDefinition,
    TitleClickEventDetail,  // <-- NEW
} from "./types";
```

#### B. Add state (after line 75, near other modal state)

```ts
const [chatViewTarget, setChatViewTarget] = useState<{ sessionId: string; messageId: string } | null>(null);
```

#### C. Add handlers (after `handleCardStar`, around line 325)

```ts
const handleTitleClick = useCallback((detail: TitleClickEventDetail) => {
    setChatViewTarget({ sessionId: detail.sessionId, messageId: detail.messageId });
}, []);

const closeChatView = useCallback(() => {
    setChatViewTarget(null);
}, []);
```

#### D. Pass to ChatMap (lines 386-396)

Add `onTitleClick={handleTitleClick}` prop:
```tsx
<ChatMap
    cards={cards}
    hasSearched={hasSearched}
    query={activeView.type === "search" ? query : activeView.name}
    isLoading={isLoading}
    onHover={handleHover}
    onViewportChange={handleViewportChange}
    onLineClick={handleLineClick}
    onCardStar={handleCardStar}
    onTitleClick={handleTitleClick}   // <-- NEW
    starredCardIds={starredCardIds}
/>
```

#### E. Render ChatViewDialog (after FavoritesPickerDialog, around line 434)

```tsx
{chatViewTarget && (
    <ChatViewDialog
        sessionId={chatViewTarget.sessionId}
        messageId={chatViewTarget.messageId}
        onClose={closeChatView}
    />
)}
```

---

## Verification Steps

1. **Start backend**: `bun start` (port 3210)
2. **Start frontend**: `cd visualizer && npm run dev` (port 5173)
3. **Search**: Enter any query and execute search
4. **Zoom**: Zoom in until card titles are visible (summary LOD or higher, k ≥ 0.7)
5. **Hover**: Hover over a title — should show:
   - Underline
   - Accent color (#3b82f6)
   - Pointer cursor
6. **Click title**:
   - Modal should open at 75% screen size
   - Show loading spinner initially
   - Then display full message list
7. **Verify target message**:
   - Scrolled to vertical center
   - Blinks 3 times with blue background flash
   - Total blink duration ~2.4 seconds
8. **Verify tool calls**:
   - Collapsed by default (chevron ▸ + tool name)
   - Expand on click (chevron ▾)
   - Show Context and Results sections
9. **Close modal**:
   - Click outside dialog → closes
   - Click × button → closes
   - Press Escape → closes
10. **Verify other buttons**:
    - Star button (☆/★) still works
    - Envelope button (📧) still works
    - Add-to-basket (+) still works
    - None should be intercepted by title handler

---

## Architecture Notes

### Event Flow
```
User clicks title
  ↓
D3 engine: .chat-title classList check
  ↓
emit("title-click", { sessionId, messageId })
  ↓
useChatMap: onTitleClickRef.current(detail)
  ↓
ChatMap: onTitleClick prop callback
  ↓
App: handleTitleClick → setChatViewTarget
  ↓
App: conditional render ChatViewDialog
  ↓
ChatViewDialog: fetchSessionMessages(sessionId)
  ↓
Server: GET /api/sessions/:sessionId
  ↓
ChatViewDialog: render messages, scroll to messageId, blink
```

### Z-Index Hierarchy (updated)
- **1300**: ChatViewDialog (new, highest)
- **1250**: FavoritesPickerDialog
- **1200**: ViewDialog
- **1000**: ClipboardBasket
- **0**: Main content (ChatMap, HoverPanel, StatusBar)

### Modal Pattern Consistency
All three modals (ViewDialog, FavoritesPickerDialog, ChatViewDialog) follow the same pattern:
- Overlay with `onClick={onClose}` and `role="presentation"`
- Dialog with `onClick={e => e.stopPropagation()}` and `aria-modal="true"`
- Escape key listener for keyboard close
- Consistent CSS structure and theming

---

## Success Criteria

✅ Titles show visual affordance on hover
✅ Clicking title opens modal at 75% screen size
✅ Modal fetches and displays full session
✅ Target message scrolls to center and blinks 3× blue
✅ Tool calls are collapsed, expandable on click
✅ Modal closes on overlay click, × button, or Escape
✅ Other card buttons (star, envelope, add) remain functional
✅ No TypeScript errors
✅ No console errors
✅ Responsive layout (modal scales with viewport)
