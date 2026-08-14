# NBJ-ARCH-P2 Contract

Status: `P2-4 CONTRACT REGISTRATION — PASS / IMPLEMENTATION AUTHORIZATION OPEN`

Baseline: `76187e1a3d4c7b83a70fc2aabb0a6fb4a8f05232`

Historical Review 0 checkpoint: `fead997b78afb2b03c372a957f9fe8c19fd6d4a0` — `REQUEST CHANGES`

Accepted corrected checkpoint: `fec5659a7f514201ea1f090cc2c7e9c02aeb57db` — `PASS`

Corrected checkpoint parent: `fead997b78afb2b03c372a957f9fe8c19fd6d4a0`

Remote branch: `nbj-arch-p2`

CI preflight receipt: [nbj-arch-p2-ci-preflight-receipt.md](./nbj-arch-p2-ci-preflight-receipt.md)

P2-1 Final Review Seal: [nbj-arch-p2-review-1-final.md](./nbj-arch-p2-review-1-final.md)

P2-2A Final Review Seal: [nbj-arch-p2-review-2a-final.md](./nbj-arch-p2-review-2a-final.md)

P2-2B Repository Boundary Evidence: [nbj-arch-p2-2b-repository-boundary.md](./nbj-arch-p2-2b-repository-boundary.md)

P2-2B / P2-2 Final Review Seal: [nbj-arch-p2-review-2b-final.md](./nbj-arch-p2-review-2b-final.md)

P2-3A Migration Ledger Evidence: [nbj-arch-p2-3a-migration-ledger.md](./nbj-arch-p2-3a-migration-ledger.md)

P2-3A Final Review Seal: [nbj-arch-p2-review-3a-final.md](./nbj-arch-p2-review-3a-final.md)

P2-3B Contract: [nbj-arch-p2-3b-contract.md](./nbj-arch-p2-3b-contract.md)

P2-3 Final Closure Seal: [nbj-arch-p2-review-3-final.md](./nbj-arch-p2-review-3-final.md)

P2-4 Legacy JSON Import Contract: [nbj-arch-p2-4-contract.md](./nbj-arch-p2-4-contract.md)

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
| `P2-PRE-03` Missing diarrhea observation is not `none` | PASS | Independent P2-2A review accepted the complete Chat/API/Domain/repository/SQLite close-reopen evidence chain; omission remains distinct from explicit `none`. |
| `P2-PRE-04` Exceptions after plan confirmation are not swallowed | PASS | Confirmed plans are immutable; post-confirmation amendments have independent digest, state, audit, confirmation, and application paths. |
| `P2-PRE-05` LLM cannot freely generate safety-critical numbers | PASS | Protected facts are deterministic; numeric LLM narration is discarded; missing/tampered receipts fail closed. |

These statuses are not permission for automatic device control. P2-2A closes the
observation-presence prerequisite only; the P2 Merge Gate remains CLOSED until all
remaining stage, migration, runtime, security, recovery, and final-review criteria pass.

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

Independent Review 0 examined checkpoint `fead997b78afb2b03c372a957f9fe8c19fd6d4a0` and returned `REQUEST CHANGES`; that historical receipt remains [nbj-arch-p2-review-0.md](./nbj-arch-p2-review-0.md). A later independent re-review examined corrected checkpoint `fec5659a7f514201ea1f090cc2c7e9c02aeb57db`, confirmed its parent and exact five-file docs-only diff, and returned `PASS`; that receipt is [nbj-arch-p2-review-0-final.md](./nbj-arch-p2-review-0-final.md).

