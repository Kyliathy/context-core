# Search Scoring & Aggregation Review

**Date**: 2026-03-21
**Scope**: Scoring logic, field filtering, and result aggregation across all search scenarios
**References**: [`archi-search.md`](../../architecture/search/archi-search.md), [`archi-qdrant.md`](../../architecture/search/archi-qdrant.md)

---

## 1. Overview

This document maps the **scoring formulas** and **aggregation behavior** across every combination of search inputs (query, symbols, subject) and runtime modes (Qdrant enabled/disabled). The goal is to surface inconsistencies and identify tuning points.

The search system has four input dimensions that combine to determine which code paths execute:

| Dimension       | Values             | Source                                   |
| --------------- | ------------------ | ---------------------------------------- |
| **query** (`q`) | present / absent   | POST body `query` or GET `?q=`           |
| **symbols**     | present / absent   | POST body `symbols`                      |
| **subject**     | present / absent   | POST body `subject`                      |
| **Qdrant**      | enabled / disabled | Runtime: `QDRANT_URL` + `OPENAI_API_KEY` |

---

## 2. Scoring Formulas Reference

### 2.1 Fuse.js Composite Score (OR mode)

Used by `computeCompositeScore()` in `queryParser.ts`:

```
normalizedScore = 1 − avgFuseScore          // invert: Fuse 0=best → 1=best
matchRatio      = matchedTerms / totalTerms  // breadth: 0→1

compositeScore  = (normalizedScore × scoreWeight) + (matchRatio × countWeight)
```

| Parameter     | Default | Tunable via       |
| ------------- | ------- | ----------------- |
| `scoreWeight` | **0.6** | `DEFAULT_SCORING` |
| `countWeight` | **0.4** | `DEFAULT_SCORING` |

**Range**: 0.0 – 1.0 (higher = better).

### 2.2 Fuse.js Composite Score (AND mode)

Same formula as OR, but `matchedTerms === totalTerms` always (all tokens must match), so `matchRatio` is always **1.0**. The formula simplifies to:

```
compositeScore = (1 − fuseScore) × 0.6 + 1.0 × 0.4
               = (1 − fuseScore) × 0.6 + 0.4
```

**Range**: 0.4 – 1.0 (the countWeight term is a fixed floor).

### 2.3 Exact Phrase Score

Exact phrases (quoted `"..."`) bypass Fuse.js entirely. They produce `fuseScore = 0` (perfect), so:

```
compositeScore = (1 − 0) × 0.6 + matchRatio × 0.4 = 0.6 + matchRatio × 0.4
```

If the query is a single exact phrase, `matchRatio = 1.0` → **compositeScore = 1.0**.

### 2.4 Hybrid Combined Score (`AgentMessageFound`)

Used by `AgentMessageFound.fromAgentMessage()` when merging Fuse + Qdrant:

```
normalizedFuse  = fuseScore !== null ? (1 − fuseScore) : 0
qdrantWeight    = qdrantScore !== null ? qdrantScore × 0.75 : 0
fuseWeight      = fuseScore !== null ? normalizedFuse × 0.25 : 0

combinedScore   = qdrantWeight + fuseWeight
```

| Weight | Value    | Tunable in                    |
| ------ | -------- | ----------------------------- |
| Qdrant | **0.75** | `AgentMessageFound.ts` L81-82 |
| Fuse   | **0.25** | `AgentMessageFound.ts` L81-82 |

**Range**: 0.0 – 1.0 (higher = better).

### 2.5 Field-Only Score

When no query `q` is provided (field-only search with symbols/subject), `messagesToResults()` assigns:

```
score = 1.0   (fixed)
matchedTerms = []
```

All matching messages are scored equally — no relevance ranking. Results sorted by `dateTime` descending.

---

## 3. Scenario Matrix — Message Search (`POST /api/search`)

### 3.1 Scoring by Scenario

