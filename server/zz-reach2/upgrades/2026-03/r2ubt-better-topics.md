# R2UBT — AI-Powered Topic Summaries & Custom Thread Naming

**Date**: 2026-03-12
**Status**: Planned
**Scope**: Add GPT-5-nano-driven topic summarization for chat threads, persisted in `.settings/topics.json` isolated from AgentMessage storage. Replace NLP-derived subjects with AI summaries across all API responses. Prepare the `customTopic` field for future client-side renaming.

---

## Architecture Overview

### Data Flow

```
Startup → Load MessageDB → Load topics.json (if exists)
       → For each session without a topic entry:
            Build context → Call GPT-5-nano → Store result in topics.json
       → Start API server (with TopicStore injected)
       → All endpoints replace `subject` with `aiSummary` when available
```

### Context Assembly Algorithm

For each session, we build a text payload from the thread's messages:

1. **Loop** through messages in chronological order.
2. **User messages**: include full text.
3. **Assistant messages**: segment into paragraphs using LangChain `RecursiveCharacterTextSplitter`, then extract only the **first 2** and **last 2** paragraph chunks. Within each chunk, **truncate at the first code symbol** (`{` or `}`), discarding everything from that point onward.
4. **Tool messages**: skip entirely.
5. **Push** each processed segment into an array, maintaining a running character total.
6. **Budget enforcement** (150,000 chars max, last 50,000 guaranteed from end): continue processing all messages even when over budget. When total exceeds 150K, evict the **oldest** segment from the front of the array (subtracting its length from the total). This continues until total is back under 150K. The invariant is that segments from the final 50K chars of the chat are never evicted — they represent the tail of the conversation and must always be preserved.

### Storage

```
{storage}/
├── .settings/
│   └── topics.json          ← AI summaries + custom topics (isolated from AgentMessage wipes)
├── {machine}/               ← processed AgentMessages (can be wiped independently)
│   └── ...
```

`topics.json` structure:
```json
[
  {
    "sessionId": "a1b2c3d4e5f6",
    "charsSent": 84200,
    "aiSummary": "This chat covers implementing a dark mode toggle...",
    "customTopic": ""
  }
]
```

### Integration Points

- **`ContextCore.ts`**: Load TopicStore after MessageDB. Run summarization pipeline. Pass TopicStore to server.
- **`threadAggregator.ts`**: `aggregateToThreads()` and `getLatestThreads()` replace `subject` with `aiSummary`.
- **`ContextServer.ts`**: All message/thread endpoints apply topic replacement before sending response.
- **New files**: `TopicEntry.ts`, `TopicStore.ts`, `TopicContextBuilder.ts`, `TopicSummarizer.ts`.

---

## Implementation Plan

### Group 1 — Foundation: Types & Persistence

{{SIMPLE}}

- [x] **T1.** Create `src/models/TopicEntry.ts` — define `TopicEntry` type with fields: `sessionId: string`, `charsSent: number`, `aiSummary: string`, `customTopic: string`
- [x] **T2.** Create `src/settings/TopicStore.ts` — class skeleton with constructor that takes `storagePath: string` and computes `.settingsDir = join(storagePath, ".settings")` and `topicsFilePath = join(.settingsDir, "topics.json")`
- [x] **T3.** In `TopicStore` constructor, ensure `.settings/` directory exists (`mkdirSync` with `{ recursive: true }`)
- [x] **T4.** Implement `TopicStore.load()` — read `topics.json` with `readFileSync`, parse JSON array into `Map<string, TopicEntry>` keyed by sessionId. If file doesn't exist, initialize empty map silently
- [x] **T5.** Implement `TopicStore.save()` — serialize the entries map back to a JSON array and write to `topics.json` with 2-space indent formatting
- [x] **T6.** Implement `TopicStore.getBySessionId(sessionId): TopicEntry | undefined` and `TopicStore.upsert(entry: TopicEntry): void` (insert or update by sessionId)
- [x] **T7.** Implement `TopicStore.hasSession(sessionId): boolean` — quick check for skip logic during summarization
- [x] **T8.** Add `TopicStore.count` getter — returns number of entries (used for startup logging)

