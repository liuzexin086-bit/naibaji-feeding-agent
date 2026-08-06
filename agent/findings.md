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
