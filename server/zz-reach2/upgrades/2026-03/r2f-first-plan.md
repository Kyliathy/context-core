# Context Master – MVP Plan (R2F)

**Date**: 2026-03-06
**Goal**: Bring Context Master from scaffold to a functional MVP that ingests, normalizes, stores, and queries AI chat history from four IDEs.
**Entry point**: `src/ContextMaster.ts`

**Code style mandate**: Above-average comment density throughout all source files. Every function and its parameters must be commented. Non-obvious logic blocks, branching, and data transformations must be annotated. Comments tell the story of what the code is doing and why — but do not state the obvious (no "push to array" before an `array.push`).

---

## Part 0: Observed Data Formats (Reconnaissance)

Before implementation, here is what the actual data looks like in each harness. This section is the blueprint for building deserializers.

### 0A — Claude Code (`.jsonl`)

**Location**: `~/.claude/projects/<project-slug>/`
**File structure**:
- Root contains UUID-named directories (one per session) and `.jsonl` files.
- UUID directories hold `tool-results/` with `.txt` files of tool outputs, and `subagents/` with `.jsonl` agent transcripts.
- The `.jsonl` files at root level ARE the conversations. Each line is a typed JSON event.

**Line types and extraction map:**

| Line type                       | Key fields                                                                                                                                                                                                         | AgentMessage mapping                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `type: "user"`                  | `message.content[]` (Array of `{type:"text", text}` or `{type:"tool_result", tool_use_id, content}`), `uuid`, `parentUuid`, `timestamp`, `sessionId`, `cwd`, `version`, `gitBranch`                                | `role: "user"`, `dateTime` from `timestamp`, `context` from `<ide_opened_file>` tags in text, `project` from `cwd`                |
| `type: "assistant"`             | `message.model`, `message.content[]` (Array of `{type:"thinking"}`, `{type:"text", text}`, `{type:"tool_use", id, name, input}`), `message.usage.{input_tokens, output_tokens}`, `uuid`, `parentUuid`, `timestamp` | `role: "assistant"`, `model` from `message.model`, `toolCalls` from `content[type="tool_use"]`, `tokenUsage` from `message.usage` |
| `type: "file-history-snapshot"` | File backup metadata                                                                                                                                                                                               | **SKIP**                                                                                                                          |
| `type: "queue-operation"`       | Session lifecycle event                                                                                                                                                                                            | **SKIP**                                                                                                                          |

**Threading**: `parentUuid` chains reconstruct the conversation order. `sessionId` groups everything.
**Session name**: `slug` field (e.g. `"wise-brewing-tiger"`) when present.
**Tool calls structure**: `content[]` entries of `type: "tool_use"` contain `{id, name, input}`. Tool results arrive as subsequent `type: "user"` lines with `content[].type = "tool_result"` and matching `tool_use_id`. Map as: `{ name: <tool_use.name>, context: <input.file_path or similar>, results: <tool_result.content> }`.

### 0B — Kiro (`.chat`)

