# NBJ-ARCH-P2 P2-4 Legacy JSON Import Contract Registration

Status: `P2-4 CONTRACT REGISTRATION — PASS / IMPLEMENTATION AUTHORIZATION OPEN`

Registration baseline: `2fb45b25f6880f03f563fd472d8143bfed8699b5`

Registration checkpoint: `138b1ae6782615022eefb743537f0781eee9f330` — `P2-4 register legacy JSON import contract`

First correction checkpoint: `ce16798b0b989b6a403082e8d0c9b917882a84f2` — `P2-4 freeze canonical identity and migration-bound import schema`

Second correction checkpoint: `f921b4f67187494b6d91965d176a3a85857ee938` — `P2-4 bind quarantine identity to source and add separation vector`

Independent contract review of the registration checkpoint: `REQUEST CHANGES` — `P2-4-F01` / `P2-4-F02` (audit history in §18)

First correction re-review: `REQUEST CHANGES` — `P2-4-F01.1`; `P2-4-F02` closed (audit history in §18)

Second correction re-review: `PASS` — `P2-4-F01` / `P2-4-F01.1` / `P2-4-F02` closed (audit history in §18)

This checkpoint records the independent PASS verdict and opens no authority by itself: P2-4 Implementation Authorization was opened only by that independent review. The implementation candidate is recorded in `nbj-arch-p2-4-implementation.md`; the P2-4 Gate remains CLOSED.

### 18.6 Implementation review — REQUEST CHANGES (P2-4-F04 / F05 / F06 / F07)

Independent remote implementation review of
`87dab7d333f815b9579168a836bd5ce3ca0a0b2b` (2 commits / 40 files)
accepted the v14 migration authority, the real sanitized fixture and
manifest, the P2-4 gate wiring, and exact-SHA CI (run 31761100591,
457 passed + 1 skipped = 458 total, P2-4 gate 93/93), then returned
`REQUEST CHANGES` with four P1 contract-conformance findings:

- `P2-4-F04` (OPEN / P1) - CJSON key semantics: JS default sort is
  UTF-16 code-unit order, not Unicode code-point order, and duplicate
  detection ran before NFC normalization, so NFC-equivalent keys could
  produce repeated canonical keys. Fixed: code-point comparator, keys
  NFC-normalized before sorting and duplicate detection (parse and
  serialize), with U+E000-vs-U+10000 ordering and NFC-equivalent collision
  tests.
- `P2-4-F05` (OPEN / P1) - replay payload digest was not
  tenant-safe (target tables are keyed (user_id, id) but rows were read by
  id alone) and did not bind preserved_raw trace evidence. Fixed: digest is
  scoped to the accepted target user, and now binds target rows, every
  trace identity/ordinal/disposition with content-bearing raw payloads,
  and quarantine records; blocking tests cover two users with the same
  business ID and preserved_raw payload mutation replay-drift.
- `P2-4-F06` (OPEN / P1) - duplicate-key rows failed the whole
  source instead of being quarantined; unknown top-level keys were detected
  but not recorded; field-level dispositions were not implemented. Fixed:
  per-row duplicate-key quarantine (envelope-level duplicates still fail
  closed), unknown top-level keys recorded in the manifest, and real
  field-level dispositions (field_paths_json) for mapped, preserved_raw,
  and quarantined rows with field-specific reasons.
- `P2-4-F07` (OPEN / P1) - backup evidence lacked schema/
  ledger/application identity and FK proof, and post-import integrity
  failure did not trigger automatic rollback. Fixed: backup evidence now
  records schema digest, migration-ledger digest, application/importer
  identity, integrity and FK proof, persisted per run via forward migration
  v15 (`registered-schema-v15-import-evidence`, checksum
  `22DAC823AA20D7401C3BD5F4A6EA83CC9C037D2AAE3A14B56E1683A90490D08F`)
  without touching the published v14 identity (`0711127C...`);
  post-import integrity acceptance runs inside the transaction so any
  failure rolls the destination back to the prior reviewed state.

The correction commit records these closures; the findings stay OPEN until
the independent narrow re-review closes them. The P2-4 Gate remains CLOSED.

### 18.7 Implementation re-review — REQUEST CHANGES (P2-4-F05.1 / F06 / F07.1 / F08)

