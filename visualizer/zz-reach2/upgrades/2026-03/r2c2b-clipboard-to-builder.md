# r2c2b — Clipboard Basket → Agent Builder

**Date**: 2026-03-23  
**Status**: Implemented  
**Scope**: Add a 🏗️ button to the ClipboardBasket that sends all collected snippets to the Agent Builder as knowledge entries.

---

## Overview

The ClipboardBasket currently has two header buttons: **📋 Copy All** and **🗑️ Clear**. This upgrade adds a third button (**🏗️**) positioned _before_ the other two with `20px` right-padding for visual separation. Pressing it:

1. Switches to the `agent-builder` view (same mechanism as **Launch Builder** in the SearchBar dropdown — calls `switchView("built-in-agent-builder")`).
2. Populates `agentKnowledgeEntries` with every `BasketLine`, each mapped to an `AgentKnowledgeEntry` with `kind: "custom"` and the line's `.text` as `.value`.

---

## Affected Files

| File | Change |
|------|--------|
| `visualizer/src/components/searchView/ClipboardBasket.tsx` | Add 🏗️ button + new `onSendToBuilder` prop |
| `visualizer/src/App.tsx` | Wire `handleSendClipboardToBuilder` callback; pass it to `<ClipboardBasket>` |

---

## Tasks

{{SIMPLE}}

- [x] **ClipboardBasket.tsx — Add `onSendToBuilder` prop** to the `Props` type.
- [x] **ClipboardBasket.tsx — Render the 🏗️ button** before the existing `📋` and `🗑️` buttons. Use a wrapper/span with `margin-right: 20px` on the new button to visually separate it from the other two. Title: `"Send to Agent Builder"`. Disable when `lines.length === 0`.
- [x] **App.tsx — Create `handleSendClipboardToBuilder`** callback: convert each `BasketLine` → `AgentKnowledgeEntry` (`kind: "custom"`, `value: line.text`, unique `id`, `addedAt: Date.now()`), set them into `agentKnowledgeEntries`, then call `switchView("built-in-agent-builder")`.
- [x] **App.tsx — Pass `onSendToBuilder={handleSendClipboardToBuilder}`** to `<ClipboardBasket>`.
- [ ] **Smoke-test** — Launch visualizer, collect a few clipboard lines, press 🏗️, verify view switches and basket populates.

---

## Implementation Notes

- **Mapping**: `BasketLine.text` → `AgentKnowledgeEntry.value`. Since clipboard lines are free-text (not file paths), `kind` must be `"custom"`.
- **Dedup**: No dedup needed at transfer time — the Agent Builder basket already handles duplicates with flash feedback when the user tries to add a duplicate later.
- **Existing entries**: The transfer _replaces_ current knowledge entries (sets state, doesn't append) because the user is explicitly starting a new builder session from clipboard content. If the user wants to keep existing entries, they should add clipboard items manually.
- **View switch**: Reuses the existing `switchView("built-in-agent-builder")` which triggers the `/prepare` fetch and enables the agent-builder card render mode.
- **Button placement**: The 🏗️ button sits _before_ (to the left of) 📋 and 🗑️ in the `.basket-actions` div, with `margin-right: 20px` to create clear visual separation.
