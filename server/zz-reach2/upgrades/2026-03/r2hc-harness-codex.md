# R2HC - Codex Harness

**Date**: 2026-03-21  
**Status**: Planning  
**Scope**: Add a new `Codex` harness (`src/harness/codex.ts`) that ingests Codex JSONL sessions into `AgentMessage[]` without duplicate message rows and without instruction fluff.

---

## 1. Source Format Analysis (Sample JSONL)

Analyzed sample:
`c:\Users\Axonn\.codex\sessions\2026\03\21\rollout-2026-03-21T06-41-10-019d0ee9-6514-7fe0-a18c-bff1c29f0c52.jsonl`

Observed counts in this file:
- 320 JSONL records total
- `response_item`: 211
- `event_msg`: 100
- `turn_context`: 8
- `session_meta`: 1

Key duplicate patterns:
- Assistant text is duplicated in both:
  - `event_msg` with `payload.type = "agent_message"`
  - `response_item` with `payload.type = "message"` and `payload.role = "assistant"`
- User prompts are duplicated in both:
  - `event_msg` with `payload.type = "user_message"`
  - `response_item` with `payload.type = "message"` and `payload.role = "user"`
- Final answer is duplicated again in:
  - `event_msg` with `payload.type = "task_complete"` (`last_agent_message`)

Instruction fluff source:
- `session_meta.payload.base_instructions.text` contains a very large static prompt block and must be excluded from emitted chat messages.
- `response_item.message` with `role = "developer"` contains runtime/system instructions and must be excluded.

Conclusion:
- Use `event_msg.user_message` and `event_msg.agent_message` as the canonical conversation text stream.
- Use `response_item.function_call` / `response_item.custom_tool_call` (and paired outputs) only for `toolCalls`.
- Ignore all instruction/control/meta records for `message` text.

---

## 2. Path Reality Check

