# Progress Log

## Session: 2026-08-06（NBJ-SAFETY-P1 第一阶段）

### P1-0 baseline and optimizer quarantine — complete

- Created branch `nbj-safety-p1` from `main` (`a0e9581`); worktree was clean before edits.
- Recorded Node `v24.16.0`, npm `11.13.0`, Python `3.10.9`, schema `MIGRATION_VERSION=7`, root test pass, agent `npm ci` with engine warning, `npm run check` pass, `npm test` pass (32 files / 273 tests), and `python -m compileall optimizer` pass.
- Added `EXPERIMENTAL / NOT FOR PRODUCTION / 现有旧参数输出已失效` to `optimizer/README.md`.
- Added `optimizer/legacy-artifacts-manifest.json` with SHA-256 and `validForProduction=false` for existing simulation JSON outputs.
- Confirmed by repository scan that no production path outside `optimizer/` reads optimizer JSON.
- The plan file `NBJ-SAFETY-P1-Codex-Plan.md` was not found in the repo; the user-provided plan text is authoritative and this fact is recorded.
- P1-0 is committed separately before P1-1.

### P1-1 unify optimizer parameter contract — complete

- Added `optimizer/contracts.py` with immutable `FeedingParametersV3`, field ranges/units/defaults, `from_mapping()`, `to_mapping()`, `to_vector()`, and strict rejection of legacy/unknown/missing/non-finite/out-of-range parameters.
- Rewrote `optimizer/search.py` to search the six V3 fields, iterate by field name, and emit named, versioned output with seed and data digest.
- Updated `model.py`, `train.py`, `gradient.py` imports/paths, `pareto.py`, `farm_tune.py`, `loss.py`, and `simulate.py` so parameter definitions come from `contracts.py`.
- Added `optimizer/tests/test_parameter_contract.py` and `optimizer/tests/test_search_contract.py`.
- Verified `python -m unittest discover -s optimizer/tests -p "test_*.py"` (7 tests) and `python -m compileall optimizer`.

### P1-2 make growth calibration identifiable — complete

- Removed `diarOffset` from `calibrate.py` and `farm_tune.py`; growth calibration is limited to `scaleFactor` and `peakAdjust`.
- `predict_error()` now counts eligible batches only, returns eligible count and exclusion reasons, and raises `NBJ_CALIBRATION_INSUFFICIENT_WEIGHT_DATA` below 3 eligible batches.
- Calibration candidates are marked `status=candidate`, `validForProduction=false`, `applied=false`.
- Added `optimizer/tests/test_calibration.py`; full Python suite now passes 11 tests and `python -m compileall optimizer` passes.

### P1-3 enforce diarrhea adjustment safety contract — complete

- Removed `targetRatio` and `gradeTargetRatio()` from `decision/core.ts` and the shared contract.
- Added `DiarrheaAdjustmentResult` with `none | proposal | preview_only | manual_only`, plus deterministic cumulative/target facts.
- `previewDiarrheaAdjustment()` now selects the target only from frozen SOP `reductionPriority`/`freeReductionPriority`, checks `observedAt` on the 09:00 business-day axis, and fails closed on missing slots.
- Severe, target-passed, and cumulative-overrun cases return `manual_only` with no device proposal; moderate returns preview-only; mild returns a pending proposal.
- Updated `observation-feedback.ts`, `container/tools.ts`, LangGraph state/runtime/responses, local API observed-at handling, and tests.
- Verified `npm run check`, full `npm test` (32 files / 277 tests), and P1-3 targeted suites.

### P1-4 persist post-confirmation amendments — complete

- Added `daily_operation_amendments` migration version 8 with unique origin/idempotency keys, base plan/confirmation foreign keys, status, operations/proposal JSON, SHA-256 digest, and audit metadata.
- Removed the confirmed-plan `skipped: true` path from `materializeObservationFeedbackPlan()`; new observations now create or reuse a pending amendment without modifying the confirmed plan.
- Added store methods and local API routes for amendment creation/listing/confirm/reject/apply with stale revision/digest protection and audit events.
- `GET today-operations` now returns amendments; `agent/ui/liquid-index.html` displays amendment status/severity/proposal state.
- Added `tests/local-integration/amendments.test.ts` and migration/data-count coverage in `tests/local-db/local-store.test.ts`.
- Verified `npm run check` and full `npm test` (33 files / 281 tests after adding migration count test; targeted amendment suite also passes).

