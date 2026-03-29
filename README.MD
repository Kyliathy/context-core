# Context Core (by https://reach2.ai )

Context Core aggregates agentic AI conversation histories from multiple IDEs/harnesses (Claude Code, Cursor, Kiro, Codex, VS Code Copilot, OpenCode) into a unified, searchable system. It consists of a **Bun/TypeScript backend** with an MCP server, and a **React + D3 visualizer frontend** that can scaffold AI agents from conversation history and project knowledge sources (defined in the server's `cc.json` configuration).

🙂 Friendly heads-up: the setup wizard helps a lot, but it is still early, so you may need a little manual configuration in some environments. 🛠️

We're actively developing ContextCore, so feel free to reach out by posting issues and comments <3.

☑️ 242 tests passing locally, but fixtures are missing from the repo due to privacy reasons. Will generate new fixtures when more developers join.

Release 1 - Codename "LEO"

## Quick Start

1. Start the backend:

  ```bash
  cd server
  bun install
  bun run setup
  bun run dev
  ```

2. In a second terminal, start the visualizer:

  ```bash
  cd visualizer
  npm install
  npm run dev
  ```

3. Open `http://localhost:5173`.

### Final Note: PWA Install

If you want the installable app (standalone window) instead of dev mode:

1. Build the visualizer with `npm run build` in `visualizer`.
2. Open `http://localhost:3210`.
3. Install from the browser's install prompt/menu (Chrome or Edge).

If the backend starts on a different port because `3210` is busy, open the port listed in `server/.cxc-port` and reinstall the PWA from that URL.

### Memory problems?

If you've been very chatty with your AIs, bun might run out of the standard 8 GiB of memory `while startup indexing`. It will never consume that much, usually dropping to under 1 GiB. In that case, use `start-himem` to start the server.

## Search

Context Core search combines lexical and semantic retrieval, then boosts discoverability with AI-generated topic summaries.

- **Fuse.js (lexical)**: weighted fuzzy matching over message text, subjects, symbols, tags, and context.
- **Qdrant (semantic, optional, see below for setup)**: vector similarity search using OpenAI `text-embedding-3-large` (3072 dimensions).
- **Hybrid ranking**: when both engines are active, results are merged with **75% semantic / 25% lexical** weighting.
- **AI topic summarization**: two-pass summarization (`gpt-5-nano` + `gpt-5-mini`) with `customTopic` override support.

### Improved Search Tools

#### Qdrant

Qdrant is optional. Without it, search falls back to Fuse.js fuzzy matching only.

1. **Start Qdrant** from the project root using [compose.yaml](compose.yaml):

   ```bash
   docker compose up -d
   ```

   This starts `qdrant/qdrant:latest`, maps ports `6333` (HTTP API) and `6334` (gRPC), and bind-mounts persistent data:
   - `qdrant/storage` -> `/qdrant/storage`
   - `qdrant/snapshots` -> `/qdrant/snapshots`

2. **Set required env values** in `server/.env`:

   ```bash
   QDRANT_URL=http://localhost:6333
   OPENAI_API_KEY=sk-...
   ```

   Both must be present. If either is missing, vector search is disabled.

3. **Restart server indexing**:
   - On first run, embeddings are generated and indexed.
   - On next runs, only new messages are processed.
   - `SKIP_UPDATING_QDRANT` was renamed to `SKIP_STARTUP_UPDATING_QDRANT`.
   - Set `SKIP_STARTUP_UPDATING_QDRANT=true` to skip startup re-embedding.
   - Set `DO_NOT_USE_QDRANT=true` to disable Qdrant at runtime.

Stop Qdrant with `docker compose down`. Data remains in `qdrant/storage`.

> Read more: [Search architecture](server/zz-reach2/architecture/search/archi-search.md) | [Qdrant vector search](server/zz-reach2/architecture/search/archi-qdrant.md) | [AI summarization](server/zz-reach2/architecture/prose/archi-summarizer.md)

## Environment Variables

Create `server/.env` from [server/.env.example](server/.env.example).

| Variable                        | Default      | Description                                                |
| ------------------------------- | ------------ | ---------------------------------------------------------- |
| `IN_MEMORY_DB`                  | `false`      | Use in-memory SQLite instead of on-disk persistent storage |
| `QDRANT_URL`                    | —            | Qdrant endpoint (for example `http://localhost:6333`)      |
| `QDRANT_API_KEY`                | —            | Optional Qdrant API key                                    |
| `OPENAI_API_KEY`                | —            | OpenAI key for embeddings and AI topic summarization       |
| `QDRANT_MIN_SCORE`              | `0.6`        | Minimum semantic match threshold                           |
| `EMBEDDING_BATCH_DELAY_MS`      | `200`        | Delay between embedding batches (ms)                       |
| `SKIP_STARTUP_UPDATING_QDRANT`  | `false`      | Skip startup embedding update only                         |
| `DO_NOT_USE_QDRANT`             | `false`      | Disable Qdrant usage at runtime                            |
| `SKIP_AI_SUMMARIZATION`         | `true`       | Set `false` to enable startup summarization                |
| `AI_SUMMARIZATION_MODEL_PASS_1` | `gpt-5-nano` | Pass 1 summarization model                                 |
| `AI_SUMMARIZATION_MODEL_PASS_2` | `gpt-5-mini` | Pass 2 summarization model                                 |
| `FUSE_THRESHOLD`                | `0.4`        | Fuse.js fuzzy threshold                                    |
| `PORT`                          | `3210`       | HTTP port; retries PORT+1 through PORT+10 if busy          |
| `DISABLE_SEARCH_CACHE`          | `false`      | Disable search response cache                              |
| `MCP_ENABLED`                   | `true`       | Master switch for MCP startup (stdio + optional SSE)       |
| `MCP_SSE_ENABLED`               | `false`      | Enables MCP SSE endpoints on Express                       |
| `MCP_AUTH_TOKEN`                | —            | Optional bearer token for MCP SSE endpoints                |

## Visualizer

A Vite + React + D3 SPA is served from the same `:3210` origin. Cards render as a zoomable SVG map using `foreignObject` for rich HTML cards.

- **Score-sorted masonry layout**: highest relevance appears top-left.
- **4-tier LOD system**: card HTML only rebuilds when zoom crosses thresholds.
- **React owns state, D3 owns rendering**: bridged via `useChatMap` with ref-stabilized callbacks.
- **Multi-view workspace**: Search, Latest Chats, Favorites with localStorage persistence.
- **Search history autocomplete**: 100-entry FIFO with keyboard navigation.

> Read more: [Visualizer architecture](visualizer/zz-reach2/architecture/archi-context-core-visualizer.md) | [UI components](visualizer/zz-reach2/architecture/ui/archi-context-core-visualizer-ui.md)

### PWA / Standalone Window

The visualizer is installable as a Progressive Web App. Navigate to `localhost:3210` in Chrome or Edge and click the install icon in the address bar (or use the browser menu: "Install ContextCore Visualizer..."). The app opens in its own standalone window with no browser chrome.

- `localhost` is always a secure origin — no HTTPS certificates needed for local use.
- The service worker caches the app shell and recent API responses, so the UI loads instantly and remains usable during brief network interruptions.
- When a new version is deployed, a banner appears at the top of the app prompting you to reload.

## MCP Server

Context Core includes an MCP server that turns the conversation archive into live memory for MCP-capable LLMs.

### Transports

- **stdio** (default): clients spawn `bun run mcp` as a subprocess. Fast startup and no full ingestion required.
- **SSE** (opt-in with `MCP_SSE_ENABLED=true`): `GET /mcp/sse` + `POST /mcp/messages`, optional auth via `MCP_AUTH_TOKEN`.

### Tools (12)

| Category                | Tools                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------- |
| **Messages & Sessions** | `get_message`, `get_session`, `list_sessions`, `query_messages`, `get_latest_threads` |
| **Search**              | `search_messages`, `search_threads`, `search_thread_messages`, `search_by_symbol`     |
| **Topics**              | `get_topics`, `get_topic`, `set_topic`                                                |

### Resources And Prompts

- Resources: `cxc://stats`, `cxc://projects`, `cxc://harnesses`, `cxc://query-syntax`, `cxc://projects/{name}/sessions`
- Prompts: `explore_history`, `summarize_session`, `find_decisions`, `debug_history`

### Quick Config — VS Code (SSE)

To connect a remote VS Code workspace to a running ContextCore instance, add this to your project's `.vscode/mcp.json`:

```json
{
  "servers": {
    "context-core": {
      "type": "sse",
      "url": "http://localhost:3210/mcp/sse"
    }
  }
}
```

Requires `MCP_ENABLED=true` and `MCP_SSE_ENABLED=true` on the server. If `MCP_AUTH_TOKEN` is set, add a `headers` block:

```json
{
  "servers": {
    "context-core": {
      "type": "sse",
      "url": "http://localhost:3210/mcp/sse",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

> Full integration guide (Claude Code, Cursor, VS Code stdio + SSE): [MCP connection guide](server/zz-reach2/guides/mcp-connection-guide.md)
> Architecture deep-dive: [MCP server architecture](server/zz-reach2/architecture/mcp/archi-mcp.md)

## Multi-Machine Support

A single `cc.json` contains per-hostname harness paths. The server detects `COMPUTERNAME` / `os.hostname()` and loads the matching machine config.

## Agent Builder

The Agent Builder lets you create `.agent.md` files (GitHub Copilot / VS Code agent format) from your project's knowledge sources directly in the visualizer. It is configured via `dataSources` entries in `server/cc.json`, nested inside the machine block that matches your hostname.

### Configuration

Add a `dataSources` block to your machine entry in `cc.json`:

```json
{
  "machine": "MY-MACHINE",
  "harnesses": { "..." },
  "dataSources": {
    "zz-reach2": [
      {
        "path": "/home/me/my-project/docs",
        "agentPath": "/home/me/my-project/.github/agents",
        "name": "My Project Docs",
        "type": "Reach2 Architectural Repo",
        "purpose": "AgentBuilder"
      }
    ]
  }
}
```

### Field Reference

| Field       | Required | Description                                                                                                                                                      |
| ----------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`      | yes      | Root directory to index. All files under this path (recursively) appear as selectable knowledge sources in the Agent Builder view. This is **what data shows up**. |
| `agentPath` | no       | Directory where created `.agent.md` and `.agent.json` files are saved. Omit if this source is content-only and agents should not be written from it.              |
| `name`      | yes      | Human-readable label shown in the visualizer's project dropdown. Also used as the filter key when preparing file listings.                                        |
| `type`      | yes      | Informational tag describing the source kind (e.g. `"Reach2 Architectural Repo"`). Not used for filtering.                                                       |
| `purpose`   | yes      | Must be `"AgentBuilder"` for the source to be indexed. Entries with any other value are ignored.                                                                  |

### How It Works

- **`path`** controls what shows up in the Agent Builder view. Point it at a directory containing documentation, architecture notes, or any files you want available as agent knowledge. The indexer recursively walks the directory, skipping `.git/` and `node_modules/`.
- **`agentPath`** controls where agents are saved. When you create an agent in the visualizer, the resulting `.agent.md` and `.agent.json` files are written to this directory. Multiple data sources can share the same `agentPath` — the indexer deduplicates by absolute path.
- If no `dataSources` entries with `purpose: "AgentBuilder"` exist for the current machine, the Agent Builder feature is disabled and its endpoints return 404.

### Example: Two Sources, One Agent Directory

A common pattern is indexing both backend and frontend docs while saving all agents to a shared `.github/agents/` directory:

```json
"dataSources": {
  "zz-reach2": [
    {
      "path": "/project/server/docs",
      "agentPath": "/project/.github/agents",
      "name": "Backend Docs",
      "type": "Reach2 Architectural Repo",
      "purpose": "AgentBuilder"
    },
    {
      "path": "/project/frontend/docs",
      "agentPath": "/project/.github/agents",
      "name": "Frontend Docs",
      "type": "Reach2 Architectural Repo",
      "purpose": "AgentBuilder"
    }
  ]
}
```

Both sources appear in the visualizer. Files from each are labeled by their `name`. Created agents land in the shared `.github/agents/` directory.

> Read more: [Agent Builder architecture](server/zz-reach2/architecture/agents/archi-agent-builder.md) | [Agent Builder UI](visualizer/zz-reach2/architecture/agents/archi-agent-builder-ui.md)

## Setup Wizard

`bun run setup` launches an interactive CLI that discovers IDE chat sources (Windows, Linux, Darwin), proposes storage, supports harness-by-harness confirmation, and writes/merges `cc.json` safely.

## Architecture

### Ingestion Pipeline

On startup, the server reads five harness formats:

- **Claude Code**: `.jsonl` with `tool_use_id` correlation.
- **Cursor**: SQLite `state.vscdb` (`bubbleId:*`, `composerData:*`) with project mapping.
- **Kiro**: `.chat` JSON with `metadata.modelId` extraction and system-prompt filtering.
- **VS Code**: `.json` + `.jsonl` incremental reconstruction (`setByPath` / `appendByPath`).
- **OpenCode**: SQLite `opencode.db` with step rows consolidated by `parentID`.

All records normalize into a 19-field `AgentMessage` with deterministic SHA-256-based IDs for dedupe.

### Storage (Two-Tier)

1. **Tier 1 (disk JSON)**: `{storage}/{machine}/{harness}/{project}/{YYYY-MM}/` as source of truth, with raw archives under `{machine}-RAW/`.
2. **Tier 2 (SQLite)**: on-disk (WAL) by default or in-memory via `IN_MEMORY_DB=true`, with indexed query runtime.

`FileWatcher` + `IncrementalPipeline` keep both tiers updated in near real time.

### API

Express REST API on `:3210` exposes session/message retrieval, filtered pagination, hybrid search, thread aggregation, project discovery, and topic management.

> Read more: [System architecture](server/zz-reach2/architecture/archi-context-core-level0.md) | [Harness readers](server/zz-reach2/architecture/harness/archi-harness.md) | [Database architecture](server/zz-reach2/architecture/data/archi-database.md) | [File watcher](server/zz-reach2/architecture/data/archi-file-watcher.md)

### Architecture Docs Index

Recommended reading path:

1. System foundation (what the platform is and how it runs)
- [server/zz-reach2/architecture/archi-context-core-level0.md](server/zz-reach2/architecture/archi-context-core-level0.md): Top-level backend architecture, runtime flow, module map, and API surface.

2. Ingestion and storage (how data gets in and stays consistent)
- [server/zz-reach2/architecture/harness/archi-harness.md](server/zz-reach2/architecture/harness/archi-harness.md): Harness ingestion internals for Claude Code, Cursor, Kiro, VS Code, and OpenCode.
- [server/zz-reach2/architecture/data/archi-database.md](server/zz-reach2/architecture/data/archi-database.md): Two-tier storage and SQLite query-runtime design, indexing, and persistence model.
- [server/zz-reach2/architecture/data/archi-file-watcher.md](server/zz-reach2/architecture/data/archi-file-watcher.md): Live-ingestion watcher architecture, debounce/queue behavior, and incremental updates.

3. Retrieval and memory intelligence (how context is found and shaped)
- [server/zz-reach2/architecture/search/archi-search.md](server/zz-reach2/architecture/search/archi-search.md): Search pipeline architecture for lexical retrieval, scoring, and thread aggregation.
- [server/zz-reach2/architecture/search/archi-qdrant.md](server/zz-reach2/architecture/search/archi-qdrant.md): Semantic search integration with Qdrant, embeddings, and hybrid merge behavior.
- [server/zz-reach2/architecture/prose/archi-summarizer.md](server/zz-reach2/architecture/prose/archi-summarizer.md): AI topic summarization architecture, two-pass pipeline, and custom topic precedence.

4. Agent and protocol surfaces (how external tools and builders use the system)
- [server/zz-reach2/architecture/mcp/archi-mcp.md](server/zz-reach2/architecture/mcp/archi-mcp.md): MCP server architecture, transports (stdio/SSE), tools, resources, and prompts.
- [server/zz-reach2/architecture/agents/archi-agent-builder.md](server/zz-reach2/architecture/agents/archi-agent-builder.md): Backend agent-builder architecture for generating agent packs from context.

5. Visualizer experience layer (how users explore and act on context)
- [visualizer/zz-reach2/architecture/archi-context-core-visualizer.md](visualizer/zz-reach2/architecture/archi-context-core-visualizer.md): Visualizer system architecture (React + D3 split, rendering engine, and data flow).
- [visualizer/zz-reach2/architecture/ui/archi-context-core-ui.md](visualizer/zz-reach2/architecture/ui/archi-context-core-ui.md): UI components and hooks architecture, view state, modal flows, and localStorage contracts.
- [visualizer/zz-reach2/architecture/ui/archi-search-ui.md](visualizer/zz-reach2/architecture/ui/archi-search-ui.md): Search UI architecture for query flow, controls, and interaction behavior.
- [visualizer/zz-reach2/architecture/agents/archi-agent-builder-ui.md](visualizer/zz-reach2/architecture/agents/archi-agent-builder-ui.md): Agent Builder UI architecture, screens, and interaction flow.

6. Technical debt and future improvements
- [server/zz-reach2/architecture/techDebt/td-memory-optimization.md](server/zz-reach2/architecture/techDebt/td-memory-optimization.md): Memory-optimization technical debt analysis and proposed improvements.

See [server/README.md](server/README.md) for complete backend configuration and API details.
