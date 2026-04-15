# ContextCore — The Complete Guide

> **Your AI conversations are a goldmine of decisions, context, and institutional knowledge.
> ContextCore captures them all — across every IDE, every model, every machine — and turns them into a searchable, queryable, composable memory layer for developers and their AI assistants.**

---

## What Is ContextCore?

ContextCore is a full-stack platform that **ingests, indexes, searches, visualizes, and exposes** your entire AI chat history from multiple IDE assistants. Whether you're pair-programming with Claude in the terminal, iterating with Cursor in your editor, prototyping with Kiro, or chatting with GitHub Copilot in VS Code — every conversation you have with an AI is captured, normalized into a unified format, and made available through a rich set of interfaces.

At its core, ContextCore solves a fundamental problem: **AI conversations are ephemeral by default.** You have a brilliant debugging session with Claude at 2 AM, make critical architectural decisions with Copilot during a sprint, or work through a complex refactor with Cursor over multiple days — and all of that context evaporates when you close the tab. ContextCore makes it permanent, searchable, and reusable.

But storage alone isn't the vision. ContextCore is designed as a **memory layer for AI-assisted development** — a system where both humans and AI agents can look back at what was discussed, what was decided, and what was tried before. Through the MCP (Model Context Protocol) server, any MCP-capable LLM can directly search your conversation archive, retrieve past session transcripts, and build on prior reasoning. Your next AI assistant doesn't start from zero — it starts from everything you've already discussed.

---

## The Six Pillars

### 1. Multi-Harness Ingestion

ContextCore reads chat history from **five IDE assistants**, each with its own storage format, and normalizes everything into a single unified data model:

| Harness               | Source Format                    | Storage Location                        |
| --------------------- | -------------------------------- | --------------------------------------- |
| **Claude Code**       | JSONL event streams              | `~/.claude/projects/<project>/`         |
| **Cursor**            | SQLite database (`state.vscdb`)  | Cursor's `globalStorage/` directory     |
| **Kiro**              | JSON `.chat` files               | `kiro.kiroagent/<hash>/`                |
| **VS Code / Copilot** | JSON + incremental JSONL patches | `workspaceStorage/<hash>/chatSessions/` |
| **OpenCode**          | SQLite database (`opencode.db`)  | `~/.local/share/opencode/`              |

Each harness has a dedicated reader that understands the quirks of its IDE's data format. Claude Code stores conversations as line-delimited JSON events that need tool-result correlation. Cursor embeds everything in a single SQLite database with bubble records and session model maps. Kiro uses clean JSON with identity tags for system prompts. VS Code Copilot has a dual-format system where older sessions are self-contained JSON files and newer ones use incremental JSONL patches with set/append operations that must be replayed to reconstruct the conversation. OpenCode uses a step-based SQLite schema where one user prompt produces multiple assistant `message` rows (one per tool-call cycle), all linked by `parentID` — the harness consolidates these into a single response per turn.

Despite these differences, every message from every harness is normalized into the same 19-field `AgentMessage` model. This means downstream systems — the database, the search engine, the API, the visualizer, and the MCP server — are completely format-agnostic. A search for "authentication" returns results from Claude Code, Cursor, Kiro, VS Code, and OpenCode sessions equally, ranked by relevance regardless of origin.

The ingestion pipeline is **incremental and idempotent**. Source files are cached by comparing size and modification time against archived copies. Unchanged files are skipped entirely on subsequent runs, making re-ingestion fast even for large histories. Message identity is deterministic — a SHA-256 hash of `sessionId | role | timestamp | messagePrefix` produces a stable 16-character hex ID. Re-running the pipeline never produces duplicates.

### 2. Hybrid Search

Finding the right conversation in a sea of thousands is where ContextCore truly shines. The search system combines two complementary engines, three filtering dimensions, and an intelligent scoring pipeline that adapts to what you're looking for.

**Fuse.js Lexical Search** — A fuzzy text search engine that matches on message content (weighted 3×), subjects and symbols (weighted 2×), and file context (weighted 1×). It supports an advanced query syntax:

- Simple fuzzy: `authentication` — finds messages that approximately match the term
- Exact phrase: `"error handling"` — case-insensitive substring match, no fuzzy tolerance
- OR queries: `auth token` — matches messages containing either term, composite scoring blends match quality (60%) with match breadth (40%)
- AND queries: `JWT + refresh` — only messages containing both terms survive, with sequential filtering for fast early exits
- Mixed: `"tile info" + render` — exact phrase AND fuzzy term in the same query