### P1-5 render protected numeric facts deterministically — complete

- Added `DeterministicFact` typed claims and `protectedFacts()`/`deterministicFactBlockText()` in the LangGraph runtime.
- Protected intents now render deterministic facts plus safety note without invoking the LLM; `numericWhitelist` is no longer an acceptance gate.
- LLM explanation segments containing Arabic/full-width digits, percentages, times, dates, or Chinese numerals are discarded and replaced with deterministic fallback.
- Added number-swap, unit, Chinese numeral, percent/date/day-age, tool-call, stale receipt, and provider-unavailable regression tests.
- Verified `npm run check` and full `npm test` (33 files / 285 tests).

## Session: 2026-08-04

### Plan authoring

- **Status:** complete
- Captured the new daily single-confirmation requirement.
- Defined a separate onsite “今日操作” column and exactly-once persistence contract.
- Defined eight administrator-editable free-feeding time slots and publication/snapshot validation.
- Integrated the requirements into the SOP-driven LangGraph v2 implementation sequence.
- Expanded `task_plan.md` with the decision-complete orchestration design: graph ownership, routes, SOP subgraphs, typed state, node contracts, checkpoint/replay, SSE, graph-out boundaries and failure policy.
- Promoted the four known defects to numbered mandatory gates `P0-01` through `P0-04`, with fail-closed behavior, release proof and a no-bypass exit rule.
- Preserved the four known P0 safety fixes as Phase 0 release prerequisites.
- Created Codex-readable `task_plan.md`, `findings.md`, and `progress.md` only; project source was not implemented in this planning step.

## Implementation Progress

| Phase | Status | Notes |
|---|---|---|
| Phase 0 Safety prerequisites | complete | `p0-release-gate` passed: 6 files / 38 tests; full suite also passed 26 files / 199 tests |
| Phase 1 BatchDecisionService consolidation | complete | Shared frozen-context service now drives local API and Agent adapters with canonical refs/modes |
| Phase 2 Eight free-feeding slots | complete | Exact frozen 8-slot snapshot, 09:00 validation, enabled-window projection, and republish hash coverage verified |
| Phase 3 Admin SOP editor | complete | Eight-row editor, client-side business-day validation, immutable-copy flow, and metadata/count display verified |
| Phase 4 Daily operation persistence | complete | Frozen daily plans, SHA-256, one-confirmation transaction and audit evidence |
| Phase 5 Today-operations API | complete | Lazy GET and dedicated confirm API with stable plan/hash/error handling |
| Phase 6 LangGraph v2 | complete | Static intent/evidence routing, named SOP subgraph selection, receipt validation and checkpoint-safe references verified |
| Phase 7 Onsite column | complete | Separate operation card, one confirmation action, stateful replay and confirmer/timestamp display |
| Phase 8 Verification/migration | complete | Backed up persistent volumes, built images, ran isolated end-to-end Compose smoke and migrated a backup clone without resetting business data |

### Read-only baseline restoration — 2026-08-04

- Restored `task_plan.md`, `findings.md`, and `progress.md`; the next implementation batch remains Phase 0.
- Confirmed a broad dirty worktree, including files that overlap every planned phase. These are preserved as existing user changes.
- Began read-only architecture, domain-safety, and QA reviews for P0-01 through P0-04. No source, database, container, or production-state changes have been made.
- Phase 0 remains `pending` until explicit authorization for this safety-critical code batch; no phase has been marked `in_progress`.
- Baseline checks passed: `git diff --check` reported no whitespace errors, and `npm test` passed all 24 files / 184 tests. Git emitted only CRLF-conversion warnings for existing modified files.
- Completed and independently verified architecture, domain-safety, and QA reviews for P0. The review confirms the phase is not release-ready and must remain pending until explicit authorization starts the fail-closed implementation batch.

### Phase 0 execution — 2026-08-04

- **Status:** in progress
- Authorized the local implementation batch for P0-01 through P0-04.
- Scope is limited to shared frozen-decision loading, no-default safe blocks, 09:00 business-day normalization, deterministic response evidence validation, and their tests/release gate.
- Existing source, backup, configuration, and deployment changes remain preserved. This batch will not run a schema migration, rebuild containers, or publish an image.
- The required implementation subagent dispatch could not start because completed review leaves still consume the available agent-thread limit. The dispatch was recorded as blocked in the external ledger; the root agent is continuing the same scoped work locally.

