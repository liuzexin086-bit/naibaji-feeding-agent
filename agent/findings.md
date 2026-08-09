# Findings & Decisions

## NBJ-SAFETY-P1 Baseline — 2026-08-06

- P1 plan file is not present in the repository; the user supplied the complete plan text in the task message and it is being used as the authoritative execution contract.
- Baseline branch: `nbj-safety-p1` created from `main` at `a0e95818b64224f884acc6bedee6bcf84a032128`; worktree was clean before P1-0 edits.
- Environment: Node `v24.16.0`, npm `11.13.0`, Python `3.10.9`. The exact `agent/package.json` engine is Node `24.18.0`; `npx node@24.18.0` resolves that runtime for later exact-Node gates, but `npm ci` baseline was executed on `v24.16.0` with an `EBADENGINE` warning.
- Schema baseline: `MIGRATION_VERSION = 7` in `agent/src/local-db/schema.ts`.
- Baseline tests: root `npm test` passed; `agent npm run check` passed; `agent npm test` passed 32 files / 273 tests; `python -m compileall optimizer` passed.
- Optimizer outputs are experimental and must not be imported into production. Existing JSON hashes were recorded in `optimizer/legacy-artifacts-manifest.json` with `validForProduction=false`.
- Repository scan found no production consumer reading optimizer JSON outside `optimizer/` itself. No additional runtime block was required in P1-0 beyond the quarantine manifest and README freeze.

## P1-1 Optimizer parameter contract

- Added `optimizer/contracts.py` as the single `feeding-parameters-v3` contract: immutable `FeedingParametersV3`, strict mapping/vector validation, ranges, units, `from_mapping()`, `to_mapping()`, and `to_vector()`.
- Legacy seven-parameter vectors are rejected with `NBJ_OPTIMIZER_PARAMETER_SCHEMA_MISMATCH`; unknown, missing, non-finite, and out-of-range values fail closed.
- `search.py` now searches six named V3 fields, uses deterministic seeds, and writes `schemaVersion`, `modelVersion`, seed, data digest, metrics, names, and units.
- Optimizer Python tests: 7 tests pass under `python -m unittest discover -s optimizer/tests -p "test_*.py"`.

## P1-2 Growth calibration identifiability

- `diarOffset` removed from `calibrate.py` and `farm_tune.py`; growth calibration now only emits `scaleFactor` and `peakAdjust`.
- `predict_error()` uses only eligible batches with at least two valid weight points and positive time span; fewer than 3 eligible batches raises `NBJ_CALIBRATION_INSUFFICIENT_WEIGHT_DATA`.
- Calibration output is explicitly `candidate`, `validForProduction=false`, `applied=false`; it does not overwrite defaults.
- Optimizer Python tests now cover no/one-point/zero-span data, eligible-only denominator, no `diarOffset`, synthetic recovery, and seed stability.

## P1-3 Diarrhea adjustment safety contract

- Removed `targetRatio` and `gradeTargetRatio()`; mild/proposal, moderate/preview-only, severe/manual-only are explicit result kinds.
- Target meal/window must come from frozen SOP `reductionPriority`; missing priority or no matching slot raises `NBJ_DECISION_DIARRHEA_REDUCTION_SLOT_REQUIRED`.
- `observedAt` is now decisive: a passed target slot, severe grade, or cumulative actual above adjusted total produces `manual_only` with no device proposal.
- Deterministic facts include `adjustedProgramTotal`, `cumulativeActual`, `remainingDeliverable`, `targetSlot`, and `targetAlreadyHappened`.
- Agent/local API/UI/feedback paths were updated to carry the new result kinds; full Agent suite passes 32 files / 277 tests.

## P1-4 Post-confirmation amendments

- Added SQLite migration version 8 and `daily_operation_amendments` with origin/idempotency uniqueness, base plan/confirmation FKs, status, proposal, digest, revision, audit actor/time.
- `materializeObservationFeedbackPlan()` no longer silently skips confirmed plans; new diarrhea/anomaly observations create or reuse a canonical amendment while the confirmed `DailyOperationPlan` remains immutable.
- `GET /api/batches/:id/today-operations` returns `amendments`; independent confirm/reject/apply APIs were added and audited.
- UI “今日操作” card renders confirmed-plan amendment status, severity, proposal availability, and digest.
- Tests cover canonical idempotency/concurrent ensure, original plan immutability, stale revision/digest rejection, severe proposal-less amendments, migration 7→8 data-count preservation, and audit events.

