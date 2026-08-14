# NBJ-ARCH-P2 P2-4 Legacy JSON Import Implementation

Status: `IMPLEMENTATION CANDIDATE — CHANGES REQUIRED (P2-4-F05.1 / F07.1 / F09) — THIRD CORRECTION COMMITTED — RE-REVIEW PENDING`

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

## Independent review — REQUEST CHANGES and correction

Independent implementation review returned `REQUEST CHANGES` with four P1
findings. The correction closes them as follows.

### P2-4-F04 — canonical key semantics

`canonical-json.ts` now sorts object keys with a real Unicode code-point
comparator (JS default sort is UTF-16 code-unit order and differs for
supplementary-plane keys), NFC-normalizes keys before sorting and before
duplicate detection in both the strict parser and the serializer, and
rejects NFC-equivalent duplicate canonical keys. Tests cover U+E000 vs
U+10000 ordering and NFC-equivalent key collision.

### P2-4-F05 — tenant-safe content-bearing replay digest

`computeSourceDigest` now reads target rows scoped to the accepted target
user (the authority key of batches/daily_observations is (user_id, id)) and
binds target rows plus every trace record (identity, ordinal, disposition,
raw payload SHA, raw payload content) plus quarantine records. Blocking
tests: two users with the same business ID (digest reads only the accepted
user; other-scope reads fail closed) and preserved_raw payload mutation
fails replay with target-drift.

### P2-4-F06 — per-row duplicate-key quarantine and field-level zero-loss

The tolerant parser reports duplicate-key paths; a row with duplicate keys
is quarantined with reason `duplicate-key` (envelope-level duplicates still
fail the whole source closed). Unknown top-level keys are recorded in the
import manifest. Every trace and quarantine row now carries real
field-level dispositions (`field_paths_json`): mapped, preserved_raw, or
the quarantine reason; field-specific reasons (invalid-field,
ambiguous-omission-null-zero) mark only the offending fields.

### P2-4-F07 — backup identity evidence and runtime acceptance

Backup evidence now records schema digest, migration-ledger digest,
application/importer identity, integrity, and foreign-key proof, and is
persisted per run through forward migration v15
`registered-schema-v15-import-evidence` (checksum
`22DAC823AA20D7401C3BD5F4A6EA83CC9C037D2AAE3A14B56E1683A90490D08F`); the
published v14 identity (`0711127C...`) is unchanged. Post-import integrity
acceptance runs inside the transaction: any integrity or foreign-key
failure rolls the destination back to the prior reviewed state (test
proves automatic rollback with zero residual writes).
## Third correction — F05.1 / F07.1 / F09 (final narrow re-review)

The independent final narrow re-review (contract §18.8) returned
`REQUEST CHANGES` with three P1 items. This correction closes them as
follows, in the order required by the review:

### P2-4-F09 — docs-only micro-amendment first, then identity correction

The docs-only micro-amendment is frozen in contract 5.2: a duplicate-key
row is not canonically serializable, so CJSON(raw_row) is undefined for
it. Rule 1 — the duplicate key does NOT affect the source id: the row
keeps the normal `record_identity` with disposition `quarantined` and the
original raw row slice as evidence. Rule 2 — the duplicate key IS the id
field (or the id is otherwise unprovable):

```text
raw_duplicate_quarantine_identity =
  SHA-256( UTF-8( CJSON([ "quarantine-raw", source_kind, source_sha256,
                         collection, original_raw_row_sha256,
                         source_ordinal ]) ) )
original_raw_row_sha256 = SHA-256( original raw row slice text )
```

`identity.ts` implements `rawDuplicateQuarantineIdentity` and freezes the
V7 known vector (`e977a32c...` raw slice / `d1026155...` identity);
`source-adapter.ts` reports the duplicated key names per row; `importer.ts`
routes duplicate-key rows by rule 1 or rule 2. Tests assert the V7 bytes,
the raw-slice binding (never a last-wins CJSON), and the rule-1
record-identity path.

### P2-4-F05.1 — complete authoritative replay digest projection

`computeSourceDigest` now binds the frozen `ReplayDigestProjection`:

