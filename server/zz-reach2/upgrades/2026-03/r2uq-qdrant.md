# Qdrant Vector Search Integration

**Date**: 2026-03-09 (revised 2026-03-10)
**Scope**: Enhance ContextCore search with optional Qdrant-based semantic search
**Dependencies**: `@qdrant/js-client-rest`, `ai` (Vercel AI SDK), `@ai-sdk/openai`, `@langchain/textsplitters`

---

## Overview

ContextCore currently uses Fuse.js for fuzzy text search (`/api/search`). This upgrade **enhances** (not replaces) the existing search with an optional **vector search pipeline** powered by Qdrant and OpenAI embeddings. When Qdrant is available, the existing `/api/search` endpoint combines Fuse.js fuzzy results with Qdrant semantic results using weighted scoring (75% Qdrant, 25% Fuse.js). When Qdrant is not configured, search works exactly as before.

### Activation

Qdrant is enabled when **both** `QDRANT_URL` and `OPENAI_API_KEY` are defined in `.env`. No `QDRANT_ENABLED` flag needed — presence of these two keys is the signal.

### Per-Harness Collections

Qdrant collections are created **per harness per machine**, using the naming convention:

```
CXC_{HOSTNAME}_{Harness}
```

Examples: `CXC_KYLIATHY3_Kiro`, `CXC_KYLIATHY3_ClaudeCode`, `CXC_KYLIATHY3_Cursor`, `CXC_KYLIATHY3_VSCode`

This keeps embeddings partitioned by source, allows per-harness search, and makes cross-machine sync clean.

### Chunking Strategy — LangChain Text Splitters

Instead of a naive paragraph window, we use `@langchain/textsplitters` — specifically `RecursiveCharacterTextSplitter` — for intelligent chunking. A **content classifier** (`classifyBlob()`) routes each message to the appropriate splitter:

| Content Kind | Splitter | Strategy |
| ------------ | -------- | -------- |
| **prose** | `RecursiveCharacterTextSplitter` (default separators) | Chunk at paragraph/sentence boundaries |
| **code** | `RecursiveCharacterTextSplitter.fromLanguage(lang)` | Language-aware splitting (respects function/class boundaries) |
| **mixed** | Span parser → route each span | Fenced code blocks split from prose, each routed to the right splitter |
| **unknown** | Default `RecursiveCharacterTextSplitter` | Fall back to prose-style chunking |

The classifier uses weighted heuristics (not LLM calls): code punctuation density, keyword presence, stopword density, sentence structure, line-ending semicolons, and fenced code blocks. Short snippets (<30 chars) require stronger evidence to classify.

#### Splitter Configuration

```
Prose:  chunkSize=1000, chunkOverlap=150
Code:   chunkSize=1200, chunkOverlap=120
```

### Combined Search & Deduplication

When Qdrant is enabled, `/api/search` runs **both** engines in parallel:

1. **Fuse.js** — existing fuzzy search (scores 0..1, lower is better)
2. **Qdrant** — semantic vector search (scores 0..1, higher is better, threshold ≥ 0.6)

Results are merged by `messageId`. When the same message appears in both result sets, scores are combined:

```
combinedScore = (qdrantScore × 0.75) + (normalizedFuseScore × 0.25)
```

Where `normalizedFuseScore = 1 - fuseScore` (Fuse uses 0=perfect, 1=worst; we invert it).

Messages appearing only in Qdrant results use `qdrantScore × 0.75` as the combined score.
Messages appearing only in Fuse.js results use `normalizedFuseScore × 0.25`.

### Qdrant Point Payload

Each Qdrant point stores this metadata alongside the vector:

```typescript
{
  messageId: string,      // AgentMessage.id — for resolution via MessageDB
  sessionId: string,      // for grouping
  chunkIndex: number,     // position within the message's chunks
  chunkText: string,      // the actual text of this chunk (stored as metadata)
  harness: string,        // source harness name
  project: string,        // project label
  contentKind: string,    // "prose" | "code" | "mixed" | "unknown"
}
```

### New Models

Two new model classes support the enhanced search:

**`AgentMessageFound`** (`src/models/AgentMessageFound.ts`) — extends `AgentMessage` with search scoring:
- `qdrantScore: number | null` — semantic similarity score (null when Qdrant is disabled)
- `fuseScore: number | null` — fuzzy match score (null when message only found via Qdrant)
- `combinedScore: number` — weighted composite score for final ranking

**`SearchResults`** (`src/models/SearchResults.ts`) — encapsulates search response:
- `results: AgentMessageFound[]` — ranked results
- `query: string` — the original query
- `engine: "fuse" | "qdrant" | "hybrid"` — which engines contributed
- `totalFuseResults: number` — count before merge
- `totalQdrantResults: number` — count before merge