## P1-5 Deterministic numeric output

- Added typed `DeterministicFact` and a protected-facts renderer with field/value/unit/evidenceRef/revision/SOP digest/device digest.
- Protected intents (`batch_overview`, `device_plan_or_mode`, `timeline_or_today_operations`, diarrhea/laggard paths) no longer call the LLM; final text is deterministic facts + deterministic body + safety note.
- General/knowledge narration is allowed only as a non-numeric explanation; Arabic digits, full-width digits, percentages, time expressions, dates, and Chinese numerals cause fallback.
- `numericWhitelist` is retained as telemetry/compatibility only and is no longer used as the acceptance gate; replay no longer validates against it.
- Attack tests cover number/unit/time swaps, Chinese numerals, percent/date/day-age injection, tool calls, stale receipts, and provider unavailability.

## P1-6 Integration, release gates, and final acceptance

- Added `agent/package.json` script `p1-safety-gate` covering decision core, observation feedback, local store/migration 7→8, amendments API/store, local tools, LangGraph runtime, Agent/local parity, and today-operations.
- Exact Node `24.18.0` was used by invoking npm-cli with the Node 24.18 binary; `npm ci`, `npm run check`, `npm test`, `npm run build`, `npm run p0-release-gate`, and `npm run p1-safety-gate` all passed without `EBADENGINE`.
- Root `npm test`, Python `unittest` (11 tests), `python -m compileall optimizer`, temp SQLite creation/integrity, migration 7→8 count preservation, and `docker compose config` all passed.

Final acceptance record:

```text
NBJ-SAFETY-P1: PASS
Safety Contract Gate: OPEN
Optimizer Production Gate: CLOSED
Real Device Control Gate: CLOSED
```

## Review Remediation — 2026-08-06

复审发现并修复的阻断项：

- `decideDailyOperationAmendment()` 不再在 confirm 时创建 active decision；只有 apply 才创建并保留 `decision_id`。manual-only 修订无法 apply。
- 新增 `daily_operation_amendment_actions` 表，动作幂等键独立于 amendment 创建幂等键；confirm/apply 重试返回 `replayed=true` 和原始结果。
- `parseObservation()` 在未填写腹泻时不再补 `none`；新增单元测试证明 omitted 不会关闭既有腹泻事件。
- `feedbackOriginId()` 现包含 user、batch、immutable observation id；同 origin 不同 payload 返回 `LOCAL_STORE_AMENDMENT_ORIGIN_CONFLICT`。
- Amendment 的 severity 可为 null 且新增 priority；UI 按 `originKind` 显示腹泻/教槽控奶。
- 优化器 CLI 入口修复：`farm_tune.py` 导入、边界感知数值梯度、顶层 schemaVersion 校验、四入口 smoke 测试。
- 最近消息 SQL 改为先取最新 N 条再升序；client/response message id 使用精确 evidence JSON 查询。
- 复审中的 P1-7 请求体大小/登录限速仍按原计划归入 P3，不伪装为 P1 已关闭。

## NBJ-SAFETY-P1-R1 — 2026-08-06

- `commitRecord()`/`commitAdvance()` 现在可在同一事务内完成 observation、batch update、feedback materialization 和 amendment creation；commit 失败不会残留 amendment。
- `decideDailyOperationAmendment()` 同时校验 batch revision 与 amendment `basedOnBatchRevision`，事务内重新读取并校验当前状态。
- 新增 `superseded/cancelled` 状态；显式 `none` 或更新观察会 supersede 旧 diarrhea amendment。
- Diarrhea preview 在 `cumulativeActual >= adjustedProgramTotal` 或未来餐次计划量超过 `remainingDeliverable` 时转 manual-only，不再返回完整设备 proposal。
- LangGraph `TodayOperationSummary` 增加 amendments 投影；确定性今日操作回复包含待确认/已确认待应用/已应用修订数量。
- V8→V9 重建 amendment 表后显式恢复 batch/date 索引，并新增真实旧表迁移测试。