Configured `cc.json` entry:
- `c:\Users\Axonn\.codex\sessions\`

Observed on disk:
- `.codex\sessions\YYYY\MM\DD\rollout-*.jsonl` exists

Plan:
- In `codex.ts`, resolve only the configured path from `cc.json`.
- If that path is missing, log and skip (no fallback path inference).

This keeps path behavior explicit and avoids hidden path heuristics.

---

## 3. Codex -> AgentMessage Mapping

| AgentMessage Field | Mapping Plan |
|---|---|
| `id` | `generateMessageId(sessionId, role, timestampMillis, message.slice(0,120))` |
| `sessionId` | `session_meta.payload.id` fallback: filename stem |
| `harness` | `"Codex"` |
| `machine` | `""` (stamped by orchestrator later) |
| `role` | `event_msg.user_message -> "user"`; `event_msg.agent_message -> "assistant"` |
| `model` | user: `null`; assistant: turn model from `turn_context.payload.model` fallback `session_meta.payload.model_provider` |
| `message` | `payload.message` trimmed |
| `subject` | `""` |
| `context` | `[]` (first iteration) |
| `symbols` | `[]` |
| `history` | `[]` |
| `tags` | `[]` |
| `project` | derive from `session_meta.payload.cwd` via `deriveProjectName("Codex", cwd)` fallback harness path basename |
| `parentId` | sequential chain by emitted order (`previousMessageId`) |
| `tokenUsage` | `null` (phase 1) |
| `toolCalls` | attach turn-level tool calls (see section 4) to the turn's terminal assistant message |
| `rationale` | `[]` (reasoning records are encrypted/empty summary in sample) |
| `source` | path to copied raw `.jsonl` in `-RAW` |
| `dateTime` | top-level record `timestamp` parsed via Luxon |
| `length` | `message.length` |

---

## 4. No-Duplicate / No-Fluff Rules

Message keep/drop policy:

Keep:
- `event_msg` + `payload.type = "user_message"`
- `event_msg` + `payload.type = "agent_message"`

Drop:
- `session_meta` (including `base_instructions`)
- `response_item.message` (all roles) for text emission
- `event_msg.task_complete.last_agent_message`
- `event_msg.token_count`, `task_started`, `turn_aborted`
- `turn_context` as message text (used only for model metadata)
- `response_item.reasoning` as message text

Tool-call keep policy:
- Keep `response_item.function_call` and `response_item.custom_tool_call`
- Pair outputs from:
  - `response_item.function_call_output`
  - `response_item.custom_tool_call_output`
- Correlate by `call_id`
- Dedup by `call_id` (already unique in sample, but enforce anyway)

Turn attachment rule:
- Build turns using `event_msg.task_started` boundaries.
- Attach collected tool calls to the turn's terminal assistant message:
  1. assistant with `phase = "final_answer"` if present
  2. else last assistant message in that turn

This avoids copying the same tool calls across multiple commentary messages.

---

## 5. Implementation Plan

{{SIMPLE}}

- [x] 1. Create `server/src/harness/codex.ts` with exported `readCodexChats(path, rawBase): AgentMessage[]` scaffold and typed local event interfaces.
- [x] 2. Add Codex source-path resolver that uses the configured path only (no path fallback).
- [x] 3. Add recursive file discovery for `rollout-*.jsonl` files under the resolved Codex root.
- [x] 4. Add file-level cache gating with `isSourceFileCached()` so unchanged session files are skipped.
- [x] 5. Copy each processed source file to `-RAW` via `copyRawSourceFile()` and keep that destination for `AgentMessage.source`.
- [x] 6. Implement safe JSONL line parsing with per-line `try/catch` and malformed-line skip logging.

{{MEDIUM}}

- [x] 7. Parse `session_meta` once per file and extract `sessionId`, `cwd`, `model_provider`, and startup timestamp fallback.
- [x] 8. Parse all `turn_context` records and build `turnId -> model` lookup for assistant model attribution.
- [x] 9. Parse `event_msg.task_started` records to open turn windows and track active `turn_id`.
- [x] 10. Parse `event_msg.user_message` records and stage canonical user message candidates in chronological order.
- [x] 11. Parse `event_msg.agent_message` records and stage canonical assistant message candidates in chronological order.
- [x] 12. Parse `response_item.function_call` and `response_item.custom_tool_call` into pending tool-call records keyed by `call_id`.
- [x] 13. Parse `response_item.function_call_output` and `response_item.custom_tool_call_output` and attach outputs to matching pending calls by `call_id`.
- [x] 14. Ignore non-conversation payloads (`session_meta.base_instructions`, `response_item.message`, `task_complete.last_agent_message`, token/misc meta events) to prevent fluff and duplicate text emission.

{{HARD}}

- [x] 15. Build a deterministic turn assembler that assigns canonical user/assistant messages to their turn boundary (`task_started` -> `task_complete`/`turn_aborted`/EOF).
- [x] 16. Implement terminal-assistant selection per turn (prefer `phase=final_answer`, else last assistant event) for tool-call attachment.
- [x] 17. Materialize `ToolCall[]` for that terminal assistant by merging input/output pairs and deduplicating by `call_id`.
- [x] 18. Convert staged canonical events into `AgentMessage` objects with stable IDs from `generateMessageId(...)`.
- [x] 19. Set `project` from `session_meta.cwd` via `deriveProjectName("Codex", cwd)` with fallback to sanitized path basename.
- [x] 20. Set assistant `model` from `turn_context` map with fallback to `session_meta.model_provider`; keep user `model = null`.
- [x] 21. Apply sequential `parentId` chaining across emitted messages within a session.
- [x] 22. Run final dedup pass by `AgentMessage.id` before return to guarantee no duplicate rows from edge-case event replay.

{{MEDIUM}}

- [x] 23. Register the new reader in `server/src/harness/index.ts` (`import readCodexChats` + `Codex: readCodexChats` in `READERS`).
- [x] 24. Add Codex watcher config in `server/src/watcher/FileWatcher.ts` (`HARNESS_EXTENSIONS.Codex = [".jsonl"]` and debounce entry).
- [x] 25. Verify Codex ingestion via targeted harness probes (`readCodexChats` and `readHarnessChats`) and confirm non-zero message counts.
- [ ] 26. Validate persisted output exists under `{storage}/{machine}/Codex/{project}/{YYYY-MM}/` and contains only canonical chat rows.
- [x] 27. Validate stored messages do not contain `base_instructions`, developer instruction payloads, environment wrappers, or duplicated final text.
- [x] 28. Re-run Codex harness reads against the same raw cache to confirm idempotency (first pass ingests; second pass returns cached/no new messages).
- [x] 29. Update `server/zz-reach2/architecture/archi-context-core-level0.md` to include Codex in harness inventory/flow/model strategy.
- [x] 30. Update `server/zz-reach2/architecture/harness/archi-harness.md` with Codex operational flow and field mapping.

---

## 6. Open Decisions

1. Commentary messages:
Keep both commentary + final assistant outputs (current plan), or keep only `final_answer` assistant messages.

2. Token usage:
Phase 1 keeps `tokenUsage = null`. We can optionally derive per-turn approximations from `token_count` events later.