### Architecture Integration

```
                    ┌──→ Fuse.js fuzzy search ──→ fuseScore per message ──┐
/api/search?q= ──→ │                                                      │──→ merge by messageId ──→ AgentMessageFound[] ──→ SearchResults
                    └──→ EmbeddingService ──→ QdrantService ──→ qdrantScore ──┘
                         (skip if Qdrant disabled)
```

Ingestion flow:
```
AgentMessage[] ──→ classifyBlob() ──→ LangChain Splitter ──→ EmbeddingService (OpenAI) ──→ QdrantService (upsert per harness collection)
```

New/modified modules:

| Module | Path | Responsibility |
| ------ | ---- | -------------- |
| `VectorConfig` | `src/vector/VectorConfig.ts` | Load `.env`, expose `isQdrantEnabled()`, env constants |
| `ContentClassifier` | `src/vector/ContentClassifier.ts` | `classifyBlob()` — heuristic code/prose/mixed classifier |
| `Chunker` | `src/vector/Chunker.ts` | LangChain splitter routing based on content kind |
| `EmbeddingService` | `src/vector/EmbeddingService.ts` | OpenAI embedding generation via Vercel AI SDK |
| `QdrantService` | `src/vector/QdrantService.ts` | Qdrant client: multi-collection management, upsert, search |
| `VectorPipeline` | `src/vector/VectorPipeline.ts` | Orchestrator: classify → chunk → embed → upsert |
| `AgentMessageFound` | `src/models/AgentMessageFound.ts` | Extended message with search scores |
| `SearchResults` | `src/models/SearchResults.ts` | Combined search response container |

---

## Tasks

### Group 1 — Setup & Scaffolding

{{SIMPLE}}

- [x] Install `@qdrant/js-client-rest` via `bun add`
- [x] Install `ai` and `@ai-sdk/openai` via `bun add`
- [x] Install `@langchain/textsplitters` via `bun add`
- [x] Create `.env.example` at project root with: `QDRANT_URL`, `QDRANT_API_KEY`, `OPENAI_API_KEY`, `QDRANT_MIN_SCORE`, `EMBEDDING_BATCH_DELAY_MS`
- [x] Add `.env.local` and `.env` to `.gitignore`
- [x] Create `src/vector/VectorConfig.ts` — reads env vars via `process.env`, exports typed config object and `isQdrantEnabled()` helper (returns `true` only when both `QDRANT_URL` and `OPENAI_API_KEY` are set)
- [x] Create `src/vector/` directory and an `index.ts` barrel export

### Group 2 — Content Classifier

{{MEDIUM}}