Independent narrow re-review of
`cdded43c56926921155c6eb9a64761c8521ff593` (1 commit / 21 files)
closed `P2-4-F04` (CLOSED / PASS) and the original F05 tenant
isolation, and confirmed runtime transactional acceptance and exact-SHA CI
(run 31762710620; Full Agent 468 passed + 1 skipped = 469 total; P2-4 gate
104/104). It then returned `REQUEST CHANGES` with four P1
items:

- `P2-4-F05.1` - the replay digest did not bind complete
  provenance (trace field paths/reason/parent, quarantine reason/field
  paths/resolution status, manifest counters and unknown-key evidence).
  Fixed: the digest now binds manifest acceptance facts plus the complete
  trace and quarantine semantic evidence, with tamper tests for
  field_paths_json, quarantine reason_code, and manifest counters.
- `P2-4-F06` - duplicate-key quarantine was not lossless
  (last-wins parse lost the original malformed row) and unknown top-level
  values were not preserved. Fixed: the parser records byte spans;
  duplicate-key rows keep the ORIGINAL source row slice (both duplicate
  occurrences) as raw payload, and unknown top-level keys are preserved
  with their value and original text slice in the manifest.
- `P2-4-F07.1` - rollback evidence lacked a frozen restore
  receipt. Fixed: restore now emits a receipt binding backup SHA, pre-
  import content digest, post-restore content digest (must match),
  integrity/FK result, and restore log; backup tamper aborts the restore.
- `P2-4-F08` - the v15 migration identity still used
  `version: CURRENT_MIGRATION_VERSION`, so a future v16 bump
  would silently change v15's checksum. Fixed: v15 is pinned to literal 15
  with `SEALED_V15_CHECKSUM` (`22DAC823...`) and a
  runtime drift assert like v12; tests pin v14 and v15 checksums exactly.

The correction commit records these closures; the findings stay OPEN until
the independent final narrow re-review closes them. The P2-4 Gate remains
CLOSED.

### 18.8 Implementation final narrow re-review — REQUEST CHANGES (P2-4-F05.1 / F07.1 / F09)

Independent final narrow re-review of
`bb1aa8aeba92971fd75bac0eb91865e5af7a6af4` (1 commit / 13 files) closed
`P2-4-F04` (canonical key semantics), the original F05 tenant isolation,
`P2-4-F06` (lossless duplicate-key raw evidence and unknown top-level value
preservation), `P2-4-F07` (transactional rollback) and `P2-4-F08`
(sealed v15 with literal `version: 15` and runtime drift assert), and
confirmed exact-SHA CI (run 31763824664; Full Agent 471 passed + 1 skipped
= 472 total; P2-4 gate 107/107). It then returned `REQUEST CHANGES` with
three P1 items:

- `P2-4-F05.1` - the replay digest projection is still incomplete:
  mapped target rows bind only `data_json` (authoritative columns
  `status/revision/current_day` on batches and
  `batch_id/date_local/observed_at/batch_revision` on daily_observations
  can drift without digest change); quarantine digest omits
  `source_ordinal`, `parent_source_identity` and
  `owner_mapping_sha256`; manifest digest binds only counters/unknown
  keys/owner mapping/run state, not the immutable semantic manifest
  fields (`source_byte_length`, `source_schema_version`,
  `importer_contract_version`, `backup_sha256`, `restore_location`,
  ...). No tamper tests exist for batch.status, observation.batch_id,
  quarantine parent identity, or manifest importer/version drift.
- `P2-4-F07.1` - restore proof is not authoritative/complete:
  `preImportDigest` is supplied by the caller instead of being sealed by
  the backup authority; `RestoreReceipt` lacks `preImportCommit`,
  `sourceSha256` and `ownerMappingSha256`; `computeDestinationDigest`
  hashes 7 of the 22 destination authority tables; restore returns a
  receipt even when `digestMatch=false` or integrity/FK checks fail
  (not fail-closed).
- `P2-4-F09` (new) - duplicate-key quarantine identity still uses the
  contract-forbidden lossy canonical representation: the quarantine
  identity's `raw_row_canonical_sha256` is computed over the LAST-WINS
  parsed row via CJSON (source `{"id":"a","id":"b"}` binds
  `{"id":"b"}`), although contract 5.1 declares a duplicate-key row not
  canonically serializable; and a row with a provable source ID
  (`{"id":"stable-id","status":"a","status":"b"}`) is routed to the
  quarantine identity anyway, bypassing `record_identity`.