The independent P2-1 review examined `edbe4335f8436abdd2084776fecaf4dc9e22cff2`
with parent `b861e2c8f9e1c462a67b26fe0b32e0cfb29852`, verified remote
[agent-safety run 31558952869](https://github.com/liuzexin086-bit/naibaji-feeding-agent/actions/runs/31558952869),
and returned `PASS WITH NON-BLOCKING FINDINGS`. See the [P2-1 Final Review Seal](./nbj-arch-p2-review-1-final.md).

```text
P0-01..P0-04 Baseline Gates: OPEN / PASS
P2-0 Review 0: PASS
P2-0 Contract Gate: OPEN

P2-PRE-03: PASS
P2-F-001: CLOSED
P2-ED-001: CLOSED — ACCEPTED

P2-001: CLOSED — CI PREFLIGHT PASS
P2-1 CI Preflight: PASS
P2-1 Implementation: PASS
P2-1 Independent Review: PASS
P2-1 Gate: OPEN
P2-2 Persistence Boundary Authorization: OPEN
P2-2A Implementation: PASS
P2-2A Independent Review: PASS
P2-2A Gate: OPEN

P2-2B Implementation: PASS
P2-2B Independent Review: PASS
P2-2B Gate: OPEN

P2-2-F01: CLOSED
P2-2-F02: CLOSED
P2-2-F03: CLOSED

P2-2 Persistence Boundary: PASS
P2-2 Gate: OPEN

P2-3 Migration Ledger Authorization: OPEN
P2-3A Ordered Migration Ledger: PASS
P2-3A.1 Correction: PASS
P2-3A Independent Remote Review: PASS
P2-3A-F01: CLOSED
Independent QA: BLOCKED — INFRASTRUCTURE / NO VERDICT
Later local QA re-review: PASS — SEPARATE RECEIPT
P2-3A Gate: OPEN
P2-3A Final Review Seal: PASS
P2-3 Closure Contract Review: CLOSED / PASS
P2-3B Contract Registration: PASS
P2-3B Implementation Authorization: OPEN
P2-3B Implementation: PASS
P2-3B Independent Remote Review: PASS
P2-3B-F02: CLOSED / PASS
P2-3B Gate: OPEN
P2-3 Final Closure Seal: PASS
P2-3 overall: CLOSED / PASS

P2-4 Legacy JSON Import Authorization: OPEN
P2-4 Contract Registration: PASS
P2-4-F01: CLOSED / PASS
P2-4-F01.1: CLOSED / PASS
P2-4-F02: CLOSED / PASS
P2-4-F03: CLOSED — NON-BLOCKING / P2 (audit wording only)
P2-4 Implementation Authorization: OPEN
P2-4 Implementation: CANDIDATE / INDEPENDENT REVIEW PENDING
P2-4 Gate: CLOSED

P2 Runtime/Cutover Gate: CLOSED
P2 Compose Replacement Gate: CLOSED
P2 Merge Gate: CLOSED
Architecture Unification Gate: CLOSED
Optimizer Production Gate: CLOSED
Real Device Control Gate: CLOSED
```

This P2-0.2 Final Seal records the independent review of `fec5659a7f514201ea1f090cc2c7e9c02aeb57db`; it does not review or certify its own commit.

CI preflight commit `7912b1721a11e441a741e7bdcd4e7ebf367f1a76` added push coverage for `main` and `nbj-arch-p2` plus pull-request coverage targeting `main`. Remote push run [`31550812177`](https://github.com/liuzexin086-bit/naibaji-feeding-agent/actions/runs/31550812177) executed that exact SHA and passed, closing `P2-001`; the evidence is recorded in [nbj-arch-p2-ci-preflight-receipt.md](./nbj-arch-p2-ci-preflight-receipt.md).

P2-1 Domain implementation and independent review have passed. P2-2A independently
proved the accepted Domain contract through repository, SQLite, reload, and Domain
round-trip behavior. P2-2B independently closed `P2-2-F01` through `P2-2-F03`,
so the P2-2 Persistence Boundary and P2-2 Gate are OPEN. P2-3 Migration Ledger
is the next authorized stage. This does not authorize Application, Agent, UI,
runtime/cutover, Compose replacement, merge, deployment, tagging, optimizer
production, or real device control stages.

P2-1 Domain checkpoint status is implementation and independent review PASS.
The independent P2-2A review accepted the complete observation-presence evidence
chain and closed `P2-ED-001`, `P2-F-001`, and `P2-PRE-03`. The independent
P2-2B review then closed `P2-2-F01` through `P2-2-F03` without reopening the
explicit-none semantics. Runtime/Cutover, Compose Replacement, Merge, and other
later Gates remain CLOSED.

P2-2B implementation evidence is recorded in the Repository Boundary Evidence
document and its independent PASS is sealed by the P2-2B / P2-2 Final Review
Seal. Persistence contracts no longer import legacy LocalStore types, the
architecture scanner is recursive, and raw metadata ownership/overlay/quarantine
semantics are explicit. P2-2 is complete; there is no P2-2C. P2-3 Migration
Ledger Authorization is OPEN. At the P2-2 seal checkpoint, no P2-3
implementation was included.

P2-3A implementation evidence now records an ordered, checksum-verified ledger
and lossless legacy-ledger compatibility seam. It retains schema version 12 and
does not invent identities for historical v3-v11 rows. Review of
checkpoint `7d8da7fc0ce06dbfd6d6a6928de712cdc31869d4` returned `REQUEST CHANGES`
for `P2-3A-F01`; the P2-3A.1 candidate separates one-time frozen snapshot
backfill from structural restart repair. Independent remote re-review of
correction checkpoint `7e4101bebadbce8aed43a1b02a0f7f61f67aebc6`
returned `PASS`, closed `P2-3A-F01`, and opened the P2-3A Gate. The failed QA
dispatch remains separately recorded as an infrastructure blocker with no
verdict. P2-3 overall remained in progress, P2-4 remained unauthorized, and the
P2-3 Closure Contract Review then identified three remaining P2-3 gaps:
migration identity/orchestration has not moved to the frozen Persistence
migration authority, a rich-v12 zero-pending restart can still execute ad-hoc
schema DDL, and the required sanitized legacy SQLite fixture is not yet present
or replaced by an independently accepted equivalence amendment. P2-3B was
registered to close only those gaps while freezing every accepted P2-3A
invariant. Independent remote review of implementation correction checkpoint
`c9165b269339cca1c2ec94bd63750d765b836079` returned `PASS`, closed
`P2-3B-F02`, and opened the P2-3B Gate. The three historical gaps are therefore
remediated, but this docs-only Final Closure Seal candidate cannot certify
itself. P2-3 overall remains in progress pending its independent review; P2-4
authorization and every later Gate remain CLOSED.

Independent remote review of Final Closure Seal checkpoint
`2fb45b25f6880f03f563fd472d8143bfed8699b5` returned `PASS`. Exact-SHA
`agent-safety` run `31680852943` completed with `success`, including the precise
full-suite result `413 passed / 1 skipped / 414 total`. The review formally
closed the P2-3 Closure Contract Review and P2-3 overall, and opened P2-4 Legacy
JSON Import Authorization. All later Gates remain CLOSED.

The linked P2-4 contract is a docs-only registration candidate. It inventories
the actual JSON Database v1 and browser-snapshot source families, rejects
unrelated JSON artifacts, and freezes source identity, owner mapping,
collection disposition, replay/conflict semantics, durable quarantine,
zero-loss counters, backup/rollback, fixtures, and required gates. It does not
implement an importer or open P2-4 Implementation Authorization.

Independent remote contract review of registration checkpoint
`138b1ae6782615022eefb743537f0781eee9f330` returned `REQUEST CHANGES` with
two P1 findings: `P2-4-F01` (canonical identity encoding, known hash vectors,
and owner-map rebinding semantics were under-specified) and `P2-4-F02`
(import manifest/trace/quarantine schema was not explicitly bound to the
sealed `packages/persistence/migrations` authority). The narrow docs-only
correction checkpoint recorded here freezes the canonical CJSON tuple encoding
and its known vectors, the same-source/different-owner-map fail-closed rule,
the forward-migration-only schema rule with zero runtime DDL, and this audit
history, changing exactly the three registered `docs/p2/**` files. It does
not implement the importer, and P2-4 Implementation Authorization remains
CLOSED until independent re-review closes F01/F02.

Independent re-review of correction checkpoint
`ce16798b0b989b6a403082e8d0c9b917882a84f2` accepted `P2-4-F02`
(`CLOSED / PASS`), matched the independently recomputed V1–V5 vectors, and
returned `REQUEST CHANGES` with one P1 residual, `P2-4-F01.1`: the frozen
quarantine identity was not source-bound. The narrow second correction
recorded here freezes the source-bound quarantine identity
(`"quarantine", source_kind, source_sha256, collection,
raw_row_canonical_sha256, source_ordinal`), updates V5, adds the cross-source
separation vector V6, and records F01.1 in the audit history. It changes
exactly the three registered `docs/p2/**` files; P2-4 Implementation
Authorization remains CLOSED until independent re-review closes F01.1.

Independent re-review of second correction checkpoint
`f921b4f67187494b6d91965d176a3a85857ee938` returned `PASS` with P0 = 0 and
P1 = 0. `P2-4-F01`, `P2-4-F01.1`, and `P2-4-F02` are `CLOSED / PASS`;
the P2-4 Contract Registration Review is `CLOSED / PASS`; and P2-4
Implementation Authorization is `OPEN`. One non-blocking P2 item
(`P2-4-F03`, audit wording only) was recorded without requiring a further
correction. P2-4 Implementation remains NOT STARTED and the P2-4 Gate remains
CLOSED; P2-6, runtime/cutover, Compose replacement, merge, tag, PR,
deployment, and real-device control remain unauthorized.

The P2-4 implementation candidate is recorded in
`nbj-arch-p2-4-implementation.md`: the frozen CJSON/identity
modules with V1-V6 vectors, the import application service with
source-bound identities, owner-mapping hash binding and mismatch
fail-closed, manifest/trace/durable-quarantine persistence through forward
migration v14 (`registered-schema-v14-import`) with zero runtime
DDL, the sanitized real JSON Database v1 fixture set and manifest, the
`p2-4-legacy-json-import-gate` wired into the safety workflow, and local
gate results (P2-4 93/93; full suite 60 files / 458 passed; P2-1/P2-2/P2-3A/
P2-3B/P0/P1, build, and clean-source all green). The candidate does not
self-certify: exact-SHA CI and independent implementation review remain
required before the P2-4 Gate may open.
