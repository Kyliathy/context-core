# R2BF — Agent Builder: Graceful "No Data Sources" Handling

**Date**: 2026-03-23
**Status**: Planning
**Scope**: Server error response for `/api/agent-builder/prepare` when no `dataSources` are configured, frontend error UX, and a public help document explaining how to configure data sources.

---

## 1. Problem

When `cc.json` has no `dataSources` block (or no entries with `purpose: "AgentBuilder"`), the server does **not** instantiate `AgentBuilder`. All agent-builder endpoints previously returned HTTP 404 with `{ error: "AgentBuilder not available (no dataSources configured)" }`.

The frontend's `fetchAgentBuilderPrepare()` threw on 404, and the error surfaced as `"Agent Builder endpoint not available — is the server updated?"` — confusing and unhelpful. A prior fix changed the `/prepare` endpoint to return HTTP 200 with `{ error: "No data sources defined" }`, but the frontend still shows a bare text error with no guidance on what to do about it.

---

## 2. Goal

When a user hits the Agent Builder view and no data sources are configured:

1. Show a **clear error message** in the error banner.
2. Include a **clickable link** to a help document (`README-DATA-SOURCES.MD`) hosted in `visualizer/public/` that explains how to configure data sources in `cc.json`.
3. The help document should be a standalone reference covering:
   - What `dataSources` are and why they're needed
   - How each entry maps to a directory of knowledge files (`.md`, `.txt`, etc.)
   - The requirement that **at least one `agentPath`** must be present so the system knows where to save created agents
   - A working example based on the real `cc.json` format
   - How `purpose: "AgentBuilder"` gates inclusion

### Key Insight

The minimum viable configuration is **one data source entry with an `agentPath`**. Even without content files to browse, the user can still create agents manually (fill in name, description, hint, custom knowledge) as long as there is a target `agentPath` directory and a `name` (project identifier) for the dropdown. Content file scanning is a bonus, not a requirement.

---

## 3. Plan

### A1 — Create `visualizer/public/README-DATA-SOURCES.MD`

A standalone Markdown help file served as a static asset at `/README-DATA-SOURCES.MD`. Contents:

- Title: "Configuring Data Sources for the Agent Builder"
- Section: What are data sources?
- Section: Minimum configuration (1 entry with `agentPath` + `name` + `purpose: "AgentBuilder"`)
- Section: Full field reference (`path`, `agentPath`, `name`, `type`, `purpose`)
- Section: Example `cc.json` snippet
- Section: What happens at startup (AgentBuilder indexes files, serves via `/prepare`)
- Section: Troubleshooting ("I see 'No data sources defined'" → add a `dataSources` block)

### A2 — Update server `/prepare` error message

Already done in prior fix: returns `{ error: "No data sources defined" }` with HTTP 200.

No further server changes needed.

### A3 — Update error banner in `App.tsx` to render a link for data source errors

The error banner currently renders `<span>{error}</span>` (plain text). For the specific "No data sources defined" message, we should render a linked version:

```
No data sources defined — Instructions for how to add Data Sources / Agent Paths
```

Where "Instructions for how to add Data Sources / Agent Paths" is an `<a>` tag pointing to `/README-DATA-SOURCES.MD` (opens in a new tab).

**Implementation approach**: In the JSX where the `error` is rendered, check if the error string matches `"No data sources defined"` and render a richer message with a link. Otherwise render the plain text as before.

This affects **two** error display sites:
1. The top-level `error` from `useSearch` (shown in the error banner in `App.tsx` ~line 1244) — this is triggered when switching to the `agent-builder` view and `/prepare` fails.
2. The mount-time `fetchAgentBuilderPrepare()` in the `useEffect` at ~line 607 — this one currently silently swallows the error (no UI). The dropdown shows "No data sources configured" which is fine.

Only site (1) needs the link treatment.

### A4 — Verify

- Start server with no `dataSources` in `cc.json`
- Switch to Agent Builder view
- Confirm error banner shows linked message
- Click link → opens `README-DATA-SOURCES.MD` in new tab
- Confirm other views still work normally

---

## 4. Files Changed

| File                                             | Change                                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| `visualizer/public/README-DATA-SOURCES.MD`       | **New** — help document for data source configuration                       |
| `visualizer/src/App.tsx`                         | Error banner: render link when error is "No data sources defined"           |
| `server/src/server/routes/agentBuilderRoutes.ts` | Already done — returns `{ error: "No data sources defined" }` on `/prepare` |

---

## 5. Non-Goals

- No changes to other agent-builder endpoints (`/create`, `/list`, `/get-agent`) — they keep their 404 behavior since those endpoints shouldn't be called if `/prepare` already indicated no sources.
- No changes to `useSearch.ts` or `search.ts` fetch wrappers beyond what was already done.
- No changes to the `AgentBuilder` class itself.