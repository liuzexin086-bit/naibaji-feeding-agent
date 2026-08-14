# NBJ-ARCH-P2 P2-4 Legacy JSON Import Implementation

Status: `IMPLEMENTATION CANDIDATE — INDEPENDENT REVIEW PENDING`

Contract registration: `PASS` (independent re-review of `f921b4f67187494b6d91965d176a3a85857ee938`)

Implementation authorization: `OPEN` (recorded at `2657aff6e4077ee4823f602ebcac4f8709617784`)

## Candidate boundary

This checkpoint implements the P2-4 legacy JSON import per the frozen
contract [nbj-arch-p2-4-contract.md](./nbj-arch-p2-4-contract.md). It does
not open the P2-4 Gate, authorize P2-6, or begin runtime/cutover, Compose
replacement, merge, tag, PR, deployment, optimizer production, or real-device
work.

## Frozen identity encoding

`agent/src/import/canonical-json.ts` implements the frozen CJSON
serialization and a strict parser that rejects duplicate object keys and
invalid number tokens. `agent/src/import/identity.ts` implements the frozen
identities:

```text
record_identity =
  SHA-256( UTF-8( CJSON([ source_kind, source_sha256, collection, source_record_id ]) ) )

quarantine_identity =
  SHA-256( UTF-8( CJSON([ "quarantine", source_kind, source_sha256, collection,
                         raw_row_canonical_sha256, source_ordinal ]) ) )
```

The quarantine identity is source-bound. All six frozen known vectors
(V1-V6) are committed in the module and asserted byte-for-byte by
`tests/p2-4/identity-vectors.test.ts`; V5/V6 prove cross-source quarantine
separation.

## Import application service

`agent/src/import/importer.ts` is the single import application authority
with dependency direction

```text
source adapter -> import application service -> persistence ports -> SQLite adapters
```

Ports and types live in `agent/src/import/contracts.ts`; the SQLite adapters
live in `agent/src/import/sqlite-adapters.ts` and execute zero schema DDL.
Behavior implemented per the frozen contract:

- read-only source handling with byte SHA-256 and strict parsing;
- envelope preflight (`meta.schemaVersion` must be 1, all nine collections
  must be arrays); unsupported schema and malformed JSON fail closed with
  zero destination writes;
- owner-mapping manifest load, format validation, and hash binding; the
  same source with a different `owner_mapping_sha256` throws
  `owner-mapping-mismatch` before any destination write; the target user
  must already exist (import never creates users or credentials);
- per-row dispositions: `mapped`, `preserved_raw`, `exact_duplicate`, or
  `quarantined` - there is no silent ignore;
- duplicate/conflict handling: an exact duplicate occurrence is counted and
  mapped once with every occurrence traced; the same collection/source ID
  with different canonical content is a `duplicate-conflict` and the whole
  identity is quarantined before target mutation;
- rows without a provable source ID (string or safe integer) receive the
  stable source-bound quarantine identity;
- parent/child integrity: a dailyRecord whose batch is not in the source is
  quarantined as `missing-parent`; target orphans remain zero by
  construction and by counter assertion;
- null vs omission vs explicit zero remain distinct: omitted diarrhea
  fields are preserved as omission, explicit zero stays zero, and `null` is
  quarantined as `ambiguous-omission-null-zero`;
- collection mapping follows the frozen table: batches map to the `batches`
  table (source ID preserved, import revision 0, lossless raw snapshot in
  `data_json`, idempotency key = record identity); dailyRecords map to
  `daily_observations` through the observation row contract;
  weighSamples/recommendations/approvals/executions/sceneStates/
  modelRegistry/auditLogs are preserved as raw archive evidence;
- zero-loss counters per collection and in total, with the invariant
  `source rows = mapped new + replay existing + exact duplicate occurrences
  + preserved/archive-only + quarantined` asserted inside the transaction;
- one transaction wraps all manifest, trace, quarantine, and target writes;
  any failure rolls back and the destination is unchanged;
- an isolated destination backup (`VACUUM INTO` + integrity check + SHA-256)
  is created before mutation; restore is a documented file replacement;
- same-source/same-owner replay performs zero writes and re-verifies the
  content-bearing payload digest (target rows + quarantine records) against
  the stored manifest; drift fails closed;
- quarantine is durable and queryable after restart, one row per identity
  with every occurrence traced, `resolution_status` defaulting to
  `unresolved`.