**Qdrant Semantic Vector Search** (optional) — When enabled, messages are embedded using OpenAI's `text-embedding-3-large` model (3072 dimensions) and stored in a Qdrant vector database. Semantic search finds messages by *meaning*, not just keywords. A search for "how to handle user login" will surface conversations about authentication flows even if those exact words never appeared.

Qdrant uses **subject-aware dual-channel routing**: queries are routed to both `chunk` (message content) and `summary` (session-level topic) vector channels, while subject-only searches target only the `summary` channel — because session topics live in summaries, not scattered across message chunks. When symbols are specified, Qdrant payload filters narrow results at the vector DB level before they reach the application layer.

When both engines are active, results are **merged with balanced 50/50 scoring**: 50% semantic similarity from Qdrant, 50% inverted Fuse.js score. This equal weighting gives semantic meaning and lexical precision fair representation. Messages found by both engines get the combined score; single-engine hits keep their individual score. When Qdrant is absent, the Fuse score occupies the full 0–1 range — no score compression.

**Field-Targeted Filtering** — Beyond full-text search, results can be narrowed by two metadata dimensions:

- **Symbols** — case-insensitive substring match against the message's extracted code symbols array (functions, classes, variables). Search for `HexGrid` and find every conversation that touched that class.
- **Subject** — case-insensitive substring match against the AI-generated conversation subject. Search for `tile rendering` and find every thread about that topic.

Field filters can be combined with full-text queries (applied post-search, preserving relevance scores) or used standalone in **field-only mode** — where the system starts from all messages, applies filters, and computes relevance scores based on match precision (60%) and recency boost (40%) rather than assigning a flat score.

Search operates at two levels:
- **Message-level** (`POST /api/messages`) — individual chat turns ranked by relevance, with optional project scoping, date-range filtering, and field-targeted filtering
- **Thread-level** (`POST /api/threads`) — entire conversation sessions, deduplicated and ranked by their best-matching message, with configurable result limits

**Hit counting** tracks total term occurrences per message, surfaced in the visualizer as gradient intensity bars on cards — so you can visually spot the most relevant results at a glance.

Results are cached daily on disk with content-hash filenames for fast repeat queries. The latest-threads endpoint uses a 5-minute TTL since results change as new conversations arrive. POST requests with project filters are never cached to ensure scoped searches always return fresh results.

### 3. Interactive Visualization

The ContextCore Visualizer is a standalone React + D3.js single-page application that renders your conversation history as a **zoomable 2D card map**. It's not a list view — it's an explorable landscape where each card is a conversation or message, positioned in a masonry grid sorted by relevance score.

**Progressive Web App (PWA)** — The visualizer is installable as a standalone desktop app. Navigate to `localhost:3210` in Chrome or Edge and click the install icon in the address bar. The app opens in its own window with no browser chrome, dark `#0a0a0f` title bar, and the ContextCore icon in the taskbar — indistinguishable from a native application. `localhost` is always a secure origin, so no HTTPS certificates are needed. The service worker caches the app shell (HTML, JS, CSS) at build time and runtime API responses with configurable strategies: `NetworkFirst` for search and session data, `StaleWhileRevalidate` for the project list. When a new build is deployed, a banner appears prompting the user to reload — no silent mid-session updates.

The architecture maintains a strict separation: React owns state and UI chrome; D3 owns the SVG viewport, zoom/pan behavior, and high-frequency pointer interactions. A thin hook (`useChatMap`) bridges the two runtimes. Data flows down from React to D3; events flow up through callbacks. Neither runtime reads the other's internal state.

**Multi-View Workspace** — The visualizer supports multiple persistent views, each targeting a different data source:

- **Latest Threads** — Most recent conversations by last activity
- **Search Messages** — Full-text search across all messages, rendered as D3 cards
- **Search Threads** — Thread-level search results, one card per conversation session
- **Favorites** — Starred cards and threads saved to localStorage
- **Agent Builder** — Browse indexed project files for agent composition
- **Agent List** — Browse and edit existing agent definitions
- **Template Create** — Compose reusable templates for agent definitions
- **Template List** — Browse and manage existing templates
- **Custom views** — User-created views with configurable type, emoji, color, auto-refresh interval, auto-query-on-switch behavior, project scope, and field-targeted filters

Views are persisted in `localStorage` with their full configuration. Each view carries its own query, optional project scope filter, optional `symbols` and `subject` field filters, and behavioral settings (auto-query, auto-refresh interval). Switching between views is instant — the search bar adapts its available controls based on the active view type. Built-in views can be customized (name, emoji, color) but not deleted.

