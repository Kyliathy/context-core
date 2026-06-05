# Agent Builder Phase 3 — UI: Multi-Platform Checkboxes

**Date**: 2026-03-20
**Scope**: Add platform checkboxes to `AgentBasket.tsx`; update visualizer types and create flow to support `platform` field.
**Depends on**: `r2uab3-agent-builder-3.md` (server — already implemented)
**Files touched**: `AgentBasket.tsx`, `AgentBasket.css`, `types.ts` (visualizer), `App.tsx`

---

## 1. Background

The server's `POST /api/agent-builder/create` now requires a `platform: "github" | "claude"` field. The server accepts **one platform per call**. The UI needs to let the user select one or both platforms before creating.

**Current state**: `AgentBasket.tsx` has no platform awareness. `CreateAgentInput` in the visualizer's `types.ts` has no `platform` field. The `handleCreate` callback builds the input and calls `onCreateAgent` once.

**Target state**: Two checkboxes ("GitHub Copilot" and "Claude Code") appear below the Create button. At least one must be checked for Create to be enabled. When both are checked, the create flow fires **two sequential server calls** (one per platform). Success/error feedback reflects the combined result.

---

## 2. Implementation Plan

### Group A — Type change in `visualizer/src/types.ts`

**A1 — Add `platform` to `CreateAgentInput`**

```typescript
export type CreateAgentInput = {
  projectName: string;
  agentName: string;
  description: string;
  "argument-hint": string;
  tools?: string[];
  agentKnowledge: string[];
  platform: "github" | "claude";   // NEW — matches server
};
```

This mirrors the server's `CreateAgentInput` exactly.

No changes to `fetchAgentBuilderCreate` in `api/search.ts` — the `platform` field is already part of the `CreateAgentInput` type that gets `JSON.stringify`-ed in the POST body.

---

### Group B — `AgentBasket.tsx` state & UI

**B1 — New state: `platforms`**

Add a `Set<"github" | "claude">` state to track which checkboxes are checked:

```typescript
const [platforms, setPlatforms] = useState<Set<"github" | "claude">>(new Set(["github"]));
```

Default: `github` checked (backward-compatible).

**B2 — Toggle helper**

```typescript
const togglePlatform = useCallback((p: "github" | "claude") => {
  setPlatforms(prev => {
    const next = new Set(prev);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    return next;
  });
}, []);
```

**B3 — Update `canCreate`**

Add `platforms.size > 0` to the existing `canCreate` expression for all non-template modes:

```
agent mode:       ... && platforms.size > 0
agent-from-template: ... && platforms.size > 0
template mode:    unchanged (templates don't target a platform)
```

**B4 — Checkbox UI**

Render two checkboxes **below** the Create/Save button row, inside the header area. Layout: a horizontal row with two `<label>` elements, each containing a native `<input type="checkbox">` and a label string.

```
[ ☑ GitHub Copilot ]  [ ☐ Claude Code ]
```

Only visible when `mode !== "template"` (templates are platform-agnostic).

In edit mode, pre-populate from `initialValues.platform` (if it exists on the initial values). Since `initialValues` currently has no `platform` field, extend the `initialValues` type on Props:

```typescript
initialValues?: {
  projectName: string;
  agentName: string;
  description: string;
  hint: string;
  tools: string;
  platform?: "github" | "claude";   // NEW
} | null;
```

The edit-mode `useEffect` that populates form fields should also set `platforms`:

```typescript
if (editMode && initialValues) {
  // ...existing field population...
  setPlatforms(new Set([initialValues.platform ?? "github"]));
}
```

**B5 — Update `handleCreate` to pass `platform`**

Currently `handleCreate` calls `onCreateAgent(input)` once. Change it to call `onCreateAgent` **once per selected platform**:

```typescript
const handleCreate = useCallback(() => {
  if (!canCreate) return;
  const toolList = tools.split(",").map(t => t.trim()).filter(Boolean);
  // ... template mode unchanged ...

  const platformList = Array.from(platforms);
  for (const platform of platformList) {
    onCreateAgent({
      projectName,
      agentName,
      description,
      "argument-hint": argumentHint,
      tools: toolList.length > 0 ? toolList : undefined,
      agentKnowledge: entries.map(e => e.value),
      platform,
    });
  }
}, [canCreate, mode, projectName, agentName, description, argumentHint, tools, entries, platforms, onCreateAgent, onCreateTemplate]);
```

**Important**: Since `onCreateAgent` in `App.tsx` is async (calls `fetchAgentBuilderCreate`), and the basket fires multiple calls, `App.tsx` must handle this correctly. See Group C.

---

### Group C — `App.tsx` create handler update

**C1 — Handle multiple sequential creates**

The current `handleCreateAgent` in `App.tsx` calls `fetchAgentBuilderCreate(input)` and sets success/error state. With multi-platform, two approaches:

**Option 1 — Basket fires one call per platform (simple, chosen)**
The basket calls `onCreateAgent` once per platform. Each call is independent. `App.tsx`'s handler doesn't need to change — it already handles individual calls. The success message will show the last platform's result. Errors from either call will show.