- [x] Create `src/vector/ContentClassifier.ts` with `classifyBlob(text: string): ContentKind` where `ContentKind = "prose" | "code" | "mixed" | "unknown"`
- [x] Implement weighted heuristic scoring:
  - **Code signals**: fenced code blocks (```` ``` ````), line-ending semicolons, code keywords (`function`, `class`, `import`, `const`, `return`, etc.), syntax punctuation density (`{}`, `()`, `[]`, `=>`, `::`), declaration patterns (`public/private/protected` + identifier)
  - **Prose signals**: stopword density (`the`, `and`, `is`, `this`, `some`, etc.), sentence punctuation, word count ≥ 8, camelCase tokens appearing inside otherwise ordinary sentences
- [x] Handle short snippets: below 30 chars require stronger evidence to classify (default to `"unknown"` when evidence is weak)
- [x] Implement `splitMixedContent(text: string): Array<{ text: string, kind: ContentKind }>` — splits fenced code blocks from surrounding prose, returning tagged spans

### Group 3 — Chunking Logic (LangChain)

{{MEDIUM}}

- [x] Create `src/vector/Chunker.ts` that imports `RecursiveCharacterTextSplitter` from `@langchain/textsplitters`
- [x] Implement `chunkMessage(message: string): Promise<Array<{ text: string, kind: ContentKind, index: number }>>`:
  1. Run `classifyBlob()` on the full message
  2. If `"mixed"` → call `splitMixedContent()` to get tagged spans, then route each span to the appropriate splitter
  3. If `"code"` → use `RecursiveCharacterTextSplitter.fromLanguage("js", { chunkSize: 1200, chunkOverlap: 120 })` (default to JS/TS since our sources are IDE chats about code)
  4. If `"prose"` or `"unknown"` → use `new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 150 })`
- [x] Handle edge cases: empty message returns `[]`, very short messages (< 100 chars) become a single chunk
- [x] Each chunk carries its `ContentKind` tag for storage in Qdrant payload metadata

### Group 4 — Embedding Service

{{MEDIUM}}

- [x] Create `src/vector/EmbeddingService.ts` class with constructor accepting OpenAI API key
- [x] Implement `embed(text: string): Promise<number[]>` — generates a single embedding vector using Vercel AI SDK's `embed()` with OpenAI's `text-embedding-3-large` model
- [x] Implement `embedBatch(texts: string[]): Promise<number[][]>` — generates embeddings for multiple texts using Vercel AI SDK's `embedMany()`, respecting OpenAI's batch limits
- [x] Add retry logic with exponential backoff (3 attempts, 1s/2s/4s delays) for transient OpenAI API failures
- [x] Export embedding vector dimension as a constant (`EMBEDDING_DIMENSIONS = 3072` for `text-embedding-3-large`)

### Group 5 — Qdrant Service (Multi-Collection)

{{MEDIUM}}

- [x] Create `src/vector/QdrantService.ts` class with constructor accepting Qdrant URL, API key, and hostname prefix
- [x] Define `QdrantPointPayload` type: `{ messageId: string, sessionId: string, chunkIndex: number, chunkText: string, harness: string, project: string, contentKind: string }`
- [x] Implement `getCollectionName(harness: string): string` — returns `CXC_{HOSTNAME}_{harness}` (e.g. `CXC_KYLIATHY3_Kiro`)
- [x] Implement `ensureCollection(harness: string): Promise<void>` — creates per-harness collection if not exists, with cosine distance and vector size 3072
- [x] Implement `upsertPoints(harness: string, points: { id: string, vector: number[], payload: QdrantPointPayload }[]): Promise<void>` — batch upsert to the harness-specific collection
- [x] Implement `search(harnesses: string[], vector: number[], limit: number, minScore: number): Promise<Array<{ score: number, payload: QdrantPointPayload }>>` — searches across one or more harness collections, filters by score threshold (default 0.6), merges and re-sorts results
- [x] Implement `hasMessagePoints(harness: string, messageId: string): Promise<boolean>` — scroll/count by payload filter to check if a message is already indexed (for deduplication)
- [x] Implement `getCollectionInfo(harness: string): Promise<{ pointsCount: number } | null>` — returns collection stats or null if unreachable

### Group 6 — Search Models

{{SIMPLE}}

- [x] Create `src/models/AgentMessageFound.ts`:
  - Extends `AgentMessage` with `qdrantScore: number | null`, `fuseScore: number | null`, `combinedScore: number`
  - Override `serialize()` to include the three score fields in the output
  - Static factory `fromAgentMessage(msg: AgentMessage, scores: { qdrantScore?: number, fuseScore?: number }): AgentMessageFound` — computes `combinedScore` using the 75/25 weighting formula
- [x] Create `src/models/SearchResults.ts`:
  - Properties: `results: AgentMessageFound[]`, `query: string`, `engine: "fuse" | "qdrant" | "hybrid"`, `totalFuseResults: number`, `totalQdrantResults: number`
  - Method `serialize()` for API response
  - Static factory `merge(fuseHits, qdrantHits, query): SearchResults` — deduplicates by `messageId`, computes combined scores, sorts descending, determines `engine` label

### Group 7 — Vector Pipeline (Orchestration)

{{HARD}}

- [x] Create `src/vector/VectorPipeline.ts` class composing `EmbeddingService`, `QdrantService`, and `Chunker`
- [x] Implement `processMessages(messages: AgentMessage[]): Promise<VectorPipelineStats>` — main entry point: groups messages by harness, ensures each harness collection exists, then iterates messages, chunks each via `Chunker`, generates embeddings, upserts to the correct harness collection
- [x] Define `VectorPipelineStats` type: `{ messagesProcessed: number, chunksGenerated: number, embeddingsCreated: number, skipped: number, errors: number, collectionsCreated: string[] }`
- [x] Add deduplication: before processing a message, call `hasMessagePoints(harness, messageId)` to skip already-indexed messages
- [x] Implement batch processing: process messages in configurable batch sizes (default 50) with progress logging after each batch
- [x] Generate deterministic Qdrant point IDs using UUID v5 from `messageId + chunkIndex` to ensure idempotent upserts
- [x] Add graceful error handling: if a single message fails embedding/upsert, log warning and continue with the next message

### Group 8 — Enhanced Search Integration

{{HARD}}

- [x] Modify `ContextServer.ts` `startServer()` to accept optional `EmbeddingService` and `QdrantService` instances (nullable)
- [x] Enhance the existing `GET /api/search` endpoint:
  1. Run Fuse.js search as before → collect `fuseHits` with scores
  2. If Qdrant is available: embed query via `EmbeddingService`, search all harness collections via `QdrantService.search()` with `minScore=0.6`, resolve `messageId`s via `MessageDB.getById()` → collect `qdrantHits`
  3. Call `SearchResults.merge(fuseHits, qdrantHits, query)` to deduplicate and compute weighted scores
  4. Return `SearchResults.serialize()` — the response now includes `qdrantScore`, `fuseScore`, and `combinedScore` per result, plus metadata about which engines contributed
- [x] When Qdrant is disabled, search works exactly as before but wraps results in the new `SearchResults` format (with `engine: "fuse"`, `qdrantScore: null`)
- [x] In `ContextCore.ts`: after `messageDB.loadFromStorage()`, check `isQdrantEnabled()`. If true:
  1. Instantiate `EmbeddingService` and `QdrantService`
  2. Run startup health check via `getCollectionInfo()` on a probe collection
  3. Instantiate `VectorPipeline` and call `processMessages(messageDB.getAllMessages())`
  4. Log `VectorPipelineStats` summary (messages, chunks, embeddings, skipped, errors, collections, wall-clock time)
  5. Pass `EmbeddingService` and `QdrantService` to `startServer()`

### Group 9 — Resilience & Observability

{{MEDIUM}}

- [x] Add startup health check: on `VectorPipeline` init, attempt `getCollectionInfo()` and log collection point counts per harness, or log warning and disable vector ops if Qdrant is unreachable
- [x] Add rate limiting for OpenAI calls: implement a simple delay between batches (configurable via `EMBEDDING_BATCH_DELAY_MS` in `.env.example`, default 200ms)
- [x] Ensure enhanced `/api/search` gracefully falls back to Fuse-only results if Qdrant becomes unreachable mid-session (catch connection errors, log warning, return Fuse-only `SearchResults` with `engine: "fuse"`)
- [x] Add `QDRANT_MIN_SCORE` default of `0.6` in `VectorConfig.ts`, used by search to filter low-confidence Qdrant results

### Group 10 — Documentation

{{SIMPLE}}

- [ ] Update `archi-context-core.md` section 1 (System Overview) to mention optional Qdrant vector search
- [ ] Add new section to `archi-context-core.md`: "Vector Search Pipeline" with Mermaid diagrams covering content classification, LangChain chunking strategy, embedding flow, per-harness collection model, and hybrid search merge flow
- [ ] Update the API Surface table — document the enhanced `/api/search` response format with score fields
- [ ] Update the Technology Stack table with Qdrant, Vercel AI SDK, OpenAI, and LangChain text splitters
- [ ] Add vector search requests to `interop/insomnia-context-core.json`
- [ ] Document the `AgentMessageFound` and `SearchResults` models in the Data Model section

---

## Design Notes

### Why LangChain text splitters but not full LangChain?

Per the architecture discussion, LangChain's primary value here is **chunking ergonomics**, not retrieval orchestration. Specifically:

- `RecursiveCharacterTextSplitter` handles paragraph/sentence boundary detection better than naive `\n\n` splitting
- `fromLanguage()` provides language-aware separators for JS/TS/Python/Rust/etc., respecting function and class boundaries
- We avoid the full LangChain cathedral — no LangChain loaders, retrievers, or vector store wrappers

Vercel AI SDK remains the embedding gateway. The raw Qdrant TS client remains the vector database interface.

### Why per-harness collections?

- Clean separation of embedding spaces (Cursor chats have different characteristics than Claude Code sessions)
- Enables per-harness or cross-harness search at query time
- Makes it trivial to rebuild or drop one harness's embeddings without affecting others
- Collection names (`CXC_KYLIATHY3_Kiro`) are self-documenting in the Qdrant dashboard

### Why enhance `/api/search` instead of adding `/api/vector-search`?

- Single endpoint for the UI to consume — no client-side merge logic needed
- Graceful degradation: same endpoint works with or without Qdrant
- The `engine` field in `SearchResults` tells the client what contributed
- Individual `qdrantScore` and `fuseScore` on each `AgentMessageFound` provide full transparency

### Content classification rationale

The `classifyBlob()` heuristic handles the fact that AI chat messages are frequently **mixed**: prose explaining code, interspersed with fenced code blocks and inline identifiers. The classifier doesn't need to be perfect — it routes to `RecursiveCharacterTextSplitter` either way, just with different separator configurations. The cost of misclassification is suboptimal chunk boundaries, not data loss.