## NBJ-SAFETY-P1-R2 — 2026-08-07

- Migration now advances to schema `10`; exact old V9 status contract is rebuilt and supersede works after upgrade.
- Diarrhea feedback state reads `daily_observations` append-only event history; omitted same-day observations no longer erase an earlier explicit grade.
- `daily_observations.id` is written into persisted `batch.data.records` as `observationId`, not only into a transient in-transaction copy.
- Automatic supersede is audited as `daily_operation_amendments.superseded` with `reason`, `sourceObservationId`, and optional `replacementAmendmentId`; `decided_by` stays null for system changes.
- Added API regression: mild → same-day omitted → pending diarrhea feedback remains active.

## NBJ-SAFETY-P1-R3 — 2026-08-07

- `#ensureAmendmentV10()` now backs up `daily_operation_amendment_actions` before dropping the parent amendment table, restores the rows after rebuilding, and fails closed if amendment/action counts do not match.
- Added an exact old V9 fixture containing a confirmed then applied amendment with two action rows; migration preserves rows, FKs, indexes, integrity, and both confirm/apply idempotency replays.
- `recordedAt`/`observedAt` are normalized to UTC ISO timestamps at both the local API and store write boundaries; invalid timestamps are rejected with `NBJ_RECORDED_AT_INVALID` or `LOCAL_STORE_INVALID_TIMESTAMP`.
- Diarrhea/feedback, LangGraph summary, and local tool paths now sort observations by parsed epoch rather than timestamp string, so `10:00+08:00` before `03:00Z` is ordered correctly.
- `agent_messages.created_at` is made monotonic per store instance and latest-N message retrieval keeps stable chronological ordering under rapid writes.

## NBJ-SAFETY-P1-R3.1 — 2026-08-07

- The ISO timestamp parser now validates real calendar dates before conversion, so impossible dates such as `2026-02-31`, `2026-04-31`, and non-leap `2026-02-29` are rejected instead of being silently rolled forward by `Date.parse`.
- Explicit hour, minute, second, and UTC offset ranges are validated; invalid time and offset values fail closed.
- `timestampOrderValue()` now uses the same strict parser and returns `Number.MIN_SAFE_INTEGER` for invalid legacy timestamps, so legacy bad data can never sort as the newest observation.
- Added parser, feedback-sorting, and API regressions for impossible calendar dates, invalid ranges, explicit empty `recordedAt`, and omitted `recordedAt`.

## NBJ-SAFETY-P1-R3.2 — 2026-08-07

- `validObservationRecords()` filters malformed legacy timestamps before diarrhea and creep decision extraction; invalid rows remain stored but cannot become the latest effective diarrhea state or participate in creep-control decisions.
- Feedback engine, `preview_diarrhea_adjustment`, and LangGraph batch summaries all use the same timestamp quarantine before selecting source observations.
- Added regressions proving an only-invalid diarrhea record is ignored, invalid-only creep records do not trigger control, and a valid mild record wins over an invalid mild record.

## NBJ-SAFETY-P1 Final Acceptance — 2026-08-07

- NBJ-SAFETY-P1: PASS
- Safety Contract Gate: OPEN
- Merge to main Gate: OPEN
- Optimizer Production Gate: CLOSED
- Real Device Control Gate: CLOSED

## NBJ-DIARRHEA-CLOSURE Revision — 2026-08-07

- Mild no longer creates a device proposal or removes a meal/window; it returns `individual_intervention` with `affectsWholePen=false`, `isolateAffectedPiglets=true`, `affectedPigletMilkControlCount=1`, and `deviceAdjustmentRequired=false`.
- Moderate returns `feeding_reduction_proposal` with `requiresHumanConfirmation=true`; it removes exactly one frozen-priority meal/window and preserves the feeding mode.
- Severe returns `manual_only` with `proposal=null`, unchanged device program, isolation and emergency assessment language, and no automatic medication or diagnosis.
- Moderate with missing cumulative actual powder returns `manual_only` instead of assuming zero and generating a proposal.
- Existing newer-observation supersede semantics cover mild→moderate, moderate→severe, severe→moderate, and explicit none recovery.

## NBJ-DIARRHEA-CLOSURE-R1 — 2026-08-07