**Location**: `~\AppData\Roaming\Kiro\User\globalStorage\kiro.kiroagent\<hash>\`
**File structure**: `.chat` files are single JSON objects. Also contains subdirectories with hashed names (additional workspace data — skip for MVP).

**JSON shape:**
```
{
  executionId: string,
  actionId: "act",
  context: [{ type: "fileTree", target: number, staticDirectoryView: string, ... }],
  validations: { editorProblems: {} },
  chat: [
    { role: "human", content: "<system prompt with <identity> tag>" },
    { role: "bot",   content: "" },
    { role: "tool",  content: "<file tree or empty>" },
    { role: "human", content: "<user message with code blocks and context>" },
    { role: "bot",   content: "<assistant response>" },
    { role: "tool",  content: "" },
    ...
  ]
}
```

**Extraction rules:**
- **Skip first `human` entry** — it's the system prompt (detectable by `<identity>` tag or massive length).
- **Role mapping**: `human` → `user`, `bot` → `assistant`, `tool` → `tool`.
- **Model**: Embedded in system prompt text (e.g. `"Claude Sonnet 4.5"`). Extract via regex on the first `human` content.
- **No per-message timestamps**: Use file modification time as session `dateTime`.
- **File references**: Inline in messages as markdown code block headers (`` ```path/to/file.ts ```) and in `context[].staticDirectoryView` XML file tree.
- **Tool calls**: Kiro's format is implicit. `bot` messages preceding `tool` entries with empty content represent tool invocations. The `bot` message text describes the intent (e.g. "Now let me read the key files"). For MVP, treat consecutive `bot → tool(empty)` pairs as a tool call with `name` extracted from the bot's text, `context: []`, `results: []`.
- **Symbols**: Extract from code blocks (`` ``` ```) embedded in messages.

### 0C — VS Code / Copilot

**Location**: `~\AppData\Roaming\Code\User\workspaceStorage\<hash>\chatSessions\`
**File structure**: Two coexisting formats: `.json` (older, self-contained) and `.jsonl` (newer, incremental).

#### 0C-1: `.json` format

**JSON shape:**
```
{
  version: 3,
  requesterUsername: "Kyliathy",
  responderUsername: "",
  initialLocation: "panel",
  requests: [{
    requestId: string,
    message: {
      text: string,                          //Full user message text
      parts: [{ range, editorRange, text, kind: "text" }]
    },
    variableData: {
      variables: [{
        kind: "file" | "promptFile",
        id: string,                          //URI
        name: string,                        //e.g. "TileMakerBase.hx"
        value: { fsPath: string },           //Local file path
        modelDescription?: string            //e.g. "User's active file"
      }]
    },
    response: [{ value: string }],           //Assistant's markdown response text
    responseId: string,
    result: {
      timings: { firstProgress, totalElapsed },
      metadata: {
        toolCallRounds: [{
          response: string,                  //Assistant text for this round
          toolCalls: [],                     //Tool call objects (often empty in panel mode)
          id: string
        }],
        sessionId: string,
        agentId: string                      //e.g. "github.copilot.default"
      },
      details: string                        //e.g. "GPT-5 • 1x" — contains model name
    },
    agent: { id, description, extensionDisplayName }
  }]
}
```

**Extraction rules:**
- **User message**: `requests[i].message.text`
- **Assistant response**: `requests[i].response[0].value` (join all `response[]` entries)
- **Model**: Parse from `requests[i].result.details` (e.g. `"GPT-5 • 1x"` → `"GPT-5"`)
- **File references**: `requests[i].variableData.variables[].value.fsPath` where `kind === "file"`
- **Tool calls**: `requests[i].result.metadata.toolCallRounds[].toolCalls[]`
- **Session ID**: `requests[i].result.metadata.sessionId`
- **Timestamps**: Not per-message. Use file modification time. `result.timings.totalElapsed` gives round-trip duration.

#### 0C-2: `.jsonl` format (incremental)

**Line types:**
- Line 0 (`kind: 0`): Full session init. Key fields: `v.creationDate` (epoch ms), `v.sessionId`, `v.selectedModel.identifier` (e.g. `"copilot/claude-opus-4.6"`), `v.selectedModel.metadata.name`, `v.responderUsername`.
- Lines with `kind: 1`: Field patches. `k` is a key path Array (e.g. `["inputState","inputText"]`), `v` is the new value. Incrementally build the session object.
- Lines with `kind: 2`: Array-level patches for `response[]` — these contain tool invocation serializations.

**Reconstruction strategy:**
1. Parse line 0 to get the session skeleton.
2. Apply each `kind: 1` patch to the nested object.
3. Collect `kind: 2` entries for response arrays.
4. The fully reconstructed object matches the `.json` format above.

**Tool calls in JSONL**: Found in `kind: 2` lines where `k = ["requests", N, "response"]`. The `v` Array contains objects with `kind: "toolInvocationSerialized"` that have `invocationMessage`, `pastTenseMessage`, `toolId`, `toolCallId`, and `resultDetails[]` with file URIs.

**File references**: In `kind: 1` lines where `k = ["inputState", "attachments"]` — the `v` is an Array of `{kind: "file", value: {fsPath}}`.

### 0D — Cursor (`state.vscdb`)

**Location**: `~\AppData\Roaming\Cursor\User\globalStorage\state.vscdb`
**Format**: SQLite database. Single relevant table: `ItemTable` with `key TEXT, value TEXT` columns.

**Known chat-related keys:**
- `workbench.chat.history`
- `ai.chat.session`
- `composer.chat.history`

**Extraction strategy:**
1. Open readonly with `bun:sqlite`.
2. Query each known key: `SELECT value FROM ItemTable WHERE key = ?`.
3. Parse the JSON string value.
4. **Runtime sampling required**: The inner JSON structure is not publicly documented and changes between Cursor versions. The deserializer must:
   - Log the raw keys found via `SELECT key FROM ItemTable WHERE key LIKE '%chat%' OR key LIKE '%ai%' OR key LIKE '%composer%'`.
   - Parse each value and detect message-like objects (look for `role`, `content`, `model` fields).
   - Map whatever structure is found into AgentMessage.
5. This harness will likely need the most iteration and defensive parsing.

---

## Part 1: Data Model, Storage, and Harness Deserializers

### 1A — `CMSettings` class

Create `src/settings/CMSettings.ts`:
- Loads `cm.json` from project root.
- Exposes `storage` path (e.g. `d:\Codez\Nexus\design\CXM`).
- Ensures the storage directory exists on startup (`mkdirSync` recursive).
- Singleton access pattern.

Update `cm.json` schema in `types.ts` to include `storage: string` in `ContextMasterConfig`.

### 1B — `AgentMessage` class

Create `src/models/AgentMessage.ts`:

```ts
class AgentMessage {
  id: string;              //Unique hash (deduplication across runs)
  sessionId: string;       //Groups messages into a single conversation
  harness: string;         //Source IDE: "ClaudeCode" | "Cursor" | "Kiro" | "VSCode"
  machine: string;         //Hostname of the machine this was read from

  role: string;            //"user" | "assistant" | "tool" | "system"
  model: string | null;    //e.g. "claude-sonnet-4-5-20250929", null for human/tool
  message: string;         //The actual text content of the message
  subject: string;         //Session-level subject, repeated per message for queryability

  context: string[];       //File paths referenced in or attached to the message
  symbols: string[];       //Symbol references (function names, class names, etc.)
  history: string[];       //References to prior sessions or historical context
  tags: string[];          //Freeform tags for categorization

  project: string;         //Project/workspace name or path
  parentId: string | null; //Parent message ID for threading

  tokenUsage: {            //Token consumption (when available)
    input: number | null;
    output: number | null;
  } | null;

  toolCalls: ToolCall[];   //Structured tool invocation data
  dateTime: DateTime;      //Luxon DateTime
}

