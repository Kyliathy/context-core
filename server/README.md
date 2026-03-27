# Context Master

**Context Master** aggregates AI chatbot conversation histories from multiple IDEs into one place. It reads chat data from Claude Code, Cursor, Kiro, OpenCode, and VS Code, using a machine-specific config so the same project can be synced across computers and each machine loads its own paths.

## How It Works

1. **Config (`cc.json`)** – Defines per-machine harness paths. Each machine entry has a hostname and paths for each supported IDE.
2. **Hostname detection** – On startup, the app detects the current machine (Windows: `COMPUTERNAME`, else `os.hostname()`) and selects the matching config.
3. **Harness readers** – Each IDE has a reader that knows where and how to find chat history:
   - **ClaudeCode** – JSON/JSONL in `.claude/projects/<project>/`
   - **Cursor** – SQLite `state.vscdb` (ItemTable + bubble records)
   - **Kiro** – JSON `.chat` files in `kiro.kiroagent/<hash>/`
   - **OpenCode** – SQLite `opencode.db` (session/message/part tables, step-based consolidation)
   - **VSCode** – JSON/JSONL in `workspaceStorage/<hash>/chatSessions/`
4. **Normalization** – All messages are converted to a unified `AgentMessage` model with 19 fields (role, model, message, context, symbols, etc.)
5. **Storage** – Sessions are persisted as JSON files in `{storage}/{machine}/{harness}/{project}/{YYYY-MM}/`
6. **Query Runtime** – Messages are loaded into an in-memory SQLite database and exposed via REST API on `localhost:3210`

## Features

### Hybrid Search

The `/api/search` endpoint combines two search engines:

- **Fuse.js** (lexical) – Fuzzy text matching on message content, subjects, symbols, tags, and context with weighted scoring
- **Qdrant** (semantic, optional) – Vector similarity search using OpenAI `text-embedding-3-large` embeddings (3072 dimensions)

When both are enabled, results are merged with **weighted scoring: 75% semantic, 25% lexical**. This means a message matching on *meaning* ranks higher than one matching only on keywords.

### File-Based Caching

Source files are cached by comparing size and modification time. Unchanged files are skipped entirely on subsequent runs, making re-ingestion fast even for large chat histories.

### AI Topic Summaries + Custom Topic Overrides

ContextCore generates AI summaries per session via a **two-pass pipeline** at startup and stores them in `{storage}/.settings/topics.json` (isolated from `{machine}/` message storage so processed messages can be wiped and regenerated without losing summaries).

- **Pass 1** (`gpt-5-nano` by default) — Summarizes every session that has no summary yet. Builds a condensed context from conversation messages (first-2/last-2 chunks of assistant messages, code blocks truncated, 150K char budget with 50K tail guarantee).
- **Pass 2** (`gpt-5-mini` by default) — Finds pass 1 results exceeding 1500 characters and tightens them. Summaries under 3000 chars are condensed directly; longer ones trigger a full context rebuild.

Both passes are fully **idempotent** — re-running the pipeline produces no redundant API calls. Live ingestion (via `FileWatcher`) performs pass 1 summarization for newly ingested sessions in real-time; pass 2 only runs at startup.

The API resolves session subject using:

`customTopic` (if non-empty) → `aiSummary` (if non-empty) → original NLP `subject`.

You can set or clear a custom topic with `POST /api/topics` using `{ sessionId, customTopic }`. Custom topics take absolute priority and are never overwritten by the summarization pipeline.

### MCP Server