- Pending routine plans no longer store moderate diarrhea in `proposedSetting` or `feedbackOrigin`; the moderate proposal is materialized as an independent safety amendment.
- `confirmDailyOperationPlan()` explicitly ignores diarrhea proposals, so routine confirmation can never apply moderate device changes.
- Mild and severe are audited as `diarrhea.individual_intervention_recorded` / `diarrhea.emergency_recorded` and do not create `daily_operation_amendments`.
- Added `GET /api/batches/:id/diarrhea-response` and `POST /api/batches/:id/diarrhea/manual-action`.
- Frontend renders independent diarrhea cards and amendment confirm/reject/apply actions.
- Docker web stage now builds directly from source and writes `/version`; verified build succeeds after removing gitignored `public/`, and image UI SHA matches source.

## NBJ-DIARRHEA-CLOSURE-R2 — 2026-08-07

- Schema advances to migration version 11 and `daily_operation_amendment_actions` accepts `cancel`; confirmed amendments can transition to `cancelled` without an active decision.
- UI confirmed card now exposes `取消调整` instead of an unsupported `拒绝调整`; apply success reloads `state.today` through `loadBatch()` so top device totals/timeline refresh immediately.
- Gateway system prompt now enforces mild individual intervention, moderate independent confirmation, and severe manual/emergency disposition.
- Manual-action idempotency keys are stable per batch/observation/action and stored in `localStorage` for replay.
- `DIARRHEA_RATIO` was removed because ratios no longer represent the diarrhea contract.

## NBJ-DIARRHEA-CLOSURE-R3 — 2026-08-07

- Mild completion audits as `diarrhea.individual_intervention_completed` with `isolationCompleted=true`, `affectedPigletMilkControlCompleted=true`, and count `1`.
- `diarrhea/manual-action` now accepts `individual_intervention_completed` and requires a deterministic idempotency key bound to `feedbackOriginId`/`observationId`.
- Cancelled and superseded amendment statuses render in Chinese and cancelled moderate cards explicitly state the plan is cancelled and device program unchanged.
- Added exact V10→V11 migration fixture with confirm/apply action rows, payload preservation, replay, cancel CHECK, FK and integrity checks.

## NBJ-EXECUTION-CONTRACT-P1 — 2026-08-07

- P1-0 created `agent/docs/execution-contract.md` as the new frozen task contract and removed the previous root freeze.
- The root cause is the conflation of mode, control, planned decision, active decision, and runtime state; the contract separates five layers.
- `selectedMode` is operator-owned; creep/diarrhea/blockage must never silently change mode.
- `freeWindows` are license time ranges; `freeDispenseLimit` is the canonical dispense quota and must satisfy `daily = single × limit`.
- Active decision mode must equal selected mode after day one; mode changes require a transaction and mode-change amendment.
- Runtime states (`normal`, `manual_hold`, `blocked`) are independent of feeding mode.
- Schema V12 must add `mode_change` origin and one-active-decision uniqueness with fail-closed migration preflight.
- Clean build must derive model assets from tracked root model sources and expose full `/version` provenance.

### P1-0.1 Contract Closure — 2026-08-07

- Review found the P1-0 contract was an architecture summary, not a self-contained execution contract; no runtime code is changed in this closure.
- Current gate state is separated from final target state; EC-P1-0 Contract Freeze is PASS and all implementation/merge gates remain CLOSED.
- `controlState` is now explicitly server-owned persisted state with monotonic `startDay`; protected model detects first trigger, persisted state owns deterministic replay, and no config/model dual authority exists.
- Added formal invariants: INV-007 Control Monotonicity and INV-008 No Double Control Reduction; free mode maps `feedTimes` to `freeDispenseLimit` exactly once.
- Added Legacy Decision Reconciliation: legacy mode mismatch requires reconciliation without mutation, execution-started blocks reconciliation; new-policy mismatch fails closed with `NBJ_ACTIVE_DECISION_MODE_INVARIANT`.
- Today API returns canonical `modeState/controlState/plannedDecision/activeDecision/runtimeState/approvalState/reconciliation`; old flat fields are deprecated and not authoritative.
- Runtime lifecycle now requires explicit observation to clear `blocked`/`manual_hold`; omitted observations preserve state.
- Curve cap approval semantics frozen: no mode/runtime change, `approvalState=manual_confirmation_required`, no active decision before confirmation.
- Observation allowlist is strict `additionalProperties=false`; removed “其它真实现场观察” escape hatch; new fields require contract, validation, test.
- Manual diarrhea audit freezes severity↔action mapping and server-computed deterministic idempotency key.
- V11→V12 migration evidence now requires exact status/action fixtures, count/payload/replay/decisionId/FK/integrity checks.
- Clean build contract now includes Web model from same tracked source, root `.dockerignore`, and `git archive HEAD` clean-source gate; CI contract fixes Node 24.18.0 and provenance checks.
- `agent/task_plan.md` now has Supersession Notice and legacy rules marked `SUPERSEDED BY execution-contract-v1`.