### Group 2 — Context Builder: Message Processing

{{HARD}}

- [x] **T9.** Create `src/analysis/TopicContextBuilder.ts` with method signature `buildContext(messages: AgentMessage[]): { text: string; charsSent: number }`
- [x] **T10.** Implement message loop: iterate messages chronologically, skip any message where `role === "tool"`, route `user` and `assistant` to separate handlers
- [x] **T11.** Implement user message handler: push the full `message.message` text as a segment into the segments array, add its length to running total
- [x] **T12.** Implement assistant message paragraph segmentation: use LangChain `RecursiveCharacterTextSplitter` with `separators: ["\n\n", "\n"]` and `chunkSize: 2000` / `chunkOverlap: 0` to split `message.message` into paragraph-level chunks
- [x] **T13.** From the segmented assistant chunks, extract the **first 2** and **last 2** chunks (if the message has ≤4 chunks, keep all). For each extracted chunk, scan for the first occurrence of `{` or `}` and truncate the chunk at that position (discard the symbol and everything after it). Skip chunks that become empty after truncation
- [x] **T14.** Implement the **150K char budget with 50K end guarantee**: maintain `segments: { text: string; fromTail: boolean }[]`. Mark segments from the last 50K chars of the conversation as `fromTail = true`. When total exceeds 150,000, evict the oldest segment where `fromTail === false` and subtract its length. Repeat until total ≤ 150K or only tail segments remain
- [x] **T15.** Assemble final context string: join all surviving segments with `"\n---\n"` separators. Return `{ text: joinedText, charsSent: joinedText.length }`

### Group 3 — AI Summarization Service

{{MEDIUM}}

- [x] **T16.** Create `src/analysis/TopicSummarizer.ts` class with constructor taking `topicStore: TopicStore` and `messageDB: MessageDB`
- [x] **T17.** Import `generateText` from `"ai"` and `openai` from `"@ai-sdk/openai"`. Configure model as `openai("gpt-5-nano")`
- [x] **T18.** Implement `summarizeSession(sessionId: string): Promise<TopicEntry | null>` — fetch messages via `messageDB.getBySessionId()`, build context via `TopicContextBuilder`, call `generateText()` with the prompt, return assembled `TopicEntry`
- [x] **T19.** Build the prompt string: `"Please summarize what this chat is about, in maximum 10 sentences. Only add all 10 sentences when the chat is very long. Use your best judgement to summarize as best as possible. Do not use fluff words. Save on prepositions and articles. Tech-speak! Here is the chat:\n\n"` + the built context text
- [x] **T20.** Implement `runPipeline(): Promise<void>` — get all unique session IDs from `messageDB.listSessions()`, filter out sessions already in `topicStore` (`hasSession()`), then process remaining sessions sequentially
- [x] **T21.** In `runPipeline()`, add a configurable delay between API calls (default 300ms) using `await new Promise(r => setTimeout(r, delay))` — prevents rate limiting from OpenAI
- [x] **T22.** After each successful summarization, immediately call `topicStore.upsert()` and `topicStore.save()` — ensures partial progress is persisted even if the pipeline is interrupted
- [x] **T23.** Add pipeline progress logging: `[Topics] Progress: N/M sessions summarized (S skipped, E errors)` — log every 10 sessions and at completion

### Group 4 — Startup Wiring & Server Injection

{{SIMPLE}}