| #   | query | symbols | subject | Qdrant | Scoring Pipeline                                                                       | Final Score Field                                         | Notes                                                                                 |
| --- | ----- | ------- | ------- | ------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | ✅     | ✗       | ✗       | ✗      | Fuse composite → `SearchResults.merge(fuseHits, [], ...)`                              | `combinedScore` = `normalizedFuse × 0.25`                 | ⚠ No qdrantWeight term → scores compressed to 0.0–0.25 range                          |
| 2   | ✅     | ✗       | ✗       | ✅      | Fuse composite + Qdrant dual-channel → `SearchResults.merge()`                         | `combinedScore` = `qdrant × 0.75 + normalizedFuse × 0.25` | Full hybrid — best ranking quality                                                    |
| 3   | ✅     | ✅       | ✗       | ✗      | Fuse composite → `filterResultsBySymbols()` → `SearchResults.merge(filtered, [], ...)` | `combinedScore` = `normalizedFuse × 0.25`                 | Fuse scores preserved through filter; symbols is boolean post-filter                  |
| 4   | ✅     | ✗       | ✅       | ✗      | Fuse composite → `filterResultsBySubject()` → `SearchResults.merge(filtered, [], ...)` | `combinedScore` = `normalizedFuse × 0.25`                 | Same as #3 but filtering on subject field                                             |
| 5   | ✅     | ✅       | ✅       | ✗      | Fuse composite → `filterResultsBySymbols()` → `filterResultsBySubject()` → merge       | `combinedScore` = `normalizedFuse × 0.25`                 | Both field filters chained; still no Qdrant contribution                              |
| 6   | ✅     | ✅       | ✗       | ✅      | Fuse composite → `filterResultsBySymbols()` on Fuse side; Qdrant unfiltered → merge    | `combinedScore` = hybrid                                  | ⚠ Qdrant results are NOT filtered by symbols — may re-introduce filtered-out messages |
| 7   | ✅     | ✗       | ✅       | ✅      | Fuse composite → `filterResultsBySubject()` on Fuse side; Qdrant unfiltered → merge    | `combinedScore` = hybrid                                  | ⚠ Same gap: Qdrant results bypass subject filter                                      |
| 8   | ✅     | ✅       | ✅       | ✅      | Fuse filtered by both; Qdrant unfiltered → merge                                       | `combinedScore` = hybrid                                  | ⚠ Qdrant can contribute messages that match neither symbols nor subject               |
| 9   | ✗     | ✅       | ✗       | —      | `getAllMessages()` → `filterMessagesBySymbols()` → `messagesToResults()`               | `combinedScore` = `1.0 × 0.25 = 0.25`                     | Qdrant skipped entirely; score is fixed; sorted by dateTime                           |
| 10  | ✗     | ✗       | ✅       | —      | `getAllMessages()` → `filterMessagesBySubject()` → `messagesToResults()`               | `combinedScore` = `1.0 × 0.25 = 0.25`                     | Same as #9 for subject                                                                |
| 11  | ✗     | ✅       | ✅       | —      | `getAllMessages()` → filter symbols → filter subject → `messagesToResults()`           | `combinedScore` = `1.0 × 0.25 = 0.25`                     | Both field filters, no relevance ranking                                              |

### 3.2 Aggregation by Scenario

| #    | query | symbols | subject | Qdrant | Aggregation Flow                                                                                                 |
| ---- | ----- | ------- | ------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| 1    | ✅     | ✗       | ✗       | ✗      | `SearchResults.merge(fuseHits, [])` → dedup by messageId → sort by `combinedScore` desc                          |
| 2    | ✅     | ✗       | ✗       | ✅      | `SearchResults.merge(fuseHits, qdrantHits)` → max-score dedup by messageId → sort by `combinedScore` desc        |
| 3–5  | ✅     | any     | any     | ✗      | Fuse results post-filtered (boolean narrow) → `SearchResults.merge(filtered, [])` → sort by `combinedScore` desc |
| 6–8  | ✅     | any     | any     | ✅      | Fuse results post-filtered → merge with **unfiltered** Qdrant → max-score dedup → sort by `combinedScore` desc   |
| 9–11 | ✗     | any     | any     | —      | No merge step. `messagesToResults()` → flat array, score=1.0, sorted by `dateTime` desc                          |

---

## 4. Scenario Matrix — Thread Search (`POST /api/search/threads`)

Thread search follows the same Fuse + field-filter pipeline as message search, but **never invokes Qdrant** and feeds results to `aggregateToThreads()` instead of `SearchResults.merge()`.

### 4.1 Scoring