### P1-0.2 Final Contract Seal — 2026-08-07

- Review confirmed P1-0.1 changes are present and no runtime/schema files changed, then required five final contract boundaries before EC-P1-1.
- Mode-switch execution evidence is now frozen as `cumulativeActualPowderGramsForBusinessDay`; missing/unknown fails closed, and a later zero actual record cannot overwrite the business-day cumulative actual.
- Runtime state aggregation is frozen as independent device/feeding domain latches with precedence `blocked > manual_hold > normal`; explicit normal clears only its own domain.
- Decision policy compatibility is frozen: known legacy comes only from an explicit registry; `execution-contract-v1` is current; any unknown/future value returns `NBJ_DECISION_POLICY_UNSUPPORTED` and fails closed.
- Provenance now requires source SHA plus actual artifact SHA for Agent and Web, with deterministic source→artifact build fixture in CI.
- Remaining `effectiveMode` implementation instructions in `agent/task_plan.md` were replaced with layered `modeState.selectedMode/plannedMode`, `activeDecision`, and `runtimeState`.

### EC-P1-1 — 2026-08-07

- Decision Core no longer contains `forcedTimed`; `exceptionSignals`, `milkControlActive`, and `diarrheaGrades` cannot change `setting.mode`.
- Generic base-decision diarrhea action was removed; diarrhea continues through `observation-feedback` and amendment/manual disposition only.
- BatchDecisionService no longer reads `FREE_FEEDING_BLOCKERS` to derive requested mode; `selectedMode` is authoritative except Day 0.
- `freeFeedingBlockers` remains only as a compatibility response field and is always empty under the new contract.
- Added direct and service-level regressions proving free + milk control and free + exception signals remain free.

### EC-P1-2 — 2026-08-07

- The protected model's committed-day anchor no longer reassigns `currentCount` upward from a stored higher `feedTimesAtCommit`; it clamps with `Math.min`.
- Agent runtime now imports the tracked root model files directly, removing the ignored `agent/container-models` copy from the authority path.
- Dockerfile now copies root model sources into the build and agent image.
- Regression covers both the existing committed-anchor case and the new “old committed 10 must not increase future count” case.

### EC-P1-3 — 2026-08-07

- `freeDispenseLimit` is now a first-class field; `dailyPowderGrams = singlePowderGrams × freeDispenseLimit` is enforced for free decisions.
- Free-feeding direct totals are mapped as `single = floor(directTotal / limit)` then `daily = single × limit`, so `daily <= directTotal` holds.
- Moderate free diarrhea reduces quota only; windows and single powder remain unchanged; `baseLimit <= 1` returns `manual_only` with `NBJ_DIARRHEA_FREE_DISPENSE_LIMIT_MIN`.
- `freeReductionPriority` is no longer used by the free-feeding decision path; timed mode still uses frozen `reductionPriority`.
- Future deliverable for free mode is no longer `windows.length × single`; it uses business-day window availability and remaining deliverable.
- Added `hasActiveOrFutureBusinessDayWindow()` with cross-midnight tests and core regressions for direct totals, quota-only moderate, passed windows, and minimum quota.

### EC-P1-2.1 / EC-P1-3.1 — 2026-08-07