### P0 and Phase 1 completion — 2026-08-04

- Added `BatchDecisionService` with one frozen SOP/device-plan context used by both `local-api.ts` and Agent tools. It verifies SOP snapshot and device-plan digests, preserves selected mode separately from effective mode, and returns canonical references.
- Removed numeric fallbacks when frozen SOP/device metadata is absent or tampered. API errors now return only `NBJ_FROZEN_*` codes; Agent numeric tools fail before generating a plan.
- Added the 09:00 business-day normalizer for cross-midnight meal/window handling and verified the 23:30 regression.
- Added deterministic evidence receipts containing batch revision, SOP/device digests, an input digest, and a numeric whitelist. The runtime rejects invented, tampered, or stale-revision numeric evidence.
- Added `npm run p0-release-gate`, direct frozen-service tests, Agent/local API parity coverage for both timed and free-feeding modes, plus SOP/device tamper regressions.
- Verified `npm run p0-release-gate` (6 files / 38 tests), `npm test` (26 files / 199 tests), and `git diff --check` (no whitespace errors; only existing CRLF warnings).

### Phase 2 completion — 2026-08-04

- Added exact `1..8` free-feeding slot types and a shared normalizer. Every frozen device plan now retains eight immutable rows while exposing only enabled windows to the decision core.
- Enabled slots are checked for invalid times, zero duration, overlap, and the 09:00 business-day axis. Empty/partial slot configurations fail closed.
- SOP publication normalizes and persists all eight rows. New batches snapshot the current published rows; later publication changes generate a distinct device-plan digest without altering earlier batch snapshots.
- Verified `npm test` (27 files / 203 tests) and `git diff --check` (no whitespace errors; existing CRLF warnings only).

### Phase 3 completion — 2026-08-04

- Added a dedicated eight-row “自由采食时间段” editor to the SOP administration form. Each row owns its enabled state, label, start time, and end time.
- The editor validates input and business-day overlaps inline, projects the configuration to `freeFeedingTemplate.windows`, preserves the complete row set when cloning a version, and shows enabled-window count alongside existing version/digest/index metadata.
- Published SOPs remain immutable: the sole editing flow creates a new version from the selected source.
- Verified `node --check E:\plan\admin.js`, `npm test` (27 files / 204 tests), and `git diff --check` (no whitespace errors; existing CRLF warnings only).

### Phases 4, 5 and 7 completion — 2026-08-04

- Added immutable `daily_operation_plans` and one-per-business-day `daily_operation_confirmations`, with plan-operation SHA-256, indexes, actor/snapshot audit details and no batch revision increment.
- Added lazy `GET /api/batches/:id/today-operations` and `POST /api/batches/:id/today-operations/confirm`; confirmation replays the canonical record for either an identical key or a concurrent same-day request.
- Added the separate onsite “今日操作” card. It displays the business day, frozen batch revision, effective mode and all operations; a single confirmation control is replaced by actor/timestamp after success. Offline retries reuse a persisted idempotency key.
- Verified the focused store, API concurrency, UI shell and operation-generator suites (5 files / 35 tests) and `npm run check`.

### Phase 6 implementation — 2026-08-04

- Replaced ReAct-style model tool selection with static safety-priority intent routing and fixed evidence plans. The model is unbound from tools and a tool call in narration is rejected.
- Added checkpoint-safe v2 state references, named SOP subgraph selection, `daily_operation_gate`, receipt/digest validation, numeric response validation and deterministic response templates for protected paths.
- Local `get_today_timeline` now materializes/reuses the frozen daily operation plan instead of returning an empty task list.
- Added a concurrent confirmation integration test: two simultaneous requests return one canonical confirmation and leave exactly one audit row.
- Final local verification passed: `npm test` (29 files / 210 tests), `npm run check`, `npm run build`, `npm run p0-release-gate` (6 files / 38 tests), `git diff --check`, SQLite `integrity_check` on the migrated test database, and Compose configuration validation with a temporary non-secret validation email.
- Phase 6 is complete. Phase 8 evidence was subsequently completed using only isolated resources and a verified backup clone; the persistent stack remains stopped and unchanged.

### Phase 8 verification and migration evidence — 2026-08-04