- [x] **T24.** In `ContextCore.ts`, after `messageDB.loadFromStorage()`, instantiate `TopicStore` and call `load()`. Log: `[Topics] Loaded N topic entries from topics.json`
- [x] **T25.** In `ContextCore.ts`, after vector pipeline (or after MessageDB if Qdrant is disabled), instantiate `TopicSummarizer` and call `runPipeline()`. Wrap in try/catch so failure does not block server startup
- [x] **T26.** Modify `startServer()` signature in `ContextServer.ts` to accept an optional `topicStore?: TopicStore` parameter
- [x] **T27.** Update the `startServer()` call in `ContextCore.ts` to pass the loaded `TopicStore` instance
- [x] **T28.** Add a `GET /api/topics/:sessionId` endpoint in `ContextServer.ts` — returns the `TopicEntry` for the given session, or 404 if not found
- [x] **T29.** Add a `GET /api/topics` endpoint in `ContextServer.ts` — returns the full topic entries array (for client-side bulk access)

### Group 5 — Subject Replacement in API Responses

{{MEDIUM}}

- [x] **T30.** Create helper function `resolveSubject(sessionId: string, originalSubject: string, topicStore?: TopicStore): string` — returns `topicEntry.customTopic || topicEntry.aiSummary || originalSubject` (customTopic takes priority when non-empty, then aiSummary, then original)
- [x] **T31.** Modify `aggregateToThreads()` in `threadAggregator.ts` — add optional `topicStore?: TopicStore` parameter. When building each thread, call `resolveSubject()` to replace `subject`
- [x] **T32.** Modify `getLatestThreads()` in `threadAggregator.ts` — add optional `topicStore?: TopicStore` parameter. Apply same subject replacement logic
- [x] **T33.** Update `/api/search/threads` endpoint in `ContextServer.ts` to pass `topicStore` to `aggregateToThreads()`
- [x] **T34.** Update `/api/threads/latest` endpoint in `ContextServer.ts` to pass `topicStore` to `getLatestThreads()`
- [x] **T35.** In `/api/sessions/:sessionId` endpoint, after serializing messages, replace `subject` field on each serialized message using `resolveSubject()`
- [x] **T36.** In `/api/messages` endpoint, after serializing messages, apply `resolveSubject()` to each result
- [x] **T37.** In `/api/search` endpoint, after merging results, apply `resolveSubject()` to each serialized message in the response

### Group 6 — Resilience & Error Handling

{{SIMPLE}}