```text
mapped batches:          id, data_json, revision, current_day, status
mapped daily_observations: id, data_json, batch_id, date_local,
                         observed_at, batch_revision
trace:                   identity, ordinal, disposition, reason, parent,
                         field paths, raw payload bytes/sha/content
quarantine:              identity, ordinal, reason, field paths, parent
                         source identity, owner mapping, resolution,
                         raw payload bytes/sha/content
manifest:                every immutable semantic field except
                         payload_digest itself (and audit-only created_at)
```

Four new tamper tests prove `batches.status`, `daily_observations.batch_id`
(FK-safe swap to an existing batch), `import_quarantine.parent_source_identity`
and `import_manifests.importer_contract_version` mutations each fail replay
with `target-drift`. No schema change was needed.

### P2-4-F07.1 — sealed pre-import evidence, complete digest, fail-closed restore

`createBackup` now seals `preImportContentDigest` (the complete destination
content digest computed FROM the backup snapshot itself by the backup
authority), `preImportCommit`, `sourceSha256` and `ownerMappingSha256`.
`computeDestinationDigest` enumerates every authority table from
`sqlite_schema` (all 22 tables, migration ledger included).
`restoreDatabaseFromBackup` consumes ONLY the sealed evidence, verifies
the backup SHA before any mutation, and FAILS CLOSED (throws) unless the
post-restore complete digest matches the sealed pre-import digest with
integrity ok and zero foreign-key violations; the receipt then carries the
sealed fields and the restore log. The new evidence columns are persisted
through forward migration v16 `registered-schema-v16-sealed-restore-evidence`
(checksum `F79E3F38925EDAF819D7D9CEF19DF36E02FF9BD8258C8BFA980DA6FC5014366D`,
literal version 16, guarded column inspection, runtime drift assert); v14
(`0711127C...`) and v15 (`22DAC823...`) are byte-identical. Tests cover the
happy path, backup tamper, and forged-evidence fail-closed.

### Local verification at the third correction

```text
p2-4 gate scope (p2-4/p2-3b/migration/architecture/local-db/provenance/ci): 114 passed
npm test (full agent suite): 60 files / 479 passed
P2-3A / P2-3B migration gates: green (fixture manifest regenerated for v16)
npm run check (typecheck): PASS
npm run build: PASS
npm run clean-source-gate: PASS
git diff --check: PASS
```

The findings stay OPEN until an independent re-review closes them; the
P2-4 Gate remains CLOSED.
## Second correction — F05.1 / F06 / F07.1 / F08

- `P2-4-F05.1` — the replay digest binds manifest acceptance
  facts (counters, unknown-key evidence, owner mapping, run state) plus the
  complete trace evidence (identity, ordinal, disposition, reason, parent,
  field paths, raw payload) and complete quarantine evidence (reason, field
  paths, resolution status, payload). Tamper tests: field_paths_json,
  quarantine reason_code, and manifest counters mutations all fail replay
  with target-drift.
- `P2-4-F06` — the parser records byte spans for every value;
  duplicate-key rows keep the ORIGINAL source row slice (including both
  duplicate occurrences) as their quarantine raw payload with its own
  SHA-256; unknown top-level keys are preserved in the manifest with their
  value and original text slice.
- `P2-4-F07.1` — restore emits a frozen receipt: backup SHA,
  pre-import content digest, post-restore content digest (digestMatch),
  integrity and FK result, restore log; a backup SHA mismatch aborts the
  restore before any file mutation.
- `P2-4-F08` — v15 is pinned to literal 15 with
  `SEALED_V15_CHECKSUM` (`22DAC823...`) and a runtime
  drift assert in the migration chain; tests pin v14 and v15 checksums
  exactly, independent of CURRENT_MIGRATION_VERSION.
## Candidate state

```text
P2-4 Legacy JSON Import Authorization: OPEN
P2-4 Contract Registration: PASS
P2-4-F01: CLOSED / PASS
P2-4-F01.1: CLOSED / PASS
P2-4-F02: CLOSED / PASS
P2-4-F03: CLOSED — NON-BLOCKING / P2
P2-4 Implementation Authorization: OPEN
P2-4 Implementation: CANDIDATE / CHANGES REQUIRED (P2-4-F05.1 / F06 / F07.1 / F08 — correction committed)
P2-4 Gate: CLOSED

Runtime/Cutover Gate: CLOSED
Compose Replacement Gate: CLOSED
P2 Merge Gate: CLOSED
Architecture Unification Gate: CLOSED
Optimizer Production Gate: CLOSED
Real Device Control Gate: CLOSED
```
