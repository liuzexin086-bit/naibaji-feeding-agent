# NBJ-ARCH-P2 P2-4 Legacy JSON Import Contract Registration

Status: `PENDING INDEPENDENT REVIEW`

Registration baseline: `2fb45b25f6880f03f563fd472d8143bfed8699b5`

P2-3 Final Closure Seal review: `PASS`

P2-3 Seal exact-SHA CI: [agent-safety run 31680852943](https://github.com/liuzexin086-bit/naibaji-feeding-agent/actions/runs/31680852943)

P2-4 Legacy JSON Import Authorization: `OPEN`

P2-4 Implementation Authorization: `CLOSED — PENDING INDEPENDENT CONTRACT REVIEW`

## 1. Registration boundary

This docs-only checkpoint registers the contract and execution plan for P2-4.
It does not implement an importer, add or alter a schema, create a fixture,
change runtime behavior, or authorize P2-4 implementation.

Independent review of the P2-3 Final Closure Seal formally set:

```text
P2-3 Closure Contract Review: CLOSED / PASS
P2-3 Final Closure Seal: PASS
P2-3 overall: CLOSED / PASS
P2-4 Legacy JSON Import Authorization: OPEN
```

That decision authorizes this P2-4 registration stage. Only a later independent
review of this registration may open P2-4 Implementation Authorization. The
P2-4 Gate remains CLOSED until implementation, evidence, exact-SHA CI, and
independent implementation review all pass.

## 2. Objective

P2-4 creates a one-way, traceable, replay-safe path from frozen legacy JSON
sources into the authoritative Domain/Repository/SQLite architecture:

```text
read-only legacy JSON source
  -> source inventory, raw SHA-256, and preflight validation
  -> Legacy Import Application Service
  -> Domain and Repository contracts
  -> authoritative SQLite repositories
  -> persisted import manifest, record trace, and quarantine
```

P2-4 must never make JSON, the legacy UI, the legacy backend, Supabase, or an
import adapter a production business authority.

## 3. Source inventory and classification

Repository inspection establishes these distinct JSON-shaped source families.
They must not be silently conflated.

| Source family | Frozen evidence | P2-4 disposition |
|---|---|---|
| Electron JSON Database v1 | `backend/src/storage/jsonDatabase.js` defines `meta.schemaVersion: 1` and nine collections. `main.js` resolves the live file beneath Electron `userData/data/naibaji-db.json`; direct backend execution defaults to `.data/naibaji-db.json`. | Primary P2-4 source family. A sanitized, immutable, hash-bound JSON v1 fixture is required before implementation acceptance. |
| Browser batch snapshots | Legacy key `nbj_batches`; user-scoped key `nbj_batches:<userId>` in `index.html`. Values are batch snapshots with nested records. | A distinct source kind. Import is allowed only from an explicitly exported, byte-stable artifact plus an external owner-mapping manifest; the implementation must never scrape live browser storage or run from UI startup. |
| Supabase JSONB snapshots | Legacy `public.batches.config` and `records`. | Out of this registration. Supabase import requires its own source inventory/amendment and must not enter through the JSON-file importer. |
| Training export | `feeding-model.js` returns `version: naibaji-v2` with `batch`, `dailyRecords`, and derived `labels`. | Export-only, not JSON Database v1. Quarantine/reject as unsupported source kind; never infer a full production snapshot from it. |
| Shadow export/state | `naibaji-*-shadow.json` and V5-Lite shadow local-storage state. | Shadow telemetry only; archive/quarantine, never decision, model, or device authority. |
| Optimizer JSON | `optimizer/*.json`; manifest marks it `validForProduction: false`. | Always reject from P2-4 import. |
| Research synthesis | Root `synthesis_output.json`. | Knowledge artifact, never a production business-data source. |

No committed JSON Database v1 fixture exists at the registration baseline. The
committed P2-3B fixture is SQLite and cannot be represented as JSON v1 import
proof.

## 4. Frozen JSON Database v1 envelope

The v1 top-level envelope is:

```text
meta.schemaVersion = 1
batches[]
dailyRecords[]
weighSamples[]
recommendations[]
approvals[]
executions[]
sceneStates[]
modelRegistry[]
auditLogs[]
```

Every required collection must be present and must be an array. Unknown
top-level keys and unknown row fields are preserved in raw evidence. An absent,
invalid, or unsupported `meta.schemaVersion` fails preflight before destination
mutation. The importer may not repair the source file in place.

## 5. Stable source and record identity

Each source manifest must persist at least:

```text
source_kind
source_sha256
source_byte_length
source_schema_version
original_filename_or_export_label
captured_at
sanitization_or_origin_record
owner_mapping_sha256
importer_contract_version
```

The stable source identity is `(source_kind, source_sha256)`. Filesystem path,
mtime, current operator, or current logged-in user is not identity.

Each source row is addressed by:

```text
(source_kind, source_sha256, collection, source_record_id)
```

Source IDs, revisions, timestamps, hashes, and idempotency keys are preserved
when valid; they are never regenerated to force a mapping. A row without a
provable source ID receives a deterministic quarantine identity based on its
collection, canonical raw-row SHA-256, and source ordinal. That identity is
for preservation only and must not become a Domain business ID.

## 6. Owner and tenant binding

JSON Database v1 rows do not prove an authoritative target `user_id`. Import
must therefore require a separate, explicit owner-mapping manifest that binds
legacy owner/batch scope to an existing SQLite user. The manifest itself is
hash-bound to the import run.

The importer must never:

- attach all data to the current authenticated operator by default;
- infer ownership from a filename, browser key suffix, email-like text, or
  batch name;
- create credentials or elevate roles;
- merge two source owners without an explicit reviewed mapping.

Missing or conflicting owner evidence fails closed or quarantines the affected
records and their dependents.

## 7. Collection mapping and disposition

Every source row and field receives one explicit disposition: `mapped`,
`preserved_raw`, `exact_duplicate`, or `quarantined`. There is no `ignored` or
silent-drop disposition.

| JSON v1 collection | Target/disposition contract |
|---|---|
| `batches` | Map to authoritative SQLite batches only when owner, source ID, lifecycle, revision, timestamps, and full raw snapshot are traceable. Preserve the source batch ID. |
| `dailyRecords` | Map through the Observation/Record repository contract. Preserve source ID, batch relationship, business-date/time meaning, revisions, null/omitted/zero distinctions, and the complete raw row. Invalid or ambiguous Domain-owned fields are quarantined, never normalized to “normal”. |
| `weighSamples` | No separate target table is frozen at this baseline. Retain only through an explicitly reviewed observation/raw-evidence mapping; otherwise quarantine. Do not invent a new target schema during import. |
| `recommendations` | Legacy recommendations are not active `FeedingDecision` authority unless frozen model/SOP identity, evidence, revision, and decision-state contracts are provable. Preserve as archive/quarantine evidence by default. |
| `approvals` | Map to a confirmation only when plan/decision identity, digest, actor, timestamp, revision, and idempotency semantics are complete. Otherwise preserve/quarantine. |
| `executions` | Map to operation results only when the target operation identity, request/result evidence, actor/device provenance, and idempotency contract are provable. Otherwise preserve/quarantine. |
| `sceneStates` | V5-Lite/legacy scene state is shadow or archive evidence only; never production Feeding Model, decision, or device authority. |
| `modelRegistry` | Preserve as legacy metadata only. It cannot publish or select the production Feeding Model. |
| `auditLogs` | Append to authoritative audit storage only when actor, action, target, timestamp, and raw details are traceable; otherwise preserve/quarantine. Never rewrite historical audit meaning. |
| `meta` | Import-manifest evidence only, not a business record. |

Child records whose parent mapping is absent, conflicting, or quarantined may
not become target orphans. They remain linked to their raw source identities in
quarantine.

## 8. Idempotency and duplicate semantics

The implementation must persist import-specific manifest, record-trace, and
quarantine authorities in SQLite. Existing business-table idempotency keys are
not a substitute for import provenance.

Required deterministic import record key:

```text
SHA-256(source_kind || source_sha256 || collection || source_record_id)
```

Required behavior:

- replay of the same source and owner mapping creates zero new Domain records,
  zero new quarantine records, and no changed business payload;
- an exact duplicate row in one source is counted and mapped once, with every
  occurrence traceable;
- the same collection/source ID with different canonical content is a conflict
  and is quarantined before target mutation for that identity;
- a later, byte-different source is not treated as replay merely because its
  filename is unchanged;
- target-ID collision with non-imported or different-source content fails
  closed; it is never overwritten or merged by last-write-wins.

An append-only replay-attempt audit receipt is permitted, but it is not a new
Domain or quarantine record and cannot change the accepted import result.

## 9. Quarantine contract

Quarantine is a successful preservation outcome, not permission to report the
import as complete. It must be durable and queryable after restart.

Each quarantine record must retain:

```text
import_run_identity
source_kind / source_sha256 / collection / source_record_identity
raw_payload_bytes_or_lossless_raw_json
raw_payload_sha256
reason_code
field_path(s)
parent_source_identity, when applicable
owner_mapping_identity
created_at
resolution_status (initially unresolved)
```

Reason codes are deterministic and machine-testable, including at least:
unsupported source/schema, invalid envelope, missing/conflicting owner,
missing/conflicting ID, invalid field, ambiguous omission/null/zero, duplicate
conflict, target collision, missing parent, unsupported collection mapping, and
unprovable frozen model/SOP/device/audit evidence.

No quarantined row may be reinterpreted by the latest Feeding Model or SOP.
Resolution requires a new forward import contract or independently reviewed
mapping amendment; it cannot silently mutate the historical run.

## 10. Zero-loss counters and completion states

For each collection and the whole source, the persisted manifest must prove:

```text
source rows = mapped new + replay existing + exact duplicate occurrences
              + preserved/archive-only + quarantined
silent drops = 0
unaccounted rows = 0
unexpected duplicates = 0
target orphans = 0
source bytes changed = 0
```

Every source field must also be traceable as mapped, preserved raw, or the
reason for quarantine. Aggregate row counts alone are insufficient; tests must
bind canonical content digests for the source, mapped target rows, raw evidence,
manifest, and quarantine.

Run states are:

- `COMPLETE`: every row accounted for and unresolved quarantine count is zero;
- `PRESERVED_WITH_QUARANTINE / INCOMPLETE`: all bytes/rows are preserved but
  one or more mappings remain unresolved;
- `FAILED_ROLLED_BACK`: preflight or transactional acceptance failed and the
  destination was restored/unchanged.

## 11. Transaction, backup, and rollback

Before mutation the implementation must:

1. read and hash the source without modifying it;
2. preflight the envelope, collection shapes, IDs, owner mapping, duplicate
   conflicts, and dependency graph;
3. create an isolated destination SQLite backup and record its SHA-256,
   schema/application/migration-ledger identity, and restore location;
4. prove the backup opens and passes integrity checks.

Import writes, provenance, record traces, quarantine, audit, and counters must
commit atomically where SQLite permits. A parse/preflight failure performs zero
destination writes. Any counter mismatch, target collision, orphan, unexpected
duplicate, source mutation, transaction failure, or post-import integrity
failure triggers rollback to the prior reviewed checkpoint/backup.

Rollback evidence includes the pre-import commit, destination backup SHA-256,
source/owner-manifest hashes, restore log, integrity/foreign-key result, and
post-restore content digest. P2-4 does not claim the broader P2-12 production
backup/restore Gate.

## 12. Required fixtures and hard proofs

Implementation acceptance requires immutable, hash-bound fixtures for:

- sanitized real JSON Database v1 success path, or an independently accepted
  reconstructed-fixture equivalence amendment when a real source cannot be
  provided;
- exact duplicate replay;
- same ID with conflicting content;
- partial mapping with archive-only collections;
- invalid/ambiguous observation fields proving null, omission, explicit none,
  zero, and empty collection remain distinct;
- missing/conflicting owner mapping;
- parent/child orphan attempt;
- unsupported schema/source kind;
- quarantine persistence across close/reopen;
- import failure and destination restore;
- byte-for-byte source immutability;
- same-source replay producing zero new Domain/quarantine records and identical
  target/raw/quarantine content digests.

Tests must exercise the real file reader, application service, repository,
SQLite transaction, manifest, and quarantine seams. A mocked array-to-array
converter or final row-count comparison is not acceptance evidence.

## 13. Required implementation ownership

The implementation checkpoint must define one import application authority,
expected under the Application/Persistence boundary, with dependency direction:

```text
source adapter -> import application service -> Domain/Repository contracts
               -> SQLite adapters
```

Legacy `backend/src/**`, root `index.html`, Supabase clients, UI startup, Agent,
LangGraph, model, SOP, optimizer, and device code may not own or invoke import.
The source adapter is read-only. No bidirectional sync, live fallback, import on
application startup, or production read from the JSON source is allowed.

## 14. Required gates

The implementation checkpoint must add a dedicated CI-enforced command named:

```text
p2-4-legacy-json-import-gate
```

It must cover source identity, real/sanitized fixture provenance, mapping and
field traceability, duplicates/conflicts, replay, quarantine/restart,
transaction/rollback, source immutability, content digests, zero-loss counters,
architecture ownership, and scope exclusions.

The checkpoint must also pass:

- TypeScript/check gates;
- P2-1 Domain;
- P2-2 Persistence;
- P2-3A and P2-3B migration gates;
- full Agent tests;
- P0 and P1 gates;
- build and clean-source;
- exact-SHA `agent-safety`, including images, Compose config, and runtime
  provenance/UI checks;
- independent P2-4 implementation review with P0 = 0 and P1 = 0.

## 15. Explicit exclusions

This registration and the future P2-4 implementation do not authorize:

- Supabase import without an independently accepted contract amendment;
- live browser localStorage scraping or startup migration;
- production JSON reads/writes or bidirectional sync;
- recomputation through the latest Feeding Model, SOP, Agent, or LLM;
- Feeding Model single-source work (P2-6) or SOP authority work (P2-7);
- Application/API/UI/LangGraph runtime cutover;
- legacy runtime removal, Compose replacement, merge, tag, PR, deployment;
- optimizer production or real-device control;
- schema changes outside the minimum independently reviewed import manifest,
  trace, and quarantine persistence required by this contract.

## 16. Registration acceptance and implementation stop conditions

Before P2-4 Implementation Authorization may open, independent registration
review must accept:

- the exact source families and explicit exclusions;
- sanitized fixture/equivalence requirements;
- owner mapping and stable identity rules;
- collection mapping/disposition table;
- import-specific idempotency and conflict semantics;
- durable quarantine and zero-loss counters;
- transaction, backup, restore, and rollback evidence;
- required gate commands and architecture boundary.

Implementation must stop for an amendment if a real source contradicts this
frozen envelope/mapping, if owner identity cannot be proven, or if any proposed
mapping would invent business facts, reinterpret old decisions with current
rules, or require an authority outside the frozen P2 architecture.

## 17. Candidate state

```text
P2-3 Closure Contract Review: CLOSED / PASS
P2-3 Final Closure Seal: PASS
P2-3 overall: CLOSED / PASS

P2-4 Legacy JSON Import Authorization: OPEN
P2-4 Contract Registration: PENDING INDEPENDENT REVIEW
P2-4 Implementation Authorization: CLOSED
P2-4 Implementation: NOT STARTED
P2-4 Gate: CLOSED

Independent architecture pre-review: PASS
Independent domain pre-review: BLOCKED — INFRASTRUCTURE / NO VERDICT

Runtime/Cutover Gate: CLOSED
Compose Replacement Gate: CLOSED
P2 Merge Gate: CLOSED
Architecture Unification Gate: CLOSED
Optimizer Production Gate: CLOSED
Real Device Control Gate: CLOSED
```

This candidate does not review or certify its own docs commit. It records the
already completed independent P2-3 Seal decision, but only a new independent
review of this registration may open P2-4 Implementation Authorization.