This is the simplest approach. The only caveat is that `isCreating` will flip true/false between the two calls, but since they're synchronous loop iterations dispatching into an async handler, React will batch them. The user sees "Saving..." until both complete.

**Option 2 — Basket sends platforms array, App loops (alternative)**
The basket passes `platforms: ("github" | "claude")[]` alongside the input. `App.tsx` loops and calls the API for each. Better control over combined success/error messaging.

**Decision: Option 1** — Keep it simple. The basket calls `onCreateAgent` once per platform. If both succeed, the success message shows both names. If either fails, the error shows.

Actually, on reflection, Option 1 has a problem: the second `onCreateAgent` call might overwrite the first's success/error state before the user sees it. **Revised decision: Option 2** — pass the platforms array to `App.tsx` and let it loop.

**C2 — Update `onCreateAgent` signature**

Change the callback to accept an extra `platforms` parameter, or bundle it into the input. Since `CreateAgentInput` now has a single `platform` field, pass the array separately:

Update the `Props` type of `AgentBasket`:

```typescript
onCreateAgent: (input: Omit<CreateAgentInput, "platform">, platforms: ("github" | "claude")[]) => void;
```

Then in `App.tsx`, the handler becomes:

```typescript
const handleCreateAgent = useCallback(async (
  input: Omit<CreateAgentInput, "platform">,
  platforms: ("github" | "claude")[],
) => {
  setIsCreatingAgent(true);
  setAgentCreateError(null);
  setAgentCreateSuccess(null);
  const results: string[] = [];

  for (const platform of platforms) {
    try {
      const result = await fetchAgentBuilderCreate({ ...input, platform });
      results.push(`${platform}: ${result.agentName}`);
    } catch (err: any) {
      setAgentCreateError(`${platform}: ${err.message}`);
      setIsCreatingAgent(false);
      return; // stop on first error
    }
  }

  setIsCreatingAgent(false);
  setAgentCreateSuccess(results.join(" · "));
  // ...existing post-create cleanup (clear basket, refresh, etc.)...
}, [editingAgentPath, ...]);
```

**C3 — Edit mode pre-population**

When `handleEditAgent` loads an existing agent via `fetchAgentBuilderGetAgent`, the response now includes `platform`. Pass it through to `agentEditInitial`:

```typescript
setAgentEditInitial({
  projectName: agent.projectName,
  agentName: agent.agentName,
  description: agent.description,
  hint: agent["argument-hint"],
  tools: (agent.tools ?? []).join(", "),
  platform: agent.platform,   // NEW
});
```

---

### Group D — `AgentBasket.css` styles

**D1 — Platform checkboxes row**

```css
.agent-basket-platforms {
  display: flex;
  gap: 12px;
  padding: 4px 12px 8px;
  border-bottom: 1px solid #1f2937;
}

.agent-basket-platforms label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.8rem;
  color: #9ca3af;
  cursor: pointer;
  user-select: none;
}

.agent-basket-platforms input[type="checkbox"] {
  accent-color: #3b82f6;
  cursor: pointer;
}
```

---

## 3. Rendering Placement

```
┌──────────────────────────────────────┐
│  🏗️ Agent Creator     [Cancel] [Create] [✕] │
├──────────────────────────────────────┤
│  [ ☑ GitHub Copilot ]  [ ☐ Claude Code ]    │  ← NEW
├──────────────────────────────────────┤
│  ⚠ error banner (if any)                    │
│  ✓ success banner (if any)                   │
├──────────────────────────────────────┤
│  Project: [ ▾ select ]                       │
│  Name:    [ my-agent  ]                      │
│  Desc:    [ ... ]                            │
│  Hint:    [ ... ]                            │
│  Tools:   [ ... ]                            │
├──────────────────────────────────────┤
│  Knowledge (3 entries)                       │
│  ...                                         │
└──────────────────────────────────────┘
```

The checkboxes sit between the header buttons and the error/success banners. They are only visible when `mode !== "template"`.

---

## 4. Behavioral Summary

| Scenario | GitHub checked | Claude checked | Create enabled | Server calls |
|---|---|---|---|---|
| Default | ✅ | ❌ | ✅ (if form valid) | 1× `platform:"github"` |
| Both | ✅ | ✅ | ✅ | 2× sequential |
| Neither | ❌ | ❌ | ❌ | — |
| Claude only | ❌ | ✅ | ✅ | 1× `platform:"claude"` |
| Template mode | — | — | (always enabled, no checkboxes) | 0 (template) |

---

## 5. Edit Mode Behavior

When editing an existing agent (`editMode === true`):
- The checkboxes pre-populate from `initialValues.platform` (only one will be checked — the platform the agent was originally created for).
- The user can check the other platform too, creating a copy on the second platform.
- The Save button label stays "💾 Save" regardless of platform selection.

---

## 6. Error Handling

- If the user checks both platforms and the first create succeeds but the second fails, the error banner shows which platform failed (e.g. `"claude: No claudeAgentPath configured"`).
- The successfully created file from the first call is NOT rolled back — partial success is acceptable.

---

## 7. Out of Scope

- Displaying which platform an existing agent belongs to in the agent-list view cards.
- Deleting agents.
- "Create for both" as a single server call (would require server changes).