- Review blocked EC-P1-4 because compiled Agent runtime import, persisted control latch, committed-anchor state machine, and free moderate executable deliverable still had safety gaps.
- Runtime model imports now use generated `agent/.generated-models` assets with the same relative path from `src/model` and `dist/model`; `npm run smoke:dist` and Docker health smoke pass.
- `feeding-model.js` now treats an explicit persisted `controlStartDay` as the replay authority; later observation revisions cannot move it later.
- Committed days are no longer pre-decremented before being replaced by the committed value; the next uncommitted day drops at most one from the committed anchor.
- Free moderate future deliverable is discretized to whole standard dispenses, so `remaining=30g` with `single=70g` fails closed instead of claiming 30g is deliverable.
- Free moderate result reason is free-specific and never prints `targetSlot=null`; `freeReductionPriority` is deprecated compatibility only.
- `computeDayDecision` fails closed when `requestedMode=free_feeding` has no free window.

### EC-P1-1.1 / EC-P1-2.2 / EC-P1-3.2 — 2026-08-07

- Review found deleting `FREE_FEEDING_BLOCKERS` also removed free-feeding eligibility checks; mode forcing is still gone, but eligibility is now a separate pure gate.
- `evaluateFreeFeedingEligibility()` validates `earliestBatchDay`, `requiresOperatorSelection`, free windows, and exception config shape; `/mode` maps ineligible free requests to `409 NBJ_FREE_FEEDING_NOT_ELIGIBLE`.
- Free SOP quantity authority now caps limit by SOP `mealCount`; the previous `25g × 4 meals` becoming `24g × 10 = 240g` is closed to `24g × 4 = 96g`.
- Free SOP settings enforce `daily <= safeSOP target`; direct/indirect conflicts fail closed.
- Committed control history that jumps upward after control start now raises `NBJ_CONTROL_HISTORY_NON_MONOTONIC`; valid `10→9→8` history remains accepted and future counts stay non-increasing.

### EC-P1-3.3 Final Seal — 2026-08-07

- `SOP mealCount` is now validated as a positive safe integer in `resolveSopTarget()`, shared by timed and free paths.
- The protected model validates the final visible `feedTimes` sequence: no increase and no adjacent drop greater than one.
- `requiresOperatorSelection=false/missing` is treated as compatible; `/mode` itself is the explicit operator action.
- Unknown `exceptionBlockers` values invalidate free eligibility as schema validation only; they never switch mode.
- Raw SOP `perMeal × mealCount > directTotal` fails closed before precision rounding, per the reviewer-preferred policy B.

### EC-P1-4 — 2026-08-07

- Runtime state is now a separate layer (`RuntimeExecutionState`) resolved from observation history, not part of `FeedingDecision`.
- Device and feeding domain latches are independent; omitted observations keep the previous latch, and explicit normal clears only its own domain.
- Aggregation precedence is `blocked > manual_hold > normal`; reasons and source observation IDs are returned with the state.
- Observation API now validates canonical runtime enums and maps legacy values (`ok/offline/active/mixed/refusing`) without treating omitted as normal.
- Local API `today.runtimeState` exposes state, reasons, source IDs, device latch, and feeding latch; invalid runtime enums return `NBJ_DEVICE_STATUS_INVALID` or `NBJ_FEEDING_RESPONSE_INVALID`.

### EC-P1-5 — 2026-08-07

- Local schema is now V12 with `mode_change` amendment origin and a unique partial index for one active decision per day.
- V12 preflight fails closed on duplicate active decisions before any schema rebuild; exact V11→V12 fixture preserves amendment and action history, replay, decision IDs, FKs, and integrity.
- Mode switch now uses `cumulativeActualPowderGramsForBusinessDay`: unknown or executed actual blocks the request; open safety amendments block the request.
- Confirmed-plan mode switches create `mode_change` amendments; confirm is approval-only and apply atomically switches selected mode and active decision.
- Pending-plan mode switches refresh the daily operation plan in the same transaction as the batch update.

### EC-P1-6 — 2026-08-07

- Observation API is now strict allowlist; any unknown field or forbidden plan field fails with `NBJ_OBSERVATION_PLAN_FIELD_FORBIDDEN`.
- Server-owned snapshot fields are written at commit and exposed in record responses, so clients can never author meal counts, totals, mode, exception actions, or policy version.
- Legacy local-api test that submitted `mealCount` was replaced with a real commit-snapshot regression.
- `p1-safety-gate` now includes `local-api.test.ts` to cover forged-field and server-authority regressions.

