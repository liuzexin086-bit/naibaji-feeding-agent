# NBJ-ARCH-P2 Compatibility and Behavior-Freeze Contract

Status: `P2-0 CONTRACT REVIEW PASS — P2-001 OPEN`

Baseline: `76187e1a3d4c7b83a70fc2aabb0a6fb4a8f05232`

Historical Review 0 checkpoint: `fead997b78afb2b03c372a957f9fe8c19fd6d4a0` — `REQUEST CHANGES`

Accepted corrected checkpoint: `fec5659a7f514201ea1f090cc2c7e9c02aeb57db` — `PASS`

Corrected checkpoint parent: `fead997b78afb2b03c372a957f9fe8c19fd6d4a0`

Remote branch: `nbj-arch-p2`

## 1. Compatibility rule

P2 is a behavior-preserving architecture refactor. File location, package boundary, dependency direction, storage adapter, and API composition may change; observable business results and persisted meaning may not change unless an Expected Delta is approved before implementation.

Passing typecheck or unit tests is insufficient. Compatibility is evaluated at contract, value, state-transition, persistence, and runtime levels.

## 2. Frozen behavior surfaces

| Surface | Frozen semantics |
|---|---|
| Feeding Model | Same accepted input domain, units, rounding, caps, control-start behavior, output fields, model version/digest, and deterministic result. |
| Feeding Decision | Same selected/effective mode, powder amounts, meal/window schedule, evidence, fail-closed conditions, policy classification, and revision behavior. |
| Decision application | Planned and active decisions remain separate. Current/active/applied/device-setting fields derive only from `activeDecision`; absent active state is `null` or `not_applied`. A planned preview is explicitly `previewDecision`, `previewSource: "planned"`, `isApplied: false`. |
| Observation | Omitted/not-observed remains distinct from explicit normal/`none`; recorded value and timestamp provenance are preserved. |
| Creep control | Persisted server-owned `CreepControlState { status, startDay, triggerGrade, policyVersion }` changes only through the Control Transition Service; `startDay` is never recomputed from the latest observation. |
| Runtime execution/latches | Explicit authoritative observations drive deterministic latch transitions through the Observation / Runtime State Service; omission is not normal and one domain cannot clear another domain's latch. |
| Diarrhea handling | Same severity contract, individual/manual/proposal classification, priority, explicit-none closure, and non-automatic application. |
| Daily Operation Plan | Same business date, frozen SOP/model refs, operations digest, one complete confirmation contract, and confirmed-plan immutability. |
| Amendment | Same origin uniqueness, digest, revision binding, confirmation/application state machine, audit, and idempotency. |
| SOP | Same default and published rule outputs, publication freeze, source digest, parser/index verification, and replay binding. |
| Agent | Protected facts remain deterministic; missing/stale/tampered evidence fails closed; LLM absence does not block core business behavior. |
| API | Same authorization, idempotency, error safety, and externally consumed request/response meaning during an announced compatibility window. |
| SQLite | Same business IDs, row meaning, relationships, revisions, digests, history, and transaction atomicity across migrations. |
| Legacy import | Source identity and every mapped field are traceable; unmappable records go to quarantine, never silent discard. |
| Runtime provenance | Commit, schema, decision policy, model/SOP identity, artifact hashes, and UI source remain verifiable. |

## 3. Units and representation

- Every safety-relevant number has a named unit-bearing field or `{ value, unit }` contract.
- A representation-only change is compatible only when serialization round-trips without precision or semantic loss.
- Time retains timezone/business-date meaning; a formatting change cannot move an event to another business day.
- IDs, revisions, hashes, and idempotency keys are not regenerated during migration.
- `null`, omitted, not-observed, explicit `none`, zero, and empty collection are distinct unless a contract explicitly equates them.

## 4. Parity evidence

Each affected stage must execute the same frozen inputs through the baseline and candidate paths.

Minimum suites:

