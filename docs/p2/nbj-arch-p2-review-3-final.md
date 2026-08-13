# NBJ-ARCH-P2 P2-3 Final Closure Seal Candidate

Status: `PENDING INDEPENDENT REVIEW`

P2-3A implementation checkpoint: `7d8da7fc0ce06dbfd6d6a6928de712cdc31869d4`

P2-3A correction checkpoint: `7e4101bebadbce8aed43a1b02a0f7f61f67aebc6`

P2-3B registration checkpoint: `d8a9208338b792fbcc4e3c0dbb314f9275abf842`

P2-3B implementation checkpoint: `b280f64e821614c74c9a00fb601de385971c3493`

P2-3B correction checkpoint: `c9165b269339cca1c2ec94bd63750d765b836079`

P2-3B correction parent: `b280f64e821614c74c9a00fb601de385971c3493`

Exact-SHA CI evidence: [agent-safety run 31677062701](https://github.com/liuzexin086-bit/naibaji-feeding-agent/actions/runs/31677062701)

Independent P2-3B verdict: `PASS`

## Candidate boundary

This docs-only candidate maps the three P1 blockers from the historical P2-3
Closure Contract Review to the independently accepted P2-3A and P2-3B remote
evidence. It records the P2-3B implementation verdict and proposes the final
P2-3 closure decision for a separate independent review.

It does not review or certify its own docs commit. Until that independent
Final Closure Seal review returns `PASS`, P2-3 overall remains `IN PROGRESS`,
P2-4 Authorization remains `CLOSED`, and every later Gate remains `CLOSED`.

## Checkpoint identity and scope

Independent review confirmed remote branch `nbj-arch-p2` at correction
checkpoint `c9165b269339cca1c2ec94bd63750d765b836079`, exactly one commit ahead of
implementation checkpoint `b280f64e821614c74c9a00fb601de385971c3493`
with no divergence. The correction changes only:

- `agent/tests/fixtures/p2-3b/legacy-v5-sanitized.manifest.json`;
- `agent/tests/p2-3b/fixture-provenance.test.ts`;
- `agent/tests/p2-3b/migration-ownership.test.ts`.

It changes no production migration, runtime, schema, workflow, SQLite fixture
binary, Application/API/UI/LangGraph, Compose, optimizer, or device-control
file.

## Original blocker closure mapping

| Historical P1 blocker | Accepted closure evidence | Result |
|---|---|---|
| Migration definitions and runner ownership were not under the single Persistence migration authority. | `packages/persistence/migrations` owns canonical schema/version, immutable migration identities, ordering, validation, legacy-ledger upgrade, structural operations, and orchestration. `agent/src/local-db/schema.ts` and `migration-ledger.ts` are compatibility re-exports; `local-db/index.ts` retains only the SQLite connection, transaction, and authorizer seam. The dedicated ownership test proves that boundary. | REMEDIATED |
| A rich-v12 zero-pending restart could still execute ad-hoc schema DDL. | Retained structural compatibility work is the registered forward v13 migration. The fixture is migrated to current, reopened, and migrated again through the real SQLite authorizer seam. The restart requires `ddlEvents = []` and exact equality of ledger, normalized schema, business-row, and raw-payload evidence. Persisted v12 name and checksum tamper both fail before DDL and preserve the complete post-tamper evidence object. | REMEDIATED |
| The required sanitized legacy SQLite fixture and immutable provenance/equivalence proof were missing. | The committed sanitized legacy-v5 fixture is copied to a temporary path before migration. Its manifest binds raw origin and sanitization records, committed fixture hash and size, versions, archive, integrity, foreign keys, schema inventory/digest, full business-row digest, raw payload hashes, SOP snapshot, device plan, eight free-feeding slots, and the complete frozen daily operation plan. Tests migrate only the copy and prove the committed fixture hash remains unchanged. | REMEDIATED |

## P2-3A invariant preservation

The P2-3B implementation and correction preserve every independently accepted
P2-3A invariant:

- the five-column strict ledger owns `version`, `name`, `checksum`,
  `application_version`, and `applied_at`;
- applied rows must be an exact registered prefix, and name/checksum drift
  fails closed before any migration callback;
- the historical ledger archive and `legacy-unknown` rule remain lossless;
- first-v12 frozen evidence backfill remains one-time only, while rich-v12
  restart does not reconstruct it;
- migration and ledger-row insertion remain atomic;
- sealed v12 remains `audited-schema-v12-baseline` with checksum
  `0B204D099EA0661A836F2F0DD34207A6CEF3B0C79C2FE86263F40FD381F4068E`.

P2-3A correction checkpoint
`7e4101bebadbce8aed43a1b02a0f7f61f67aebc6` was independently accepted by
exact-SHA run `31659156393` with `406 passed / 1 skipped / 407 total` and the
P2-3A gate at `35/35`.

## P2-3B-F02 closure and frozen fixture evidence

The correction replaces count-only evidence with complete deterministic
evidence. Its manifest-bound post-migration proof includes:

```text
Fixture SHA-256: D3684B7FB47130F177C8AC48778B826E7DAF51C5C94B749F8E3FC3118BE1D1C1
Fixture size: 245760 bytes
Start version: 5
Current migration versions: 12, 13
Legacy archive versions: 1, 2, 3, 4, 5
Integrity: ok
Foreign-key violations: 0
Schema digest: 3C84C1A08658681D750A9FB3314839091379C5354D16495D0D980BB49C2569EE
Business digest: B0DFF80C77DDAF13466EBA61AF6489A0F8DCCED57B064FAC1ACE234E16E0DE64
Batch raw JSON SHA-256: BF7E523CAA677DC20A8ED7D2BE5C0487F8D59C0C4A518A71EE808CE4CA1B9CB3
Observation raw JSON SHA-256: B47F868796965BC922A6197471DD8ACE3AAEC38575CD180A837D4001F9EBB08F
Message content SHA-256: 9192767DF9B73718AB7AE1F07D839C3646F06C086BD6FCD4449A44BA55142FDE
SOP snapshot SHA-256: 4C04269BD5FF2A723D8C8F6451C6D798878866B6B6B97225678E4F72387A1930
Device plan SHA-256: 613A2BC7AC57C35A9CEED911FDB91277191355B182090FA3AF4876A41F63C6B4
```

The test also checks the complete `fixture-plan` daily operation plan and
exactly eight free-feeding slots: slot 1 is enabled and spans `09:00-18:00`;
slots 2-8 are disabled and each spans `09:00-10:00`. This content-bearing
evidence closes the prior false-positive risk where row counts could pass after
business payload mutation.

Independent remote re-review of correction checkpoint `c9165b2` returned
`PASS`, closed `P2-3B-F02`, and opened the P2-3B Gate. No new P0 or P1 finding
was recorded.

## Exact-SHA CI

Remote run `31677062701` executed exact correction SHA
`c9165b269339cca1c2ec94bd63750d765b836079` via `push` and completed with
`success`.

```text
Full Agent Suite:       413 passed / 1 skipped / 414 total
P2-1 Domain:             20/20
P2-2 Persistence:         9/9
P2-3A Migration:         35/35
P2-3B Migration:         46/46
P0 Release:             100/100
P1 Safety:              197/197
Python Optimizer:        12/12
Agent Build:            PASS
Clean Source:           PASS
Agent/Web Images:       PASS
Compose Config:         PASS
Runtime Provenance/UI:  PASS
```

The precise full-suite result is `413 passed + 1 skipped = 414 total`; it is
not represented as `414 passed`.

## QA and review ledger

The historical local independent-QA dispatch remains permanently recorded as
`BLOCKED — INFRASTRUCTURE / NO VERDICT`. A later local QA re-review returned
`PASS`; it is a separate, later receipt and does not rewrite the historical
no-verdict record. The independent remote P2-3B correction review is the
authority for the accepted implementation verdict.

## Candidate state for independent Final Closure Seal review

```text
P2-3A: CLOSED / PASS
P2-3A Gate: OPEN
P2-3A-F01: CLOSED

P2-3B Contract Registration: PASS
P2-3B Implementation Authorization: OPEN
P2-3B Implementation: PASS
P2-3B Independent Remote Review: PASS
P2-3B-F02: CLOSED / PASS
P2-3B Gate: OPEN

P2-3 Closure Contract Review: REMEDIATED / FINAL CLOSURE SEAL PENDING
P2-3 Final Closure Seal: PENDING INDEPENDENT REVIEW
P2-3 overall: IN PROGRESS — FINAL CLOSURE SEAL PENDING

Historical local QA dispatch: BLOCKED — INFRASTRUCTURE / NO VERDICT
Later local QA re-review: PASS — SEPARATE RECEIPT

P2-4 Authorization: CLOSED
Runtime/Cutover Gate: CLOSED
Compose Replacement Gate: CLOSED
P2 Merge Gate: CLOSED
Architecture Unification Gate: CLOSED
Optimizer Production Gate: CLOSED
Real Device Control Gate: CLOSED
```

Only an independent review of this docs-only Seal checkpoint may change the
historical P2-3 Closure Contract Review to `CLOSED / PASS` and P2-3 overall to
`CLOSED / PASS`. That verdict must separately decide whether P2-4
Authorization may open; this candidate keeps it `CLOSED` and contains no P2-4
implementation.