The correction checkpoint (this round) applies the docs-only micro-amendment
in 5.2 (two frozen duplicate-key identity rules plus known vector V7) and
records the implementation closures in the implementation document; the
findings stay OPEN until an independent re-review of the correction closes
them. The P2-4 Gate remains CLOSED.

### 18.9 Final implementation narrow re-review — PASS (P2-4 Gate OPEN)

Independent final narrow re-review of
`08046ce3380ec7ad5714acf929cc57f8292e3511` -> `fb27065f39f1cce4d80bb1e4a604ccca47c076e6` (5
files: contracts.ts, importer.ts, source-adapter.ts, sqlite-adapters.ts,
importer.test.ts; +193/-48) -> `9184c22f81c3bd05f06f71dd1ea0ab50fc6d6d4e` (1
file: agent/vitest.config.ts, testTimeout 20_000, non-semantic) returned
`PASS`. The three residual P1 groups from §18.8 were closed as follows:

- `P2-4-F09.1` (CLOSED / PASS) - a nested duplicate-key named `id` no
  longer triggers Rule 2: source-adapter records `sourceIdFieldDuplicated`
  true ONLY for the exact top-level path
  `$["<collection>"][ordinal]["id"]`; nested
  `{"id":"stable-id","nested":{"id":"x","id":"y"}}` keeps
  `record_identity` with disposition quarantined.
- `P2-4-F05.1` (CLOSED / PASS) - the mapped target digest now binds batches
  `idempotency_key/created_at/updated_at` and daily_observations
  `idempotency_key/created_at`; the broken
  `queryTargetRowsByImportKeys` was deleted from port and adapter (zero
  references); tamper tests for batch idempotency/updated_at and observation
  idempotency all produce target-drift.
- `P2-4-F07.1` (CLOSED / PASS) - `preImportCommit` is now REQUIRED with
  /^[0-9a-fA-F]{40}$/ validation before any source read/backup/mutation,
  rejecting empty and "unknown" with zero writes; `createBackup` throws
  ImportError when `foreignKeyViolations` != 0 before import mutation; the
  failure-injection test proves zero import writes.