ContextCore exposes its conversation archive to MCP-capable LLMs via the [Model Context Protocol](https://modelcontextprotocol.io/). The MCP server runs inside the same Bun process, sharing the message database and TopicStore directly.

**Two entry points:**

| Entry Point          | Command         | What Starts                                                                |
| -------------------- | --------------- | -------------------------------------------------------------------------- |
| `src/ContextCore.ts` | `bun run start` | Full pipeline: ingest + Express API + MCP stdio (+ optional MCP SSE)       |
| `src/mcp/serve.ts`   | `bun run mcp`   | Lightweight: load from storage + MCP stdio only (no ingestion, no Express) |

**Dual transport:**
- **stdio** — MCP client spawns `bun run mcp` as a child process. JSON-RPC over stdin/stdout.
- **SSE** (opt-in) — `GET /mcp/sse` establishes a Server-Sent Events stream; `POST /mcp/messages?sessionId=X` sends messages back. Optional bearer token auth via `MCP_AUTH_TOKEN`.

**Available capabilities:**

| Category  | Count | Examples                                                                                                      |
| --------- | ----- | ------------------------------------------------------------------------------------------------------------- |
| Tools     | 11+   | `search_messages`, `search_threads`, `search_by_symbol`, `get_session`, `set_topic`, `get_developer_timeline` |
| Resources | 4     | `cxc://stats`, `cxc://projects`, `cxc://harnesses`, `cxc://projects/{name}/sessions`                          |
| Prompts   | 4     | `explore_history`, `summarize_session`, `find_decisions`, `debug_history`                                     |

See the [MCP architecture doc](zz-reach2/architecture/mcp/archi-mcp.md) for the full tool/resource/prompt reference.

### D3 Visualizer

A React + D3.js web interface for exploring conversations with:
- Interactive force-directed graph visualization
- Multi-view workspace (Latest, Favorites, custom views)
- Session timeline and message cards
- Search history and filters

## Setup

### Prerequisites

- [Bun](https://bun.sh/) (v1.0+). Install: `powershell -c "irm bun.sh/install.ps1 | iex"`

### Install

```bash
bun install
```

### Configure `cc.json`

Add one entry per machine. Use your computer’s hostname so the right config is chosen:

```bash
# Windows (PowerShell)
$env:COMPUTERNAME

# macOS / Linux
hostname
```

Example `cc.json`:

```json
{
  "storage": "D:\\Projects\\ChatHistory",
  "machines": [
    {
      "machine": "DESKTOP-PC",
      "harnesses": {
        "ClaudeCode": {
          "path": ["C:\\Users\\YourName\\.claude\\projects"]
        },
        "Cursor": {
          "path": "C:\\Users\\YourName\\AppData\\Roaming\\Cursor\\User\\globalStorage\\state.vscdb"
        },
        "Kiro": {
          "path": ["C:\\Users\\YourName\\AppData\\Roaming\\Kiro\\kiro.kiroagent"]
        },
        "OpenCode": {
          "path": "C:\\Users\\YourName\\.opencode"
        },
        "VSCode": {
          "path": ["C:\\Users\\YourName\\AppData\\Roaming\\Code\\User\\workspaceStorage"]
        }
      }
    },
    {
      "machine": "LAPTOP",
      "harnesses": {
        "ClaudeCode": {
          "path": ["C:\\Users\\YourName\\.claude\\projects"]
        },
        "Cursor": {
          "path": "C:\\Users\\YourName\\AppData\\Roaming\\Cursor\\User\\globalStorage\\state.vscdb"
        }
      }
    }
  ]
}
```

- `path` can be a single string or an array of strings.
- Cursor uses a single SQLite file; OpenCode uses a directory containing `opencode.db`; all others use directory paths.

### Project Mapping Rules

Some harnesses (Cursor, Kiro, OpenCode) don't always store clear project names in their chat data. Project mapping rules tell ContextCore how to extract meaningful project names from workspace paths.

#### Rule Types

**1. Explicit Rules (`projectMappingRules`)** - Direct path-to-project mapping:

```json
"Cursor": {
  "path": "C:\\Users\\YourName\\AppData\\Roaming\\Cursor\\User\\globalStorage\\state.vscdb",
  "projectMappingRules": [
    {
      "path": "C:\\Dev\\my-company\\legacy-backend",
      "newPath": "LegacyAPI"
    },
    {
      "path": "C:\\Dev\\personal\\side-project",
      "newPath": "SideProject"
    }
  ]
}
```

When a conversation's workspace path contains `C:\Dev\my-company\legacy-backend`, the project is labeled as `LegacyAPI`.

**2. Generic Rules (`genericProjectMappingRules`)** - Pattern-based extraction:

```json
"Kiro": {
  "path": ["C:\\Users\\YourName\\AppData\\Roaming\\Kiro\\kiro.kiroagent"],
  "genericProjectMappingRules": [
    {
      "path": "C:\\Dev\\projects",
      "rule": "byFirstDir"
    }
  ]
}
```

The `byFirstDir` rule extracts the first directory after the matched prefix:
- `C:\Dev\projects\my-api\src` → project: `my-api`
- `C:\Dev\projects\web-app\components` → project: `web-app`

This is useful for monorepo-style layouts where the first child folder represents the project boundary.

#### Fallback Behavior

If no rules match, the conversation is labeled as `MISC`.

#### Rule Priority

Rules are evaluated in this order:
1. **Explicit rules** (`projectMappingRules`) - checked first
2. **Generic rules** (`genericProjectMappingRules`) - checked if no explicit match
3. **Fallback** - `MISC` if nothing matches

#### Full Example

```json
{
  "storage": "D:\\ChatHistory\\CXC",
  "machines": [
    {
      "machine": "DESKTOP-PC",
      "harnesses": {
        "ClaudeCode": {
          "path": ["C:\\Users\\YourName\\.claude\\projects"]
        },
        "Cursor": {
          "path": "C:\\Users\\YourName\\AppData\\Roaming\\Cursor\\User\\globalStorage\\state.vscdb",
          "projectMappingRules": [
            { "path": "C:\\work\\client-portal", "newPath": "ClientPortal" },
            { "path": "C:\\work\\admin-dashboard", "newPath": "AdminDashboard" }
          ],
          "genericProjectMappingRules": [
            { "path": "C:\\Dev", "rule": "byFirstDir" }
          ]
        },
        "Kiro": {
          "path": ["C:\\Users\\YourName\\AppData\\Roaming\\Kiro\\kiro.kiroagent"],
          "genericProjectMappingRules": [
            { "path": "C:\\Dev", "rule": "byFirstDir" }
          ]
        },
        "VSCode": {
          "path": ["C:\\Users\\YourName\\AppData\\Roaming\\Code\\User\\workspaceStorage"]
        }
      }
    }
  ]
}
```

**Note:** ClaudeCode and VSCode extract project names directly from their workspace metadata and typically don't need mapping rules. OpenCode derives project names from the session's working directory.

### Environment Variables

Create a `.env` file in the project root to configure optional features. See [`.env.example`](.env.example) for a template.

#### Database Mode

| Variable       | Default | Description                                                                 |
| -------------- | ------- | --------------------------------------------------------------------------- |
| `IN_MEMORY_DB` | `false` | Set to `true` to use in-memory SQLite instead of on-disk persistent storage |

#### Vector Search (Optional)

Enable semantic search alongside fuzzy text search using Qdrant + OpenAI embeddings:

| Variable         | Required                        | Default | Description                                                                                 |
| ---------------- | ------------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| `QDRANT_URL`     | For vector search               | —       | Qdrant server endpoint (e.g., `http://localhost:6333`)                                      |
| `QDRANT_API_KEY` | No                              | —       | Optional Qdrant authentication key                                                          |
| `OPENAI_API_KEY` | For vector search and AI topics | —       | OpenAI API key for `text-embedding-3-large` embeddings and `gpt-5-nano` topic summarization |

**Both `QDRANT_URL` and `OPENAI_API_KEY` must be set to enable vector search.** If only one is present, a warning is logged and vector search is disabled.

#### Vector Search Tuning

`SKIP_UPDATING_QDRANT` was renamed to `SKIP_STARTUP_UPDATING_QDRANT`.

| Variable                       | Default | Description                                                                                                     |
| ------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------- |
| `QDRANT_MIN_SCORE`             | `0.6`   | Minimum cosine similarity threshold for Qdrant results (0.0-1.0). Higher = stricter semantic matching.          |
| `EMBEDDING_BATCH_DELAY_MS`     | `200`   | Delay in milliseconds between embedding API batches for rate limiting.                                          |
| `SKIP_STARTUP_UPDATING_QDRANT` | `false` | Skip only the startup embedding pipeline. Set to `true` to use existing Qdrant index without bulk re-embedding. |
| `DO_NOT_USE_QDRANT`            | `false` | Fully disable Qdrant usage at runtime (no vector init, no semantic search).                                     |

#### AI Summarization

| Variable                        | Default      | Description                                                                  |
| ------------------------------- | ------------ | ---------------------------------------------------------------------------- |
| `SKIP_AI_SUMMARIZATION`         | `true`       | Master switch. Set to `false` to enable both summarization passes at startup |
| `AI_SUMMARIZATION_MODEL_PASS_1` | `gpt-5-nano` | Model for initial bulk summarization (pass 1)                                |
| `AI_SUMMARIZATION_MODEL_PASS_2` | `gpt-5-mini` | Model for verbose summary tightening (pass 2)                                |

#### Search Configuration

| Variable               | Default | Description                                                                                                                                                      |
| ---------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FUSE_THRESHOLD`       | `0.4`   | Fuse.js fuzzy search threshold (0.0 = exact match, 1.0 = match anything). Lower = stricter. The default (0.4) is stricter than Fuse.js's built-in default (0.6). |
| `DISABLE_SEARCH_CACHE` | `false` | Disable the daily search response cache. Set to `true` for debugging to force fresh results on every query.                                                      |

#### MCP Configuration

| Variable          | Default | Description                                                                                           |
| ----------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `MCP_ENABLED`     | `true`  | Master switch for MCP startup. When `false`, MCP stdio and MCP SSE are both disabled.                 |
| `MCP_SSE_ENABLED` | `false` | Controls only the HTTP/SSE transport (`/mcp/sse`, `/mcp/messages`). Ignored when `MCP_ENABLED=false`. |
| `MCP_AUTH_TOKEN`  | —       | Optional bearer token for SSE routes. When set, clients must send `Authorization: Bearer <token>`.    |

`MCP_SSE_ENABLED` defaults to `false`, so SSE is not mounted unless explicitly enabled.

#### Example `.env`

```bash
# Database mode
IN_MEMORY_DB=false

# Enable vector search
QDRANT_URL=http://localhost:6333
OPENAI_API_KEY=sk-...

# Tune search behavior
QDRANT_MIN_SCORE=0.7          # Only high-confidence semantic matches
SKIP_STARTUP_UPDATING_QDRANT=false
DO_NOT_USE_QDRANT=false
FUSE_THRESHOLD=0.3            # Stricter fuzzy matching
DISABLE_SEARCH_CACHE=true     # Force fresh results (debugging)

# AI summarization (disabled by default)
SKIP_AI_SUMMARIZATION=false
AI_SUMMARIZATION_MODEL_PASS_1=gpt-5-nano
AI_SUMMARIZATION_MODEL_PASS_2=gpt-5-mini

# MCP transport controls
MCP_ENABLED=true
MCP_SSE_ENABLED=false
# MCP_AUTH_TOKEN=change-me
```

### Run

```bash
bun run dev
```

The server starts on `localhost:3210`. The web visualizer is available at `http://localhost:3210/visualizer/`.

## API Reference

All endpoints return JSON. The API is mostly read-oriented, with one write endpoint for custom topic updates.

| Endpoint                            | Method | Description                                    |
| ----------------------------------- | ------ | ---------------------------------------------- |
| `GET /api/messages/:id`             | GET    | Single message by ID                           |
| `GET /api/sessions/:sessionId`      | GET    | All messages in a session (time-ordered)       |
| `GET /api/sessions`                 | GET    | Session summaries (count, date range, harness) |
| `GET /api/messages`                 | GET    | Filtered message listing with pagination       |
| `GET /api/search?q=query`           | GET    | Hybrid search (Fuse.js + optional Qdrant)      |
| `GET /api/search/threads?q=query`   | GET    | Thread-level search (aggregated by session)    |
| `GET /api/threads/latest?limit=100` | GET    | Latest threads by activity                     |
| `GET /api/topics`                   | GET    | List topic entries (AI + custom)               |
| `GET /api/topics/:sessionId`        | GET    | Get one topic entry by session                 |
| `POST /api/topics`                  | POST   | Set or clear `customTopic` for a session       |

### Custom Topic Request (`POST /api/topics`)

```json
{
  "sessionId": "replace-with-session-id",
  "customTopic": "My custom thread title"
}
```

Set `customTopic` to `""` to clear the custom override.

### Search Query Parameters

| Parameter | Type   | Description             |
| --------- | ------ | ----------------------- |
| `q`       | string | Search query (required) |

### Filter Parameters (for `/api/messages`)

| Parameter  | Type     | Description                                                             |
| ---------- | -------- | ----------------------------------------------------------------------- |
| `role`     | string   | Filter by role: `user`, `assistant`, `tool`, `system`                   |
| `harness`  | string   | Filter by harness: `ClaudeCode`, `Cursor`, `Kiro`, `OpenCode`, `VSCode` |
| `model`    | string   | Filter by AI model (e.g., `claude-sonnet-4-5`)                          |
| `project`  | string   | Filter by project name                                                  |
| `from`     | ISO date | Start date (inclusive)                                                  |
| `to`       | ISO date | End date (inclusive)                                                    |
| `page`     | number   | Page number (1-indexed, default: 1)                                     |
| `pageSize` | number   | Results per page (default: 50, max: 500)                                |

### Search Response Format

```json
{
  "results": [
    {
      "id": "a1b2c3d4",
      "message": "How do I handle JWT authentication?",
      "harness": "ClaudeCode",
      "model": "claude-opus-4-6",
      "qdrantScore": 0.847,
      "fuseScore": 0.32,
      "combinedScore": 0.805,
      "...": "...19 total fields..."
    }
  ],
  "query": "authentication",
  "engine": "hybrid",
  "totalFuseResults": 12,
  "totalQdrantResults": 8
}
```

**Engine values:**
- `"hybrid"` – Both Fuse.js and Qdrant returned results
- `"fuse"` – Only Fuse.js (Qdrant disabled or no matches)
- `"qdrant"` – Only Qdrant (Fuse.js returned nothing)

## Project Structure

```
context-core/
├── cc.json
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── ContextCore.ts              # Main entry point (full pipeline)
    ├── ContextMaster.ts            # Legacy entry point
    ├── config.ts                   # Config loading + hostname detection
    ├── setup.ts                    # First-run setup utility
    ├── types.ts                    # Shared types (HarnessConfig, ToolCall, etc.)
    ├── agentBuilder/
    │   └── AgentBuilder.ts
    ├── analysis/
    │   ├── SubjectGenerator.ts     # NLP subject extraction (winkNLP)
    │   ├── TopicContextBuilder.ts  # Context assembly for AI summarization
    │   └── TopicSummarizer.ts      # Two-pass AI summarization pipeline
    ├── cache/
    │   └── ResponseCache.ts        # Daily search response cache
    ├── db/
    │   ├── IMessageStore.ts        # Store interface + factory
    │   ├── BaseMessageStore.ts     # Shared SQLite schema + queries
    │   ├── InMemoryMessageStore.ts # In-memory SQLite store
    │   └── DiskMessageStore.ts     # On-disk persistent SQLite store
    ├── harness/
    │   ├── index.ts                # Harness registry + dispatch
    │   ├── claude.ts               # ClaudeCode reader
    │   ├── cursor.ts               # Cursor reader
    │   ├── kiro.ts                 # Kiro reader
    │   ├── opencode.ts             # OpenCode reader (SQLite DB)
    │   └── vscode.ts               # VS Code reader
    ├── mcp/
    │   ├── MCPServer.ts            # Wraps MCP SDK Server (stdio transport)
    │   ├── serve.ts                # Standalone MCP entry point (no Express)
    │   ├── registry.ts             # Registers tools, resources, prompts
    │   ├── formatters.ts           # LLM-friendly text formatters
    │   ├── tools/                  # MCP tool handlers
    │   ├── resources/              # MCP resource handlers
    │   ├── prompts/                # MCP prompt handlers
    │   ├── transports/             # SSE transport manager
    │   └── tests/                  # MCP integration tests
    ├── models/
    │   ├── AgentMessage.ts         # Core message model (19+ fields)
    │   ├── AgentMessageFound.ts    # Search result wrapper
    │   ├── AgentThread.ts          # Thread aggregation model
    │   ├── SearchResults.ts        # Search response model
    │   └── TopicEntry.ts           # AI summary + custom topic entry
    ├── search/
    │   ├── queryParser.ts          # Search query syntax parser
    │   ├── searchEngine.ts         # Fuse.js search index
    │   └── threadAggregator.ts     # Thread-level search aggregation
    ├── server/
    │   └── ContextServer.ts        # Express REST API
    ├── settings/
    │   ├── CCSettings.ts           # Environment + runtime settings
    │   ├── CMSettings.ts           # Legacy settings
    │   └── TopicStore.ts           # AI summary persistence (topics.json)
    ├── storage/
    │   └── StorageWriter.ts        # JSON session file writer
    ├── utils/
    │   ├── hashId.ts               # Deterministic ID generation
    │   ├── pathHelpers.ts          # Path utilities
    │   └── rawCopier.ts            # Raw source data archiver
    ├── vector/
    │   ├── Chunker.ts              # Text chunking (code vs prose)
    │   ├── ContentClassifier.ts    # Content type detection
    │   ├── EmbeddingService.ts     # OpenAI embedding client
    │   ├── QdrantService.ts        # Qdrant vector DB client
    │   ├── VectorConfig.ts         # Vector pipeline configuration
    │   └── VectorPipeline.ts       # Embedding orchestration
    └── watcher/
        ├── FileWatcher.ts          # File-system change detection
        └── IncrementalPipeline.ts  # Live ingestion pipeline
```

## Multi-Machine Sync

Sync the project (e.g. via Dropbox, OneDrive, or git) and add a `machines` entry for each computer. Each machine will load only its own paths when the hostname matches.

## Dependencies

### Core
- **Bun** – Runtime with built-in TypeScript, ESM, and `bun:sqlite`
- **Express** – REST API server
- **Fuse.js** – Fuzzy text search
- **Luxon** – DateTime handling
- **chalk** – Terminal coloring
- **uuid** – ID generation
- **winkNLP** – NLP for subject generation (verb/symbol extraction)

### MCP
- **@modelcontextprotocol/sdk** – MCP server SDK (stdio + SSE transports)

### Vector Search & AI Summarization (Optional)
- **@qdrant/js-client-rest** – Qdrant vector database client
- **ai** + **@ai-sdk/openai** – Vercel AI SDK for OpenAI embeddings and AI summarization
- **@langchain/textsplitters** – Intelligent text chunking (code vs prose)

### Development
- **TypeScript** – Type checking with strict mode
- **Chalk** – Colored console output