| #   | query | symbols | subject | Scoring Pipeline                                 | Thread `bestMatchScore`                                   |
| --- | ----- | ------- | ------- | ------------------------------------------------ | --------------------------------------------------------- |
| 1   | ✅     | ✗       | ✗       | Fuse composite (OR/AND)                          | `max(compositeScore)` across matching messages in session |
| 2   | ✅     | ✅       | ✗       | Fuse composite → `filterResultsBySymbols()`      | Same — filter narrows but doesn't re-score                |
| 3   | ✅     | ✗       | ✅       | Fuse composite → `filterResultsBySubject()`      | Same                                                      |
| 4   | ✅     | ✅       | ✅       | Fuse composite → filter symbols → filter subject | Same                                                      |
| 5   | ✗     | ✅       | ✗       | `messagesToResults()` → score = 1.0              | **1.0** (fixed) — no relevance differentiation            |
| 6   | ✗     | ✗       | ✅       | `messagesToResults()` → score = 1.0              | **1.0** (fixed)                                           |
| 7   | ✗     | ✅       | ✅       | `messagesToResults()` → score = 1.0              | **1.0** (fixed)                                           |

### 4.2 Thread Aggregation

`aggregateToThreads()` always:
1. Groups `SearchResult[]` by `sessionId`
2. Fetches full session from MessageDB for metadata (messageCount, totalLength, date range)
3. Computes `bestMatchScore = max(score)` across matching messages
4. Computes `hits = Σ countTermHits(message, matchedTerms)` across matches
5. Sorts threads by `bestMatchScore` descending

