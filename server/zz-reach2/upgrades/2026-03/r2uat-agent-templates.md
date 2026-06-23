# Agent Templates — Backend Plan

**Date**: 2026-03-18  
**Scope**: Two new endpoints under `/api/agent-builder/` for creating and listing agent templates  
**Storage**: `{storage}/.settings/agent-templates/`

---

## 1. Concept

Agent templates are reusable, pre-configured agent definitions stored as **JSON-only** files. Unlike agents, they never produce a `.agent.md` runtime artifact — they exist purely as structured templates that the frontend can load to pre-populate the Agent Builder form.

Templates support **placeholder tokens** in their `agentKnowledge` array: strings containing `<PLACEHOLDER>` (angular brackets, capslock) signal to the frontend that the user must substitute a real value before creating an agent from the template. Placeholder handling is entirely a frontend concern — the backend stores and returns them as-is.

---

## 2. Storage Location

Templates live in the settings directory alongside `topics.json`:

```
{storage}/
└── .settings/
    ├── topics.json              ← existing (TopicStore)
    └── agent-templates/         ← NEW
        ├── my-template.json
        └── another-template.json
```

This follows the established `TopicStore` pattern: settings data isolated from `AgentMessage` storage, under the `.settings` root. The `agent-templates/` subdirectory is created on first write (or on startup if templates are feature-gated).

---

## 3. Template JSON Schema

Each template file is `{templateName}.json`:

```json
{
  "templateName": "my-template",
  "description": "A reusable template for UI workers.",
  "argument-hint": "A task to implement.",
  "tools": ["read", "edit", "search"],
  "agentKnowledge": [
    "docs/architecture.md",
    "<PLACEHOLDER>",
    "src/components/README.md"
  ]
}
```

| Field            | Type       | Required | Description                                                          |
| ---------------- | ---------- | -------- | -------------------------------------------------------------------- |
| `templateName`   | `string`   | yes      | Slug identifier (lowercase, numbers, hyphens). Used as filename stem |
| `description`    | `string`   | yes      | Human-readable description of what the template is for               |
| `argument-hint`  | `string`   | yes      | Default argument hint for agents created from this template          |
| `tools`          | `string[]` | no       | Default tool set (empty array or omitted = all tools)                |
| `agentKnowledge` | `string[]` | yes      | Knowledge entries — may include `<PLACEHOLDER>` tokens               |

---

## 4. API Endpoints

### 4.1 `POST /api/agent-builder/add-template`

Creates (or overwrites) a template JSON file in the `agent-templates/` directory.

**Request body:**

```json
{
  "templateName": "my-template",
  "description": "A reusable template for UI workers.",
  "argument-hint": "A task to implement.",
  "tools": ["read", "edit"],
  "agentKnowledge": ["docs/architecture.md", "<PLACEHOLDER>"]
}
```

**Validation:**
- `templateName` required, must be a valid slug (`/^[a-z0-9]+(-[a-z0-9]+)*$/`)
- `description` required, non-empty string
- `argument-hint` required, non-empty string
- `agentKnowledge` required, must be an array (can be empty)
- `tools` optional, defaults to `[]`

**Response (201):**

```json
{
  "created": true,
  "templateName": "my-template",
  "path": "d:\\...\\.settings\\agent-templates\\my-template.json"
}
```

**Error responses:**
- `400` — missing/invalid required fields, invalid slug format
- `500` — filesystem write failure

### 4.2 `GET /api/agent-builder/list-templates`

Returns all templates from the `agent-templates/` directory.

**Response:**

```json
{
  "totalTemplates": 2,
  "templates": [
    {
      "templateName": "my-template",
      "description": "A reusable template for UI workers.",
      "argument-hint": "A task to implement.",
      "tools": ["read", "edit"],
      "agentKnowledge": ["docs/architecture.md", "<PLACEHOLDER>"]
    },
    {
      "templateName": "another-template",
      "description": "...",
      "argument-hint": "...",
      "tools": [],
      "agentKnowledge": []
    }
  ]
}
```

Templates are sorted alphabetically by `templateName`. Malformed JSON files are silently skipped with a console warning.

---

## 5. Implementation Tasks

### 5.1 Interfaces & Types

{{SIMPLE}}

- [x] **T1.** Add `CreateTemplateInput` interface to `AgentBuilder.ts` — fields: `templateName` (string), `description` (string), `"argument-hint"` (string), `tools?` (string[]), `agentKnowledge` (string[])
- [x] **T2.** Add `CreateTemplateResponse` interface to `AgentBuilder.ts` — fields: `created` (boolean), `templateName` (string), `path` (string)
- [x] **T3.** Add `TemplateListResponse` interface to `AgentBuilder.ts` — fields: `totalTemplates` (number), `templates` (CreateTemplateInput[])

### 5.2 Core Methods

{{MEDIUM}}

- [x] **T4.** Add `addTemplate(storagePath: string, input: CreateTemplateInput): CreateTemplateResponse` method to `AgentBuilder` class — resolves `{storagePath}/.settings/agent-templates/`, ensures dir exists via `mkdirSync`, writes `{templateName}.json` with the full `CreateTemplateInput` payload, returns response. `storagePath` comes from `CCSettings.storage`, passed through `ContextServer` at call time (avoids adding storage awareness to the `AgentBuilder` constructor which currently only knows `MachineConfig`)
- [x] **T5.** Add `listTemplates(storagePath: string): TemplateListResponse` method to `AgentBuilder` class — reads all `.json` files from `{storagePath}/.settings/agent-templates/`, parses each defensively (skips malformed with `console.warn`), sorts by `templateName`, returns `TemplateListResponse`. Returns `{ totalTemplates: 0, templates: [] }` when dir doesn't exist

### 5.3 Endpoint Registration

{{MEDIUM}}

- [x] **T6.** Register `POST /api/agent-builder/add-template` in `ContextServer.ts` — same `if (!agentBuilder) → 404` guard pattern. Validate: `templateName` required + slug regex `/^[a-z0-9]+(-[a-z0-9]+)*$/`, `description` required non-empty, `argument-hint` required non-empty, `agentKnowledge` required array, `tools` optional defaults to `[]`. Call `agentBuilder.addTemplate(settings.storage, input)`, return 201
- [x] **T7.** Register `GET /api/agent-builder/list-templates` in `ContextServer.ts` — same guard pattern. Call `agentBuilder.listTemplates(settings.storage)`, return result

### 5.4 Smoke Test

{{SIMPLE}}

- [ ] **T8.** Start the server, POST a valid template with `<PLACEHOLDER>` in knowledge, verify 201 + file written to `.settings/agent-templates/`
- [ ] **T9.** GET list-templates, verify the created template appears in the response with placeholder preserved
- [ ] **T10.** POST add-template with missing `templateName` → verify 400
- [ ] **T11.** POST add-template with invalid slug (uppercase / spaces) → verify 400
- [ ] **T12.** POST add-template with same name again → verify 201 (overwrite)

---

## 6. Design Notes

- **JSON-only** — no `.agent.md` generation; templates are not runtime agents
- **Storage**: `{storage}/.settings/agent-templates/` follows the `TopicStore` pattern (settings isolated from message storage)
- **Placeholder passthrough** — `<PLACEHOLDER>` tokens stored and returned as-is; substitution is a frontend concern
- **AgentBuilder gate** — endpoints return 404 when no data sources are configured, keeping API surface consistent. Can be lifted later if templates should work independently
- **No new files** — 3 interfaces + 2 methods in `AgentBuilder.ts`, 2 routes in `ContextServer.ts`
