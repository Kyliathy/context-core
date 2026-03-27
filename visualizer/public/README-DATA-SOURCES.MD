# Configuring Data Sources for the Agent Builder

The Agent Builder lets you create AI agent definition files (`.agent.md`) by browsing your project's knowledge files and selecting which ones the agent should read. Before it can work, you need to tell the server **where your knowledge files live** and **where to save created agents**.

This is done through the `dataSources` block in your server's `cc.json` configuration file.

---

## What Are Data Sources?

A **data source** is a directory on your machine that contains files you want the Agent Builder to index and display. These are typically:

- Markdown files (`.md`) — architecture docs, design specs, upgrade plans
- Text files (`.txt`) — notes, reference material
- Any other files relevant to your project's knowledge base

Each data source entry also optionally specifies an **agent path** — the directory where newly created `.agent.md` and `.agent.json` files will be saved.

---

## Minimum Configuration

To use the Agent Builder, you need **at least one data source entry** with:

1. **`name`** — A project identifier (appears in the UI dropdown so you can select which project to create an agent for)
2. **`agentPath`** — The directory where agent files will be written
3. **`purpose`** set to `"AgentBuilder"`

Without an `agentPath`, the system has nowhere to save agents. Without `purpose: "AgentBuilder"`, the entry is ignored by the Agent Builder.

The `path` field (content directory) is optional in the minimal case — if omitted, you won't see any files in the grid to browse, but you can still create agents manually by filling in the form fields and adding custom knowledge entries.

### Minimal Example

```json
{
  "dataSources": {
    "my-projects": [
      {
        "name": "My Project",
        "agentPath": "C:\\Code\\my-project\\.github\\agents",
        "path": "C:\\Code\\my-project\\docs",
        "type": "Documentation",
        "purpose": "AgentBuilder"
      }
    ]
  }
}
```

This single entry tells the Agent Builder:
- Index all files under `C:\Code\my-project\docs` (shown as browsable cards in the UI grid)
- Save created agents to `C:\Code\my-project\.github\agents`
- Label this source as **"My Project"** in the dropdown

---

## Full Field Reference

Each entry in the `dataSources` block has these fields:

| Field       | Required | Description                                                                                                                                                                    |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `path`      | Yes      | Root directory to scan for knowledge files. The Agent Builder recursively indexes all files here (skipping `.git/`, `node_modules/`, and hidden directories except `.github`). |
| `agentPath` | No*      | Directory where `.agent.md` and `.agent.json` files are created. **At least one entry must have this field**, or you won't be able to save agents.                             |
| `name`      | Yes      | Human-readable project name. Appears in the UI project dropdown and is used to identify which source an agent belongs to.                                                      |
| `type`      | Yes      | Informational label (e.g. `"Architecture Docs"`, `"Knowledge Base"`). Shown on file cards for context.                                                                         |
| `purpose`   | Yes      | Must be `"AgentBuilder"` for the Agent Builder to pick it up. Other values (e.g. `"SyntaxHelper"`) are used by other subsystems.                                               |

*While `agentPath` is optional per-entry, **at least one entry across all your data sources must define it**. Multiple entries can share the same `agentPath`.

---

## Where Does This Go in `cc.json`?

The `dataSources` block lives inside a machine config entry. Here's how it fits into the overall structure:

```json
{
  "storage": "C:\\path\\to\\cxc-storage",
  "machines": [
    {
      "machine": "MY-MACHINE",
      "harnesses": {
        "...harness config..."
      },
      "dataSources": {
        "my-knowledge": [
          {
            "path": "C:\\Code\\project-alpha\\docs",
            "agentPath": "C:\\Code\\project-alpha\\.github\\agents",
            "name": "Project Alpha",
            "type": "Architecture Docs",
            "purpose": "AgentBuilder"
          },
          {
            "path": "C:\\Code\\project-beta\\knowledge",
            "agentPath": "C:\\Code\\project-beta\\.github\\agents",
            "name": "Project Beta",
            "type": "Design Specs",
            "purpose": "AgentBuilder"
          }
        ]
      }
    }
  ]
}
```

The category key (`"my-knowledge"` above) is a grouping label — you can name it anything. All entries inside it with `purpose: "AgentBuilder"` will be indexed.

---

## Multiple Projects, Shared Agent Path

Multiple data source entries can point to different content directories but share the same `agentPath`. This is useful when a single repository has agents that draw knowledge from multiple source trees:

```json
{
  "dataSources": {
    "my-repo": [
      {
        "path": "D:\\Repos\\my-app\\server\\docs",
        "agentPath": "D:\\Repos\\my-app\\.github\\agents",
        "name": "Server Docs",
        "type": "Backend Architecture",
        "purpose": "AgentBuilder"
      },
      {
        "path": "D:\\Repos\\my-app\\frontend\\docs",
        "agentPath": "D:\\Repos\\my-app\\.github\\agents",
        "name": "Frontend Docs",
        "type": "UI Architecture",
        "purpose": "AgentBuilder"
      }
    ]
  }
}
```

Both sources share `.github/agents` as the agent output directory. The Agent Builder deduplicates agent files by absolute path so they aren't counted twice.

---

## What Happens at Startup

When the ContextCore server starts:

1. It reads `cc.json` and finds entries with `purpose: "AgentBuilder"`
2. It creates an `AgentBuilder` instance and recursively scans each `path` directory for files
3. It also scans each `agentPath` for existing `.agent.md` files
4. The complete file index is held in memory and served through the `POST /api/agent-builder/prepare` endpoint
5. The visualizer fetches this index and renders files as browsable cards

If **no data source entries** have `purpose: "AgentBuilder"`, the AgentBuilder is not created and the UI shows an error.

---

## Troubleshooting

### "No data sources defined"

This means `cc.json` has no `dataSources` entries with `purpose: "AgentBuilder"` for the current machine. To fix it:

1. Open `server/cc.json`
2. Find your machine entry (matching your hostname)
3. Add a `dataSources` block with at least one entry that has `purpose: "AgentBuilder"` and an `agentPath`
4. Restart the server

### Files not showing up in the grid

- Make sure `path` points to a directory that exists and contains files
- Hidden directories (starting with `.`) are skipped except `.github`
- `node_modules/` and `.git/` are always skipped
- The server must be restarted after changing `cc.json` for new paths to take effect

### Agent creation fails

- Verify that `agentPath` points to a directory that exists (or can be created)
- Ensure the server process has write permissions to the `agentPath` directory