### EC-P1-5.1 / EC-P1-6.1 Authority Seal — 2026-08-07

- Review found cumulative actual was scanned across the whole batch instead of only the current business day; both API and store apply paths now filter by `dayIndex`.
- Review found `activeDecisionIdAtCommit` could not be populated because `getActiveDecision()` returned only `decision_json`; added `getActiveDecisionRecord()` and surfaced the real row id through `today.activeDecisionId`.
- Review found `effectiveHeads` could indirectly rewrite `planPerPigAtCommit`; planned per-pig is now computed from server planned heads, while observation `effectiveHeads` remains a separate record field.
- `DECISION_POLICY_VERSION` is now a single shared constant for snapshot policy version.
- Added regression coverage for D1 unknown/zero/executed actual, active decision id before/after mode apply, and head-change snapshot stability.

### EC-P1-5.2 Execution Evidence Seal — 2026-08-07

- Review found batch snapshot records are replaced by same-day `/records`, so a later `actual=0` could erase an earlier positive execution fact.
- Added `getBusinessDayExecutionState()` reading immutable `daily_observations`; state is monotonic `unknown → zero → executed`.
- `/mode` and mode-change apply now call the same store method; duplicate API/store record-scan helpers were removed.
- Regression proves `180 → 0` on the same day still blocks mode switch and amendment apply.

### EC-P1-7 — 2026-08-08

- Today API now exposes the five-layer contract plus `approvalState` and `reconciliation`; old flat fields remain compatibility-only.
- New active decisions carry `decisionPolicyVersion` in evidence inputs so legacy and current decisions can be distinguished.
- Legacy active mode mismatch becomes a reconciliation signal; new-policy mismatch fails closed with `NBJ_ACTIVE_DECISION_MODE_INVARIANT`.
- Reconciliation is blocked when execution evidence exists for the business day.
- Tests cover layered state, legacy reconciliation, executed reconciliation block, and new-policy invariant failure.

### EC-P1-7.1 — 2026-08-09

- Review found unknown/future `decisionPolicyVersion` was treated as legacy and curve-cap approval read active/flat decision.
- Added explicit policy registry classification before mode matching; unsupported values always fail closed.
- Approval state now derives from `plannedDecision` curve-cap plus open amendments; active decision curve-cap history is not authority.
- Observation commit and mode-change proposal now consume canonical `activeDecision ?? plannedDecision` instead of `today.setting`.
- Added future-policy same-mode API regression and planned approval unit regression.

## Requirements

- Produce a Codex-readable work plan only; do not implement source changes in the planning turn.
- Aggregate all routine human SOP actions for a business day into a separate onsite “今日操作” column.
- Permit only one routine-operation confirmation per batch and business day.
- Provide exactly eight administrator-editable free-feeding time-slot rows in SOP configuration.
- Freeze the published slot configuration into new batches without changing existing batches.

## Existing System Findings

- Current LangGraph is a generic ReAct loop and can finalize without deterministic numeric evidence.
- Local API already freezes timed/free templates and hashes the device plan.
- Agent tools currently duplicate local decision construction, hardcode a generic free window and select the timed curve as the current decision.
- Missing frozen run can fall back to the default SOP template for numeric decisions.
- Cross-midnight remaining-meal adjustment compares `HH:mm` strings and can lose next-day meals.
- Local timeline returns no SOP tasks and local decision draft persistence is unavailable.
- Current canonical SOP has 22 operational chunks and excludes the filming appendix.

## Implementation Baseline — 2026-08-04

- The repository worktree already contains broad, uncommitted changes across the local API, tools, storage, LangGraph, deployment, UI, tests, and new planning artifacts. Treat all of them as user work; P0 implementation must be additive and must not reset, checkout, or overwrite them.
- `src/container/tools.ts` still has the P0-01/P0-02 defect shape: local `currentRun()` can return `null`, `batchDecisionState()` then falls back to `DEFAULT_SOP_TEMPLATE`, and `productionDecisionsForBatch()` selects a timed-quantity decision regardless of the frozen selected mode.
- `src/container/local-api.ts` already has a more complete frozen device-plan path, but its free-feeding snapshot currently accepts one to eight windows and has no fixed eight-slot/09:00-axis validation.
- `src/decision/core.ts` still determines implicit remaining meals by lexically comparing `HH:mm` strings, which loses cross-midnight meals after 23:59. The P0-03 correction must use a business-day timeline, not another string comparison.
- `src/agent/langgraph/runtime.ts` remains the generic ReAct loop. P0-04 therefore needs a deterministic evidence/response-validation layer before final text can contain operational numbers.

