# Better Search for ContextCore

**Date**: 2026-03-12
**Status**: Planning
**Scope**: Enhanced search query syntax + thread-based results endpoint

---

## 1. Problem Statement

### 1.1 Current Search Limitations

The current `/api/search?q=` endpoint has flat query semantics — the entire query string is passed to Fuse.js as a single fuzzy match term. This prevents:

- **Exact phrase matching**: No way to search for `"error handling"` as a literal phrase
- **OR queries**: `storyteller nncharacter` treats the space as part of the search, not as "match either term"
- **AND queries**: No way to require multiple terms all appear in the same message

### 1.2 Missing Thread-Level Results

Search currently returns individual `AgentMessage` objects. For discovery workflows, users often want to find **conversations** (sessions/threads) that match, not individual messages. Missing:

- Thread-level grouping of results
- Thread metadata (message count, total length, subject)
- The `length` field on `AgentMessage` to compute total thread length

---

## 2. Proposed Query Syntax

### 2.1 Operators

| Syntax | Meaning | Example |
|--------|---------|---------|
| `term` | Fuzzy match (default Fuse.js behavior) | `storyteller` |
| `"phrase"` | Exact substring match (case-insensitive) | `"error handling"` |
| `term1 term2` | OR — match messages containing **either** term | `storyteller nncharacter` |
| `term1 + term2` | AND — match messages containing **both** terms | `storyteller + nncharacter` |
| `"phrase" + term` | Mixed — exact phrase AND fuzzy term | `"tile info" + render` |

### 2.2 Parsing Algorithm

```
1. Tokenize the query:
   - Extract quoted phrases → exact match tokens
   - Split remaining text on ` + ` → AND groups
   - Split each AND group on whitespace → OR terms within group

2. For AND queries (contains `+`):
   - Search first term/phrase → result set A
   - For each subsequent term: filter A to messages matching that term
   - Return intersection (sequential filtering for performance)

3. For OR queries (space-separated, no `+`):
   - Execute search for each term
   - Merge results (union), dedupe by message ID
   - Sort by composite score (see §2.3)

4. For exact phrases (quoted):
   - Use simple substring match (case-insensitive) instead of Fuse.js fuzzy
```

**Design Decision — AND Query Strategy**: Sequential filtering (Option B). Search the first term, then filter the result set through each subsequent term. This is faster when the first term is selective, and avoids computing full result sets for all terms upfront.

### 2.3 Scoring Formula (Configurable)

For OR queries that merge multiple search results, we use a **hybrid scoring formula** that combines Fuse.js match scores with term match counts:

```typescript
type ScoringConfig = {
  scoreWeight: number;    // weight for normalized Fuse.js score (0-1)
  countWeight: number;    // weight for term match ratio (0-1)
  // scoreWeight + countWeight should equal 1.0
};

const DEFAULT_SCORING: ScoringConfig = {
  scoreWeight: 0.6,
  countWeight: 0.4,
};

function computeCompositeScore(
  avgFuseScore: number,      // average Fuse.js score across matched terms (0 = perfect)
  matchedTermCount: number,  // how many query terms this message matched
  totalTermCount: number,    // total terms in the query
  config: ScoringConfig = DEFAULT_SCORING
): number {
  // Fuse.js scores are 0 (perfect) to 1 (worst), invert for ranking
  const normalizedScore = 1 - avgFuseScore;
  const matchRatio = matchedTermCount / totalTermCount;

  return (normalizedScore * config.scoreWeight) + (matchRatio * config.countWeight);
}
```

Users can override the scoring function by providing a custom `ScoringConfig` or replacing `computeCompositeScore` entirely. The config could be passed via query param or set globally in `cc.json`.

### 2.4 Examples

| Query | Interpretation |
|-------|----------------|
| `storyteller nncharacter tileinfo` | OR: match any of the 3 terms |
| `storyteller + nncharacter` | AND: must contain both |
| `"NNCharacter"` | Exact: literal substring match |
| `storyteller + "tile info"` | AND: fuzzy "storyteller" AND exact "tile info" |
| `"error" + handler + config` | AND: exact "error" AND fuzzy "handler" AND fuzzy "config" |

---

## 3. Architecture Changes

### 3.1 New Module: `src/search/queryParser.ts`

Parses raw query strings into structured query objects.

```typescript
export type SearchToken =
  | { type: "fuzzy"; term: string }
  | { type: "exact"; phrase: string };

export type ParsedQuery =
  | { mode: "or"; tokens: SearchToken[] }
  | { mode: "and"; tokens: SearchToken[] };

/** Parse a raw search query into structured tokens and mode. */
export function parseSearchQuery(raw: string): ParsedQuery;

/** Check if a message matches an exact phrase (case-insensitive). */
export function matchesExact(message: string, phrase: string): boolean;
```