The **view dropdown** uses a two-column grid layout: the left column shows all views grouped by category (Built-in, Search Threads, Search Messages, Favorites — categories with no user views are hidden), while the right column provides Agent Builder shortcuts (Launch Builder, List Agents, Create Template, List Templates). Full keyboard navigation with arrow keys, Home/End, Enter, Escape, and letter typeahead.

**Card Interaction** — Cards respond to zoom level through a Level-of-Detail (LOD) system. At low zoom, cards show only title and harness color. At medium zoom, text content becomes visible. At full zoom, complete metadata is rendered. The HoverPanel adapts too — at low zoom it shows full message preview; at higher zoom it switches to a metadata-only layout (harness, project, model, date, score, role, session, tools, symbols) since the card itself is already readable.

**Favorites & Starring** — Any card can be starred into one or more favorites views. When a user clicks the star icon on a card, a favorites picker dialog appears showing all favorites-type views, with the option to create a new one. The full message or thread data is snapshotted into the favorite entry, so favorites survive even if the backend data changes.

**Power Search Controls** — The search bar is a full command center with contextual controls that adapt per view type:

- **Date-range filter** ("Since:") — An always-visible dropdown with 16 time presets (Last week through Last 3 years, plus All and Custom). Selecting "Custom" reveals a date picker for arbitrary since-dates. Changing the date range automatically re-triggers the current search. State is persisted to localStorage across sessions.
- **Limit selector** — Visible on Latest and Search Threads views, controlling how many results to fetch (50–500). Persisted to localStorage.
- **Live filter** — An instant client-side text filter that narrows already-fetched results without a server round-trip. Always visible at the far right of the search bar.
- **Result filter** — Opens a filter dialog for role and score filtering, with a badge indicator when active filters are applied.
- **Source filter** — Multi-select dropdown for agent-builder views, filtering indexed files by data source name.

All search settings (date preset, custom date, limit) are persisted to localStorage and validated on restore.

**Search History** — A 100-entry FIFO queue backed by localStorage provides autocomplete for the search input. Entries are deduplicated case-insensitively, and each can be individually deleted or bulk-cleared. Full keyboard navigation with arrow keys, Enter to select, and Escape to dismiss.

**Clipboard Basket** — Selected text lines from cards can be saved to a clipboard basket for easy copying and reference.

### 4. MCP Server — AI Memory Made Accessible

The Model Context Protocol server is what transforms ContextCore from a storage/visualization tool into a **live memory layer for AI assistants**. Any MCP-capable client — Claude Code, Cursor, VS Code Copilot, Kiro, or custom agents — can connect to ContextCore and search, retrieve, and reason about your past conversations.

The MCP server runs inside the same Bun process as ContextCore, sharing the message database and topic store directly with zero serialization overhead. It exposes capabilities through three MCP primitives:

**12 Tools** for direct data access:

| Category            | Tools                                                                                 | Purpose                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Messages & Sessions | `get_message`, `get_session`, `list_sessions`, `query_messages`, `get_latest_threads` | Retrieve individual messages, full session transcripts, filtered listings, and recent activity            |
| Search              | `search_messages`, `search_threads`, `search_thread_messages`, `search_by_symbol`     | Full-text + semantic search with field filtering, project scoping, date ranges, and scope-based filtering |
| Topics              | `get_topics`, `get_topic`, `set_topic`                                                | Browse AI-generated summaries, check session topics, and label sessions for discoverability               |

Search tools accept the same advanced query syntax as the REST API (`fuzzy`, `"exact"`, `OR`, `AND`), plus powerful filtering options:

- **`projects`** — substring-matched project name patterns (case-insensitive). `["reach2"]` matches "reach2", "zz-reach2", "reach2-web".
- **`scope`** — named scope lookup that resolves to its constituent projects. Can be combined with explicit `projects` (union of both sets).
- **`subject`** and **`symbols`** — field-targeted filters that can drive search alone (field-only mode) or narrow full-text results.
- **`from`** / **`to`** — ISO date boundaries for temporal scoping.
- **`includeAssistantMessages`** — all search and message tools return only human messages by default, preventing bloated AI responses from consuming context windows. Opt-in to include assistant messages when deep research is needed.

Two tools are MCP-exclusive, unavailable through the REST API:

- **`search_thread_messages`** — drill into a specific thread found via `search_threads`, searching within its messages by query, subject, or symbols. Perfect for the search → drill-down workflow.
- **`search_by_symbol`** — word-boundary symbol search that finds whole identifiers only (searching `DB` won’t match `MessageDB`), ranked by occurrence count. Ideal for tracing which conversations discussed a code symbol most frequently.