type ToolCall = {
  name: string;            //Tool function name (e.g. "Read", "Edit", "copilot_getErrors")
  context: string[];       //File paths or inputs provided to the tool
  results: string[];       //Tool output / return values (truncated if massive)
};
```

**Proposed additions over original spec:**
- `id` — SHA-256 of `(sessionId + role + timestamp + message_prefix)` for deduplication.
- `sessionId` — critical for grouping messages into conversations.
- `harness` — which IDE produced this message.
- `machine` — which machine it came from.
- `project` — workspace/project context.
- `parentId` — enables conversation threading reconstruction.
- `tokenUsage` — token consumption data (available from Claude Code and VS Code Copilot).
- `toolCalls` — structured as `ToolCall[]` with `{ name, context[], results[] }`.
- `subject` — persisted subject for API and DB filtering; same value across one session.

### 1C — Subject Generation (`src/analysis/SubjectGenerator.ts`)

Each stored chat JSON must be named with a subject derived from the conversation content. The subject is composed of two parts concatenated:

#### 1C-1: Verb extraction (first 10 verbs from first user message)

**Dependency**: `wink-eng-lite-web-model` + `wink-nlp` — lightweight (~1MB), ~95% POS accuracy, fast tokenization.

**Algorithm**:
1. Take the first user message in the session (skip system prompts).
2. Tokenize using winkNLP.
3. Filter tokens tagged as verbs (POS tags: `VB`, `VBD`, `VBG`, `VBN`, `VBP`, `VBZ`).
4. Collect up to 10 unique verbs (lowercased, deduplicated).
5. Join with hyphens: e.g. `"look-build-check-diff-get-receive-use-create-handle-fix"`.

#### 1C-2: Symbol extraction (10 most common camelCase/PascalCase symbols in entire chat)

**Definition of "symbol"**: Any word containing at least one capital letter that is NOT at position 0. This captures `camelCase`, `mixedCase`, and interior capitals, but excludes `PascalCase` words that start with a capital and have no other capitals (those are just regular English words like "The"). Specifically: a word matching `/(?!^)[A-Z]/` within the word body (i.e. after index 0 of the word).

Wait — the user said "at least 1 capital letter that is not at the beginning". So `getLeafTile` qualifies (has L and T after position 0), `NNDataTileSetLeaf` qualifies, `StoryTeller` qualifies (T after position 0). Regular words like "The" or "Here" would also match this regex... We need to be smarter: the regex should match words where a capital letter appears after a lowercase letter, or a lowercase letter appears after a capital — essentially mixed case. The regex `/[a-z][A-Z]/` (camelCase hump) is the safest detector.

**Revised definition**: A word is a symbol if it contains the pattern `[a-z][A-Z]` anywhere — a lowercase letter immediately followed by an uppercase letter. This catches `getLeafTile`, `StoryTeller`, `NNDataTileSetLeaf`, `createTileInfo`, `camelCase`, etc. but NOT `THE`, `HERE`, `API`, or `HTML`.

**Large chat sampling algorithm**:
1. Concatenate ALL message text (all roles) into one combined string.
2. Count space characters in the combined string.
3. If spaces > 100,000 (very large chat):
   - Divide the string into 10 equally-spaced segments.
   - From each segment, extract ~1,000 words (split on whitespace).
   - This yields ~10,000 words total as a representative sample.
4. If spaces <= 100,000: use the entire text.
5. Split into words (whitespace + punctuation boundaries).
6. Filter words matching `/[a-z][A-Z]/`.
7. Count occurrences of each matching word.
8. For symbol candidates containing `.`, drop the extension/segment after the first dot before counting (e.g. `CombatView.tsx` → `CombatView`).
9. Take the top 10 by frequency.
10. Join with hyphens: e.g. `"getLeafTile-StoryTeller-createTileInfo-moveToTile-NNDataTileSetLeaf-getRandomInt-TileMaker-triggerOutcome-onSelected-choiceMade"`.

**Final subject format**: `"{verbs}_{symbols}"`, truncated to max 120 chars, sanitized for filesystem safety (no `\/:*?"<>|`, spaces → dashes).
When truncation is required, preserve the full verb segment first; symbols are secondary and may be dropped/truncated.

**Full filename**: `{YYYY-MM-DD HH-mm} {SUBJECT}.json`

### 1D — Harness Deserializers (detailed per-file tasks)

Each harness deserializer reads source files and produces `AgentMessage[]`.

#### 1D-1: Claude Code Deserializer (`src/harness/claude.ts`)

**Input**: Array of directory paths (e.g. `c:\Users\Axonn\.claude\projects\d--Codez-Nexus-Evo-NexusPlatform\`)

**Tasks:**
1. **Scan directory**: List all `.jsonl` files at root level (ignore UUID directories for now — tool results can be correlated later).
2. **Parse JSONL**: Read each file line by line. Parse each line as JSON. Wrap in try/catch per line (malformed lines are skipped with a warning).
3. **Filter lines**: Keep only lines with `type === "user"` or `type === "assistant"`. Skip `file-history-snapshot`, `queue-operation`, and any unknown types.
4. **Extract user messages**:
   - `message.content[]` → concatenate all `{type: "text"}` entries' `.text` fields.
   - Detect `<ide_opened_file>` tags → extract file path → push to `context[]`.
   - `uuid` → `id`, `parentUuid` → `parentId`, `timestamp` → `dateTime`.
   - `sessionId` → `sessionId`, `cwd` → `project`.
5. **Extract assistant messages**:
   - `message.content[]` → concatenate `{type: "text"}` entries for `message`.
   - `{type: "tool_use"}` entries → build `ToolCall` objects: `name` from `.name`, `context` from `.input` (extract file paths), `results: []` (results come in next user line).
   - `message.model` → `model`.
   - `message.usage` → `tokenUsage`.
6. **Correlate tool results**: When a `type: "user"` line has `content[].type === "tool_result"`, match its `tool_use_id` to the previous assistant's `tool_use.id` and populate that ToolCall's `results[]`.
7. **Group by sessionId**: Each `.jsonl` file maps to one session. Use `sessionId` from the first non-skip line.
8. **Extract symbols**: From `cwd` path, derive project name (last path segment).

#### 1D-2: Kiro Deserializer (`src/harness/kiro.ts`)

**Input**: Array of directory paths (e.g. `kiro.kiroagent\<hash>\`)

**Tasks:**
1. **Scan directory**: List all `.chat` files (skip subdirectories with hashed names).
2. **Parse JSON**: Read each `.chat` file as a single JSON object.
3. **Detect and skip system prompt**: The first `chat[]` entry with `role === "human"` whose content contains `<identity>` is the system prompt. Skip it. Extract model name from it via regex (e.g. `/Name:\s*(.+)/`).
4. **Walk chat array**: Starting after the system prompt:
   - `role: "human"` → `role: "user"`. Content is the `message` text.
   - `role: "bot"` → `role: "assistant"`. Content is the `message` text.
   - `role: "tool"` → `role: "tool"`. Content (often empty or file tree) is the `message`.
5. **Extract file references**: Parse markdown code block headers (`` ```path/to/file.ext ``) from message content. Also scan `context[0].staticDirectoryView` for workspace file paths.
6. **Build ToolCalls**: When a `bot` message is immediately followed by a `tool` message with empty content, treat the pair as a tool invocation. Parse the `bot` text for intent (e.g. "let me read..." → `name: "readFile"`). This is best-effort for MVP.
7. **Timestamps**: No per-message timestamps exist. Use file `mtime` (modification time) as session `dateTime`. All messages in a `.chat` file share the same `dateTime`.
8. **Session ID**: Use `executionId` from the JSON root.
9. **Project**: Derive from metadata JSON in the hash root when present (workspace/project name fields). Fallback to workspace file tree hints (`package.json` / root folder in `staticDirectoryView`), then hash folder name.

#### 1D-3: VS Code Deserializer (`src/harness/vscode.ts`)