Design decisions recorded for the reviewer:

- duplicate keys anywhere in the source make the document non-canonically
  serializable; the importer fails closed with zero writes rather than
  partially quarantining (strict-parse rule of contract 5.1);
- quarantine rows are keyed per identity (UNIQUE on source/collection/
  identity); repeated occurrences of the same conflicted identity are all
  traced with disposition `quarantined` but share one quarantine row;
- `batches.revision` is imported as 0 and `batch_revision` on observations
  as 0: legacy JSON v1 has no revision concept; revisions are documented as
  import-initial and preserved raw in `data_json`.

## Migration v14

`packages/persistence/migrations` registers forward migration v14
`registered-schema-v14-import` (checksum
`0711127CBEA84AC5D2E07145D535A1BE011176CAF893C8096F498B8FD2C94C33`)
creating `import_manifests`, `import_record_traces`, and `import_quarantine`
as STRICT tables with content-bearing raw payload JSON, payload digest, and
durable resolution status. The accepted v12 (`0B204D...`) and v13
(`5AE20D...`) identities, names, canonical bodies, and checksums remain
immutable. The runner applies v14 only while pending and writes its ledger
row in the same transaction.

Runtime/import code executes zero schema DDL:

- `tests/p2-4/migration-v14.test.ts` scans every `src/import/**` module and
  rejects CREATE/DROP/ALTER/IF NOT EXISTS statements;
- the same test instruments the SQLite authorizer at the real connection
  seam and proves a zero-pending restart executes zero schema DDL;
- the P2-3A/P2-3B gates remain green at the same checkpoint.

## Sanitized real JSON Database v1 fixture

The base fixture `tests/fixtures/p2-4/legacy-json-v1-sanitized.json` is a
deterministic sanitization of the real Electron userData JSON Database v1
file recorded in the manifest (raw SHA-256
`2f276e5d1a4b1ec3b828227cbf0110c6c66e4d41a91e6ea364a65067070e13e2`, 36,290
bytes, captured 2026-07-07). The sanitization record binds the origin, the
replacement rules (ids, timestamps, CJK/free text, email-like strings), and
the absence of secrets, personal data, live endpoints, and device-control
authority.

The manifest also binds constructed variants for the required proofs:
exact duplicates, same-ID conflicts, missing source IDs, parent orphans,
null/omission/zero/empty-collection distinctions, and an unsupported
schema, plus committed owner-mapping manifests (good and conflicting).
`tests/p2-4/fixture-provenance.test.ts` verifies every committed hash,
collection inventory, id-link coherence, and the absence of personal-data
markers before any import test opens a fixture.

## Gate wiring

`p2-4-legacy-json-import-gate` runs `npm run check` plus the P2-4, P2-3B,
migration, architecture, local-store, provenance, and CI-contract suites;
the workflow `.github/workflows/agent-safety.yml` runs it between the P2-3B
and P0 gates, and `tests/ci-contract.test.ts` pins both the command and the
step.

## Local verification

```text
npm run p2-4-legacy-json-import-gate: 93 passed
npm test: 60 files / 458 passed
npm run p2-1-domain-gate: 20 passed
npm run p2-2-persistence-gate: 9 passed
npm run p2-3a-migration-gate: 35 passed
npm run p2-3b-migration-ownership-gate: 46 passed
npm run p0-release-gate: 100 passed
npm run p1-safety-gate: 197 passed
npm run build: PASS
npm run clean-source-gate: PASS
git diff --check: PASS
```

The identity vectors were additionally cross-verified against an
independent SHA-256 implementation during fixture construction. Local
evidence does not self-certify this candidate: exact-SHA CI and independent
implementation review remain required.

## Candidate state

```text
P2-4 Legacy JSON Import Authorization: OPEN
P2-4 Contract Registration: PASS
P2-4-F01: CLOSED / PASS
P2-4-F01.1: CLOSED / PASS
P2-4-F02: CLOSED / PASS
P2-4-F03: CLOSED — NON-BLOCKING / P2
P2-4 Implementation Authorization: OPEN
P2-4 Implementation: CANDIDATE / INDEPENDENT REVIEW PENDING
P2-4 Gate: CLOSED

Runtime/Cutover Gate: CLOSED
Compose Replacement Gate: CLOSED
P2 Merge Gate: CLOSED
Architecture Unification Gate: CLOSED
Optimizer Production Gate: CLOSED
Real Device Control Gate: CLOSED
```