**5 Resources** for browsable metadata:

| URI                              | Content                                                  |
| -------------------------------- | -------------------------------------------------------- |
| `cxc://stats`                    | Total messages, sessions, per-harness counts, date range |
| `cxc://projects`                 | All projects with session counts and last activity       |
| `cxc://harnesses`                | Harness list with message counts and date ranges         |
| `cxc://query-syntax`             | Search query syntax reference with examples              |
| `cxc://projects/{name}/sessions` | Sessions for a specific project                          |

**4 Prompts** for pre-built investigation workflows:

| Prompt              | Purpose                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `explore_history`   | Search threads for a topic and present results for LLM analysis  |
| `summarize_session` | Load a full session transcript for AI summarization              |
| `find_decisions`    | Multi-query search for architectural decisions about a component |
| `debug_history`     | Chronological debugging timeline for an issue                    |

**Dual Transport** — The MCP server supports two connection methods:

- **stdio** — The default for local clients. The MCP client (Claude Code, Cursor) spawns `bun run mcp` as a subprocess. JSON-RPC messages flow over stdin/stdout. Zero networking, zero configuration.
- **SSE (Server-Sent Events)** — For remote or web-based MCP clients. Mounts on the existing Express server at `GET /mcp/sse` and `POST /mcp/messages`. Each connection gets its own isolated MCP server instance. Optional bearer token authentication via `MCP_AUTH_TOKEN`.

A standalone entry point (`bun run mcp`) skips ingestion and the Express server entirely, loading only from persisted storage. This makes subprocess startup fast — typically under a second.

**Response Formatting** — All tool responses are formatted as information-dense plain text, not raw JSON. LLMs process natural language better than data structures. Sessions longer than 30 messages are truncated to first-5 + last-5 with an omission marker. Search results beyond 20 hits show only the top-ranked subset. When Qdrant is active, scores display the full breakdown: `Score: 85% (Q:91% | F:72%)`. Adaptive truncation progressively reduces detail when responses exceed ~8000 characters.

The MCP server is backed by **242 tests across 20 test files**, covering integration tests for all tools, fixture-backed search scenarios (subject, symbols, project substring, scope combos, role filtering), cross-tool workflows (search → get_message, search → get_session), and prompt handler validation.

The real power of the MCP server is in **regression investigation and task continuity**. When an LLM encounters a regression, it can search conversation history — scoped by project, filtered by date range, narrowed by code symbols — to understand what changed, when, and why. When continuing an abandoned task, it can load the prior session transcript and pick up exactly where the previous conversation left off. When exploring unfamiliar code, it can search by symbol to find every conversation that touched a specific function or class, ranked by how frequently that symbol was discussed.

---

## AI Topic Summarization

Every conversation session gets an AI-generated summary through a **two-pass pipeline** that runs at startup:

**Pass 1** (cheap model — `gpt-5-nano` by default) summarizes every session that doesn't have a summary yet. It builds a condensed context from the conversation's messages using an intelligent budget algorithm: user messages are included nearly in full (truncated at code block boundaries), while assistant messages are sampled from their first two and last two chunks. This captures the question and the conclusion without burning tokens on implementation detail. A 150K character budget with a 50K tail guarantee ensures the end of the conversation — where decisions and outcomes live — is always preserved.

**Pass 2** (smarter model — `gpt-5-mini` by default) finds pass 1 summaries that exceeded 1500 characters and tightens them. Moderately verbose summaries (under 3000 chars) are condensed directly — the existing summary text is sent to the smarter model with a tight prompt. Extremely long summaries (over 3000 chars) trigger a full context rebuild from the source messages.

Both passes are fully idempotent — re-running the pipeline produces no redundant API calls.

Summaries are stored in `{storage}/zeSettings/topics.json`, isolated from the message storage tree. This means processed messages can be wiped and regenerated without losing AI summaries. Users can also override any AI summary with a custom topic name via the API or MCP tool, and custom topics take absolute priority — they are never overwritten by the AI pipeline.

The subject resolution cascade throughout the system is: **custom topic → AI summary → NLP-derived subject**. This three-tier approach means every session always has a meaningful label, starting with the user's own words if provided, falling back to AI prose, and ultimately to the NLP-extracted verb+symbol subject.

---

### 5. Agent Builder

The Agent Builder is a full-stack feature that lets you **compose AI agent definitions directly from the visualizer UI**. Agents are `.agent.md` files conforming to the GitHub Copilot / VS Code agent format — the same files that tools like Copilot, Kiro, and Cursor consume to create specialized agent modes.