- Created and verified [compose-20260804-133807](backups/compose-20260804-133807/) before any container replacement. It contains archives of `agent-config`, checkpoints and Chroma data, a resolved Compose file and SHA-256 manifest. The source database passed `PRAGMA integrity_check = ok` through a read-only mount.
- Built the `naibaji-feeding-agent:local` and `naibaji-feeding-web:local` images. An isolated Compose project with four newly named volumes reached healthy states for Agent, Chroma, embedding and Nginx.
- Through Nginx on loopback, verified health, local login, batch creation, frozen daily-operation materialization, one confirmation plus idempotent replay, and delivery of the current "今日操作" UI. Chroma returned 200, the embedding endpoint returned a 512-dimensional vector, and the checkpoint database created both LangGraph tables. The SSE proxy returned `message_start` and the expected `NBJ_AGENT_PROVIDER_UNAVAILABLE` event when no LLM credential was intentionally supplied.
- Corrected two release defects exposed by the smoke run: HTTP loopback sessions no longer receive an unusable `Secure` cookie, while HTTPS-proxied sessions retain it; batch age validation and the shipped UI now match the 1–30-day frozen feeding-model contract. Re-ran `prepare:assets` so the Docker image receives the updated UI.
- Migrated a network-isolated copy of the verified `agent-config` archive from schema versions `1,2` to `1,2,3`. Integrity remained `ok`; counts for users, batches, observations, sessions, messages, audit records, published SOP templates and SOP knowledge chunks were unchanged, while the new daily-operation tables were added empty. The clone and all smoke volumes were removed afterward; the four `naibaji-*` persistent volumes still exist and were never attached to the test stack.
- Final verification: `npm test` passed 29 files / 212 tests; `npm run p0-release-gate` passed 6 files / 38 tests; `npm run check`, `npm run build`, and `git diff --check` passed (only pre-existing CRLF warnings).

## Session: 2026-08-05（LangGraph v2 上线与通路修复）

- 提交 `f16faf4` 至 `bb8bd80`：SOP 驱动的 LangGraph v2、今日操作、SOP 自然语言
  后台、冻结 SOP 回答、已核实上下文自然叙述 v3、首日 5 项操作与自定义任务。
- 架构与领域复核后完成本轮通路修复：
  - 腹泻异常改为调用确定性 `preview_diarrhea_adjustment`，返回批次日龄、
    剩余餐次、时间点和单次下粉的固定文案；缺少档位时提示补充，不猜测。
  - 聊天请求携带 `observation`，工具按“本次观察 > 请求参数 > 最近记录 > 0”
    解析实际累计下粉量，并记录来源。
  - general 意图同样注入已核实现场上下文（批次/第 N 天/日龄/模式/今日操作），
    数值统一走 `narrationWhitelist` 校验。
  - 管理员后台新增批次 SOP 迁移界面：预览目标模板、规则变化和今日操作影响，
    以“迁移 SOP”短语确认后原子迁移；已确认今日操作仍被阻止。
  - Agent 头部状态栏显示当前批次、第 N 天和日龄，不再停留在“等待批次”。
- 验证基线：`npm run check`、32 文件 / 268 测试、`npm run p0-release-gate`（59 测试）、`npm run build` 全绿；
  本轮新增路由、运行时、工具与 UI 契约测试。

## Test Results

| Test | Expected | Actual | Status |
|---|---|---|---|
| Planning artifact review | All new requirements represented | Represented in plan/contracts/tests | pass |
| Source mutation check | No implementation source edits from this planning turn | Only planning and KB files created | pass |

## Error Log

| Timestamp | Error | Attempt | Resolution |
|---|---|---:|---|
| 2026-08-04 | Existing diarrhea-preview test interpreted `06:00` by calendar day after moving scheduling to the 09:00 business-day axis | 1 | Updated the expected remaining schedule to include the next-business-day 06:00 meal; regression test now proves the new invariant. |

## 5-Question Reboot Check

| Question | Answer |
|---|---|
| Where am I? | Plan authoring complete; Phase 0 is next |
| Where am I going? | SOP-driven LangGraph v2 with one daily confirmation and 8 admin slots |
| What's the goal? | See `task_plan.md` Goal |
| What have I learned? | See `findings.md` |
| What have I done? | Created the persistent implementation plan files |
