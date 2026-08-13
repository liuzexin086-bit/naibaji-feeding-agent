# NBJ-ARCH-P2 P2-3A Ordered Migration Ledger

Status: `IMPLEMENTATION EVIDENCE — INDEPENDENT REVIEW PENDING`

Baseline: `55877db1367a190ea182642bd720ac6a9382dee6`

Scope: migration infrastructure only. This checkpoint does not import JSON or
Supabase data, change business rules or business schema version, or cut over API,
Application, UI, LangGraph, runtime, Compose, optimizer, or device-control paths.

## Ledger identity

The authoritative SQLite ledger has five required columns:

```text
version
name
checksum
application_version
applied_at
```

- `version` is a positive integer and registry definitions are unique and
  strictly increasing.
- `name` is normalized to NFC and is immutable once applied.
- `checksum` is uppercase SHA-256 over canonical UTF-8 JSON containing
  `{ version, name, body }`. The explicit operation manifest body is NFC and
  LF-normalized. It does not include a JavaScript function rendering,
  `application_version`, or `applied_at`.
- `application_version` records the first application. New rows use the embedded
  Agent package version (`0.1.0` at this checkpoint); imported legacy v12 rows
  use the explicit sentinel `legacy-unknown` because the old ledger cannot prove
  the original application version.
- `applied_at` is audit metadata only. It is preserved during legacy import and
  does not participate in migration identity or ordering.

Applied rows must be the exact ordered prefix of the registered migration chain.
Unknown versions, gaps, name changes, checksum changes, duplicate/out-of-order
registry definitions, or incomplete audit metadata fail closed before a pending
migration callback runs.

## Legacy ledger boundary

P2-3A does not invent checksums or names for historical versions 3–11. When the
old two-column table is detected, it is transactionally renamed to
`schema_migrations_legacy` and retained row-for-row with unchanged values as provenance-only
metadata. The new ledger registers one independently audited baseline:

```text
version: 12
name: audited-schema-v12-baseline
```

If the old ledger already contains version 12, its `applied_at` is preserved and
no second ledger application is recorded. The frozen idempotent LocalStore
compatibility checks still run on every startup, matching the sealed runtime
behavior. If the old ledger contains only an earlier version, that same frozen
path upgrades the real database to v12 and only then records the rich v12 row.
All work remains within the existing
`BEGIN IMMEDIATE` transaction, so business and ledger changes roll back together.

## Acceptance evidence

The P2-3A gate covers:

- fresh database application and idempotent rerun;
- old v12 ledger import with unchanged business data and audit time;
- rich v12 restart repair without a second ledger application;
- real historical/N-1 v3, v6, v7, v8, v9, v10, and v11 fixtures;
- checksum and name tampering before later apply;
- duplicate and out-of-order registry definitions;
- persisted unknown/gap rows that are not a registered prefix;
- transaction rollback of both migration effects and ledger writes;
- first-applier application version immutability;
- `applied_at` remaining audit-only.

P2-3A implementation and local evidence do not self-open its Gate. Independent
review is required. P2-4 JSON Import and every runtime/cutover or later Gate
remain CLOSED.