## P0 Read-only Review — 2026-08-04

- P0 is not release-ready. The existing suite passes, but none of the four mandatory gates has the dedicated implementation and acceptance evidence required by `task_plan.md`.
- The smallest safe implementation order is: (1) one frozen-context/`BatchDecisionService` used by Agent and local API; (2) fail-closed revision/SOP-digest/device-plan-digest validation with no numeric fallback; (3) a shared 09:00 business-day normalizer for remaining meals and free-feeding windows; (4) deterministic evidence receipts plus numeric-whitelist response validation; and (5) a `p0-release-gate` command covering unit, integration, and Agent/local parity tests.
- The safety review adds two linked guardrails: late admission that cannot retain the required 8–10 hour adaptation window before the fixed 17:00 teaching meal must escalate rather than silently reschedule, and the SOP engine must not permit a teaching interval that diverges from the fixed six-meal first-day schedule.
- Required P0 regressions include missing/wrong/old frozen digest safe-blocks, Agent/local parity for selected/effective mode/hash/times/quantities, 23:30 retaining 02:00/05:00/08:00, 08:59 versus 09:00 date boundaries, cross-midnight/overlap/zero-duration window rejection, and rejection of missing/stale/tampered/invented numeric evidence.
- Implementation is being serialized by the root agent because no new execution leaf can be created while the completed review threads remain counted against the agent limit. File ownership and the planned no-overwrite constraint remain unchanged.

## Technical Decisions

| Decision | Rationale |
|---|---|
| Daily plan and confirmation are separate persistent entities | Supports a frozen audit target and exactly-once confirmation |
| Unique key uses batch plus business date | Enforces one confirmation at the database layer |
| Operations list is hashed | Detects stale UI or altered confirmation payloads |
| Later anomalies do not reopen daily confirmation | Preserves one-confirmation rule while retaining separate safety approval |
| Eight ordered slots include `enabled` | Provides all 8 admin controls without requiring all 8 to run |
| Cross-midnight windows normalize on a 09:00 business-day axis | Matches feeding operations and prevents lexical-time defects |
| Complete orchestration contract lives in `task_plan.md` | Future Codex execution must not depend on chat history or an informal design note |
| Short-lived `TurnGraph` routes into SOP-oriented subgraphs | Separates message lifecycle from long-lived batch, approval and daily-operation state |
| Evidence receipts and numeric whitelist gate every answer | Prevents model-generated numbers or unverified tool claims from becoming operational advice |

## Resources

- `E:\obsidian_hermes\hermes\山川奶爸®超早期断奶SOP完整视频脚本.md`
- `E:\plan\agent\src\agent\langgraph\runtime.ts`
- `E:\plan\agent\src\container\local-api.ts`
- `E:\plan\agent\src\container\tools.ts`
- `E:\plan\agent\src\decision\core.ts`
- `E:\plan\agent\src\local-db\schema.ts`
- `E:\plan\admin.html`
- `E:\plan\admin.js`
- `E:\plan\agent\ui\liquid-index.html`

## Issues to Preserve as Explicit Work

- The four defects `P0-01` snapshot drift/currentRun null, `P0-02` frozen-SOP fallback, `P0-03` cross-midnight meal loss and `P0-04` missing numeric-evidence enforcement are mandatory release blockers.
- SOP source says approximately 17:00 after 8–10 hours, while the product rule fixes six first-day times. Late admission must be blocked/escalated, not silently rescheduled.
- SOP mentions free feeding at 20+ days, while product rules allow operator selection from day two. Frozen stage conditions remain the operational authority.
- Water resumption and veterinary safety exceptions are not sufficiently specified for automatic device control.
- Routine daily confirmation must not absorb abnormal, weak-pig disposition, mode-change or device-change approvals.