### 3.2 New Module: `src/search/searchEngine.ts`

Core search execution engine used by both `/api/search` and `/api/search/threads`.

```typescript
import Fuse from "fuse.js";
import type { AgentMessage } from "../models/AgentMessage.js";
import type { ParsedQuery, ScoringConfig } from "./queryParser.js";

export type SearchResult = {
  message: AgentMessage;
  score: number;           // composite score (higher = better match)
  matchedTerms: string[];  // which query terms matched
};

/** Initialize the Fuse.js index. Call once at server startup. */
export function initSearchIndex(messages: AgentMessage[]): void;

/** Execute a parsed query against the cached index. */
export function executeSearch(
  query: ParsedQuery,
  scoringConfig?: ScoringConfig
): SearchResult[];
```

**Why cache at module level?** The Fuse.js index is expensive to build (O(n) where n = message count). Since ingestion is a batch process at startup, the message data is static during runtime. Building the index once and reusing it across all search requests eliminates redundant computation. The cache lives at module scope in `searchEngine.ts`.

### 3.3 New Endpoint: `GET /api/search/threads`

Returns **distinct conversation threads** matching the query, not individual messages. Each thread appears once even if multiple messages match.

**Design Decision — Thread Deduplication**: Distinct threads only (Option A). For per-message search context, use `/api/search` (message-level results). The thread endpoint is for discovery of relevant conversations.

**Design Decision — No Pagination**: Returns all matching threads (no pagination). This matches the behavior of `/api/search` which also returns all results. Pagination was initially planned but removed to keep the API consistent and simple.

**Query params:**
- `q` — search query (same syntax as `/api/search`)

**Response shape:**

```typescript
type ThreadSearchResponse = {
  results: Array<{
    sessionId: string;
    subject: string;
    harness: string;
    messageCount: number;
    totalLength: number;        // sum of all message.length in thread
    firstDateTime: string;      // ISO datetime
    lastDateTime: string;       // ISO datetime
    firstMessage: string;       // content of first message (initial prompt)
    matchingMessageIds: string[]; // which messages matched the query
    bestMatchScore: number;     // highest composite score among matches
  }>;
  total: number;   // total matching threads (same as results.length)
  page: number;    // always 1 (no pagination)
};
```

### 3.4 Modified Endpoint: `GET /api/search`

The existing message-level search endpoint adopts the new query syntax. Response shape unchanged, but now supports:
- Exact phrases with quotes
- OR queries (space-separated)
- AND queries (plus-separated)

### 3.5 `length` Field on AgentMessage

**File:** `src/models/AgentMessage.ts` *(already implemented)*

- Field: `length: number` — character count of `message` field
- `deserialize()` computes from `message.length` if missing (backward compat)
- All harness readers must populate `length` when creating messages

---

## 4. Task Breakdown

Tasks are grouped by difficulty and sorted chronologically within each group.

---

### Group 1: Model & Config Updates

{{SIMPLE}}

- [x] **T1.1** Update `claude.ts` harness: add `length: message.length` to AgentMessage construction
- [x] **T1.2** Update `cursor.ts` harness: add `length: message.length` to AgentMessage construction
- [x] **T1.3** Update `kiro.ts` harness: add `length: message.length` to AgentMessage construction
- [x] **T1.4** Update `vscode.ts` harness: add `length: message.length` to AgentMessage construction
- [x] **T1.5** Add `length` column to MessageDB SQLite schema in `src/db/MessageDB.ts`
- [x] **T1.6** Update MessageDB `insert()` to persist `length` field
- [x] **T1.7** Update MessageDB `rowToMessage()` to read `length` from DB row

---

### Group 2: Query Parser Implementation

{{MEDIUM}}

- [x] **T2.1** Create `src/search/queryParser.ts` with type definitions (`SearchToken`, `ParsedQuery`, `ScoringConfig`)
- [x] **T2.2** Implement `extractQuotedPhrases(raw: string)`: returns array of exact phrases and remaining string
- [x] **T2.3** Implement `tokenize(raw: string)`: splits on ` + ` for AND, whitespace for OR
- [x] **T2.4** Implement `parseSearchQuery(raw: string)`: combines extraction and tokenization
- [x] **T2.5** Implement `matchesExact(message: string, phrase: string)`: case-insensitive substring match
- [x] **T2.6** Implement `computeCompositeScore()` with configurable weights
- [x] **T2.7** Export `DEFAULT_SCORING` config constant
- [x] **T2.8** Add JSDoc comments to all exported functions

---

### Group 3: Search Engine Core

{{MEDIUM}}