- [x] **T38.** In `TopicSummarizer.summarizeSession()`, wrap the `generateText()` call in try/catch — on failure, log `[Topics] Failed to summarize session {id}: {error}` and return `null` (skip session, don't crash pipeline)
- [x] **T39.** Add retry logic to `summarizeSession()`: on transient errors (429 rate limit, 5xx server errors), retry up to 3 times with exponential backoff (1s, 2s, 4s) — reuse the same pattern as `EmbeddingService.withRetry()`
- [x] **T40.** In `TopicStore.load()`, add defensive parsing: if `topics.json` exists but contains invalid JSON, log a warning and start with an empty map instead of crashing
- [x] **T41.** Verify isolation: `.settings/` lives at `{storage}/.settings/`, not under any `{machine}/` folder — wiping processed AgentMessages (which live under `{machine}/`) does not affect `topics.json`

---

## Files Created / Modified

| File                                  | Action       | Purpose                                                                   |
| ------------------------------------- | ------------ | ------------------------------------------------------------------------- |
| `src/models/TopicEntry.ts`            | **New**      | Type definition for topic entries                                         |
| `src/settings/TopicStore.ts`          | **New**      | Load/save/query `topics.json` from `.settings/`                          |
| `src/analysis/TopicContextBuilder.ts` | **New**      | Build AI-ready context from session messages                              |
| `src/analysis/TopicSummarizer.ts`     | **New**      | Orchestrate GPT-5-nano calls and persist results                          |
| `src/ContextCore.ts`                  | **Modified** | Load TopicStore, run summarization pipeline, pass to server               |
| `src/server/ContextServer.ts`         | **Modified** | Accept TopicStore, add `/api/topics` endpoints, apply subject replacement |
| `src/search/threadAggregator.ts`      | **Modified** | Accept TopicStore, replace subjects in thread results                     |

## Dependencies

- `ai` (Vercel AI SDK) — already installed, used for `generateText()`
- `@ai-sdk/openai` — already installed, used for `openai("gpt-5-nano")` model reference
- `@langchain/textsplitters` — already installed, used for paragraph segmentation
- `OPENAI_API_KEY` — already configured in environment (used by EmbeddingService)

## Notes

- ~~`customTopic` is always `""` for now — the client-side rename feature will POST to a new endpoint (future work)~~ → Implemented below in Group 7+8
- The `resolveSubject()` priority chain is: `customTopic` (if non-empty) > `aiSummary` (if non-empty) > original `subject`
- The summarization pipeline is **idempotent**: sessions already in `topics.json` are skipped on subsequent runs
- `topics.json` is saved after each successful summarization to ensure crash resilience
- The pipeline runs before the server starts, so all topics are available when the first API request arrives

---

## Custom Topic — User-Defined Thread Names

**Date**: 2026-03-13
**Status**: Planned
**Scope**: Accept user-defined `customTopic` per session via a POST endpoint. Custom topics take priority over AI summaries (existing `resolveSubject()` already handles this). Sessions with a non-empty `customTopic` are **skipped** by the summarization pipeline. Clearing the custom topic (sending empty string) removes the override and allows the pipeline to summarize the session on its next run.

### Endpoint Decision

The frontend originally used `POST /thread/set-custom-topic` with `{ sessionID, customTopic }`. This is **inconsistent** with the existing API convention:

- All endpoints live under `/api/` — there is no `/thread/` prefix
- Property `sessionID` (uppercase D) conflicts with `sessionId` (lowercase d) used everywhere

**Corrected endpoint**: `POST /api/topics` with body `{ sessionId: string, customTopic: string }`
This pairs naturally with the existing `GET /api/topics` (list all) and `GET /api/topics/:sessionId` (get one).

The frontend has been renamed accordingly in `ChatViewDialog.tsx`.

### Behavioral Rules

1. **Set custom topic**: `POST /api/topics` with `{ sessionId: "abc", customTopic: "My custom name" }` — upserts the topic entry, setting `customTopic`. If no entry exists yet (session was never AI-summarized), a new entry is created with `aiSummary: ""` and `charsSent: 0`.
2. **Clear custom topic**: `POST /api/topics` with `{ sessionId: "abc", customTopic: "" }` — clears the `customTopic` field. The session is now eligible for AI summarization on the next pipeline run. Until summarized, the original NLP-derived `subject` is used.
3. **Pipeline skip logic**: `TopicSummarizer.runPipeline()` skips sessions where the TopicStore entry has a non-empty `customTopic`, in addition to sessions already AI-summarized.
4. **Existing `resolveSubject()` chain** (already correct): `customTopic > aiSummary > original subject`.

### Implementation Plan

#### Group 7 — POST Endpoint & TopicStore Update

{{SIMPLE}}

- [x] **T42.** Add `POST /api/topics` endpoint in `ContextServer.ts` — parse `{ sessionId, customTopic }` from `req.body`. Validate that `sessionId` is a non-empty string. Return 400 if missing or invalid. Return 404 if topicStore is not available
- [x] **T43.** In the `POST /api/topics` handler: if `topicStore.hasSession(sessionId)`, fetch the existing entry via `getBySessionId()`, update only the `customTopic` field, and call `upsert()`. If the session does **not** exist in the store, create a new `TopicEntry` with `{ sessionId, charsSent: 0, aiSummary: "", customTopic }` and call `upsert()`
- [x] **T44.** After upserting, call `topicStore.save()` to persist immediately. Return `200` with the updated `TopicEntry` as JSON
- [x] **T45.** Add the new `POST /api/topics` endpoint to `interop/insomnia-context-core.json` — method POST, URL `{{ base_url }}/api/topics`, body `{ "sessionId": "{{ session_id }}", "customTopic": "My custom name" }`, content-type `application/json`

#### Group 8 — Pipeline Skip Logic & Clearing Behavior

{{SIMPLE}}

- [x] **T46.** In `TopicSummarizer.runPipeline()`, modify the filter: skip sessions where `topicStore.hasSession(sessionId)` **AND** the entry has either a non-empty `aiSummary` or a non-empty `customTopic`. This replaces the current simple `hasSession()` check — a session with only `customTopic` set should be skipped, a session with entry `{ aiSummary: "", customTopic: "" }` (cleared custom topic, never AI-summarized) should be processed
- [x] **T47.** Add a `TopicStore.shouldSkipSummarization(sessionId): boolean` helper — returns `true` if the session has a non-empty `aiSummary` or a non-empty `customTopic`. Returns `false` if no entry exists or both fields are empty. Use this in the pipeline filter instead of raw `hasSession()`
- [x] **T48.** Update pipeline progress logging to distinguish custom-topic skips from AI-summary skips: `[Topics] Starting summarization pipeline: N to process, S already summarized, C custom-named (T total)`
- [ ] **T49.** Rebuild the visualizer (`cd visualizer && bun run build`) to include the renamed endpoint. Verify the `POST /api/topics` call works end-to-end by setting and clearing a custom topic via the ChatViewDialog UI

---

### Files Modified (Custom Topic Feature)

| File                                           | Action       | Purpose                                                                                            |
| ---------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| `src/server/ContextServer.ts`                  | **Modified** | Add `POST /api/topics` endpoint                                                                    |
| `src/settings/TopicStore.ts`                   | **Modified** | Add `shouldSkipSummarization()` helper                                                             |
| `src/analysis/TopicSummarizer.ts`              | **Modified** | Use `shouldSkipSummarization()` in pipeline filter                                                 |
| `interop/insomnia-context-core.json`           | **Modified** | Add POST /api/topics request definition                                                            |
| `visualizer/src/components/ChatViewDialog.tsx` | **Modified** | Renamed endpoint from `/thread/set-custom-topic` to `/api/topics`, fixed `sessionID` → `sessionId` |

---

## Pass 2 — Smarter Model Re-Summarization for Verbose Topics

**Date**: 2026-03-16
**Status**: Planned
**Scope**: After the pass 1 pipeline completes, scan all topic entries for `aiSummary` exceeding 1500 characters. Re-summarize those sessions using a smarter model (`AI_SUMMARIZATION_MODEL_PASS_2`, default `gpt-5-mini`) with the same prompt and context-building workflow. The result overwrites the existing `aiSummary`. This ensures all summaries stay concise even when pass 1's cheaper model produces overly long output.

### Design

**Trigger**: At startup, after `runPipeline()` (pass 1) completes, a second pass iterates all topic entries in `TopicStore`. Any entry whose `aiSummary.length > 1500` (and has no `customTopic` override) is queued for re-summarization.

**Model selection**: `TopicSummarizer` currently hardcodes `openai("gpt-5-nano")`. We parameterize the model name so the same class can be used for both passes. The model string comes from `AI_SUMMARIZATION_MODEL_PASS_1` / `AI_SUMMARIZATION_MODEL_PASS_2` environment variables.

**Same prompt, same workflow**: Pass 2 reuses `buildContext()`, the same prompt prefix, the same retry logic, and the same `TopicStore` persistence. The only differences are: (1) the model, and (2) the candidate selection (entries with long `aiSummary` instead of entries with no `aiSummary`).

**Idempotency**: Once an entry's `aiSummary` is ≤1500 chars after pass 2, it won't be re-processed on subsequent runs. Entries with a `customTopic` are always skipped regardless of summary length.

```
Startup → Pass 1 (gpt-5-nano): summarize sessions with no aiSummary
        → Pass 2 (gpt-5-mini): re-summarize sessions where aiSummary > 1500 chars
        → Start API server
```

### Implementation Plan

#### Group 9 — Parameterize Model in TopicSummarizer

{{SIMPLE}}

- [x] **T50.** Add a `modelName: string` parameter to `TopicSummarizer`'s constructor (default `"gpt-5-nano"`). Store as `this.modelName`. Replace the hardcoded `openai("gpt-5-nano")` call in `summarizeSession()` with `openai(this.modelName)`
- [x] **T51.** In `ContextCore.ts`, read `process.env.AI_SUMMARIZATION_MODEL_PASS_1` (default `"gpt-5-nano"`) and pass it to the `TopicSummarizer` constructor for pass 1

#### Group 10 — Pass 2 Pipeline Method

{{MEDIUM}}

- [x] **T52.** Add `TopicStore.getVerboseEntries(maxChars: number): TopicEntry[]` — returns all entries where `aiSummary.trim().length > maxChars` and `customTopic.trim().length === 0` (custom topics are never re-summarized)
- [x] **T53.** Add `runPass2(maxSummaryChars: number): Promise<void>` method to `TopicSummarizer`. This method calls `topicStore.getVerboseEntries(maxSummaryChars)` to get candidates, then for each candidate: calls `summarizeSession(sessionId)`, and if the result is non-null, calls `topicStore.upsert()` + `topicStore.save()`. Uses the same rate-limit delay and progress logging pattern as `runPipeline()`
- [x] **T54.** In `runPass2()`, log at start: `[Topics/Pass2] Starting pass 2 re-summarization (model: {modelName}): N sessions with aiSummary > {maxChars} chars`. Log per-session: `[Topics/Pass2] [{i}/{N}] {sessionId} → {oldLen} → {newLen} chars`. Log at end: `[Topics/Pass2] Complete: N re-summarized, E errors`

#### Group 11 — Startup Wiring for Pass 2

{{SIMPLE}}

- [x] **T55.** In `ContextCore.ts`, after the pass 1 `topicSummarizer.runPipeline()` block, read `process.env.AI_SUMMARIZATION_MODEL_PASS_2` (default `"gpt-5-mini"`). If the value is non-empty and differs from pass 1 model, create a **second** `TopicSummarizer` instance with the pass 2 model and call `runPass2(1500)` on it. Wrap in try/catch so failure does not block server startup
- [x] **T56.** Add a `SKIP_AI_SUMMARIZATION_PASS_2` env var check (default `"false"` when summarization is enabled). When `"true"`, skip pass 2 entirely. Log: `[Topics/Pass2] Skipped (set SKIP_AI_SUMMARIZATION_PASS_2=false to enable)`

---

### Files Modified (Pass 2 Feature)

| File                              | Action       | Purpose                                                                          |
| --------------------------------- | ------------ | -------------------------------------------------------------------------------- |
| `src/analysis/TopicSummarizer.ts` | **Modified** | Parameterize model name, add `runPass2()` method                                 |
| `src/settings/TopicStore.ts`      | **Modified** | Add `getVerboseEntries()` helper                                                 |
| `src/ContextCore.ts`              | **Modified** | Wire pass 2 after pass 1, read env vars for model names                          |
| `.env`                            | **Modified** | Already has `AI_SUMMARIZATION_MODEL_PASS_1` and `AI_SUMMARIZATION_MODEL_PASS_2`  |

### Notes

- Both passes share the same `TopicStore` instance — pass 2 overwrites the `aiSummary` that pass 1 wrote
- Pass 2 uses the same `buildContext()` and prompt prefix — the smarter model is simply better at respecting the character/sentence constraints
- The 1500-char threshold is passed as a parameter to `runPass2()`, not hardcoded, so it can be tuned later
- On a fresh install with no `topics.json`, pass 1 runs first (all sessions), then pass 2 runs immediately on any verbose results — both complete before the server starts
