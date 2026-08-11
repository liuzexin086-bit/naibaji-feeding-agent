# NBJ-ARCH-P2 Contract

Status: `REVIEW 0 — CHANGES REQUIRED`

Baseline: `76187e1a3d4c7b83a70fc2aabb0a6fb4a8f05232`

Review candidate/checkpoint: `fead997b78afb2b03c372a957f9fe8c19fd6d4a0`

Checkpoint parent: `76187e1a3d4c7b83a70fc2aabb0a6fb4a8f05232`

Remote branch: `nbj-arch-p2`

Baseline tag: `nbj-execution-contract-p1-baseline-20260811`

Date: 2026-08-11

## 1. Objective

NBJ-ARCH-P2 consolidates the repository into one production architecture that is explicit, testable, upgradeable, and recoverable:

```text
Web / UI
  -> authenticated HTTP / SSE Agent API
  -> Application Services
  -> Domain + Feeding Model + SOP
  -> Repository contracts
  -> SQLite
  -> Backup / Migration
```

LangGraph is an orchestration consumer of Application Services. It is not a source of business facts. Chroma is a derived knowledge index. It is not the SOP authority.

## 2. Scope of P2-0

P2-0 freezes contracts and evidence only. It does not move runtime files or change production behavior.

P2-0 deliverables are:

- this architecture contract;
- the authority map;
- the immutable evidence manifest;
- the compatibility and behavior-freeze contract;
- an independent Contract Review verdict.

P2-1 through P2-13 implementation is out of scope until the P2-0 Contract Gate is OPEN.

## 3. Production target and exclusions

The target production runtime has:

- one Web/UI runtime;
- one authenticated Agent API;
- one Application layer;
- framework-free Domain contracts;
- one production Feeding Model source;
- one published SOP authority;
- one local production business-data authority: SQLite;
- explicit migration, backup, restore, and rollback paths.

The following must leave the production read/write and decision paths before P2 closure:

- Electron v1;
- JSON Database v1;
- Supabase v1 runtime;
- independently maintained model copies;
- Python Optimizer outputs.

They may remain for one release cycle only as versioned migration sources, compatibility fixtures, or legacy archives. No bidirectional synchronization is allowed.

## 4. Binding architecture principles

1. One domain fact has one authoritative implementation and one authoritative store.
2. SQLite is the sole local production authority for business data. Secret material and process configuration remain in dedicated secret/config channels and are not reclassified as domain facts.
3. UI accesses business state only through the Agent API and Application Services.
4. Domain packages must not import HTTP, React/UI, SQLite drivers, LangGraph, or LLM providers.
5. Agent runtime may explain and orchestrate, but may not calculate, validate, transition, or persist business facts independently.
6. P2 is behavior-preserving except for separately approved, evidenced, and tested P0 corrections.
7. New authority is established and parity-proven before an old path is isolated or removed.
8. Derived stores and artifacts must expose their source version/digest and be reconstructable from authority.

## 5. Baseline safety freeze

### 5.1 Canonical P0 release gates

The canonical P0 identifiers remain those frozen in `agent/task_plan.md`. P2 does not rename or reuse them:

| Canonical Gate | Required behavior | Baseline status/evidence |
|---|---|---|
| `P0-01` Agent/local decision parity | Shared batch decision service; same revision, mode, device hash, slots/windows, quantities, active decision, and runtime state | PASS — remote P0 release gate and Agent/local parity tests in run `31465609647` |
| `P0-02` frozen SOP/device digest | Missing, mismatched, or stale frozen evidence fails closed; no latest/default SOP numeric fallback | PASS — remote P0 release gate and frozen evidence regression suites |
| `P0-03` 09:00 business-day/cross-midnight normalization | Preserve next-day slots/windows; reject ambiguous or overlapping schedules | PASS — remote P0 release gate and business-day/free-window suites |
| `P0-04` deterministic evidence validation | Missing, stale, or tampered deterministic receipts cannot emit protected facts or actions | PASS — remote P0 release gate and LangGraph evidence/tamper suites |

If any canonical P0 gate regresses, runtime migration and Compose replacement stop immediately and the P2 Merge Gate remains CLOSED. Feature flags, default templates, prompts, or verbal approval cannot bypass these gates.

### 5.2 Additional P2 prerequisite safety review

These checks are starting-condition findings and deliberately do not reuse canonical P0 IDs:

| Prerequisite | Baseline status | Contract evidence |
|---|---|---|
| `P2-PRE-01` Optimizer cannot enter production | PASS | `optimizer/README.md` marks it EXPERIMENTAL / NOT FOR PRODUCTION and rejects legacy output. |
| `P2-PRE-02` `diarOffset` cannot enter production parameters | PASS | It is absent from optimizer production output/search and locked by `optimizer/tests/test_calibration.py`. |
| `P2-PRE-03` Missing diarrhea observation is not `none` | BLOCKED | Core API/store paths and tests distinguish omission from `none`, but chat normalization drops explicit `none` in `agent/src/container/server.ts`. See `P2-F-001` / `P2-ED-001`. |
| `P2-PRE-04` Exceptions after plan confirmation are not swallowed | PASS | Confirmed plans are immutable; post-confirmation amendments have independent digest, state, audit, confirmation, and application paths. |
| `P2-PRE-05` LLM cannot freely generate safety-critical numbers | PASS | Protected facts are deterministic; numeric LLM narration is discarded; missing/tampered receipts fail closed. |