- [x] **T3.1** Create `src/search/searchEngine.ts` with type definitions (`SearchResult`)
- [x] **T3.2** Implement module-level Fuse.js index cache variable
- [x] **T3.3** Implement `initSearchIndex(messages)`: builds and caches Fuse.js index with weighted keys
- [x] **T3.4** Implement `executeFuzzySearch(term: string)`: searches cached index, returns raw Fuse results
- [x] **T3.5** Implement `executeExactSearch(phrase: string, messages: AgentMessage[])`: filters by substring
- [x] **T3.6** Implement `executeOrQuery(tokens: SearchToken[])`: union + dedupe + composite scoring
- [x] **T3.7** Implement `executeAndQuery(tokens: SearchToken[])`: sequential filtering through terms
- [x] **T3.8** Implement `executeSearch(query: ParsedQuery)`: dispatcher to OR/AND handlers

---

### Group 4: Server Integration

{{MEDIUM}}

- [x] **T4.1** Import `initSearchIndex` in `src/server/ContextServer.ts`
- [x] **T4.2** Call `initSearchIndex()` after MessageDB loads, before server starts
- [x] **T4.3** Import `parseSearchQuery` and `executeSearch` in server
- [x] **T4.4** Refactor `/api/search` handler to use new query parser and search engine
- [x] **T4.5** Remove old inline Fuse.js instantiation from `/api/search`
- [x] **T4.6** Add error handling for malformed queries (empty, unbalanced quotes)
- [x] **T4.7** Return 400 Bad Request with message for parse errors

---

### Group 5: Thread Endpoint Implementation

{{HARD}}

- [x] **T5.1** Add `getSessionMessages(sessionId: string)` method to MessageDB if not exists *(already exists as `getBySessionId`)*
- [x] **T5.2** Create `src/search/threadAggregator.ts` with `ThreadResult` type definition
- [x] **T5.3** Implement `aggregateToThreads(results: SearchResult[], db: MessageDB)`: groups by sessionId
- [x] **T5.4** Implement thread metadata computation: `messageCount`, `totalLength`, date range
- [x] **T5.5** Implement `bestMatchScore` selection (max composite score among matching messages)
- [x] **T5.6** Implement thread sorting by `bestMatchScore` descending
- [x] **T5.7** ~~Implement pagination logic for thread results~~ **REMOVED** - No pagination, return all results
- [x] **T5.8** Add `/api/search/threads` route in `src/server/ContextServer.ts`

{{HARD}}

- [x] **T5.9** Wire up thread endpoint to use `parseSearchQuery` → `executeSearch` → `aggregateToThreads`
- [x] **T5.10** Add `matchingMessageIds` array to each thread result
- [x] **T5.11** Handle edge case: empty query returns empty results (not all threads)
- [x] **T5.12** Add response shape validation (ensure all fields present)

---

### Group 6: Testing

{{MEDIUM}}

- [ ] **T6.1** Create `src/search/__tests__/queryParser.test.ts`
- [ ] **T6.2** Add test: simple fuzzy term parsing
- [ ] **T6.3** Add test: quoted exact phrase extraction
- [ ] **T6.4** Add test: OR query with multiple terms
- [ ] **T6.5** Add test: AND query with `+` separator
- [ ] **T6.6** Add test: mixed exact + fuzzy in AND query
- [ ] **T6.7** Add test: edge cases (empty query, only whitespace, unbalanced quotes)
- [ ] **T6.8** Add test: `matchesExact` case insensitivity

{{MEDIUM}}

- [ ] **T6.9** Create `src/search/__tests__/searchEngine.test.ts`
- [ ] **T6.10** Add test: OR query returns union of results
- [ ] **T6.11** Add test: AND query returns intersection
- [ ] **T6.12** Add test: exact phrase filters correctly
- [ ] **T6.13** Add test: composite scoring ranks multi-term matches higher
- [ ] **T6.14** Add test: empty result set handling

{{MEDIUM}}

- [ ] **T6.15** Create `src/search/__tests__/threadAggregator.test.ts`
- [ ] **T6.16** Add test: multiple messages in same session collapse to one thread
- [ ] **T6.17** Add test: `totalLength` is sum of all message lengths in session
- [ ] **T6.18** Add test: `matchingMessageIds` contains only IDs from search results
- [ ] ~~**T6.19** Add test: pagination returns correct slice~~ **REMOVED** - No pagination

---

### Group 7: Integration Testing & Polish

{{HARD}}