The system works by indexing configured project directories (architecture docs, upgrade specs, code files) and presenting them as browsable cards in the visualizer. You select knowledge files by clicking "add to basket" on cards, fill in agent metadata (name, description, hint, allowed tools), and hit create. The server writes a properly formatted `.agent.md` file with YAML frontmatter and knowledge links, plus a companion `.agent.json` file that preserves the structured definition for lossless round-trip editing.

**How it works:**

1. **Configuration** — Declare data source directories in `cc.json` under `dataSources` with `purpose: "AgentBuilder"`. Each entry specifies a content path (files to index) and an agent path (where agent files are stored).

2. **Indexing** — At startup, the `AgentBuilder` recursively scans all configured directories, collects file metadata and excerpts, and builds an in-memory index. Hidden directories are skipped (except `.github`), as are `.git/` and `node_modules/`.

3. **Browsing** — The "Agent Builder" view in the visualizer fetches the indexed file list and renders them as D3 cards. A source filter dropdown lets you scope the view to specific data sources.

4. **Composing** — The `AgentBasket` side panel is the composition workspace. Add files from the card view, add custom free-text knowledge entries, reorder items, fill in agent metadata, and create.

5. **Editing** — The "Agent List" view shows all existing agents. Clicking edit on an agent card loads its definition into the basket for modification. The system supports both JSON-backed agents (full fidelity) and legacy markdown-only agents (best-effort reconstruction from frontmatter parsing).

6. **Output** — Each agent produces two files:
   - `.agent.md` — The runtime artifact consumed by VS Code, Copilot, Kiro, Cursor
   - `.agent.json` — The structured source of truth for lossless editing

The generated `.agent.md` files follow the standard format with YAML frontmatter (`name`, `description`, `argument-hint`, `tools`) and a body containing markdown links to the knowledge files the agent should read.

### 6. Skills & Memory Manager

> **Status: To be developed**

Beyond agent definitions, ContextCore will support composing reusable **skills** — packaged domain knowledge with tested instructions for specific tasks like testing strategies, API design, performance optimization, or database migrations. Skills go beyond simple agent prompts; they encode workflows, best practices, and domain expertise extracted from your actual development history.

The Skills & Memory Manager will be the bridge between ContextCore's conversation archive and the actionable knowledge that makes AI assistants truly effective at your specific work. Where the Agent Builder packages *what files to read*, the Skills & Memory Manager will package *how to think about a problem* — turning the patterns and decisions captured across hundreds of AI conversations into reusable, composable knowledge units that any agent can leverage.

---

## Scopes — Project Grouping Made Simple

As your conversation archive grows across multiple harnesses and projects, navigating the raw project list becomes unwieldy. **Scopes** solve this by letting you group multiple `(harness, project)` pairs under a named, colored, emoji-tagged container.

A scope called `🚀 Reach2` might group `ClaudeCode/context-core`, `Cursor/context-core`, `VSCode/reach2-web`, and `Kiro/reach2-docs` into a single selectable unit. Click the scope button in the view editor, and all its member projects are instantly selected.

Scopes serve two core purposes:

1. **Editing convenience** — In the "New View / Edit View" dialog, clicking a scope button selects its member projects instantly. No more hunting through a long checkbox grid to select the same group of related projects for every new view.

2. **Visual grouping** — At render time, the D3 chat-map engine groups cards and threads into **MasterCards** by scope rather than raw project. This gives a higher-level view of related work — all your "Reach2" conversations cluster together regardless of which harness they came from.

Scopes are **global** — they persist across all views in `scopes.json` on the server. Each scope carries a unique ID, display name, emoji, hex color, and list of project pairs. The server normalizes all strings (trim + lowercase color) before persisting.

When a project appears in multiple scopes, the **"most specific wins"** rule applies: a scope with fewer projects beats a scope with more projects for any shared member. This means a narrow, focused scope always takes visual precedence over a broad umbrella scope.

Scopes are also available in the **MCP server** — any search tool accepts a `scope` parameter that resolves to its constituent projects. An LLM can search within a scope by name: `search_messages({ query: "auth middleware", scope: "Reach2" })`. Scopes and explicit project patterns can be combined (the union of both sets is used).

The scope CRUD surface lives in the "Edit Results View" modal:
- **Create**: save the currently selected projects as a new named scope (requires ≥ 2 projects selected)
- **Modify**: edit a scope's name, emoji, and color inline
- **Update Selection**: overwrite a scope's project list with the current checkbox state
- All mutations persist immediately to the server via `POST /api/scopes`

