# NBJ-ARCH-P2 P2-3B Contract Registration Implementation

Status: `IMPLEMENTATION CANDIDATE — INDEPENDENT REVIEW PENDING`

Registration checkpoint: `d8a9208338b792fbcc4e3c0dbb314f9275abf842`

Independent registration verdict: `PASS WITH NON-BLOCKING FINDING`

## Candidate boundary

This checkpoint implements only the closure work registered by the P2-3B
contract. It does not open the P2-3B Gate, close P2-3 overall, authorize P2-4,
or begin runtime/cutover, Compose replacement, merge, optimizer, or real-device
work.

## Single migration authority

`packages/persistence/migrations` now owns:

- the canonical schema body and current migration version;
- immutable v12 and v13 definitions, names, canonical bodies, and checksums;
- ordered registry validation and exact-prefix validation;
- legacy-ledger upgrade and audit metadata rules;
- pending migration execution and orchestration.

`agent/src/local-db/schema.ts` and `migration-ledger.ts` are compatibility
re-exports only. `local-db/index.ts` retains only the SQLite connection,
transaction boundary, and DDL-observation test seam. Preflight, structural
operations, row/digest preservation checks, and the one-time v12 backfill are
physically owned by `packages/persistence/migrations/sqlite-operations.js` and
are invoked only by the canonical pending migration chain.

The accepted v12 identity is sealed at:

```text
version: 12
name: audited-schema-v12-baseline
checksum: 0B204D099EA0661A836F2F0DD34207A6CEF3B0C79C2FE86263F40FD381F4068E
```

The retained structural compatibility path is registered as forward migration
v13 `registered-schema-v13-repair`. Zero pending migrations do not enter that
adapter path.

## Hard proofs

`tests/p2-3b/migration-ownership.test.ts` instruments the SQLite authorizer at
the actual connection seam and proves:

- a rich v13 restart emits zero CREATE/DROP/ALTER schema actions;
- ledger, normalized `sqlite_schema`, and business-row digests are unchanged;
- a persisted v12 checksum tamper fails before any schema DDL;
- a persisted v12 name tamper fails before any schema DDL;
- both tamper paths preserve the post-tamper ledger/schema/business digests and
  execute no later migration.

## Sanitized legacy fixture

`tests/fixtures/p2-3b/legacy-v5-sanitized.sqlite` is derived from an ignored
real local backup. The generator pins both the raw main database SHA-256 and its
WAL SHA-256, copies both, checkpoints only the copy, removes all original
business/auth/message/SOP/audit rows, inserts deterministic synthetic linked
records, uses secure deletion plus `VACUUM`, and verifies raw source hashes
again after generation.

The manifest binds fixture hash/size, observed SQLite library version, source
state, sanitization record, raw main/WAL hashes, schema/index inventory, legacy
ledger versions 1–5, expected rich versions 12–13, integrity, foreign keys, and
relationship preservation. Tests hash the committed fixture before opening it,
migrate a temporary copy only, and require the committed fixture hash to remain
unchanged.

## Local verification

```text
npm run p2-3b-migration-ownership-gate: 46 passed
npm test: 54 files / 414 passed
npm run p2-1-domain-gate: 20 passed
npm run p2-2-persistence-gate: 9 passed
npm run p2-3a-migration-gate: 35 passed
npm run p0-release-gate: 100 passed
npm run p1-safety-gate: 197 passed
npm run build: PASS
npm run clean-source-gate: PASS
agent image build and package import smoke: PASS
web image build: PASS
```

Build, legacy gates, clean-source checks, Docker image builds, exact-SHA CI, and
independent review are recorded separately when completed. Local evidence does
not self-certify this candidate.

The local independent-QA dispatch produced no report across two bounded
attempts and was interrupted. Its status is `BLOCKED — INFRASTRUCTURE / NO
VERDICT`; it is not represented as PASS. Remote independent implementation
review and exact-SHA CI remain required.

## Candidate state

```text
P2-3A: CLOSED / PASS
P2-3A Gate: OPEN
P2-3A-F01: CLOSED

P2-3 Closure Contract Review: REQUEST CHANGES
P2-3B Contract Registration: PASS
P2-3B Implementation Authorization: OPEN
P2-3B Implementation: CANDIDATE / INDEPENDENT REVIEW PENDING
P2-3B Gate: CLOSED

P2-3 overall: IN PROGRESS
P2-4 Authorization: CLOSED
Runtime/Cutover Gate: CLOSED
Compose Replacement Gate: CLOSED
P2 Merge Gate: CLOSED
Architecture Unification Gate: CLOSED
Optimizer Production Gate: CLOSED
Real Device Control Gate: CLOSED
```