- [ ] **T7.1** Create `src/__tests__/search.integration.test.ts`
- [ ] **T7.2** Add E2E test: `/api/search?q=term` returns expected messages
- [ ] **T7.3** Add E2E test: `/api/search?q="exact phrase"` matches substring
- [ ] **T7.4** Add E2E test: `/api/search?q=term1 + term2` returns intersection
- [ ] **T7.5** Add E2E test: `/api/search/threads?q=term` returns thread summaries
- [ ] ~~**T7.6** Add E2E test: pagination works for both endpoints~~ **REMOVED** - No pagination
- [ ] **T7.7** Performance benchmark: search 10k messages, ensure <100ms response
- [ ] **T7.8** Update API documentation in `interop/insomnia-context-core.json`

---

### Group 8: Optional Enhancements

{{COMPLEX}}

- [ ] **T8.1** Add `scoringConfig` query param to override default weights
- [ ] **T8.2** Add `cc.json` setting for global scoring defaults
- [ ] **T8.3** Implement search result highlighting (which part of message matched)
- [ ] **T8.4** Add `snippet` field to thread results (preview of best-matching message)
- [ ] **T8.5** Consider Qdrant integration for hybrid scoring with semantic search
- [ ] **T8.6** Add query syntax help endpoint: `GET /api/search/help`

---

## 5. Design Decisions Summary

| Question | Decision | Rationale |
|----------|----------|-----------|
| Score normalization for OR queries | Hybrid: weighted average of Fuse.js scores + term match ratio | Configurable via `ScoringConfig`; balances relevance and coverage |
| AND query execution strategy | Sequential filtering (Option B) | Search first term, filter through subsequent terms; faster when first term is selective |
| Thread deduplication | Distinct threads only (Option A) | `/api/search` covers per-message results; thread endpoint is for conversation discovery |

---

## 6. Dependencies

- No new npm dependencies required
- Fuse.js already installed and supports required operations
- MessageDB already has `getSessionMessages()` or can be added trivially

---

## 7. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Complex queries slow down search | Implement query timeout; limit max tokens per query to 10 |
| AND queries return empty sets | Return empty gracefully; front-end can suggest removing terms |
| Backward compat breaks on `length` field | `deserialize()` computes from `message.length` if missing |
| Fuse.js index memory usage | Monitor; index is ~2x message text size; acceptable for <100k messages |
| First term in AND is unselective | Consider query optimizer in future; for now, document user should put selective terms first |

---

## 8. File Change Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `src/models/AgentMessage.ts` | Modified | Add `length` field *(done)* |
| `src/harness/claude.ts` | Modified | Populate `length` |
| `src/harness/cursor.ts` | Modified | Populate `length` |
| `src/harness/kiro.ts` | Modified | Populate `length` |
| `src/harness/vscode.ts` | Modified | Populate `length` |
| `src/db/MessageDB.ts` | Modified | Add `length` column and handling |
| `src/search/queryParser.ts` | **New** | Query parsing and scoring *(done)* |
| `src/search/searchEngine.ts` | **New** | Cached Fuse.js index and search execution *(done)* |
| `src/search/threadAggregator.ts` | **New** | Thread grouping and metadata *(done)* |
| `src/server/ContextServer.ts` | Modified | Integrate new search, add `/api/search/threads` *(done)* |
| `interop/insomnia-context-core.json` | Modified | Document new endpoint and query syntax |

---

## 9. First Message Enhancement (2026-03-12)

**Status**: ✅ Complete

### 9.1 Overview

Added `firstMessage` field to `AgentThread` type and thread search responses to provide better context about conversation threads.

### 9.2 Changes

- **`src/models/AgentThread.ts`** — Added `firstMessage: string` field to type definition
- **`src/search/threadAggregator.ts`** — Updated `aggregateToThreads()` and `getLatestThreads()` to populate `firstMessage`
- **`src/server/ContextServer.ts`** — Updated `/api/search/threads` and `/api/threads/latest` to include `firstMessage` in responses
- **`visualizer/src/types.ts`** — Added `firstMessage` to `SerializedAgentThread` type
- **`visualizer/src/components/HoverPanel.tsx`** — Display first message in thread hover panel (300 chars)
- **`visualizer/src/d3/chatMapEngine.ts`** — Display first message in thread cards (200 chars)
- **`visualizer/src/index.css`** — Added `.thread-excerpt` CSS style

### 9.3 Benefits

1. **Better Context**: Users can see the initial prompt that started each conversation
2. **Improved Discovery**: Thread browsing becomes more informative
3. **Enhanced UX**: Both cards and hover panels provide conversation context
4. **API Completeness**: Thread metadata now includes conversation starter

### 9.4 Implementation Details

The `firstMessage` field contains the full content of the first message in the thread (typically a user prompt). In the UI:
- Thread cards display first 200 characters with ellipsis
- Hover panels display first 300 characters with ellipsis
- Styling matches existing excerpt patterns for consistency