**Note**: For field-only searches (#5-7), `matchedTerms = []` → `countTermHits()` returns 0 → `hits = 0` for every thread.

---

## 5. Identified Issues & Tuning Points

### 5.1 Score Compression Without Qdrant (Scenarios #1, #3–5)

When Qdrant is disabled, Fuse results pass through `SearchResults.merge(fuseHits, [])`. The merge creates `AgentMessageFound` via `fromAgentMessage({ fuseScore })`, where:

```
combinedScore = 0 + normalizedFuse × 0.25
```

The Fuse composite score (range 0–1) is **compressed to 0–0.25**. This means:
- A perfect Fuse match gets `combinedScore = 0.25`
- Sort order is preserved but absolute scores are misleadingly low
- Any UI thresholds or cutoffs based on `combinedScore` will behave differently than with Qdrant

**Tuning note**: The `fuseScore` passed into `fromAgentMessage` is the **raw Fuse `result.score`** (0=best), not the composite score from the OR/AND engine. The composite score computed in `searchEngine.ts` is used for ordering *within* Fuse but is then discarded — `SearchResults.merge()` re-inverts the raw fuseScore independently.

### 5.2 Qdrant Bypasses Field Filters (Scenarios #6–8)

In `POST /api/search`, field filters (`filterResultsBySymbols`, `filterResultsBySubject`) are applied to Fuse results **before** merge, but Qdrant results are merged **unfiltered**. This means:

- A message filtered out by `symbols="handleClick"` from Fuse can re-enter results via Qdrant
- The Qdrant search is purely semantic (embedding of `q`) — it has no awareness of symbol/subject constraints
- Qdrant payload *does* contain `symbols[]` and `subject` fields, but they are not used for post-filtering

**Impact**: When a user searches `query="auth" symbols="JWT"`, they expect all results to contain the symbol "JWT". Qdrant can surface messages about "auth" that mention "OAuth tokens" instead.

### 5.3 Field-Only Search Has No Relevance Ranking (Scenarios #9–11)

When `q` is empty and only field filters are provided:
- All matching messages get `score = 1.0` (via `messagesToResults()`)
- Results are sorted by `dateTime` descending — pure recency, no relevance
- `matchedTerms = []` → `hits = 0` everywhere
- Thread `bestMatchScore = 1.0` for all threads

**Tuning note**: Could score by symbol match quality (exact vs substring) or count of matching symbols.

### 5.4 Fuse Composite Score Discarded at Merge

The `searchEngine.ts` computes a careful composite score (OR: quality×0.6 + breadth×0.4; AND: quality×0.6 + 0.4). But `SearchResults.merge()` reads only `result.score` from the `SearchResult` — which **is** the composite score — and passes it as `fuseScore` to `fromAgentMessage()`. Inside that function, it's treated as a raw Fuse score and re-inverted:

```
normalizedFuse = 1 − fuseScore   // fuseScore here is already a "higher=better" composite
```

This double-inversion means high composite scores become **low** `combinedScore` values. The sort order still works because all values are inverted uniformly, but the absolute values are inverted from their intended meaning.

### 5.5 Thread Search Never Uses Qdrant

`POST /api/search/threads` never calls `runQdrantSearch()`. Thread ranking is Fuse-only even when Qdrant is enabled. This is a design choice (threads aggregate from message-level results), but worth noting as a gap for semantic thread discovery.

### 5.6 GET vs POST Asymmetry

The legacy `GET /api/search` endpoint:
- Does **not** support `symbols` or `subject` filters
- Does support Qdrant (same merge path)
- Uses response cache (`withCache`)

The `POST /api/search` endpoint:
- Supports `symbols`, `subject`, `projects` filters
- Supports Qdrant
- Does **not** use response cache

Cached GET results will never reflect field-filtered results, but field filters are POST-only, so this is consistent.

---

## 6. Scoring Parameter Summary

All tunable scoring parameters in one place:

| Parameter                 | Value                   | Location                                | Affects                                                       |
| ------------------------- | ----------------------- | --------------------------------------- | ------------------------------------------------------------- |
| `scoreWeight`             | 0.6                     | `queryParser.ts` `DEFAULT_SCORING`      | Fuse OR/AND composite: quality vs breadth balance             |
| `countWeight`             | 0.4                     | `queryParser.ts` `DEFAULT_SCORING`      | Fuse OR/AND composite: quality vs breadth balance             |
| `FUSE_THRESHOLD`          | 0.4                     | Env → `CCSettings`                      | Fuse.js fuzzy matching strictness (0=exact, 1=match anything) |
| Fuse key `message` weight | 3                       | `searchEngine.ts` L56                   | Message content importance in Fuse index                      |
| Fuse key `subject` weight | 2                       | `searchEngine.ts` L57                   | Subject importance in Fuse index                              |
| Fuse key `symbols` weight | 2                       | `searchEngine.ts` L58                   | Symbols importance in Fuse index                              |
| Fuse key `tags` weight    | 2                       | `searchEngine.ts` L59                   | Tags importance in Fuse index                                 |
| Fuse key `context` weight | 1                       | `searchEngine.ts` L60                   | File path importance in Fuse index                            |
| Qdrant weight in combined | 0.75                    | `AgentMessageFound.ts` L81              | Semantic vs lexical balance in hybrid merge                   |
| Fuse weight in combined   | 0.25                    | `AgentMessageFound.ts` L82              | Semantic vs lexical balance in hybrid merge                   |
| `QDRANT_MIN_SCORE`        | 0.6                     | Env → `CCSettings`                      | Minimum cosine similarity threshold for Qdrant results        |
| Qdrant limit              | `ceil(fuseCount × 0.1)` | `searchRoutes.ts` L49                   | Max Qdrant results per channel (% of Fuse count)              |
| Field-only fixed score    | 1.0                     | `fieldFilters.ts` `messagesToResults()` | Score assigned when no query text is provided                 |

---

## 7. Search Improvements

Proposed changes to close identified gaps and improve scoring quality. Grouped by priority.

### 7.1 Rebalance Hybrid Weights — 0.50 / 0.50 (High)

**Current**: `combinedScore = qdrant × 0.75 + normalizedFuse × 0.25`

The 75/25 split heavily favors semantic similarity over lexical matching. This is problematic because:

- **Fuse.js already scores across 5 weighted fields** (message, subject, symbols, tags, context) — it captures structural relevance that embeddings miss
- **Exact keyword matches are undervalued** — a message containing the exact search term verbatim scores lower than a semantically similar message that doesn't contain the term at all
- **Symbol and tag matches are suppressed** — Fuse gives `weight: 2` to symbols/tags, but at 25% contribution this signal barely registers in `combinedScore`

**Proposed**: `combinedScore = qdrant × 0.50 + normalizedFuse × 0.50`

Equal weighting lets both engines contribute meaningfully. A message that matches both lexically and semantically will still rank highest. A message that only matches one engine gets a fair but not dominant score.

**Location**: `AgentMessageFound.ts` L81-82 — change `0.75` → `0.50` and `0.25` → `0.50`.

### 7.2 Fix Double-Inversion of Fuse Scores (High)

**Problem** (§5.4): `searchEngine.ts` returns a composite score where higher = better. `SearchResults.merge()` passes this as `fuseScore` to `fromAgentMessage()`, which inverts it again (`1 − fuseScore`). High-quality matches get low `combinedScore` absolute values.

**Fix**: Pass the **raw Fuse `result.score`** (from `Fuse.Result.score`, 0=best) into the merge, not the composite. The composite score is only needed for *intra-Fuse ordering* (which is already done via sort in `searchEngine.ts`).

Two options:

| Option              | Change                                                                               | Tradeoff                                                        |
| ------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| A — Pass raw score  | Add `rawFuseScore` to `SearchResult` type, use it in merge                           | Clean separation: composite for Fuse sort, raw for hybrid merge |
| B — Don't re-invert | Change `fromAgentMessage` to treat `fuseScore` as already normalized (higher=better) | Simpler change but muddies the `fuseScore` field semantics      |

**Recommendation**: Option A. Store both `score` (composite, for Fuse-internal ranking) and `rawFuseScore` (original Fuse score, for hybrid merge) on `SearchResult`.

### 7.3 Apply Field Filters to Qdrant Results Post-Merge (High)

**Problem** (§5.2): When `symbols` or `subject` filters are specified, they narrow Fuse results but Qdrant results enter the merge unfiltered, re-introducing messages that should have been excluded.

**Fix**: After `SearchResults.merge()`, apply the same field filters to the merged result set:

```
merged = SearchResults.merge(fuseHits, qdrantHits, ...)
if (symbolsTerm) merged.results = merged.results.filter(r => r.symbols.some(...))
if (subjectTerm) merged.results = merged.results.filter(r => r.subject.toLowerCase().includes(...))
```

This is a simple post-merge pass. Alternatively (or additionally), pass Qdrant payload filters to the search call — Qdrant's `filter` parameter supports `match` conditions on payload fields — but post-merge filtering is simpler and covers both engines uniformly.

### 7.4 Subject-Aware Qdrant Channel Routing (High)

**Current behavior**: When `subject` is specified in `POST /api/search`, it is only used as a post-filter on Fuse results (`filterResultsBySubject()`). Qdrant receives no awareness of the subject constraint — `runQdrantSearch()` embeds only the `q` parameter and searches both `chunk` and `summary` vectors indiscriminately.

**The code does NOT embed the subject term separately or search a subject-specific Qdrant field.**

The Qdrant V2 payload stores `subject`, `aiSummary`, and `customTopic` per point — but these are metadata-only. The `summary` vector channel (embedded from session-level AI summary) is the semantic equivalent for subject-level retrieval, but the route never uses it in a targeted way.

**Revised Qdrant channel routing rule**:

| Inputs          | Qdrant `chunk` channel | Qdrant `summary` channel | Embedding used            |
| --------------- | ---------------------- | ------------------------ | ------------------------- |
| `q` only        | ✅ embed(`q`)           | ✅ embed(`q`)             | 1 call (query)            |
| `q` + `subject` | ✅ embed(`q`)           | ✅ embed(`subject`)       | 2 calls (query + subject) |
| `subject` only  | ✗ skip                 | ✅ embed(`subject`)       | 1 call (subject)          |
| `symbols` only  | ✗ skip                 | ✗ skip                   | 0 calls                   |
| `q` + `symbols` | ✅ embed(`q`)           | ✅ embed(`q`)             | 1 call (query)            |

**Key principle**: Subject **only** searches the `summary` channel — never `chunk`. This is because the summary vector represents session-level topic meaning, which is where subject relevance lives. Searching `chunk` with a subject term would match on incidental content overlap, reducing result quality.

**Implementation** — refactor `runQdrantSearch()` to accept separate query and subject terms:

```typescript
async function runQdrantSearch(
    q: string,                    // full-text query (may be empty)
    subjectTerm: string,           // subject filter (may be empty)
    searchResultsCount: number,
    projectFilters: ProjectFilter[],
    ctx: RouteContext
): Promise<Array<{ score: number; payload: any }>>
{
    if (!ctx.vectorServices) return [];
    const settings = CCSettings.getInstance();
    const limit = Math.max(1, Math.ceil(searchResultsCount * 0.1));

    let chunkHits = [];
    let summaryHits = [];

    // Chunk channel: only when q is present (never for subject-only)
    if (q) {
        const queryVector = await ctx.vectorServices.embeddingService.embed(q);
        chunkHits = await qdrantService.search(harnesses, queryVector, limit, minScore, "chunk");

        // Summary channel with query vector only when subject is NOT specified
        if (!subjectTerm) {
            summaryHits = await qdrantService.search(harnesses, queryVector, limit, minScore, "summary");
        }
    }

    // Summary channel with subject vector when subject IS specified
    if (subjectTerm) {
        const subjectVector = await ctx.vectorServices.embeddingService.embed(subjectTerm);
        summaryHits = await qdrantService.search(harnesses, subjectVector, limit, minScore, "summary");
    }

    // Max-score dedup across all hits
    // ... existing bestByMessage logic ...
}
```

This gives the summary channel a dedicated role as the subject-search vector, while chunk stays focused on content-level queries.

### 7.5 Symbols-Specific Qdrant Payload Filter (Medium)

Same pattern as §7.4A for symbols. The V2 payload has `symbols: string[]`. When `symbols` is specified, add a Qdrant filter:

```typescript
filter: {
    must: [{ key: "symbols", match: { text: symbolsTerm } }]
}
```

This ensures Qdrant only returns points that actually contain the requested symbol, rather than relying on post-merge filtering.

### 7.6 Score Normalization Without Qdrant (Medium)

**Problem** (§5.1): When Qdrant is disabled, `combinedScore` is compressed to 0.0–0.25 (or 0.0–0.50 after §7.1). Scores are meaningless in absolute terms.

**Fix**: When Qdrant is disabled (no qdrant hits), skip the hybrid formula and use the Fuse score directly:

```typescript
// In fromAgentMessage():
if (qdrantScore === null) {
    combinedScore = normalizedFuseScore;  // full 0.0–1.0 range
} else {
    combinedScore = qdrantScore * 0.50 + normalizedFuseScore * 0.50;
}
```

This ensures `combinedScore` always uses the full 0.0–1.0 range regardless of Qdrant availability. UI components can treat `combinedScore` uniformly.

### 7.7 Field-Only Search Relevance Scoring (Medium)

**Problem** (§5.3): Field-only searches (no `q`) assign a flat `score = 1.0` to all results — no relevance differentiation.

**Proposed scoring signals**:

| Signal                     | Formula                                  | Rationale                                                                                    |
| -------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| Symbol match precision     | `exactMatchCount / msg.symbols.length`   | Reward messages where the matched symbol is a larger portion of total symbols (more focused) |
| Symbol match type          | exact=1.0, substring=0.7                 | Exact symbol name match is more relevant than partial                                        |
| Subject match length ratio | `searchTerm.length / msg.subject.length` | Longer match relative to subject = more specific hit                                         |
| Recency boost              | `1.0 − (daysSinceMessage / 365) × 0.2`   | Gently favor recent messages (0.8–1.0 range)                                                 |

Combine into: `score = matchPrecision × 0.6 + recencyBoost × 0.4`

This is optional — recency-only sort may be the desired UX for field-only queries. But having a relevance signal is useful for API consumers (MCP tools, etc.) that may want to filter by quality.

### 7.8 Qdrant for Thread Search (Low)

**Problem** (§5.5): `POST /api/search/threads` never invokes Qdrant. Semantic thread discovery is unavailable.

**Proposed**: Run Qdrant search, resolve hits to `SearchResult[]` format, union with Fuse results, then pass to `aggregateToThreads()`.

This requires converting `QdrantSearchResult[]` to `SearchResult[]` (resolve messageId → AgentMessage, map score). The aggregation step is already generic — it groups any `SearchResult[]` by session.

**Lower priority** because thread search is typically used for browsing (where Fuse is sufficient) rather than discovery (where embeddings shine). But if §7.1 rebalances weights, running Qdrant here becomes more valuable.

### 7.9 Improvement Priority Summary

| #   | Improvement                          | Priority | Effort  | Impact                                                     |
| --- | ------------------------------------ | -------- | ------- | ---------------------------------------------------------- |
| 7.1 | Rebalance hybrid weights 0.50/0.50   | High     | Trivial | Score fairness across both engines                         |
| 7.2 | Fix double-inversion of Fuse scores  | High     | Small   | Correct absolute `combinedScore` values                    |
| 7.3 | Field filters on Qdrant post-merge   | High     | Small   | Correctness — filtered results stay filtered               |
| 7.4 | Subject-aware Qdrant channel routing | High     | Medium  | Subject searches summary channel; chunk stays content-only |
| 7.5 | Symbols Qdrant payload filter        | Medium   | Small   | Symbol filter applies to Qdrant results                    |
| 7.6 | Score normalization without Qdrant   | Medium   | Small   | Consistent score range regardless of Qdrant                |
| 7.7 | Field-only relevance scoring         | Medium   | Medium  | Better ranking for symbol/subject-only queries             |
| 7.8 | Qdrant for thread search             | Low      | Medium  | Semantic thread discovery                                  |

---

## 8. Implementation Task List

### Group 1 — Trivial Scoring Tweaks

{{SIMPLE}}

- [x] **T1.1** In `AgentMessageFound.ts`, change Qdrant weight from `0.75` → `0.50` and Fuse weight from `0.25` → `0.50` in `fromAgentMessage()`.
- [x] **T1.2** In `AgentMessageFound.ts`, add Qdrant-absent branch: when `qdrantScore === null`, set `combinedScore = normalizedFuseScore` directly (full 0–1 range) instead of applying the hybrid formula. (§7.6)
- [x] **T1.3** Update `AgentMessageFound.ts` JSDoc comments to reflect the new 50/50 weighting and the Qdrant-absent normalization.
- [ ] **T1.4** In `AgentMessageFound.ts` tests (if any exist under `mcp/tests/`), update expected `combinedScore` values to match the new 50/50 formula and Qdrant-absent behaviour.

### Group 2 — Fix Double-Inversion Bug

{{SIMPLE}}

- [x] **T2.1** Add `rawFuseScore: number` field to the `SearchResult` type in `searchEngine.ts`. This stores the original Fuse.js score (0=best) alongside the composite `score` (higher=better).
- [x] **T2.2** In `executeOrQuery()`, when building each `SearchResult`, compute `rawFuseScore` as the average of the raw Fuse scores collected in `match.scores[]` (these are already raw). Set it on the result object.
- [x] **T2.3** In `executeAndQuery()`, propagate `rawFuseScore = candidate.score` (already raw from `executeFuzzySearch`) into each `SearchResult`.
- [x] **T2.4** In `executeExactSearch()` path: set `rawFuseScore = 0` (exact matches are perfect by definition).
- [x] **T2.5** In `searchRoutes.ts`, when mapping `searchResults` to `fuseHits` for `SearchResults.merge()`, pass `rawFuseScore` instead of `score` as the `fuseScore` field.
- [x] **T2.6** In `fieldFilters.ts` → `messagesToResults()`, add `rawFuseScore: 0` to the returned `SearchResult` objects (field-only results are treated as perfect match for merge purposes).

### Group 3 — Post-Merge Field Filtering

{{SIMPLE}}

- [x] **T3.1** In `searchRoutes.ts` `POST /api/search`, after `SearchResults.merge()` returns `data`, apply `symbols` post-filter: `data.results = data.results.filter(r => r.symbols.some(s => s.toLowerCase().includes(symbolsTerm.toLowerCase())))` when `symbolsTerm` is non-empty.
- [x] **T3.2** Same location, apply `subject` post-filter: `data.results = data.results.filter(r => r.subject.toLowerCase().includes(subjectTerm.toLowerCase()))` when `subjectTerm` is non-empty.
- [x] **T3.3** Ensure the post-filter runs on the `AgentMessageFound[]` (pre-serialization), not on the serialized output, so that field access is type-safe.

### Group 4 — QdrantService Filter Support

{{MEDIUM}}

- [x] **T4.1** In `QdrantService.ts`, add an optional `filter?: object` parameter to the `search()` method signature.
- [x] **T4.2** In the `search()` method body, spread the `filter` into the Qdrant `client.search()` call: `filter: filter ?? undefined`.
- [x] **T4.3** Export a helper type `QdrantPayloadFilter` from `QdrantService.ts` matching Qdrant's filter schema shape (at minimum: `{ must?: Array<{ key: string; match: { text: string } }> }`).
- [x] **T4.4** In `searchRoutes.ts`, build a `symbolsFilter` when `symbolsTerm` is non-empty: `{ must: [{ key: "symbols", match: { text: symbolsTerm } }] }`. Pass it to `runQdrantSearch()`. (§7.5)

### Group 5 — Subject-Aware Qdrant Channel Routing

{{MEDIUM}}

- [x] **T5.1** Refactor `runQdrantSearch()` signature to accept `subjectTerm: string` as a separate parameter (in addition to `q`).
- [x] **T5.2** When `q` is present and `subjectTerm` is empty: embed `q`, search both `chunk` and `summary` channels with the query vector (current behaviour — no change).
- [x] **T5.3** When `q` is present and `subjectTerm` is non-empty: embed `q` → search `chunk` channel only; embed `subjectTerm` → search `summary` channel only. Two embedding calls.
- [x] **T5.4** When `q` is empty and `subjectTerm` is non-empty: embed `subjectTerm` → search `summary` channel only. Skip `chunk` entirely. One embedding call.
- [x] **T5.5** Max-score dedup across chunk + summary hits (existing `bestByMessage` logic) remains unchanged after the routing changes.
- [x] **T5.6** Update the call sites in `POST /api/search` and `POST /api/search/threads` to pass `subjectTerm` to the refactored `runQdrantSearch()`.
- [x] **T5.7** When subject is specified, also pass the `subject` payload filter (from T4) to the `summary` channel search, so Qdrant narrows results to matching subjects AND uses semantic similarity.

### Group 6 — Field-Only Search Improvements

{{MEDIUM}}

- [x] **T6.1** In `fieldFilters.ts`, create a `scoreSymbolMatch(msg: AgentMessage, term: string): number` function that returns: 1.0 for exact symbol name match, 0.7 for substring match. If multiple symbols match, take the max.
- [x] **T6.2** Create a `scoreSubjectMatch(msg: AgentMessage, term: string): number` function: `term.length / msg.subject.length`, clamped to 0–1.
- [x] **T6.3** Update `messagesToResults()` to accept optional `symbolsTerm` and `subjectTerm` parameters. When provided, compute a relevance score from the signal functions instead of using flat 1.0.
- [x] **T6.4** Combine signals: `score = (matchScore × 0.6) + (recencyBoost × 0.4)` where `recencyBoost = max(0.8, 1.0 − daysSince / 365 × 0.2)`. Populate `matchedTerms` with the symbol/subject terms that matched.
- [x] **T6.5** Update call sites in `searchRoutes.ts` to pass the filter terms to the updated `messagesToResults()`.

### Group 7 — Thread Search Qdrant Integration

{{MEDIUM}}

- [x] **T7.1** In `POST /api/search/threads`, after executing Fuse search + field filters, call `runQdrantSearch()` (with the same channel routing from Group 5) when Qdrant is enabled and `q` or `subjectTerm` is present.
- [x] **T7.2** Convert `QdrantSearchResult[]` to `SearchResult[]`: resolve `payload.messageId` → `AgentMessage` via `messageDB.getById()`, map `score`, set `matchedTerms` from parsed query.
- [x] **T7.3** Union Qdrant-derived `SearchResult[]` with Fuse `SearchResult[]` (dedup by message ID, take max score) before passing to `aggregateToThreads()`.
- [x] **T7.4** Apply the same post-merge field filters (symbols/subject) to the unioned results before aggregation.

### Group 8 — Validation & Testing

{{MEDIUM}}

- [ ] **T8.1** Manual test: `POST /api/search { query: "auth" }` with Qdrant disabled — verify `combinedScore` uses full 0–1 range.
- [ ] **T8.2** Manual test: `POST /api/search { query: "auth" }` with Qdrant enabled — verify `combinedScore` uses 50/50 weighting, top results contain the search term.
- [ ] **T8.3** Manual test: `POST /api/search { query: "auth", symbols: "JWT" }` — verify ALL results (including Qdrant-sourced) contain "JWT" in their symbols.
- [ ] **T8.4** Manual test: `POST /api/search { subject: "tile rendering" }` (no query) — verify Qdrant searches `summary` channel only, no `chunk` hits.
- [ ] **T8.5** Manual test: `POST /api/search { query: "render", subject: "tile" }` — verify chunk channel uses query embedding, summary channel uses subject embedding.
- [ ] **T8.6** Manual test: `POST /api/search/threads { query: "render" }` with Qdrant enabled — verify Qdrant results contribute to thread aggregation.
- [ ] **T8.7** Manual test: field-only `POST /api/search { symbols: "handleClick" }` — verify results have differentiated scores (not all 1.0) and `matchedTerms` populated.
- [ ] **T8.8** Regression: verify `GET /api/search?q=...` (legacy endpoint) still works with the new scoring and returns valid `combinedScore` values.