The `9184c22` vitest test-timeout follow-up was accepted as non-semantic
test infrastructure. Exact-SHA CI confirmed
[agent-safety run 31781315375](https://github.com/liuzexin086-bit/naibaji-feeding-agent/actions/runs/31781315375)
(`push`, `head_sha = 9184c22f81c3bd05f06f71dd1ea0ab50fc6d6d4e`, attempt 2,
`success`; attempt 1 failed on an infrastructure `pip` step only and the
rerun succeeded). Full Agent 60 files / 485 passed + 1 skipped = 486 total;
P2-1 20/20; P2-2 9/9; P2-3A 35/35; P2-3B 46/46; P2-4 121/121; P0 100/100;
P1 197/197; optimizer 12/12; typecheck/build/clean-source/Agent image/Web
image/Compose/runtime provenance and UI E2E all PASS.

Formal dispositions: `P2-4-F04` CLOSED / PASS; `P2-4-F05.1` CLOSED / PASS;
`P2-4-F06` CLOSED / PASS; `P2-4-F07.1` CLOSED / PASS; `P2-4-F08` CLOSED /
PASS; `P2-4-F09` CLOSED / PASS; `P2-4-F09.1` CLOSED / PASS; `P2-4-F10`
CLOSED / P2; v16 migration identity PASS / SEALED; `9184c22`
test-infrastructure follow-up PASS. New P0: 0; Open P1: 0.

```text
P2-4 Contract Registration: CLOSED / PASS
P2-4 Implementation: PASS
P2-4 Gate: OPEN
P2-4 overall: CLOSED / PASS

P2-6 stage / contract registration authorization: OPEN (implementation not authorized)
Runtime/Cutover Gate: CLOSED
Compose Replacement Gate: CLOSED
P2 Merge Gate: CLOSED
Architecture Unification Gate: CLOSED
Optimizer Production Gate: CLOSED
Real Device Control Gate: CLOSED
```

P2-3 Final Closure Seal review: `PASS`

P2-3 Seal exact-SHA CI: [agent-safety run 31680852943](https://github.com/liuzexin086-bit/naibaji-feeding-agent/actions/runs/31680852943)

P2-4 Legacy JSON Import Authorization: `OPEN`

P2-4 Implementation Authorization: `OPEN — INDEPENDENT CONTRACT REVIEW: PASS (P2-4-F01 / P2-4-F01.1 / P2-4-F02 CLOSED)`

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
provable source ID receives the deterministic quarantine identity frozen in
§5.1 (source_kind, source_sha256, collection, canonical raw-row SHA-256, and
source ordinal). That identity is for preservation only and must not become a
Domain business ID.

### 5.1 Canonical identity encoding (P2-4-F01 freeze)

The deterministic record identity is frozen as one canonical encoding. Every
element is canonicalized first, then serialized, then hashed:

```text
record_identity =
  SHA-256( UTF-8( CJSON([ source_kind, source_sha256, collection, source_record_id ]) ) )
```

`CJSON` is the frozen canonical JSON serialization:

- it operates on parsed JSON values, never on raw source text; JSON escape
  sequences in the source (for example `\u00e9`) are resolved by parsing
  before canonicalization;
- object keys are sorted by Unicode code point ascending; duplicate keys are
  rejected as malformed (a row with duplicate keys is not canonically
  serializable and is quarantined);
- array element order is preserved;
- each string value is Unicode NFC-normalized before serialization; no
  normalization is applied across JSON string boundaries;
- strings are wrapped in double quotes; only `"` (`\"`), `\` (`\\`),
  and U+0000–U+001F (`\uXXXX` with lowercase hex) are escaped; every other
  code point, including non-ASCII and surrogate pairs, is emitted verbatim as
  UTF-8;
- numbers use the ECMAScript shortest round-trip decimal representation
  (identical to `Number::toString` / `JSON.stringify` numeric output);
  `-0` serializes as `0`; non-finite numbers are invalid;
- no whitespace is emitted between tokens;
- the serialized bytes are UTF-8 encoded before hashing; the hash output is
  lowercase hex.

`source_record_id` type rule: a provable source ID is a JSON string or a JSON
integer in the safe-integer range. Any other JSON value used as a source ID
(fractional number, boolean, null, object, or array) is not a provable source
ID and routes the row to the quarantine identity below. String IDs
canonicalize through the CJSON string rule (NFC included); integer IDs
canonicalize through the CJSON number rule.

Rows without a provable source ID receive the frozen quarantine identity:

```text
raw_row_canonical_sha256 = SHA-256( UTF-8( CJSON(raw_row) ) )
quarantine_identity =
  SHA-256( UTF-8( CJSON([ "quarantine", source_kind, source_sha256,
                         collection, raw_row_canonical_sha256,
                         source_ordinal ]) ) )
```

where `raw_row` is the complete raw row value (nested fields included) and
`source_ordinal` is the zero-based position of that row in its source
collection array. The quarantine identity is source-bound: it includes
`source_kind` and `source_sha256`, so the same raw row at the same ordinal
in two different sources always receives different quarantine identities,
while same-source replay reproduces the identical identity. The leading
`"quarantine"` discriminator keeps the quarantine space disjoint from the
record-key space: frozen `source_kind` values never equal `"quarantine"`,
and the two encodings are structurally distinct. Quarantine identities are
preservation-only and must never become a Domain business ID.

Because the tuple is a JSON array, field boundaries are structurally encoded:
`("ab","c")` and `("a","bc")` serialize to different byte strings, so bare
concatenation ambiguity cannot occur.

The frozen known hash vectors below are asserted verbatim by the dedicated
gate (§14.1). The gate must reproduce them from an implementation independent
of this document. V2–V4 use the same `source_kind` / `source_sha256` as
V1; V5 uses that same source, and V6 uses a different source to prove
cross-source quarantine separation.

| Vector | Tuple / row | Canonical bytes | SHA-256 |
|---|---|---|---|
| V1 — string source ID | `source_kind="json-database-v1"`, `source_sha256="3b5d5c3712955042212316173ccf37bea9d0f9b1c1e2c3d4e5f60718293a4b5c"`, `collection="dailyRecords"`, `source_record_id="legacy-2026-08-01-001"` | `["json-database-v1","3b5d5c3712955042212316173ccf37bea9d0f9b1c1e2c3d4e5f60718293a4b5c","dailyRecords","legacy-2026-08-01-001"]` | `9820db706590270d8b714764407de8d89afbddb4ed4fb95ca4973ce5d48c1e24` |
| V2 — integer source ID | as V1, but `source_record_id=42` (JSON integer) | `["json-database-v1","3b5d5c3712955042212316173ccf37bea9d0f9b1c1e2c3d4e5f60718293a4b5c","dailyRecords",42]` | `9b82659f32505dd4e0179d405f268c55f2310a651da96ecaeb03ea482abccbe8` |
| V3 — NFC normalization | as V1, but `source_record_id="café"` (U+00E9); input `"cafe\u0301"` (e + combining acute) must produce the same identity | `["json-database-v1","3b5d5c3712955042212316173ccf37bea9d0f9b1c1e2c3d4e5f60718293a4b5c","dailyRecords","café"]` | `b25bfe4da3293e2e87bfa33633a34c59ac9f0e288679cc189f3729f6b95d0a32` |
| V4a — boundary disambiguation | as V1, but `collection="ab"`, `source_record_id="c"` | `["json-database-v1","3b5d5c3712955042212316173ccf37bea9d0f9b1c1e2c3d4e5f60718293a4b5c","ab","c"]` | `2c73d6acbae7f036f6332b81887d790bd93ed79e06c9c7082a521fcb4119944a` |
| V4b — boundary disambiguation | as V1, but `collection="a"`, `source_record_id="bc"`; must differ from V4a | `["json-database-v1","3b5d5c3712955042212316173ccf37bea9d0f9b1c1e2c3d4e5f60718293a4b5c","a","bc"]` | `d60212cc53f784f272b5271ab57a73e2ca3f08b77621eb262d7afcad7429a8b1` |
| V5 — source-bound quarantine identity | `source_kind="json-database-v1"`, `source_sha256` as V1, `collection="dailyRecords"`, `raw_row={"qty":2.5,"note":"乳量","id":"r-9"}`, `source_ordinal=3`; raw row bytes `{"id":"r-9","note":"乳量","qty":2.5}`; `raw_row_canonical_sha256=42c04b184752e45f2be10e0ef8269708f33f264ea552e5f93b38d39de6355708`; tuple `["quarantine","json-database-v1","3b5d5c3712955042212316173ccf37bea9d0f9b1c1e2c3d4e5f60718293a4b5c","dailyRecords","42c04b184752e45f2be10e0ef8269708f33f264ea552e5f93b38d39de6355708",3]` | `["quarantine","json-database-v1","3b5d5c3712955042212316173ccf37bea9d0f9b1c1e2c3d4e5f60718293a4b5c","dailyRecords","42c04b184752e45f2be10e0ef8269708f33f264ea552e5f93b38d39de6355708",3]` | `e336926640a38fcc5061f098f708e6bad82a2c88da51bcca83ef0755549e4f33` |
| V6 — cross-source quarantine separation | same raw row, collection, and ordinal as V5, but `source_sha256="6653b072ca9d89fec4eaa7e88a06bcaa6860b6ad3fd7d01020b57e0cd5b12e47"` (a different source); identity MUST differ from V5 | `["quarantine","json-database-v1","6653b072ca9d89fec4eaa7e88a06bcaa6860b6ad3fd7d01020b57e0cd5b12e47","dailyRecords","42c04b184752e45f2be10e0ef8269708f33f264ea552e5f93b38d39de6355708",3]` | `6c55d8371e3befe0e3684662e94cc77bad4a932cd89ccac0df3302fed5cb5f0e` |
| V7 — raw-slice-bound duplicate-key quarantine identity | `source_kind="json-database-v1"`, `source_sha256` as V1, `collection="dailyRecords"`, `source_ordinal=3`; original raw row slice text `{"id":"a","id":"b","status":"active"}`; `original_raw_row_sha256=e977a32c23f0cf0d65dc87d91b9922bc1a0808f9cebcee7fcf5cbf046ab7adb3` (SHA-256 of the raw slice text, duplicate occurrences included); tuple `["quarantine-raw","json-database-v1","3b5d5c3712955042212316173ccf37bea9d0f9b1c1e2c3d4e5f60718293a4b5c","dailyRecords","e977a32c23f0cf0d65dc87d91b9922bc1a0808f9cebcee7fcf5cbf046ab7adb3",3]` | `["quarantine-raw","json-database-v1","3b5d5c3712955042212316173ccf37bea9d0f9b1c1e2c3d4e5f60718293a4b5c","dailyRecords","e977a32c23f0cf0d65dc87d91b9922bc1a0808f9cebcee7fcf5cbf046ab7adb3",3]` | `d102615572048ff6969643a2d4c8ae97ac00c171872140d990c7d1e36d3723d9` |

### 5.2 Duplicate-key row identity amendment (P2-4-F09 freeze)

This docs-only micro-amendment resolves the 5.1 internal tension for
duplicate-key rows. Contract 5.1 declares a row with duplicate keys not
canonically serializable, therefore `CJSON(raw_row)` — and any identity
derived from a parse of that row — is UNDEFINED for it. The amendment
freezes two rules that replace the previous implicit last-wins behavior;
the frozen V7 vector above must be reproduced byte-for-byte by the gate
(§14.1).

```text
Rule 1 — duplicate keys do NOT affect the source id (the row still has a
provable source ID, string or safe integer):
  identity            = record_identity (frozen 5.1 encoding, unchanged)
  disposition         = quarantined (reason code duplicate-key)
  raw evidence        = the ORIGINAL raw row slice, duplicate occurrences
                        included, with its own SHA-256/byte length

Rule 2 — duplicate keys make the source id ambiguous/unprovable (the
duplicate key IS the id field, or the id is otherwise not a provable
source ID):
  raw_duplicate_quarantine_identity =
    SHA-256( UTF-8( CJSON([ "quarantine-raw", source_kind, source_sha256,
                           collection, original_raw_row_sha256,
                           source_ordinal ]) ) )
  original_raw_row_sha256 = SHA-256( UTF-8( original raw row slice text ) )
```

`original_raw_row_sha256` is the hash of the ORIGINAL source row slice
text (byte-for-byte, every duplicate key occurrence included), never a
re-serialization of the last-wins parse. The leading `"quarantine-raw"`
discriminator keeps this space disjoint from both the record-key space and
the `"quarantine"` space of 5.1. Quarantine identities remain
preservation-only and must never become a Domain business ID. Rule 2
replaces `raw_row_canonical_sha256` for duplicate-key rows only; the 5.1
formula continues to apply verbatim to rows without duplicate keys.


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

### 6.1 Owner-mapping binding and rebinding rule (P2-4-F01 freeze)

```text
accepted source identity = (source_kind, source_sha256)
accepted owner mapping   = owner_mapping_sha256, bound to that source and to
                           that import result
```

Replay is defined only for the identical triple `(source_kind, source_sha256,
owner_mapping_sha256)` over byte-identical source bytes. Importing the same
source identity with a different `owner_mapping_sha256` is NOT replay. It must:

- fail closed before any destination write with the deterministic reason code
  `owner-mapping-mismatch`;
- never rebind the tenant, never silently remap owners, and never create or
  mutate Domain, quarantine, or manifest records;
- leave the previously accepted import result and its mapping hash immutable.

A genuine owner-mapping correction is not implementable by re-importing the
same source with a new mapping. It requires an independently reviewed forward
remap/amendment contract that names the old and new mappings and their hashes,
the affected record identities, and a new deterministic identity path, and
that preserves the historical run's evidence.

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

Required deterministic import record key — canonical encoding frozen in §5.1:

```text
record_identity =
  SHA-256( UTF-8( CJSON([ source_kind, source_sha256, collection, source_record_id ]) ) )
```

The record key intentionally does not include `owner_mapping_sha256`: replay
legality is enforced by the owner-mapping binding in §6.1, never by the key.

Required behavior:

- replay of the same source identity and the same owner mapping (§6.1)
  creates zero new Domain records, zero new quarantine records, and no changed
  business payload; a different owner mapping is not replay and fails closed
  (§6.1);
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

### 8.1 Import persistence schema authority (P2-4-F02 freeze)

Any import-manifest, record-trace, or quarantine persistence schema change MUST
be one or more new forward registered migrations owned by the sealed migration
authority:

```text
packages/persistence/migrations
  -> owns migration definitions, identity, ordering, validation, and orchestration

migration runner
  -> sole writer of schema version and migration history
```

The importer, source adapter, import application service, and import repository
MUST execute zero schema DDL. No `CREATE TABLE`, `CREATE INDEX`,
`ALTER TABLE`, `DROP`, schema rebuild, or `IF NOT EXISTS` structural repair
may exist anywhere in P2-4 runtime/import code. The accepted v12
(`audited-schema-v12-baseline`) and v13 (`registered-schema-v13-repair`)
migration identities, names, canonical bodies, and checksums remain immutable;
P2-4 schema must be a new forward identity (v14+) applied only by the canonical
migration runner while pending, with its ledger row written in the same
transaction as its schema effects.

The dedicated gate must add these architecture/static proofs (§14.1):

```text
import modules contain no schema DDL
new import schema is reachable only through the canonical migration runner
zero-pending restart  =>  observed schema DDL count = 0
P2-3A / P2-3B gates remain green
```

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
  target/raw/quarantine content digests;
- every §5.1 known hash vector (V1–V6), asserted byte-for-byte by an
  implementation independent of this document.

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

### 14.1 Canonical identity and schema-authority proofs

In addition to the gate coverage above, `p2-4-legacy-json-import-gate` must
assert:

- every §5.1 known hash vector byte-for-byte (V1–V6), reproduced from an
  implementation independent of this document;
- the §8.1 architecture/static proofs: import modules contain no schema DDL,
  new import schema is reachable only through the canonical migration runner,
  zero-pending restart DDL count = 0;
- P2-3A and P2-3B migration gates remain green at the same checkpoint;
- P2-4-F01 / P2-4-F02 coverage passes with P0 = 0 and P1 = 0.

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
  trace, and quarantine persistence required by this contract — which must be
  new forward registered migrations under the §8.1 authority.

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
- required gate commands and architecture boundary;
- the frozen canonical identity encoding and known hash vectors (§5.1);
- the owner-mapping binding and fail-closed rebinding rule (§6.1);
- the import persistence schema authority and zero-DDL proof requirements
  (§8.1).

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
P2-4 Contract Registration: PASS
P2-4-F01: CLOSED / PASS
P2-4-F01.1: CLOSED / PASS
P2-4-F02: CLOSED / PASS
P2-4-F03: CLOSED — NON-BLOCKING / P2 (audit wording only; fixed by this checkpoint)
P2-4 Implementation Authorization: OPEN
P2-4 Implementation: CANDIDATE / CHANGES REQUIRED
P2-4-F04: CLOSED / PASS
P2-4-F05.1: OPEN / P1 — correction committed
P2-4-F06: OPEN / P1 — correction committed
P2-4-F07.1: OPEN / P1 — correction committed
P2-4-F08: OPEN / P1 — correction committed
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

This checkpoint records the independent P2-3 Seal decision and the audit
history in §18. It does not review or certify its own docs commit, and it
opens no authority by itself: P2-4 Implementation Authorization was opened
only by the independent PASS recorded in §18.5. P2-4 Implementation remains
NOT STARTED and the P2-4 Gate remains CLOSED.

## 18. Audit history

### 18.1 Registration checkpoint

Checkpoint `138b1ae6782615022eefb743537f0781eee9f330` (`P2-4 register legacy
JSON import contract`), sole parent `2fb45b25f6880f03f563fd472d8143bfed8699b5`,
registered this contract as a docs-only candidate. Independent verification
confirmed ahead 1 / behind 0, exactly 1 commit, exactly 3 `docs/p2/**` files,
and no implementation, schema, test, fixture, runtime, or workflow change.

### 18.2 Independent contract review — REQUEST CHANGES

Independent remote contract review of the registration checkpoint returned
`REQUEST CHANGES` with P0 = 0 and two P1 findings, and kept P2-4
Implementation Authorization CLOSED:

- `P2-4-F01` (OPEN / P1) — stable identity encoding and owner-map rebinding
  semantics under-specified: tuple byte encoding, field separation/length
  encoding, UTF-8/Unicode normalization, `source_record_id` type rule,
  raw-row canonicalization, and same-source/different-owner-map behavior were
  not frozen. Frozen by §5.1 and §6.1 of this correction.
- `P2-4-F02` (OPEN / P1) — import manifest/trace/quarantine persistence
  schema was not explicitly bound to the sealed migration authority, leaving
  `CREATE TABLE IF NOT EXISTS` in importer code possible while functional
  tests stay green. Frozen by §8.1 of this correction.

The review separately PASSed remote identity/scope, legacy source inventory,
and exact-SHA [agent-safety run 31691085082](https://github.com/liuzexin086-bit/naibaji-feeding-agent/actions/runs/31691085082)
(`head_sha = 138b1ae6782615022eefb743537f0781eee9f330`, `push`, `success`);
CI green does not cover the two contract P1s.

### 18.3 Correction checkpoint

This docs-only correction commit changes exactly the three registered
`docs/p2/**` files, freezes F01 (canonical encoding + known vectors,
owner-mapping binding) and F02 (schema authority, zero DDL), and records this
audit history. It does not implement the importer, add or alter schema, create
fixtures, change runtime behavior, or open P2-4 Implementation Authorization.
This checkpoint does not review or certify its own commit; only the
independent re-review of the correction SHA can close F01/F02.

### 18.4 First re-review — REQUEST CHANGES (P2-4-F01.1)

Independent remote re-review of correction checkpoint
`ce16798b0b989b6a403082e8d0c9b917882a84f2` (sole parent
`138b1ae6782615022eefb743537f0781eee9f330`) confirmed remote identity/scope
(ahead 1 / behind 0, exactly 1 commit, exactly the three `docs/p2/**` files),
independently recomputed V1–V5 and matched every committed vector, accepted
the owner-mapping binding, accepted `P2-4-F02` (`CLOSED / PASS`), and
accepted the governance/audit handling (`PASS`). Exact-SHA
[agent-safety run 31757368178](https://github.com/liuzexin086-bit/naibaji-feeding-agent/actions/runs/31757368178)
(`push`, `head_sha = ce16798b0b989b6a403082e8d0c9b917882a84f2`, `success`)
was confirmed. The re-review then returned `REQUEST CHANGES` with one P1
residual:

- `P2-4-F01.1` (OPEN / P1) — the frozen `quarantine_identity` was not
  source-bound: it lacked `source_kind` and `source_sha256`, so two
  different sources containing the same raw row at the same ordinal in the
  same collection would produce identical quarantine identities, and the
  contract had not frozen a composite identity that would separate them.

This second correction makes the quarantine identity source-bound (§5.1:
`"quarantine", source_kind, source_sha256, collection,
raw_row_canonical_sha256, source_ordinal`), updates V5, adds the
cross-source separation vector V6 (same row/collection/ordinal, different
`source_sha256` => different identity), and records this history. It changes
exactly the three registered `docs/p2/**` files and does not implement the
importer, change schema or runtime, or open P2-4 Implementation Authorization.
This checkpoint does not review or certify its own commit; only the
independent re-review of this correction SHA can close F01.1.

### 18.5 Second re-review — PASS

Independent remote re-review of second correction checkpoint
`f921b4f67187494b6d91965d176a3a85857ee938` (sole parent
`ce16798b0b989b6a403082e8d0c9b917882a84f2`) confirmed remote identity/scope
(ahead 1 / behind 0, exactly 1 commit, exactly the three `docs/p2/**` files),
independently recomputed V5/V6 and matched the committed vectors, and closed
`P2-4-F01.1` (`CLOSED / PASS`) together with `P2-4-F01` and `P2-4-F02`
(`CLOSED / PASS`). Exact-SHA
[agent-safety run 31758897344](https://github.com/liuzexin086-bit/naibaji-feeding-agent/actions/runs/31758897344)
(`push`, `head_sha = f921b4f67187494b6d91965d176a3a85857ee938`, `success`;
413 passed / 1 skipped / 414 total; P2-1 20/20, P2-2 9/9, P2-3A 35/35, P2-3B
46/46, P0 100/100, P1 197/197, optimizer 12/12) was confirmed. The review
returned `PASS` with P0 = 0 and P1 = 0, formally closed the P2-4 Contract
Registration Review (`CLOSED / PASS`), set `P2-4 Contract Registration:
PASS`, and opened `P2-4 Implementation Authorization: OPEN`.

One non-blocking P2 item was recorded: `P2-4-F03` — a sentence in this
contract still generically said the re-review may close F01/F02 although F02
had already closed. It is wording only, without behavioral or authorization
ambiguity; the reviewer required no further correction, and this checkpoint
fixes the current-state wording while leaving the historical audit sections
unchanged.

This checkpoint records the independent verdict and does not certify its own
commit. P2-4 Implementation remains NOT STARTED, the P2-4 Gate remains CLOSED,
and P2-6, runtime/cutover, Compose replacement, merge, tag, PR, deployment,
and real-device control remain unauthorized.