These statuses are not permission for automatic device control. Because `P2-PRE-03` is not closed across every accepted input path, P2 structural implementation may begin after the P2-0 Contract Gate opens, but the P2 Merge Gate remains CLOSED until `P2-F-001` is corrected or chat observations are formally removed from the authoritative contract and the chosen contract is regression-tested.

## 6. Non-goals and closed authority

P2 does not add or enable:

- Risk Engine;
- automatic learning or optimizer promotion;
- new feeding curves, thresholds, SOP logic, diarrhea logic, or meal logic;
- automatic device control;
- Optimizer Production authority;
- V5-Lite production authority beyond its frozen shadow-only contract;
- Full Creep Control authority;
- merge, release tag, or deployment merely because a sub-stage passes.

## 7. Required stage order

The default order is:

```text
P2-0 Contract Freeze
  -> P2-1 Domain Contract
  -> P2-2 Persistence Boundary
  -> P2-3 Migration Ledger
  -> P2-4 Legacy JSON Import
  -> P2-6 Feeding Model Single Source
  -> P2-7 SOP Single Authority
  -> P2-8 Application Services
  -> P2-9 Agent Orchestration
  -> P2-10 UI API-only Path
  -> P2-5 / P2-11 Legacy Runtime Isolation
  -> P2-12 Runtime / Docker / Backup / Restore
  -> P2-13 Final Closure Review
```

Reordering requires a documented dependency argument and independent review. Legacy deletion cannot precede parity and import evidence.

## 8. Gate contract

Each P2 checkpoint records:

- implementation status;
- static and boundary tests;
- behavior parity;
- migration/data-integrity evidence where applicable;
- P0/P1/P2 findings;
- rollback point;
- independent review verdict;
- Gate state.

Gate semantics:

- `OPEN`: all blocking acceptance criteria are evidenced.
- `CLOSED`: work is not authorized past that Gate.
- `BLOCKED`: an external result or unresolved blocking finding is required.

`P2-0 Contract Gate` opens only when all production fact types have a unique target authority, legacy/experimental boundaries are explicit, behavior freeze is testable, and Review 0 passes. `P2 Merge Gate` remains CLOSED until all P2 P0/P1 findings and final runtime, migration, security, and recovery Gates pass.

## 9. Change and rollback discipline

- Work occurs on `nbj-arch-p2` from the exact P1 merge baseline.
- Each P2 stage is a focused checkpoint; unrelated business changes are prohibited.
- Every allowed behavior delta has an Expected Delta record before implementation.
- A failed stage rolls back to the prior reviewed checkpoint; it does not repair forward by silently changing business rules.
- Legacy source remains recoverable for at least one release cycle after cutover.
- Merge uses reviewed history appropriate to the audit trail; merge, push, deployment, and tagging require separate authorization.

## 10. P2 completion contract

P2 may be frozen only after evidence proves:

- one API, one business database, one Feeding Model source, one published SOP authority, and one runtime path;
- zero production JSON DB, Supabase, legacy-model, and Optimizer calls;
- migrations/imports have zero missing rows, duplicates, and orphans;
- model and behavior parity is 100% except approved Expected Deltas;
- core decisions, SOP, and device-plan preparation work without an LLM provider;
- backup, isolated restore, restart, and rollback tests pass;
- security findings are P0 = 0 and P1 = 0;
- the independent Final Closure Review returns PASS or PASS WITH NON-BLOCKING FINDINGS.

Until then, `Architecture Unification Gate` is CLOSED.

## 11. Review 0 decision

Independent Review 0 examined checkpoint `fead997b78afb2b03c372a957f9fe8c19fd6d4a0` against baseline `76187e1a3d4c7b83a70fc2aabb0a6fb4a8f05232` on remote branch `nbj-arch-p2`. The verdict is `REQUEST CHANGES`; the full receipt is [nbj-arch-p2-review-0.md](./nbj-arch-p2-review-0.md).

```text
P0-01..P0-04 Baseline Gates: OPEN / PASS
P2-0 Review 0: REQUEST CHANGES
P2-0 Contract Gate: CLOSED

P2-PRE-03: BLOCKED
P2-F-001: OPEN BLOCKER
P2-ED-001: REGISTERED / IMPLEMENTATION PENDING

P2-1 Structural Implementation Authorization: CLOSED
P2 Runtime/Cutover Gate: CLOSED
P2 Compose Replacement Gate: CLOSED
P2 Merge Gate: CLOSED
Architecture Unification Gate: CLOSED
Optimizer Production Gate: CLOSED
Real Device Control Gate: CLOSED
```

P2-0.1 may correct the Review 0 documentation findings only. It does not open the Contract Gate and cannot self-certify Review 0. A later independent review of the corrected checkpoint is required before P2-1 authorization can open.

Before any P2-1 runtime or Domain change, CI triggers must cover pushes to `main` and `nbj-arch-p2`, plus pull requests targeting `main`. The current workflow has no push run for `nbj-arch-p2`; this is finding `P2-001` and is intentionally not changed by this docs-only checkpoint.