1. Feeding Model golden vectors: at least 100 representative and boundary vectors.
2. SOP/Decision fixtures: normal, first-day, mode, capacity, diarrhea, and failure boundaries.
3. State-transition fixtures: create, confirm, amend, apply/reject/cancel, replay, stale revision, and concurrency.
4. Persistence fixtures: fresh DB, N-1 DB, and sanitized legacy SQLite copy.
5. Legacy import fixtures: JSON v1 with success, duplicate replay, partial mapping, and quarantine cases.
6. Runtime fixtures: API/Agent/UI path with a fake LLM provider; Domain and core decisions are real.

Required default result:

```text
baseline output == candidate output
delta count = 0
missing rows = 0
unexpected duplicates = 0
orphans = 0
```

Hash equality is required where ordering and serialization are contractually canonical. Otherwise compare normalized typed values and separately prove canonical reserialization.

## 5. Expected Delta registry

No intentional behavior change may be hidden inside a refactor. Before code changes, add a record with:

```text
Delta ID
Affected contract and fixtures
Baseline result
New result
Safety/business reason
P0 approval reference
Migration/backfill impact
Rollback rule
Tests
Independent reviewer
```

Only already approved P0 corrections may enter this registry during P2. Convenience, cleanup, performance, or a preferable new business rule is not an approved delta.

### Registered starting delta

| Delta ID | Baseline | Required candidate behavior | Approval/status | Required proof |
|---|---|---|---|---|
| `P2-ED-001` | Chat `observation.diarrheaGrade="none"` is normalized to an omitted grade, while the core API/store contract preserves explicit `none`. | One typed observation contract preserves `observed:none` distinctly from `not_observed` through chat, API, Domain, and persistence; alternatively remove chat observations from the authoritative input contract. | Identified by P2-0 audit; the user's P2-1 charter explicitly requires `missing != none`; implementation not yet performed. P2 Merge Gate CLOSED until independently accepted. | Endpoint regression for omitted vs explicit `none`, earlier-abnormal closure, tampered/invalid input, and no unapproved device application. |

## 6. API and data compatibility

- HTTP handlers translate transport contracts and call Application Services; they do not reproduce Domain rules.
- During cutover, an adapter may preserve a legacy API response, but the adapter is read-only with respect to business semantics and has an expiry checkpoint.
- Database migrations are forward, transactional where SQLite permits, checksum-verified, and idempotent to re-run only when explicitly designed.
- Migration never reads the latest SOP/model to reinterpret old decisions; stored version/digest evidence is authoritative for replay.
- JSON/Supabase import is one-way. Running the same source twice creates zero new domain records on the second run.
- Quarantine is a successful preservation outcome, not permission to report the import as complete.

## 7. Architecture boundary tests

CI must reject at least:

- Domain imports from HTTP, SQLite, LangGraph, React/UI, or LLM SDKs;
- UI imports/calls to Supabase, JSON files, SQLite, or feeding/SOP arithmetic;
- Agent tools that execute SQL, write device state, or reimplement feeding rules;
- production imports from `legacy/` or `optimizer/`;
- independently maintained minified/CJS/model sources;
- decisions without frozen SOP/model publication identity;
- runtime migrations without an ordered checksum ledger.

## 8. Rollback triggers

A stage must stop and roll back to its prior reviewed checkpoint if any of the following occurs:

- unapproved business-output delta;
- missing, duplicated, orphaned, or re-keyed production data;
- migration checksum/history mismatch;
- confirmed-plan, audit, or decision evidence mutation;
- fallback to legacy/Supabase/JSON write path;
- LLM/provider dependency for core decision/SOP/device-plan preparation;
- inability to restore the pre-stage database and start the prior runtime;
- P0 or unresolved P1 review finding.

Rollback evidence includes the previous commit, database backup SHA-256, schema/application/model/SOP versions, restore log, and post-restore smoke/parity result.

## 9. Closure evidence

The compatibility Gate opens only when all affected frozen fixtures pass, every delta is registered and approved, import/migration invariants are zero-loss, boundary tests are enforced in CI, and an independent reviewer confirms that architectural movement did not alter unapproved business behavior.