**Input**: Array of directory paths (e.g. `workspaceStorage\<hash>\`)

**Tasks:**
1. **Scan for chat files**: Look in `chatSessions/` subdirectory. Collect both `.json` and `.jsonl` files.
2. **Handle `.json` files (older format)**:
   a. Parse the full JSON object.
   b. For each `requests[i]`:
      - **User message**: `message.text` → `message` field. `message.parts[].text` as fallback.
      - **Assistant response**: Join `response[].value` → `message` for assistant turn.
      - **File references**: `variableData.variables[]` where `kind === "file"` → extract `value.fsPath` → `context[]`.
      - **Model**: Parse `result.details` (e.g. `"GPT-5 • 1x"` → split on `" • "`, take first).
      - **Tool calls**: `result.metadata.toolCallRounds[].toolCalls[]` → build `ToolCall` objects.
      - **Session ID**: `result.metadata.sessionId`.
      - **Timestamps**: File `mtime` as `dateTime`. `result.timings.totalElapsed` as duration metadata.
   c. Each request produces two AgentMessages: one `role: "user"`, one `role: "assistant"`.
3. **Handle `.jsonl` files (newer incremental format)**:
   a. Parse line 0 (`kind: 0`): Extract `v.creationDate` (epoch ms → `dateTime`), `v.sessionId`, `v.selectedModel.identifier` and `v.selectedModel.metadata.name` → `model`.
   b. Build a session object by applying `kind: 1` patches: for each line, traverse `k` (key path Array) into the object and set `v`.
   c. Handle `kind: 2` lines: these are array-level patches for `response[]` data. They contain `toolInvocationSerialized` objects with `toolId`, `toolCallId`, `invocationMessage`, `resultDetails[]`.
   d. After reconstruction, the object matches the `.json` format — apply the same extraction logic from step 2.
   e. File attachments: Watch for `k = ["inputState", "attachments"]` patches — `v[]` contains `{kind: "file", value: {fsPath}}`.

#### 1D-4: Cursor Deserializer (`src/harness/cursor.ts`)

**Input**: Single file path to `state.vscdb`.

**Tasks:**
1. **Open SQLite**: `new Database(dbPath, { readonly: true })` via `bun:sqlite`.
2. **Discover keys**: Run `SELECT key FROM ItemTable WHERE key LIKE '%chat%' OR key LIKE '%ai%' OR key LIKE '%composer%' OR key LIKE '%conversation%'`. Log all discovered keys.
3. **Parse known keys**: For each of `workbench.chat.history`, `ai.chat.session`, `composer.chat.history`:
   a. `SELECT value FROM ItemTable WHERE key = ?`.
   b. Parse JSON string.
   c. The inner structure is undocumented. Implement a recursive walker that searches for objects with `role` + `content` fields (message-like).
   d. Extract: `role`, `content` → `message`, any `model` field, file paths from content or sibling fields.
4. **Build AgentMessages**: Each discovered message object → one AgentMessage. Session grouping by proximity or container object structure.
5. **Defensive parsing**: Every extraction step must be wrapped in try/catch. Log warnings for unrecognized structures. This harness will need iterative refinement.
6. **Close DB**: Always in a `finally` block.

### 1E — Storage Layout

Storage mirrors the cm.json structure, organized per machine and project, with an additional **`YYYY-MM`** directory level for temporal grouping.

**Directory structure:**
```
{storage}/
  {machine}/
    {harness}/
      {project}/
        YYYY-MM/
          {YYYY-MM-DD HH-mm} {SUBJECT}.json
```

**Example:**
```
d:\Codez\Nexus\design\CXM\
  Axonn-PC\
    ClaudeCode\
      d--Codez-Nexus-Evo-NexusPlatform\
        2026-03\
          2026-03-06 08-44 look-build-check_getLeafTile-StoryTeller-createTileInfo.json
      d--Codez-Nexus-AXON\
        2026-02\
          2026-02-15 14-22 refactor-update-implement_useHexGridBridge-HexGridView.json
    Kiro\
      AXON\
        2026-01\
          2026-01-30 09-15 read-implement-create_IndraResponseParser-StoryEntity.json
    VSCode\
      d408e4a80c64ab681f9df507c4c7b740\
        2026-03\
          2026-03-05 11-30 sync-adapt-fix_CombatChoiceResolver-EncounterState.json
    Cursor\
      global\
        2026-03\
          2026-03-06 10-00 debug-explore_AgentMessage-ChatHistory.json
```

**Project name derivation:**
- **Claude Code**: Last segment of the `.claude/projects/` path (e.g. `d--Codez-Nexus-Evo-NexusPlatform`).
- **Kiro**: Derive from workspace file tree root or use hash as fallback.
- **VS Code**: Use `workspace.json` in the `workspaceStorage/<hash>/` directory (contains the workspace path), or fall back to hash.
- **Cursor**: Use `"global"` since `state.vscdb` is a single global database.

**YYYY-MM derivation**: From the session's earliest `dateTime`.

### 1F — Storage Writer (`src/storage/StorageWriter.ts`)

**Tasks:**
1. Accept a session's `AgentMessage[]`, the `machine` name, `harness` name, and `project` name.
2. Determine `dateTime` from the earliest message in the session.
3. Compute the `YYYY-MM` directory from that `dateTime`.
4. Generate the subject via `SubjectGenerator` (Section 1C).
5. Build the full path: `{storage}/{machine}/{harness}/{project}/{YYYY-MM}/{ISO-date} {SUBJECT}.json`.
6. Ensure all intermediate directories exist (`mkdirSync` recursive).
7. Serialize the `AgentMessage[]` to JSON (pretty-printed, 2-space indent).
8. Write to disk. Skip if file already exists (deduplication by filename).

### 1G — Orchestrator (`src/ContextMaster.ts`)

**Startup flow:**
1. Load CMSettings (reads `cm.json`, validates `storage` path).
2. Detect hostname, select matching machine config.
3. For each harness in the machine config:
   a. Call the appropriate deserializer → get `AgentMessage[]`.
   b. Group by `sessionId`.
   c. For each session group, call StorageWriter.
4. Log summary: sessions processed per harness, total messages, any errors.

---

## Part 2: In-Memory Database + Express API

### 2A — In-Memory Database (`src/db/MessageDB.ts`)

- Use Bun's built-in SQLite with `:memory:` as the database path.
- Schema:

```sql
CREATE TABLE AgentMessages (
  id TEXT PRIMARY KEY,
  sessionId TEXT,
  harness TEXT,
  machine TEXT,
  role TEXT,
  model TEXT,
  message TEXT,
  context TEXT,      -- JSON Array serialized
  symbols TEXT,      -- JSON Array serialized
  history TEXT,      -- JSON Array serialized
  tags TEXT,         -- JSON Array serialized
  project TEXT,
  parentId TEXT,
  tokenUsage TEXT,   -- JSON object serialized
  toolCalls TEXT,    -- JSON Array of ToolCall serialized
  dateTime TEXT      -- ISO 8601
);

CREATE INDEX idx_sessionId ON AgentMessages(sessionId);
CREATE INDEX idx_harness ON AgentMessages(harness);
CREATE INDEX idx_role ON AgentMessages(role);
CREATE INDEX idx_model ON AgentMessages(model);
CREATE INDEX idx_dateTime ON AgentMessages(dateTime);
CREATE INDEX idx_project ON AgentMessages(project);
```

- On startup (after ingestion), recursively scan the `storage` directory for all `*.json` files.
- Deserialize each file's AgentMessage Array and INSERT into the in-memory DB.

### 2B — Fuzzy String Matching

For fuzzy matching on text fields (`message`, `context`, `symbols`, `tags`, `project`):
- Use `fuse.js` for in-memory fuzzy search.
- Pre-index all AgentMessages into a Fuse instance with weighted keys (`message` highest, `symbols` and `tags` medium, `context` lower).
- Return top 10% of matches sorted by relevance score.

### 2C — Express API Server (`src/server/index.ts`)

**Endpoints:**

| Method | Path                       | Description                                                                                                      |
| ------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/messages`            | Query AgentMessages. Accepts query params for any field.                                                         |
| `GET`  | `/api/messages/:id`        | Get a single AgentMessage by ID.                                                                                 |
| `GET`  | `/api/sessions`            | List all unique sessions with metadata (count, harness, dateTime range).                                         |
| `GET`  | `/api/sessions/:sessionId` | Get all messages in a session, ordered by dateTime.                                                              |
| `GET`  | `/api/search`              | Fuzzy search across `message`, `context`, `symbols`, `tags`. Param: `q` (query string). Returns top 10% matches. |

**Query mechanics for `/api/messages`:**
- Each field name can be passed as a query param (e.g. `?role=user&harness=ClaudeCode`).
- String fields support fuzzy matching when prefixed with `~` (e.g. `?message=~refactor`).
- `dateTime` supports range queries with `from` and `to` params (ISO 8601).
- Results are paginated (default 50, max 200).
- Response format: `{ total: number, page: number, results: AgentMessage[] }`.

### 2D — Startup Flow (`src/ContextMaster.ts`)

1. Load CMSettings.
2. Run harness ingestion → write to storage (Part 1).
3. Load all stored JSONs into in-memory SQLite.
4. Start Express server on configurable port (default `3210`).
5. Log: `Context Master API ready on http://localhost:3210`.

---

## Dependencies Summary

| Package                                       | Purpose                                                       |
| --------------------------------------------- | ------------------------------------------------------------- |
| `luxon` + `@types/luxon`                      | DateTime handling for AgentMessage                            |
| `express` + `@types/express`                  | HTTP API server                                               |
| `fuse.js`                                     | Fuzzy string matching (lightweight, no native deps)           |
| `wink-nlp` + `wink-eng-lite-web-model`        | English POS tagging for verb extraction in subject generation |
| `bun:sqlite` (built-in)                       | In-memory DB + Cursor's state.vscdb reader                    |
| `typescript` + `@types/bun` (already present) | Type checking                                                 |

---

## Task Execution Order (Granular Checklist)

Tasks are grouped by difficulty and sorted chronologically within each group. Each `{{MODEL}}` tag indicates the recommended model for that batch. A new tag appears at least every 8 tasks, or whenever difficulty changes.

---

### Group 1 — Foundation: Types, Config, Dependencies

{{SIMPLE}}

- [x] **T01** — Run `bun add luxon express fuse.js wink-nlp wink-eng-lite-web-model` and `bun add -d @types/luxon @types/express` to install all MVP dependencies.
- [x] **T02** — Update `src/types.ts`: add `storage: string` field to `ContextMasterConfig`. Add `ToolCall` type: `{ name: string, context: string[], results: string[] }`.
- [x] **T03** — Create `src/models/AgentMessage.ts`: define the `AgentMessage` class with all fields (`id`, `sessionId`, `harness`, `machine`, `role`, `model`, `message`, `context`, `symbols`, `history`, `tags`, `project`, `parentId`, `tokenUsage`, `toolCalls`, `dateTime`). Add a `serialize(): object` method and a static `deserialize(obj): AgentMessage` factory.
- [x] **T04** — Create `src/settings/CMSettings.ts`: singleton that loads `cm.json`, exposes `storage` path, and calls `mkdirSync(storage, { recursive: true })` on init.
- [x] **T05** — Create `src/utils/pathHelpers.ts`: utility functions — `sanitizeFilename(input: string): string` (strip `\/:*?"<>|`, spaces → dashes, max 120 chars), `deriveProjectName(harnessName: string, sourcePath: string): string` (per-harness logic from Section 1E), `buildYYYYMM(dt: DateTime): string`.
- [x] **T06** — Create `src/utils/hashId.ts`: function `generateMessageId(sessionId, role, timestamp, messagePrefix): string` — SHA-256 truncated to 16 hex chars for deduplication.
- [x] **T07** — Update `src/ContextMaster.ts`: replace the placeholder `main()` with a skeleton that loads CMSettings, detects hostname, selects machine config, and logs the result. No harness calls yet — just the shell.

---

### Group 2 — Straightforward Deserializer Scaffolding

{{MEDIUM}}

- [x] **T08** — `src/harness/claude.ts`: Rewrite to scan a directory path for `.jsonl` files only (ignore UUID directories). Return an Array of file paths. Add above-average comments explaining Claude Code's storage layout.
- [x] **T09** — `src/harness/claude.ts`: Implement JSONL line-by-line parser. For each `.jsonl` file, read the file, split by newlines, parse each line as JSON in a try/catch (skip + warn on malformed). Filter: keep only lines where `type === "user"` or `type === "assistant"`.
- [x] **T10** — `src/harness/claude.ts`: Implement user message extraction. From `type: "user"` lines: concatenate `message.content[].text` fields, detect `<ide_opened_file>` tags → push file path to `context[]`, map `uuid` → `id`, `parentUuid` → `parentId`, `timestamp` → `dateTime` (Luxon), `sessionId` → `sessionId`, `cwd` → `project`.
- [x] **T11** — `src/harness/claude.ts`: Implement assistant message extraction. From `type: "assistant"` lines: concatenate `content[type="text"].text` → `message`, extract `message.model` → `model`, extract `message.usage` → `tokenUsage`.
- [x] **T12** — `src/harness/claude.ts`: Implement `sessionId` grouping. Each `.jsonl` file corresponds to one session. Read `sessionId` from the first valid line. Derive `project` from the last segment of the source directory path.
- [x] **T13** — `src/harness/kiro.ts`: Rewrite to scan directory for `.chat` files only. For each file, parse as a single JSON object. Return raw parsed objects with their file paths (for mtime lookup later).
- [x] **T14** — `src/harness/kiro.ts`: Implement system prompt detection and skip. The first `chat[]` entry with `role === "human"` whose content contains `<identity>` is the system prompt — skip it. Extract model name via regex `/Name:\s*(.+)/` from its content.
- [x] **T15** — `src/harness/kiro.ts`: Implement chat array walker. Map roles: `human` → `user`, `bot` → `assistant`, `tool` → `tool`. Use `executionId` as `sessionId`. Use file `mtime` as `dateTime` for all messages.

{{MEDIUM}}

- [x] **T16** — `src/harness/kiro.ts`: Implement file reference extraction. Scan message content for markdown code block headers (`` ```path/to/file ```) via regex. Also parse `context[0].staticDirectoryView` for file paths if present.
- [x] **T17** — `src/harness/kiro.ts`: Derive project name from the workspace file tree. Look for a root folder name in `staticDirectoryView` or `package.json` reference. Fall back to the hash directory name.
- [x] **T18** — `src/harness/vscode.ts`: Rewrite to scan `chatSessions/` subdirectory within each workspace storage path. Separate collected files into `.json` Array and `.jsonl` Array.
- [x] **T19** — `src/harness/vscode.ts`: Implement `.json` format parser. For each `requests[i]`: extract `message.text` → user message, join `response[].value` → assistant message. Produce two AgentMessages per request (one user, one assistant).
- [x] **T20** — `src/harness/vscode.ts`: Extract file references from `.json` format: `variableData.variables[]` where `kind === "file"` → `value.fsPath` → `context[]`.
- [x] **T21** — `src/harness/vscode.ts`: Extract model from `.json` format: parse `result.details` (e.g. `"GPT-5 • 1x"` → split on `" • "`, take first part). Extract `result.metadata.sessionId` → `sessionId`.
- [x] **T22** — `src/harness/index.ts`: Update harness registry to call the rewritten deserializers. Each harness now returns `AgentMessage[]` instead of raw `Record<string, unknown>[]`.
- [x] **T23** — `src/storage/StorageWriter.ts`: Create the StorageWriter. Accept `AgentMessage[]`, `machine`, `harness`, `project`. Build the output path: `{storage}/{machine}/{harness}/{project}/{YYYY-MM}/{date} {subject}.json`. Call `mkdirSync` recursive. Serialize to JSON with 2-space indent. Skip write if file already exists.

---

### Group 3 — Complex Parsing, Tool Correlation, Reconstruction

{{HARD}}

- [x] **T24** — `src/harness/claude.ts`: Build `ToolCall` objects from assistant `content[type="tool_use"]` entries. Map: `name` from `.name`, `context` from `.input` (extract file paths like `file_path`, `path`, etc. from the input object), `results: []` initially.
- [x] **T25** — `src/harness/claude.ts`: Implement tool result correlation. When a `type: "user"` line has `content[].type === "tool_result"`, match its `tool_use_id` to the previous assistant message's `tool_use.id`. Populate the matching ToolCall's `results[]` with the tool result content (truncate to 2000 chars if massive).
- [x] **T26** — `src/harness/vscode.ts`: Implement `.jsonl` incremental reconstruction. Parse line 0 (`kind: 0`) for the session skeleton. Apply `kind: 1` patches by traversing the `k` key-path Array into the object and setting `v`. Collect `kind: 2` entries for array-level response patches.
- [x] **T27** — `src/harness/vscode.ts`: After `.jsonl` reconstruction, extract tool calls from `kind: 2` response patches. Look for objects with `kind: "toolInvocationSerialized"` — extract `toolId` → `name`, `resultDetails[].uri` → `context`, `pastTenseMessage.value` → `results`. Extract file attachments from `k = ["inputState", "attachments"]` patches.
- [x] **T28** — `src/harness/kiro.ts`: Implement best-effort tool call extraction. When a `bot` message is immediately followed by a `tool` message with empty content, treat as a tool call. Parse the `bot` text for action verbs (e.g. "read" → `name: "readFile"`, "search" → `name: "search"`). Set `context: []`, `results: []`.
- [x] **T29** — `src/analysis/SubjectGenerator.ts`: Implement verb extraction. Initialize winkNLP with `wink-eng-lite-web-model`. Tokenize the first user message. Filter tokens with POS tags `VB`, `VBD`, `VBG`, `VBN`, `VBP`, `VBZ`. Collect up to 10 unique lowercased verbs. Join with hyphens.
- [x] **T30** — `src/analysis/SubjectGenerator.ts`: Implement symbol extraction with large-chat sampling. Concatenate all message texts. Count spaces. If > 100k: divide into 10 segments, take ~1000 words from each. Apply regex `/[a-z][A-Z]/` to find camelCase words. Count occurrences. Return top 10 by frequency, joined with hyphens.
- [x] **T31** — `src/analysis/SubjectGenerator.ts`: Combine verbs + symbols into final subject string: `"{verbs}_{symbols}"`. Apply `sanitizeFilename()`. Truncate to 120 chars. Expose a single public function `generateSubject(messages: AgentMessage[]): string`.

{{HARD}}

- [x] **T32** — `src/db/MessageDB.ts`: Create the in-memory SQLite database class. On construction: `CREATE TABLE AgentMessages (...)` with all columns. Create indexes on `sessionId`, `harness`, `role`, `model`, `dateTime`, `project`.
- [x] **T33** — `src/db/MessageDB.ts`: Implement `loadFromStorage(storagePath: string)`. Recursively scan for `*.json` files. Deserialize each file's `AgentMessage[]`. INSERT each message into the DB. Log count of messages loaded.
- [x] **T34** — `src/db/MessageDB.ts`: Implement query methods: `getById(id)`, `getBySessionId(sessionId)`, `listSessions()` (distinct sessionId with COUNT, min/max dateTime, harness). Return deserialized AgentMessage objects.
- [x] **T35** — `src/db/MessageDB.ts`: Implement `queryMessages(filters)` — accept a filters object with optional fields (`role`, `harness`, `model`, `project`, `from`, `to`). Build a dynamic `WHERE` clause. Support pagination (`page`, `pageSize`). Return `{ total, page, results }`.
- [x] **T36** — `src/server/index.ts`: Create the Express server. Set up JSON middleware. Implement `GET /api/messages/:id` and `GET /api/sessions/:sessionId` endpoints backed by MessageDB.
- [x] **T37** — `src/server/index.ts`: Implement `GET /api/sessions` — returns all sessions with metadata. Implement `GET /api/messages` — delegates to `MessageDB.queryMessages()` with query params mapped to filters.
- [x] **T38** — `src/server/index.ts`: Implement `GET /api/search` — fuzzy search using fuse.js. Pre-build a Fuse index from all AgentMessages with weighted keys (`message` weight 3, `symbols` weight 2, `tags` weight 2, `context` weight 1). Accept `q` param. Return top 10% of matches sorted by score.

---

### Group 4 — Cursor (Undocumented Format) + Full Pipeline Orchestration

{{COMPLEX}}

- [x] **T39** — `src/harness/cursor.ts`: Rewrite to open `state.vscdb` readonly via `bun:sqlite`. Run `SELECT key FROM ItemTable WHERE key LIKE '%chat%' OR key LIKE '%ai%' OR key LIKE '%composer%' OR key LIKE '%conversation%'`. Log all discovered keys for debugging. Parse JSON values for all known keys.
- [x] **T40** — `src/harness/cursor.ts`: Implement a recursive JSON walker that searches any parsed value tree for message-like objects (objects containing both `role` and `content` fields). Collect all found messages. Extract `model` from sibling/parent fields if present.
- [x] **T41** — `src/harness/cursor.ts`: Build AgentMessages from discovered message objects. Implement session grouping by container structure (messages found within the same parent array = one session). Fall back to proximity grouping. Wrap every extraction step in try/catch with warning logs.
- [x] **T42** — `src/ContextMaster.ts`: Wire the full orchestration pipeline. On startup: (1) load CMSettings, (2) detect hostname + select machine, (3) for each harness: call deserializer → group by sessionId → call StorageWriter per session, (4) load all stored JSONs into MessageDB, (5) start Express server on port 3210, (6) log summary.
- [x] **T43** — `src/ContextMaster.ts`: Add error handling and resilience to the pipeline. Each harness runs in its own try/catch so one failing harness doesn't block others. Log per-harness stats: sessions found, messages written, errors encountered. Log total wall-clock time.
- [x] **T44** — End-to-end smoke test: run `bun run dev` and verify that (a) storage files are created with the correct directory structure, (b) subjects are generated with verbs + symbols, (c) the Express API responds to `GET /api/sessions` and `GET /api/search?q=test`.

---

### Group 5 — Subject Quality + Name Persistence Corrections

{{MEDIUM}}

- [x] **T45** — `src/models/AgentMessage.ts`: add `subject: string` to the class, constructor params, `serialize()`, and `deserialize()`. Default to empty string for backward compatibility with old JSON files.
- [x] **T46** — `src/analysis/SubjectGenerator.ts`: update subject generation to prioritize verbs. Preserve full verb section during truncation and only trim/drop symbol section as needed.
- [x] **T47** — `src/analysis/SubjectGenerator.ts`: normalize symbol extraction so anything after the first `.` is removed before counting (e.g. `TileView.tsx` → `TileView`).
- [x] **T48** — `src/storage/StorageWriter.ts`: compute one session subject, assign it to every `AgentMessage.subject` before writing, and use the same value for filename generation.
- [x] **T49** — `src/db/MessageDB.ts`: add `subject` column to schema + row mapping + inserts + deserialization. Include subject in query output and optional `subject` filter.
- [x] **T50** — `src/server/index.ts`: include `subject` in `/api/messages` filtering and `/api/search` weighted keys.
- [x] **T51** — `src/harness/kiro.ts`: derive project/workspace name from metadata JSON files in each Kiro hash root (when present), with existing tree/hash fallback behavior.
- [~] **T52** — `src/ContextMaster.ts` + smoke test: run pipeline using actual hostname from `cm.json`, verify Kiro output paths use friendly workspace names (not hash folders), and verify subjects are verb-forward in filenames/API payloads.
  - **Status (2026-03-06): Partially complete.** Hostname pathing and smoke-run validation are complete; Kiro naming logic was hardened further (generic labels like `listDirectory` / `folder` are now blocked), but historical storage already written with old names still exists and needs cleanup/re-ingest validation.

### Group 6 — Runtime Source Corrections (Post-Plan Validation)

{{COMPLEX}}

- [x] **T53** — `src/harness/vscode.ts`: resolve VS Code project names from `workspaceStorage/<hash>/workspace.json` (`workspace`/`folder` URI) instead of defaulting to hash folder names.
- [x] **T54** — `src/harness/vscode.ts`: harden JSONL request reconstruction parser to skip sparse/undefined request slots that were causing malformed-file skips.
- [x] **T55** — `src/utils/pathHelpers.ts`: normalize Cursor project derivation from `state.vscdb` to `global` (matches storage layout spec and expected output folder).
- [x] **T56** — `src/harness/cursor.ts`: add Cursor `cursorDiskKV` ingestion path for `bubbleId:*` records (actual runtime source of chat text in this environment), including:
  - Type mapping: `type=1` -> `user`, `type=2` -> `assistant`
  - Session grouping: from `bubbleId:<sessionId>:<bubbleId>`
  - Message extraction: `text` field (skip empty)
  - Context extraction: path mining from text and nested context/tool payloads
- [x] **T57** — `src/harness/cursor.ts`: preserve existing `ItemTable` fallback parser for compatibility, but prioritize `cursorDiskKV` when bubble data is present.
- [x] **T58** — Smoke test reruns after fixes:
  - VSCode: now writes under friendly workspace names (e.g. `NexusEvo.code-workspace`, `AXON.code-workspace`)
  - Cursor: now emits sessions/messages (example run: `sessions=250`, `messagesWritten=7307`)

---

### Group 7 — Additional Corrections (Cursor Workspace + Subject/File Naming)

{{COMPLEX}}

- [x] **T59** — `src/harness/cursor.ts`: add session-level workspace/project extraction instead of always defaulting to `global`.
  - Build a `sessionId -> project` lookup by scanning **all** relevant `cursorDiskKV` records (not only `bubbleId:*`) for workspace hints (`workspace`, `workspacePath`, `cwd`, `rootPath`, `folder`, file-URI roots, and path-like fields in nested payloads).
  - Parse `sessionId` from key patterns when available (for example keys containing session-scoped identifiers), then associate discovered workspace paths with that session.
  - Normalize discovered paths to a stable project label (path normalization + project-root heuristics + caches).
  - Keep `global` as fallback only when no reliable workspace can be inferred.
- [x] **T60** — `src/harness/cursor.ts`: strengthen DB discovery instrumentation for Cursor so we can prove coverage.
  - Log counts by key family queried (`bubbleId:*`, other chat/session families, workspace-metadata families).
  - Add debug metrics in one run report: sessions with inferred workspace, sessions falling back to `global`, and top unresolved key families.
  - Add a targeted query helper for runtime diagnostics so we can quickly validate whether a given session hash has any workspace evidence.
- [x] **T61** — `src/analysis/SubjectGenerator.ts`: split **storage subject** from **filename subject** to avoid truncation bleed-through.
  - Generate and persist a full session `subject` value first (independent from filename budget).
  - New persisted subject format: `"{10-verbs} [Keywords- {10-symbols}]"`, prioritizing verbs and keeping all 10 verb slots (with fallback placeholders when fewer are found).
  - Ensure `AgentMessage.subject` uses this full subject and is never reconstructed from filename.
- [~] **T62** — `src/storage/StorageWriter.ts`: update filename generation to use a compact, separate recipe.
  - Filename subject now follows **5 verb-subject pairs** from the first user message (filesystem-safe), independent from persisted full subject.
  - Pair rule: choose a verb, then the first following token that is **not** a preposition, adverb, or adjective.
  - Keep deterministic ordering and sanitization so reruns produce stable names.
  - Apply existing collision behavior (skip existing file) after the new filename recipe is computed.
- [ ] **T63** — `src/db/MessageDB.ts` + `src/server/index.ts`: enforce full-subject fidelity through DB/API.
  - Verify inserts/loads keep full `subject` text (no truncation to filename-derived value).
  - Keep subject-search support against full subject text, not filename fragments.
- [ ] **T64** — End-to-end validation pass for Group 7:
  - Cursor output path check: confirm per-session project/workspace folders are inferred when present (with explicit fallback cases listed).
  - Subject check: stored JSON `subject` field shows `10 verbs + [Keywords- 10 symbols]`.
  - Filename check: resulting file names contain `5 verb-subject pairs`.
  - Regression check: Kiro remains hash-only where unresolved (no attempted fake mapping).
- [x] **T65** — Cursor regression hotfix: restore chat ingestion after Group 7 changes.
  - Fix null/invalid `cursorDiskKV` values that caused runtime crash (`text.match` on non-string payloads).
  - Add defensive sqlite value normalization before JSON parse/path extraction.
  - Verify Cursor harness returns non-zero sessions/messages again (`sessions=252`, `messagesWritten=7347` in latest run).
- [x] **T66** — Runtime behavior fix: keep API process alive after startup.
  - Reproduce case where `Context Master API listening` logs and process exits to prompt.
  - Anchor server lifecycle in `ContextMaster` and validate foreground run does not terminate.
- [x] **T67** — Ignore `.specstory` artifacts in this upgrade cycle.
  - Leave `.specstory` files untouched; do not include them in correction scope.
- [ ] **T68** — Evaluate word-classification strategy for filename pairing quality.
  - Baseline implementation: POS filtering with existing wink pipeline.
  - Optional enhancement path: dictionary-backed `wordpos` for fast lexical disambiguation (verb/adverb/adjective), with explicit preposition list handling.
  - Decide after empirical comparison on real chat samples.
- [x] **T69** — `src/harness/kiro.ts`: revert Kiro project folder naming to configured hash roots from `cm.json`.
  - Ignore metadata-derived friendly workspace labels for Kiro output pathing in this cycle.
  - Ensure Kiro storage remains stable under hash directory names.
- [~] **T70** — `src/harness/cursor.ts`: map Cursor sessions to source project roots (not file basenames).
  - Normalize path hints to project directories (file -> parent directory).
  - Probe project-root boundaries using safe path heuristics and caches (filesystem-probing approach was removed due to runtime stalls).
  - Continue to fallback to `global` only when no valid project root can be inferred.
  - **Status (2026-03-06): Mostly complete.** Cursor now resolves many chats into source-project-like folders and no longer stalls in workspace inference. Some legacy/weird folder names still exist in storage from older runs and remaining edge-path heuristics.

---

## Open Questions / Decisions for Later

- **Cursor inner format**: In this runtime, Cursor chat payloads are in `cursorDiskKV` (`bubbleId:*`) rather than only in `ItemTable`. Keep dual-path parsing (`cursorDiskKV` primary + `ItemTable` fallback) because storage shape may vary by Cursor version.
- **Incremental ingestion**: MVP does a full re-ingest on every startup. Future: track file hashes or mtimes and only process new/changed sources.
- **Kiro tool call fidelity**: The implicit tool call structure in Kiro `.chat` files is lossy. Future: look for additional metadata files in Kiro storage.
- **VS Code JSONL reconstruction**: Request-slot sparsity can occur in large incremental sessions (now guarded). Future: add schema validation + telemetry for skipped sparse entries.
- **Authentication**: None for MVP (localhost only). Future: add API key middleware.
- **Subject quality**: Verb + symbol extraction is heuristic. Future: optional LLM-based summarization pass.