---

## Database Architecture

ContextCore uses a **two-tier storage architecture**: normalized JSON session files on disk serve as the durable source of truth, while an SQLite database provides indexed querying for the API, search, MCP, and visualizer.

**Disk Storage** — Sessions are persisted as JSON files in a structured directory tree: `{storage}/{machine}/{harness}/{project}/{YYYY-MM}/`. Each file contains a serialized `AgentMessage[]` array — one complete conversation session. A parallel `{machine}-RAW/` directory preserves verbatim copies of the original source data for provenance tracing. Every `AgentMessage` carries a `source` field pointing to its raw copy.

**SQLite Database** — The system supports two modes via the `IMessageStore` interface:

- **In-memory** (`:memory:`) — All data rebuilt from JSON files on every startup. Opt-in via `IN_MEMORY_DB=true`. Suitable for development and testing.
- **On-disk** (default) — Persistent SQLite file with WAL journal mode, 64 MB page cache, and incremental loading. Only sessions not yet in the database are parsed from JSON, dramatically reducing startup time at scale.

The schema is a single `AgentMessages` table with 20 columns and 12 indexes (8 single-column + 4 compound on filter columns paired with `dateTime` for efficient range queries). Six array fields (`context`, `symbols`, `history`, `tags`, `toolCalls`, `rationale`) are stored as JSON-stringified text.

**Live Ingestion** — After startup, a `FileWatcher` monitors all configured harness source paths using `fs.watch()`. When changes are detected, they flow through the `IncrementalPipeline`: harness re-read → storage write → database insert → topic summarization → vector embedding. A per-path debounce and sequential processing queue prevent event storms from overwhelming the system.

---

## Multi-Machine Support

ContextCore is designed from the ground up for multi-machine use. The `cc.json` configuration file contains per-hostname entries, so the same codebase and storage root can be synced across computers (via Dropbox, OneDrive, git, or any sync tool). On startup, ContextCore detects the current hostname and selects the matching machine configuration automatically.

Each machine entry declares its own harness paths, project mapping rules, and data sources. The storage directory is shared — messages from all machines coexist in the same tree, organized under `{machine}/` prefixes. This means you can search across your entire conversation history from any machine, seeing results from Claude Code on your desktop, Cursor on your laptop, and VS Code on your workstation — all in one unified view.

---

## REST API

The Express server on `localhost:3210` exposes a comprehensive REST API spanning six interaction patterns:

- **Direct lookup** — Fetch a single message by ID or all messages in a session
- **Filtered listing** — Paginated message queries with filters for role, harness, model, project, date range
- **Search** — Hybrid Fuse.js + Qdrant search at message and thread level, with project scoping, date-range filtering, and field-targeted `symbols`/`subject` filters via POST
- **Project & scope discovery** — All known projects grouped by harness; all persisted scope definitions with full CRUD
- **Topic management** — Browse AI summaries, set/clear custom topic overrides
- **Agent Builder** — Prepare file indexes, create agents, list agents, retrieve agent definitions

Key endpoints:

| Endpoint              | Method | Purpose                                                                                   |
| --------------------- | ------ | ----------------------------------------------------------------------------------------- |
| `/api/messages/:id`   | GET    | Single message by ID                                                                      |
| `/api/messages`       | GET    | Paginated message browse with filters                                                     |
| `/api/messages`       | POST   | Primary message search: Fuse.js + Qdrant hybrid, field filters, date range, project scope |
| `/api/threads`        | POST   | Thread search: hybrid pipeline → thread aggregation, with limit                           |
| `/api/threads/latest` | GET    | Most recent threads by date                                                               |
| `/api/projects`       | GET    | All projects grouped by harness                                                           |
| `/api/list-scopes`    | GET    | All persisted scope definitions                                                           |
| `/api/scopes`         | POST   | Save full scope list (validated, atomic replacement)                                      |

The API supports both the original flat-array response format and the newer envelope format (`SerializedSearchResults`) for backwards compatibility. The visualizer works against both old and new server versions without configuration.

---

## Technology Stack

