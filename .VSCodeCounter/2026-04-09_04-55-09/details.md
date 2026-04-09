# Details

Date : 2026-04-09 04:55:09

Directory d:\\Codez\\Nexus\\Reach2\\context-core

Total : 201 files,  56597 codes, 7496 comments, 8060 blanks, all 72153 lines

[Summary](results.md) / Details / [Diff Summary](diff.md) / [Diff Details](diff-details.md)

## Files
| filename | language | code | comment | blank | total |
| :--- | :--- | ---: | ---: | ---: | ---: |
| [README-MORE.md](/README-MORE.md) | Markdown | 335 | 0 | 169 | 504 |
| [README.MD](/README.MD) | Markdown | 244 | 0 | 100 | 344 |
| [compose.yaml](/compose.yaml) | YAML | 15 | 0 | 0 | 15 |
| [server/README.md](/server/README.md) | Markdown | 413 | 0 | 106 | 519 |
| [server/bun.lock](/server/bun.lock) | JSON with Comments | 240 | 0 | 201 | 441 |
| [server/interop/insomnia-context-core.json](/server/interop/insomnia-context-core.json) | JSON | 735 | 0 | 0 | 735 |
| [server/interop/insomnia-context-master.xml](/server/interop/insomnia-context-master.xml) | XML | 134 | 0 | 14 | 148 |
| [server/package.json](/server/package.json) | JSON | 45 | 0 | 1 | 46 |
| [server/src/ContextCore.ts](/server/src/ContextCore.ts) | TypeScript | 445 | 80 | 56 | 581 |
| [server/src/agentBuilder/AgentBuilder.ts](/server/src/agentBuilder/AgentBuilder.ts) | TypeScript | 739 | 131 | 113 | 983 |
| [server/src/analysis/SubjectGenerator.ts](/server/src/analysis/SubjectGenerator.ts) | TypeScript | 279 | 76 | 39 | 394 |
| [server/src/analysis/TopicContextBuilder.ts](/server/src/analysis/TopicContextBuilder.ts) | TypeScript | 124 | 38 | 22 | 184 |
| [server/src/analysis/TopicSummarizer.ts](/server/src/analysis/TopicSummarizer.ts) | TypeScript | 272 | 51 | 45 | 368 |
| [server/src/cache/ResponseCache.ts](/server/src/cache/ResponseCache.ts) | TypeScript | 141 | 67 | 22 | 230 |
| [server/src/cli/discovery.ts](/server/src/cli/discovery.ts) | TypeScript | 420 | 6 | 31 | 457 |
| [server/src/cli/tests/add.integration.test.ts](/server/src/cli/tests/add.integration.test.ts) | TypeScript | 114 | 0 | 10 | 124 |
| [server/src/cli/tests/ccjson.paths.test.ts](/server/src/cli/tests/ccjson.paths.test.ts) | TypeScript | 94 | 0 | 13 | 107 |
| [server/src/cli/tests/cxccli.interactive.test.ts](/server/src/cli/tests/cxccli.interactive.test.ts) | TypeScript | 23 | 0 | 3 | 26 |
| [server/src/cli/tests/cxccli.mutations.test.ts](/server/src/cli/tests/cxccli.mutations.test.ts) | TypeScript | 147 | 0 | 21 | 168 |
| [server/src/cli/tests/cxccli.vscode.integration.test.ts](/server/src/cli/tests/cxccli.vscode.integration.test.ts) | TypeScript | 24 | 0 | 5 | 29 |
| [server/src/cli/tests/fixtures/vscode-workspace/malformed/workspace.json](/server/src/cli/tests/fixtures/vscode-workspace/malformed/workspace.json) | JSON | 1 | 0 | 1 | 2 |
| [server/src/cli/tests/fixtures/vscode-workspace/valid/workspace.json](/server/src/cli/tests/fixtures/vscode-workspace/valid/workspace.json) | JSON | 3 | 0 | 1 | 4 |
| [server/src/cli/tests/vscodeWorkspace.test.ts](/server/src/cli/tests/vscodeWorkspace.test.ts) | TypeScript | 41 | 2 | 9 | 52 |
| [server/src/config.ts](/server/src/config.ts) | TypeScript | 32 | 17 | 8 | 57 |
| [server/src/cxccli.ts](/server/src/cxccli.ts) | TypeScript | 1,631 | 13 | 194 | 1,838 |
| [server/src/db/BaseMessageStore.ts](/server/src/db/BaseMessageStore.ts) | TypeScript | 348 | 25 | 42 | 415 |
| [server/src/db/DiskMessageStore.ts](/server/src/db/DiskMessageStore.ts) | TypeScript | 74 | 21 | 12 | 107 |
| [server/src/db/IMessageStore.ts](/server/src/db/IMessageStore.ts) | TypeScript | 50 | 27 | 17 | 94 |
| [server/src/db/InMemoryMessageStore.ts](/server/src/db/InMemoryMessageStore.ts) | TypeScript | 9 | 5 | 2 | 16 |
| [server/src/harness/HarnessMatcher.ts](/server/src/harness/HarnessMatcher.ts) | TypeScript | 158 | 28 | 44 | 230 |
| [server/src/harness/antigravity.ts](/server/src/harness/antigravity.ts) | TypeScript | 52 | 16 | 13 | 81 |
| [server/src/harness/claude.ts](/server/src/harness/claude.ts) | TypeScript | 349 | 44 | 44 | 437 |
| [server/src/harness/codex.ts](/server/src/harness/codex.ts) | TypeScript | 675 | 10 | 88 | 773 |
| [server/src/harness/cursor-matcher.ts](/server/src/harness/cursor-matcher.ts) | TypeScript | 1,017 | 177 | 118 | 1,312 |
| [server/src/harness/cursor-query.ts](/server/src/harness/cursor-query.ts) | TypeScript | 903 | 84 | 55 | 1,042 |
| [server/src/harness/cursor.ts](/server/src/harness/cursor.ts) | TypeScript | 286 | 15 | 22 | 323 |
| [server/src/harness/index.ts](/server/src/harness/index.ts) | TypeScript | 44 | 12 | 8 | 64 |
| [server/src/harness/kiro.ts](/server/src/harness/kiro.ts) | TypeScript | 873 | 51 | 49 | 973 |
| [server/src/harness/opencode.ts](/server/src/harness/opencode.ts) | TypeScript | 330 | 66 | 47 | 443 |
| [server/src/harness/vscode.ts](/server/src/harness/vscode.ts) | TypeScript | 511 | 70 | 63 | 644 |
| [server/src/mcp/MCPServer.ts](/server/src/mcp/MCPServer.ts) | TypeScript | 64 | 22 | 11 | 97 |
| [server/src/mcp/formatters.ts](/server/src/mcp/formatters.ts) | TypeScript | 288 | 51 | 50 | 389 |
| [server/src/mcp/mcpLogger.ts](/server/src/mcp/mcpLogger.ts) | TypeScript | 178 | 61 | 46 | 285 |
| [server/src/mcp/prompts/index.ts](/server/src/mcp/prompts/index.ts) | TypeScript | 382 | 30 | 40 | 452 |
| [server/src/mcp/registry.ts](/server/src/mcp/registry.ts) | TypeScript | 142 | 27 | 24 | 193 |
| [server/src/mcp/resources/index.ts](/server/src/mcp/resources/index.ts) | TypeScript | 223 | 23 | 38 | 284 |
| [server/src/mcp/serve.ts](/server/src/mcp/serve.ts) | TypeScript | 57 | 28 | 14 | 99 |
| [server/src/mcp/tests/CXCTestBase.ts](/server/src/mcp/tests/CXCTestBase.ts) | TypeScript | 87 | 0 | 15 | 102 |
| [server/src/mcp/tests/loadFixtures.ts](/server/src/mcp/tests/loadFixtures.ts) | TypeScript | 200 | 0 | 37 | 237 |
| [server/src/mcp/tests/messages.test.ts](/server/src/mcp/tests/messages.test.ts) | TypeScript | 225 | 20 | 33 | 278 |
| [server/src/mcp/tests/resources.test.ts](/server/src/mcp/tests/resources.test.ts) | TypeScript | 265 | 18 | 38 | 321 |
| [server/src/mcp/tests/runAllTests.ts](/server/src/mcp/tests/runAllTests.ts) | TypeScript | 66 | 0 | 14 | 80 |
| [server/src/mcp/tests/search.test.ts](/server/src/mcp/tests/search.test.ts) | TypeScript | 490 | 53 | 80 | 623 |
| [server/src/mcp/tests/test\_cross\_tool.ts](/server/src/mcp/tests/test_cross_tool.ts) | TypeScript | 53 | 0 | 11 | 64 |
| [server/src/mcp/tests/test\_get\_latest\_threads.ts](/server/src/mcp/tests/test_get_latest_threads.ts) | TypeScript | 60 | 9 | 18 | 87 |
| [server/src/mcp/tests/test\_get\_message.ts](/server/src/mcp/tests/test_get_message.ts) | TypeScript | 41 | 2 | 9 | 52 |
| [server/src/mcp/tests/test\_get\_session.ts](/server/src/mcp/tests/test_get_session.ts) | TypeScript | 46 | 2 | 9 | 57 |
| [server/src/mcp/tests/test\_get\_topic.ts](/server/src/mcp/tests/test_get_topic.ts) | TypeScript | 26 | 0 | 6 | 32 |
| [server/src/mcp/tests/test\_get\_topics.ts](/server/src/mcp/tests/test_get_topics.ts) | TypeScript | 26 | 0 | 6 | 32 |
| [server/src/mcp/tests/test\_list\_sessions.ts](/server/src/mcp/tests/test_list_sessions.ts) | TypeScript | 32 | 0 | 7 | 39 |
| [server/src/mcp/tests/test\_project\_matching.ts](/server/src/mcp/tests/test_project_matching.ts) | TypeScript | 46 | 0 | 11 | 57 |
| [server/src/mcp/tests/test\_prompts.ts](/server/src/mcp/tests/test_prompts.ts) | TypeScript | 40 | 0 | 7 | 47 |
| [server/src/mcp/tests/test\_query\_messages.ts](/server/src/mcp/tests/test_query_messages.ts) | TypeScript | 42 | 0 | 9 | 51 |
| [server/src/mcp/tests/test\_resources.ts](/server/src/mcp/tests/test_resources.ts) | TypeScript | 37 | 0 | 7 | 44 |
| [server/src/mcp/tests/test\_scope\_resolution.ts](/server/src/mcp/tests/test_scope_resolution.ts) | TypeScript | 127 | 4 | 12 | 143 |
| [server/src/mcp/tests/test\_search\_by\_symbol.ts](/server/src/mcp/tests/test_search_by_symbol.ts) | TypeScript | 72 | 3 | 14 | 89 |
| [server/src/mcp/tests/test\_search\_messages.ts](/server/src/mcp/tests/test_search_messages.ts) | TypeScript | 359 | 27 | 49 | 435 |
| [server/src/mcp/tests/test\_search\_thread\_messages.ts](/server/src/mcp/tests/test_search_thread_messages.ts) | TypeScript | 143 | 23 | 24 | 190 |
| [server/src/mcp/tests/test\_search\_threads.ts](/server/src/mcp/tests/test_search_threads.ts) | TypeScript | 226 | 11 | 37 | 274 |
| [server/src/mcp/tests/test\_set\_topic.ts](/server/src/mcp/tests/test_set_topic.ts) | TypeScript | 34 | 0 | 6 | 40 |
| [server/src/mcp/tools/messages.ts](/server/src/mcp/tools/messages.ts) | TypeScript | 261 | 18 | 29 | 308 |
| [server/src/mcp/tools/search.ts](/server/src/mcp/tools/search.ts) | TypeScript | 684 | 85 | 113 | 882 |
| [server/src/mcp/tools/topics.ts](/server/src/mcp/tools/topics.ts) | TypeScript | 114 | 36 | 14 | 164 |
| [server/src/mcp/transports/sse.ts](/server/src/mcp/transports/sse.ts) | TypeScript | 124 | 39 | 20 | 183 |
| [server/src/models/AgentMessage.ts](/server/src/models/AgentMessage.ts) | TypeScript | 131 | 18 | 9 | 158 |
| [server/src/models/AgentMessageFound.ts](/server/src/models/AgentMessageFound.ts) | TypeScript | 116 | 44 | 16 | 176 |
| [server/src/models/AgentThread.ts](/server/src/models/AgentThread.ts) | TypeScript | 14 | 16 | 13 | 43 |
| [server/src/models/ScopeEntry.ts](/server/src/models/ScopeEntry.ts) | TypeScript | 11 | 11 | 3 | 25 |
| [server/src/models/SearchResults.ts](/server/src/models/SearchResults.ts) | TypeScript | 119 | 45 | 19 | 183 |
| [server/src/models/TopicEntry.ts](/server/src/models/TopicEntry.ts) | TypeScript | 6 | 8 | 5 | 19 |
| [server/src/search/fieldFilters.ts](/server/src/search/fieldFilters.ts) | TypeScript | 102 | 38 | 15 | 155 |
| [server/src/search/queryParser.ts](/server/src/search/queryParser.ts) | TypeScript | 102 | 53 | 22 | 177 |
| [server/src/search/searchEngine.ts](/server/src/search/searchEngine.ts) | TypeScript | 258 | 51 | 42 | 351 |
| [server/src/search/threadAggregator.ts](/server/src/search/threadAggregator.ts) | TypeScript | 136 | 40 | 30 | 206 |
| [server/src/server/ContextServer.ts](/server/src/server/ContextServer.ts) | TypeScript | 124 | 11 | 14 | 149 |
| [server/src/server/RouteContext.ts](/server/src/server/RouteContext.ts) | TypeScript | 19 | 0 | 2 | 21 |
| [server/src/server/routeUtils.ts](/server/src/server/routeUtils.ts) | TypeScript | 275 | 30 | 38 | 343 |
| [server/src/server/routes/agentBuilderRoutes.ts](/server/src/server/routes/agentBuilderRoutes.ts) | TypeScript | 153 | 0 | 25 | 178 |
| [server/src/server/routes/messageRoutes.ts](/server/src/server/routes/messageRoutes.ts) | TypeScript | 252 | 8 | 35 | 295 |
| [server/src/server/routes/projectRoutes.ts](/server/src/server/routes/projectRoutes.ts) | TypeScript | 21 | 0 | 3 | 24 |
| [server/src/server/routes/scopeRoutes.ts](/server/src/server/routes/scopeRoutes.ts) | TypeScript | 43 | 0 | 8 | 51 |
| [server/src/server/routes/sessionRoutes.ts](/server/src/server/routes/sessionRoutes.ts) | TypeScript | 20 | 0 | 3 | 23 |
| [server/src/server/routes/threadRoutes.ts](/server/src/server/routes/threadRoutes.ts) | TypeScript | 258 | 7 | 36 | 301 |
| [server/src/server/routes/topicRoutes.ts](/server/src/server/routes/topicRoutes.ts) | TypeScript | 77 | 3 | 12 | 92 |
| [server/src/settings/CCSettings.ts](/server/src/settings/CCSettings.ts) | TypeScript | 69 | 39 | 21 | 129 |
| [server/src/settings/CMSettings.ts](/server/src/settings/CMSettings.ts) | TypeScript | 31 | 13 | 6 | 50 |
| [server/src/settings/ScopeStore.ts](/server/src/settings/ScopeStore.ts) | TypeScript | 53 | 22 | 10 | 85 |
| [server/src/settings/TopicStore.ts](/server/src/settings/TopicStore.ts) | TypeScript | 88 | 51 | 17 | 156 |
| [server/src/setup.ts](/server/src/setup.ts) | TypeScript | 705 | 40 | 116 | 861 |
| [server/src/storage/StorageWriter.ts](/server/src/storage/StorageWriter.ts) | TypeScript | 133 | 49 | 15 | 197 |
| [server/src/types.ts](/server/src/types.ts) | TypeScript | 39 | 35 | 11 | 85 |
| [server/src/utils/hashId.ts](/server/src/utils/hashId.ts) | TypeScript | 10 | 8 | 2 | 20 |
| [server/src/utils/pathHelpers.ts](/server/src/utils/pathHelpers.ts) | TypeScript | 34 | 17 | 11 | 62 |
| [server/src/utils/rawCopier.ts](/server/src/utils/rawCopier.ts) | TypeScript | 66 | 33 | 15 | 114 |
| [server/src/utils/vscodeWorkspace.ts](/server/src/utils/vscodeWorkspace.ts) | TypeScript | 67 | 7 | 10 | 84 |
| [server/src/vector/Chunker.ts](/server/src/vector/Chunker.ts) | TypeScript | 104 | 48 | 22 | 174 |
| [server/src/vector/ContentClassifier.ts](/server/src/vector/ContentClassifier.ts) | TypeScript | 122 | 32 | 25 | 179 |
| [server/src/vector/EmbeddingService.ts](/server/src/vector/EmbeddingService.ts) | TypeScript | 91 | 46 | 20 | 157 |
| [server/src/vector/QdrantService.ts](/server/src/vector/QdrantService.ts) | TypeScript | 302 | 132 | 48 | 482 |
| [server/src/vector/SummaryEmbeddingCache.ts](/server/src/vector/SummaryEmbeddingCache.ts) | TypeScript | 169 | 81 | 31 | 281 |
| [server/src/vector/VectorConfig.ts](/server/src/vector/VectorConfig.ts) | TypeScript | 51 | 38 | 12 | 101 |
| [server/src/vector/VectorPipeline.ts](/server/src/vector/VectorPipeline.ts) | TypeScript | 347 | 88 | 46 | 481 |
| [server/src/vector/index.ts](/server/src/vector/index.ts) | TypeScript | 7 | 4 | 2 | 13 |
| [server/src/watcher/FileWatcher.ts](/server/src/watcher/FileWatcher.ts) | TypeScript | 432 | 109 | 71 | 612 |
| [server/src/watcher/IncrementalPipeline.ts](/server/src/watcher/IncrementalPipeline.ts) | TypeScript | 367 | 60 | 41 | 468 |
| [server/start.bat](/server/start.bat) | Batch | 1 | 0 | 0 | 1 |
| [server/tsconfig.json](/server/tsconfig.json) | JSON with Comments | 17 | 0 | 1 | 18 |
| [server/zz-reach2/architecture/agents/archi-agent-builder.md](/server/zz-reach2/architecture/agents/archi-agent-builder.md) | Markdown | 580 | 0 | 168 | 748 |
| [server/zz-reach2/architecture/archi-context-core-level0.md](/server/zz-reach2/architecture/archi-context-core-level0.md) | Markdown | 731 | 0 | 188 | 919 |
| [server/zz-reach2/architecture/cli/archi-cli.md](/server/zz-reach2/architecture/cli/archi-cli.md) | Markdown | 182 | 0 | 60 | 242 |
| [server/zz-reach2/architecture/data/archi-database.md](/server/zz-reach2/architecture/data/archi-database.md) | Markdown | 507 | 0 | 156 | 663 |
| [server/zz-reach2/architecture/data/archi-file-watcher.md](/server/zz-reach2/architecture/data/archi-file-watcher.md) | Markdown | 493 | 0 | 159 | 652 |
| [server/zz-reach2/architecture/harness/archi-h-cursor.md](/server/zz-reach2/architecture/harness/archi-h-cursor.md) | Markdown | 399 | 0 | 127 | 526 |
| [server/zz-reach2/architecture/harness/archi-harness.md](/server/zz-reach2/architecture/harness/archi-harness.md) | Markdown | 823 | 0 | 213 | 1,036 |
| [server/zz-reach2/architecture/mcp/archi-mcp.md](/server/zz-reach2/architecture/mcp/archi-mcp.md) | Markdown | 660 | 0 | 221 | 881 |
| [server/zz-reach2/architecture/search/archi-qdrant.md](/server/zz-reach2/architecture/search/archi-qdrant.md) | Markdown | 945 | 0 | 330 | 1,275 |
| [server/zz-reach2/architecture/search/archi-scopes.md](/server/zz-reach2/architecture/search/archi-scopes.md) | Markdown | 384 | 0 | 117 | 501 |
| [server/zz-reach2/architecture/search/archi-search.md](/server/zz-reach2/architecture/search/archi-search.md) | Markdown | 588 | 0 | 202 | 790 |
| [server/zz-reach2/architecture/setup/archi-setup.md](/server/zz-reach2/architecture/setup/archi-setup.md) | Markdown | 392 | 0 | 89 | 481 |
| [server/zz-reach2/architecture/summarizer/archi-summarizer.md](/server/zz-reach2/architecture/summarizer/archi-summarizer.md) | Markdown | 338 | 0 | 135 | 473 |
| [server/zz-reach2/architecture/techDebt/td-memory-optimization.md](/server/zz-reach2/architecture/techDebt/td-memory-optimization.md) | Markdown | 110 | 0 | 62 | 172 |
| [server/zz-reach2/guides/mcp-connection-guide.md](/server/zz-reach2/guides/mcp-connection-guide.md) | Markdown | 260 | 0 | 96 | 356 |
| [server/zz-reach2/protocol/cxs.md](/server/zz-reach2/protocol/cxs.md) | Markdown | 812 | 0 | 225 | 1,037 |
| [start be.bat](/start%20be.bat) | Batch | 1 | 0 | 0 | 1 |
| [start-fe&be.bat](/start-fe&be.bat) | Batch | 1 | 0 | 0 | 1 |
| [visualizer/dev-dist/suppress-warnings.js](/visualizer/dev-dist/suppress-warnings.js) | JavaScript | 0 | 0 | 1 | 1 |
| [visualizer/dev-dist/sw.js](/visualizer/dev-dist/sw.js) | JavaScript | 96 | 21 | 10 | 127 |
| [visualizer/dev-dist/workbox-7e46c8bd.js](/visualizer/dev-dist/workbox-7e46c8bd.js) | JavaScript | 2,583 | 1,988 | 62 | 4,633 |
| [visualizer/dev-dist/workbox-d940c54c.js](/visualizer/dev-dist/workbox-d940c54c.js) | JavaScript | 2,583 | 1,988 | 62 | 4,633 |
| [visualizer/index.html](/visualizer/index.html) | HTML | 18 | 0 | 0 | 18 |
| [visualizer/package-lock.json](/visualizer/package-lock.json) | JSON | 6,987 | 0 | 1 | 6,988 |
| [visualizer/package.json](/visualizer/package.json) | JSON | 27 | 0 | 0 | 27 |
| [visualizer/public/README-DATA-SOURCES.MD](/visualizer/public/README-DATA-SOURCES.MD) | Markdown | 135 | 0 | 46 | 181 |
| [visualizer/public/pwa/offline.html](/visualizer/public/pwa/offline.html) | HTML | 43 | 0 | 1 | 44 |
| [visualizer/src/App.css](/visualizer/src/App.css) | PostCSS | 29 | 0 | 3 | 32 |
| [visualizer/src/App.tsx](/visualizer/src/App.tsx) | TypeScript JSX | 1,357 | 54 | 101 | 1,512 |
| [visualizer/src/api/search.ts](/visualizer/src/api/search.ts) | TypeScript | 240 | 9 | 28 | 277 |
| [visualizer/src/components/UpdatePrompt.css](/visualizer/src/components/UpdatePrompt.css) | PostCSS | 45 | 0 | 6 | 51 |
| [visualizer/src/components/UpdatePrompt.tsx](/visualizer/src/components/UpdatePrompt.tsx) | TypeScript JSX | 32 | 5 | 4 | 41 |
| [visualizer/src/components/agentBuilder/AgentBuilder.css](/visualizer/src/components/agentBuilder/AgentBuilder.css) | PostCSS | 421 | 17 | 67 | 505 |
| [visualizer/src/components/agentBuilder/AgentBuilder.tsx](/visualizer/src/components/agentBuilder/AgentBuilder.tsx) | TypeScript JSX | 499 | 32 | 32 | 563 |
| [visualizer/src/components/agentBuilder/ContentFileDialog.css](/visualizer/src/components/agentBuilder/ContentFileDialog.css) | PostCSS | 117 | 1 | 18 | 136 |
| [visualizer/src/components/agentBuilder/ContentFileDialog.tsx](/visualizer/src/components/agentBuilder/ContentFileDialog.tsx) | TypeScript JSX | 91 | 10 | 8 | 109 |
| [visualizer/src/components/agentBuilder/SourceFilterDropdown.css](/visualizer/src/components/agentBuilder/SourceFilterDropdown.css) | PostCSS | 125 | 0 | 18 | 143 |
| [visualizer/src/components/agentBuilder/SourceFilterDropdown.tsx](/visualizer/src/components/agentBuilder/SourceFilterDropdown.tsx) | TypeScript JSX | 86 | 13 | 11 | 110 |
| [visualizer/src/components/favorites/AddFavoriteMessage.tsx](/visualizer/src/components/favorites/AddFavoriteMessage.tsx) | TypeScript JSX | 93 | 13 | 14 | 120 |
| [visualizer/src/components/favorites/FavoritesPickerDialog.css](/visualizer/src/components/favorites/FavoritesPickerDialog.css) | PostCSS | 91 | 0 | 14 | 105 |
| [visualizer/src/components/favorites/FavoritesPickerDialog.tsx](/visualizer/src/components/favorites/FavoritesPickerDialog.tsx) | TypeScript JSX | 99 | 18 | 10 | 127 |
| [visualizer/src/components/searchTools/FilterDialog.css](/visualizer/src/components/searchTools/FilterDialog.css) | PostCSS | 131 | 0 | 21 | 152 |
| [visualizer/src/components/searchTools/FilterDialog.tsx](/visualizer/src/components/searchTools/FilterDialog.tsx) | TypeScript JSX | 97 | 21 | 13 | 131 |
| [visualizer/src/components/searchTools/HoverPanel.css](/visualizer/src/components/searchTools/HoverPanel.css) | PostCSS | 109 | 2 | 18 | 129 |
| [visualizer/src/components/searchTools/HoverPanel.tsx](/visualizer/src/components/searchTools/HoverPanel.tsx) | TypeScript JSX | 311 | 20 | 18 | 349 |
| [visualizer/src/components/searchTools/SearchBar.css](/visualizer/src/components/searchTools/SearchBar.css) | PostCSS | 435 | 1 | 63 | 499 |
| [visualizer/src/components/searchTools/SearchBar.tsx](/visualizer/src/components/searchTools/SearchBar.tsx) | TypeScript JSX | 749 | 19 | 40 | 808 |
| [visualizer/src/components/searchTools/StatusBar.css](/visualizer/src/components/searchTools/StatusBar.css) | PostCSS | 57 | 0 | 8 | 65 |
| [visualizer/src/components/searchTools/StatusBar.tsx](/visualizer/src/components/searchTools/StatusBar.tsx) | TypeScript JSX | 44 | 9 | 5 | 58 |
| [visualizer/src/components/searchView/ChatMap.css](/visualizer/src/components/searchView/ChatMap.css) | PostCSS | 43 | 0 | 4 | 47 |
| [visualizer/src/components/searchView/ChatMap.tsx](/visualizer/src/components/searchView/ChatMap.tsx) | TypeScript JSX | 86 | 13 | 6 | 105 |
| [visualizer/src/components/searchView/ChatViewDialog.css](/visualizer/src/components/searchView/ChatViewDialog.css) | PostCSS | 270 | 8 | 37 | 315 |
| [visualizer/src/components/searchView/ChatViewDialog.tsx](/visualizer/src/components/searchView/ChatViewDialog.tsx) | TypeScript JSX | 284 | 25 | 26 | 335 |
| [visualizer/src/components/searchView/ClipboardBasket.tsx](/visualizer/src/components/searchView/ClipboardBasket.tsx) | TypeScript JSX | 73 | 13 | 6 | 92 |
| [visualizer/src/components/searchView/ClipboardMessage.tsx](/visualizer/src/components/searchView/ClipboardMessage.tsx) | TypeScript JSX | 41 | 9 | 3 | 53 |
| [visualizer/src/components/searchView/EditResultsView.css](/visualizer/src/components/searchView/EditResultsView.css) | PostCSS | 279 | 0 | 49 | 328 |
| [visualizer/src/components/searchView/EditResultsView.tsx](/visualizer/src/components/searchView/EditResultsView.tsx) | TypeScript JSX | 540 | 21 | 31 | 592 |
| [visualizer/src/components/searchView/EditScope.tsx](/visualizer/src/components/searchView/EditScope.tsx) | TypeScript JSX | 118 | 14 | 10 | 142 |
| [visualizer/src/d3/chatMapEngine.ts](/visualizer/src/d3/chatMapEngine.ts) | TypeScript | 967 | 13 | 102 | 1,082 |
| [visualizer/src/d3/colors.ts](/visualizer/src/d3/colors.ts) | TypeScript | 88 | 1 | 11 | 100 |
| [visualizer/src/d3/dateFormat.ts](/visualizer/src/d3/dateFormat.ts) | TypeScript | 44 | 8 | 4 | 56 |
| [visualizer/src/d3/grouping.ts](/visualizer/src/d3/grouping.ts) | TypeScript | 95 | 13 | 14 | 122 |
| [visualizer/src/d3/layout.ts](/visualizer/src/d3/layout.ts) | TypeScript | 206 | 13 | 30 | 249 |
| [visualizer/src/hooks/useChatMap.ts](/visualizer/src/hooks/useChatMap.ts) | TypeScript | 195 | 2 | 23 | 220 |
| [visualizer/src/hooks/useFavorites.ts](/visualizer/src/hooks/useFavorites.ts) | TypeScript | 162 | 4 | 18 | 184 |
| [visualizer/src/hooks/useOnlineStatus.ts](/visualizer/src/hooks/useOnlineStatus.ts) | TypeScript | 18 | 1 | 4 | 23 |
| [visualizer/src/hooks/useScopes.ts](/visualizer/src/hooks/useScopes.ts) | TypeScript | 28 | 0 | 5 | 33 |
| [visualizer/src/hooks/useSearch.ts](/visualizer/src/hooks/useSearch.ts) | TypeScript | 382 | 2 | 23 | 407 |
| [visualizer/src/hooks/useSearchHistory.ts](/visualizer/src/hooks/useSearchHistory.ts) | TypeScript | 93 | 2 | 16 | 111 |
| [visualizer/src/hooks/useViews.ts](/visualizer/src/hooks/useViews.ts) | TypeScript | 337 | 0 | 37 | 374 |
| [visualizer/src/index.css](/visualizer/src/index.css) | PostCSS | 445 | 5 | 72 | 522 |
| [visualizer/src/main.tsx](/visualizer/src/main.tsx) | TypeScript JSX | 9 | 6 | 2 | 17 |
| [visualizer/src/shared/greenFlash.ts](/visualizer/src/shared/greenFlash.ts) | TypeScript | 32 | 0 | 7 | 39 |
| [visualizer/src/types.ts](/visualizer/src/types.ts) | TypeScript | 288 | 23 | 40 | 351 |
| [visualizer/start.bat](/visualizer/start.bat) | Batch | 1 | 0 | 0 | 1 |
| [visualizer/tsconfig.app.json](/visualizer/tsconfig.app.json) | JSON | 17 | 0 | 1 | 18 |
| [visualizer/tsconfig.json](/visualizer/tsconfig.json) | JSON with Comments | 4 | 0 | 1 | 5 |
| [visualizer/tsconfig.node.json](/visualizer/tsconfig.node.json) | JSON | 12 | 0 | 1 | 13 |
| [visualizer/tsconfig.node.tsbuildinfo](/visualizer/tsconfig.node.tsbuildinfo) | JSON | 1 | 0 | 0 | 1 |
| [visualizer/vite.config.ts](/visualizer/vite.config.ts) | TypeScript | 85 | 0 | 3 | 88 |
| [visualizer/zz-reach2/architecture/agents/archi-agent-builder-ui.md](/visualizer/zz-reach2/architecture/agents/archi-agent-builder-ui.md) | Markdown | 541 | 0 | 143 | 684 |
| [visualizer/zz-reach2/architecture/archi-context-core-visualizer.md](/visualizer/zz-reach2/architecture/archi-context-core-visualizer.md) | Markdown | 649 | 0 | 179 | 828 |
| [visualizer/zz-reach2/architecture/ui/archi-context-core-visualizer-ui.md](/visualizer/zz-reach2/architecture/ui/archi-context-core-visualizer-ui.md) | Markdown | 350 | 0 | 163 | 513 |
| [visualizer/zz-reach2/architecture/ui/archi-search-ui.md](/visualizer/zz-reach2/architecture/ui/archi-search-ui.md) | Markdown | 706 | 0 | 169 | 875 |

[Summary](results.md) / Details / [Diff Summary](diff.md) / [Diff Details](diff-details.md)