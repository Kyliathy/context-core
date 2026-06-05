# R2BE — Better Endpoints: Route Extraction Refactor

## Goal
ContextServer.ts is 1457 lines with all endpoint logic inline. Extract each route group into its own file under `server/src/server/routes/`, leaving ContextServer.ts as a thin orchestrator that wires middleware, mounts routes, and binds the port.

## Current Endpoints (by group)

| Group | Endpoints | Lines |
|-------|-----------|-------|
| **topics** | `GET /api/topics`, `GET /api/topics/:sessionId`, `POST /api/topics` | 266–348 |
| **scopes** | `GET /api/list-scopes`, `POST /api/scopes` | 350–392 |
| **messages** | `GET /api/messages/:id`, `GET /api/messages`, `POST /api/messages` | 394–670 |
| **sessions** | `GET /api/sessions/:sessionId`, `GET /api/sessions` | 407–421 |
| **projects** | `GET /api/projects` | 423–438 |
| **search** | `GET /api/search`, `POST /api/search`, `GET /api/search/threads`, `POST /api/search/threads` | 672–1032 |
| **threads** | `POST /api/threads`, `GET /api/threads/latest` | 1034–1225 |
| **agent-builder** | `POST /prepare`, `POST /create`, `GET /list`, `GET /get-agent`, `GET /get-file-content`, `POST /add-template`, `GET /list-templates` | 1227–1396 |

## New File Structure

```
server/src/server/
├── ContextServer.ts          (slim: middleware, route mounting, port binding)
├── routeUtils.ts             (shared helpers: resolveSubject, loadProjectRemapsByHarness, applyProjectRemap, normalizeScopeEntry, isNonEmptyString, ProjectNameRemapRule type)
└── routes/
    ├── topicRoutes.ts         (~80 lines)
    ├── scopeRoutes.ts         (~45 lines)
    ├── messageRoutes.ts       (~280 lines — biggest, has the search+merge POST handler)
    ├── sessionRoutes.ts       (~20 lines)
    ├── projectRoutes.ts       (~20 lines)
    ├── searchRoutes.ts        (~360 lines — GET+POST search, GET+POST search/threads)
    ├── threadRoutes.ts        (~190 lines — POST /threads, GET /threads/latest)
    └── agentBuilderRoutes.ts  (~170 lines)
```

## Shared Dependencies (injected via context object)

Each route file exports a single `register(app, ctx)` function. The `ctx` parameter carries all shared services so routes don't import singletons:

```ts
// server/src/server/RouteContext.ts (type-only file)
export interface RouteContext {
    messageDB: IMessageStore;
    topicStore?: TopicStore;
    scopeStore?: ScopeStore;
    agentBuilder?: AgentBuilder;
    summaryEmbeddingCache?: SummaryEmbeddingCache;
    vectorServices?: {
        embeddingService: EmbeddingService;
        qdrantService: QdrantService;
    };
}
```

## Execution Plan

### Phase 1 — Scaffolding (no behavior change)
1. Create `server/src/server/RouteContext.ts` with the interface above.
2. Create `server/src/server/routeUtils.ts` — move `isNonEmptyString`, `normalizeScopeEntry`, `resolveSubject`, `loadProjectRemapsByHarness`, `applyProjectRemap`, and `ProjectNameRemapRule` out of ContextServer.ts.
3. Create `server/src/server/routes/` directory.

### Phase 2 — Extract route files (one at a time, build after each)
Order from simplest to most complex to catch issues early:

| Step | File | Endpoints extracted |
|------|------|---------------------|
| 2a | `sessionRoutes.ts` | `GET /api/sessions`, `GET /api/sessions/:sessionId` |
| 2b | `projectRoutes.ts` | `GET /api/projects` |
| 2c | `scopeRoutes.ts` | `GET /api/list-scopes`, `POST /api/scopes` |
| 2d | `topicRoutes.ts` | `GET /api/topics`, `GET /api/topics/:sessionId`, `POST /api/topics` |
| 2e | `agentBuilderRoutes.ts` | All 7 agent-builder endpoints |
| 2f | `threadRoutes.ts` | `POST /api/threads`, `GET /api/threads/latest` |
| 2g | `searchRoutes.ts` | `GET /api/search`, `POST /api/search`, `GET+POST /api/search/threads` |
| 2h | `messageRoutes.ts` | `GET /api/messages/:id`, `GET /api/messages`, `POST /api/messages` |

Each step = move handlers → import in ContextServer → call `register(app, ctx)` → build → verify no regressions.

### Phase 3 — Clean up ContextServer.ts
After all routes extracted, ContextServer.ts should only contain:
- Imports for express, cors, static serving, route registrations
- `startServer()`: create app, apply middleware, build `ctx`, call each `register(app, ctx)`, mount static files, bind port
- Should drop from ~1457 lines to ~80–100 lines.

### Phase 4 — Build & smoke test
- `npm run build` must pass clean
- Manual smoke test: start server, hit a few endpoints, confirm responses unchanged

## Rules
- **Pure extraction** — no logic changes, no new features, no renaming endpoints.
- Each route file is self-contained: imports its own types, calls `resolveSubject` etc. from `routeUtils.ts`.
- Keep the same request logging middleware in ContextServer.ts (it stays global).
- Preserve all existing `console.log` / `console.warn` / `console.error` calls exactly.

## Status
- [x] Phase 1 — Scaffolding
- [x] Phase 2a — sessionRoutes
- [x] Phase 2b — projectRoutes
- [x] Phase 2c — scopeRoutes
- [x] Phase 2d — topicRoutes
- [x] Phase 2e — agentBuilderRoutes
- [x] Phase 2f — threadRoutes
- [x] Phase 2g — searchRoutes
- [x] Phase 2h — messageRoutes
- [x] Phase 3 — Clean up ContextServer.ts
- [x] Phase 4 — Build & smoke test (`tsc --noEmit` passes clean)