| Layer             | Technology                               | Purpose                                                             |
| ----------------- | ---------------------------------------- | ------------------------------------------------------------------- |
| **Runtime**       | Bun                                      | TypeScript execution, native SQLite via `bun:sqlite`, fast file I/O |
| **Language**      | TypeScript (ESNext, strict)              | Type safety across the entire stack                                 |
| **HTTP**          | Express 5                                | REST API and static file serving                                    |
| **Search**        | Fuse.js                                  | Client-side fuzzy text search with weighted keys                    |
| **Vectors**       | Qdrant + OpenAI `text-embedding-3-large` | Semantic search (3072-dimensional embeddings)                       |
| **AI**            | Vercel AI SDK + `@ai-sdk/openai`         | Topic summarization (`gpt-5-nano`, `gpt-5-mini`)                    |
| **NLP**           | winkNLP + `wink-eng-lite-web-model`      | POS tagging for subject generation                                  |
| **Database**      | `bun:sqlite`                             | In-memory or on-disk SQLite with WAL mode                           |
| **Chunking**      | `@langchain/textsplitters`               | Content-aware text splitting (prose vs code)                        |
| **Protocol**      | `@modelcontextprotocol/sdk`              | MCP server for LLM integration                                      |
| **Frontend**      | React + Vite                             | SPA framework and dev server                                        |
| **Visualization** | D3.js                                    | Zoomable SVG card map with LOD                                      |
| **Date/Time**     | Luxon                                    | ISO 8601 parsing and formatting                                     |
| **Containers**    | Docker Compose                           | Qdrant vector database deployment                                   |

---

## What Makes This Unique

Most AI chat tools treat conversations as disposable. ContextCore treats them as **first-class data** — structured, searchable, and composable. Here's what sets it apart:

**Cross-harness unification.** There is no other system that reads from Claude Code's JSONL streams, Cursor's SQLite database, Kiro's JSON chat files, VS Code Copilot's incremental JSONL patches, and OpenCode's step-based SQLite schema — normalizes all of it into the same model — and makes it searchable in one place. Your conversation history is not siloed by IDE anymore.

**AI-accessible memory.** Through the MCP server, your past conversations become live context for future AI sessions. An LLM debugging a regression can search what was discussed before — scoped by project, filtered by date, narrowed by code symbol. An LLM continuing an abandoned task can load the prior transcript. This is not just storage — it's a **feedback loop** where AI agents build on each other's work. With 12 tools, 5 resources, and 4 prompts, the MCP surface covers everything from quick lookups to deep multi-session investigations.

**Hybrid search that actually works.** Combining fuzzy lexical search with semantic vector search means you find what you're looking for whether you remember the exact words or just the concept. The balanced 50/50 scoring gives both meaning and precision fair representation. Layer on field-targeted filters for symbols and subjects, and you can cut through thousands of conversations with surgical precision — find every thread where `HexGrid` was discussed, or every session about "tile rendering".

**Visual exploration, not just lists.** The D3-powered card map lets you explore your conversation history spatially — zooming in and out, seeing relevance scores and hit-count gradients at a glance, hovering for metadata, starring important findings. Cards group into MasterCards by scope, giving you a high-level overview of related work. It's a fundamentally different experience from scrolling through a list of search results. And because the visualizer is a PWA, it can live in your taskbar as a proper standalone window — not a pinned browser tab.

**A search bar that's a command center.** Date-range presets (from "Last week" to "Last 3 years" plus custom dates), configurable result limits, instant client-side filtering, role/score filtering, and persistent settings across sessions — the search bar adapts its controls per view type and remembers your preferences. Eight built-in views plus unlimited custom views, each with their own query, project scope, and auto-refresh settings.

**Scopes for organized projects.** Group related projects across harnesses into named, colored, emoji-tagged scopes. Scopes serve as one-click project selectors in the view editor, visual grouping containers on the card map, and named filters for MCP search tools. A scope called "🚀 Reach2" instantly selects all Reach2-related projects across Claude Code, Cursor, and VS Code.

**Agent composition from your own knowledge.** The Agent Builder lets you take your architecture docs, upgrade specs, and code files — the same knowledge that informed your AI conversations — and package them into reusable agent definitions. Agents built from your project's actual documentation are more accurate and context-aware than generic prompts.

**Real-time ingestion.** The file watcher detects changes to harness source files as they happen. New conversations appear in the system within seconds, with debouncing and queue serialization to handle event storms gracefully.

---

## What's Coming Next

ContextCore is just getting started. The current system establishes the foundation — multi-harness ingestion, hybrid search, MCP integration, visualization, and agent building. The sixth pillar — Skills & Memory Manager — is on the drawing board, and beyond that:

**Harness Customization** — The ability to define custom harness readers for new or proprietary AI tools. As the landscape of AI coding assistants continues to expand, ContextCore's ingestion pipeline will be extensible to any tool that stores conversation history — not just the five built-in harnesses.

**And more** — The architecture is designed for extensibility. The unified data model, the plugin-style harness registry, the MCP server's capability system, and the view-based visualizer all support adding new features without disrupting what's already built.

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) (v1.0+)
- For vector search: a running [Qdrant](https://qdrant.tech/) instance (Docker Compose file included) and an OpenAI API key

### Quick Start

```bash
# Install dependencies
cd server && bun install
cd ../visualizer && bun install

# Configure your machine's harness paths (recommended interactive editor for cc.json)
cd server && bun run cceditor
# Alternatively, edit server/cc.json directly if you prefer manual edits

# Start the server (ingestion + API + MCP)
cd server && bun run dev

# In a separate terminal, start the visualizer
cd visualizer && bun run dev
```

The server starts on `localhost:3210`. The visualizer is available at `localhost:5173` (dev mode) or `localhost:3210` (production — served directly by Express from `visualizer/dist/`).

For CLI details, commands, and architecture, see [server/zz-reach2/architecture/cli/archi-cli.md](server/zz-reach2/architecture/cli/archi-cli.md).

**Install as a standalone app (PWA)** — build the visualizer first (`cd visualizer && npm run build`), then navigate to `localhost:3210` in Chrome or Edge. Click the install icon in the address bar (or browser menu → "Install ContextCore Visualizer…"). The app opens as a standalone window with its own taskbar entry.

### Connect Your AI Assistant via MCP

**Claude Code** — Add to `.claude/mcp_servers.json`:
```json
{
  "context-core": {
    "command": "bun",
    "args": ["run", "mcp"],
    "cwd": "/path/to/context-core/server"
  }
}
```

**Cursor** — Add to MCP settings:
```json
{
  "mcpServers": {
    "context-core": {
      "command": "bun",
      "args": ["run", "src/mcp/serve.ts"],
      "cwd": "/path/to/context-core/server"
    }
  }
}
```

Once connected, your AI assistant can search your conversation history, retrieve session transcripts, browse project metadata, and build on prior reasoning — all through standard MCP tool calls.

### Enable Vector Search (Optional)

```bash
# Start Qdrant
docker compose up -d

# Set environment variables
echo "QDRANT_URL=http://localhost:6333" >> server/.env
echo "OPENAI_API_KEY=sk-..." >> server/.env
```

Both `QDRANT_URL` and `OPENAI_API_KEY` must be set. When absent, the system operates in Fuse.js-only mode with no degradation of core functionality.

---

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
- [server/zz-reach2/architecture/search/archi-scopes.md](server/zz-reach2/architecture/search/archi-scopes.md): Project scoping system — FE management, BE persistence, and display-time grouping.
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

---

## Project Structure

```
context-core/
├── compose.yaml                    # Docker Compose for Qdrant
├── server/
│   ├── cc.json                     # Per-machine configuration
│   ├── package.json
│   ├── src/
│   │   ├── ContextCore.ts          # Orchestrator entry point
│   │   ├── config.ts               # Hostname detection + config loading
│   │   ├── types.ts                # Shared type definitions
│   │   ├── agentBuilder/           # Agent Builder subsystem
│   │   ├── analysis/               # AI summarization + NLP subjects
│   │   ├── cache/                  # Response cache (daily TTL)
│   │   ├── db/                     # SQLite database layer (in-memory + on-disk)
│   │   ├── harness/                # Five IDE chat readers
│   │   ├── mcp/                    # MCP server (tools, resources, prompts, transports)
│   │   ├── models/                 # Domain models (AgentMessage, AgentThread, etc.)
│   │   ├── search/                 # Query parser, search engine, field filters, thread aggregator
│   │   ├── server/                 # Express REST API + route modules
│   │   ├── settings/               # Configuration, topic store, scope store
│   │   ├── storage/                # Session persistence to disk
│   │   ├── utils/                  # Hashing, path helpers, raw source archival
│   │   ├── vector/                 # Qdrant integration, embedding, chunking
│   │   └── watcher/                # File watcher + incremental pipeline
│   └── zz-reach2/                  # Architecture docs + upgrade specs
├── visualizer/
│   ├── src/
│   │   ├── App.tsx                 # Top-level orchestration
│   │   ├── api/                    # Fetch wrappers for all server endpoints
│   │   ├── components/             # React components (SearchBar, ChatMap, AgentBasket, etc.)
│   │   ├── d3/                     # D3 engine, layout, color palette
│   │   └── hooks/                  # State management (views, search, favorites, history)
│   └── zz-reach2/                  # UI architecture docs
├── qdrant/                         # Qdrant data volumes
└── website/                        # Project website
```

---

*ContextCore — because your AI conversations deserve to be remembered.*
