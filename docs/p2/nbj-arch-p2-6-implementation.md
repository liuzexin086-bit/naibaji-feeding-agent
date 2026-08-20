# NBJ-ARCH-P2 P2-6 Feeding Model Single Source Implementation

Status: `P2-6 IMPLEMENTATION — PASS / P2-6 GATE OPEN (independent final review of d000a09e56e79d4d58d5fb55306ec643f2203d63, run 32352472468)`

Contract registration: `PASS` (frozen `nbj-arch-p2-6-contract.md`, micro-correction chain `P2-6-F01.1 / F01.2 / F01.3`)

Implementation authorization: `OPEN`

Branch `nbj-arch-p2`; implementation candidate chain `94137fa -> 618431b ->
a1edb8f -> 5c9c525`, plus the implementation-correction chain recorded in
§Correction (independent review `REQUEST CHANGES` P2-6-F04/F05/F06/F07). This
checkpoint is the implementation candidate for the P2-6 single-source feeding
model per the frozen contract. It is local evidence; it does not self-certify.
Exact-SHA CI and an independent implementation review are required before the
P2-6 Gate may open.

## Candidate boundary

This checkpoint implements the P2-6 Feeding Model Single Source contract
[nbj-arch-p2-6-contract.md](./nbj-arch-p2-6-contract.md): the single TS
authority in `packages/feeding-model`, >= 100 golden-vector zero-delta parity,
one-way derivation of every production artifact from the package authority,
consumers re-pointed to the package, and the no-duplication gate wiring. It does
not open the P2-6 Gate, authorize runtime/cutover, Compose replacement, merge,
tag, PR, deployment, optimizer production, real-device control, or P2-7 SOP
authority work.

## packages/feeding-model (single TS authority)

`packages/feeding-model` is the P2-6 target authority (frozen Authority Map
rows 46-47). Structure:

```text
packages/feeding-model
  src/index.ts          single TypeScript implementation (faithful port of baseline)
  src/schema.ts         typed plan/daily/control/export contracts
  dist/                 tsc-compiled commonjs (index.js, index.d.ts, schema.js, schema.d.ts)
  golden-vectors.json   109 golden vectors (regeneration byte-identical)
  publication-manifest.json  version + source/baseline/golden-vector SHA-256
                             + FULL 12-item artifact inventory (per-item SHA-256 +
                               disposition; refreshed by scripts/refresh-publication-manifest.mjs)
  tsconfig.json, package.json  (build: tsc -p tsconfig.json; main: dist/index.js)
  scripts/generate-golden-vectors.mjs
```

The module exports: `WEIGHT_STANDARD`, `INTERNAL`, `CREEP_GRADE_VALUES`,
`CREEP_GRADE_ORDER`, `CREEP_MEAL_FLOORS`, `validateBatchConfig`,
`getDailyCapacity`, `getRampFactor`, `milkToGain`, `generatePlan`,
`computeControlPlan`, `computeDailyStats`, `exportTrainingData` — the same
frozen export surface as the baseline `feeding-model.js`. Types: `PlanOptions`,
`PlanDay`, `FeedingPlan`, `DailyRecord`, `WeighSample`, `ControlPlan`,
`DailyStats`, `BatchInfo`, `TrainingDailyRecord`, `TrainingExport`.

## Source authority re-pointing (scripts / backend / agent / provenance)

The one-way derivation direction (contract §5.2) is enforced by re-pointing
every producer and consumer at the package authority, never the root parity
oracle `feeding-model.js` (which remains only the migration parity oracle):

```text
packages/feeding-model/dist/index.js  (single authority)
  prepare-model-assets.mjs       -> agent/.generated-models/feeding-model.cjs (byte-copy)
  prepare-web-model-assets.mjs   -> agent/.generated-web/feeding-model.min.js
                                     + root feeding-model.min.js (synced copy)
  write-provenance.mjs           feedingModelSourceSha256 = sha256(src/index.ts)
  backend/src/models/feedingModel.js  re-export ../../../packages/feeding-model/dist/index.js
  agent/src/model/production-model.ts consumes ../../.generated-models/feeding-model.cjs
```

- `agent/scripts/prepare-model-assets.mjs` derives the Agent CJS artifact as a
  byte-copy of `packages/feeding-model/dist/index.js`; `v5lite-model.cjs` stays a
  shadow-only copy of the root `v5lite-model.js` baseline.
- `agent/scripts/prepare-web-model-assets.mjs` minifies `packages/feeding-model/dist/index.js`
  (terser) to `.generated-web/feeding-model.min.js` and, with `--root`, writes the
  tracked root `feeding-model.min.js` as the synced copy.
- `agent/scripts/write-provenance.mjs` binds `feedingModelSourceSha256` to the package
  source `packages/feeding-model/src/index.ts` and `feedingModelArtifactSha256` to the
  derived package dist (== `.generated-models/feeding-model.cjs`).
- `backend/src/models/feedingModel.js` re-exports the package dist (no diverging copy);
  `v5liteModel.js` keeps the root shadow baseline re-export.
- `agent/src/model/production-model.ts` imports the protected CJS model from
  `../../.generated-models/feeding-model.cjs` (package-derived artifact).

## 109 golden-vector zero-delta parity

`packages/feeding-model/golden-vectors.json` holds **109** representative + boundary
golden vectors. `agent/tests/p2-6/golden-vectors-parity.test.ts` (4 tests) asserts
both that the candidate matches the baseline `feeding-model.js` with zero delta
(default business delta = 0, contract §8.2) and that regenerating the golden suite
is byte-identical. The committed manifest binds source/baseline/golden-vector
SHA-256 identities.

```text
baseline root production model (feeding-model.js)
vs packages/feeding-model candidate
  accepted input domain: identical | units: identical | rounding: identical
  caps: identical | control-start behavior: identical | output fields: identical
  deterministic result: identical | delta count = 0 | 109 vectors
```

## F1 / F2 / F3 resolution

- `F1` — `agent/container-models/feeding-model.cjs` is now byte-equal to
  `.generated-models/feeding-model.cjs` (== package dist, SHA `8d9064d1...`):
  deterministic single-source regeneration (gate f.F1 PASS).
- `F2` — `agent/public/feeding-model.min.js` is now byte-equal to
  `.generated-web/feeding-model.min.js` and the tracked root
  `feeding-model.min.js` (SHA `7fb29e29...`): deterministic single-source
  regeneration (gate f.F2 PASS).
- `F3` — the divergent `web/lib/feeding.ts` (`MEALS=12` vs the 10-meal cap) is
  ELIMINATED (the on-disk gitignored file was removed; no pre-approved Expected
  Delta exists, contract §4.3/§8.3). The gate FAILS CLOSED if any divergent
  feeding implementation exists ANYWHERE (tracked OR on-disk gitignored `web/`,
  e.g. a reappearing `web/lib/feeding.ts` with `MEALS>10`) — a warning is not
  sufficient. The production Web consumer must consume the package-derived
  artifact; a gitignored local file is never a production authority.

## p2-6 gate wiring

`p2-6-feeding-model-single-source-gate` runs `npm run check`, then
`node scripts/p2-6-model-single-source-gate.mjs`, then the P2-6, web-model
derivation, provenance-contract, and CI-contract suites. The workflow
`.github/workflows/agent-safety.yml` runs it as the `P2-6 Feeding Model Single
Source gate` step between the P2-4 and P0 gates, and
`agent/tests/ci-contract.test.ts` pins both the command and the step name.

`agent/scripts/p2-6-model-single-source-gate.mjs` asserts:

```text
(a1) logic-definition scan (no duplicate function defs outside DEFINE allowlist)
(a2) reference allowlist (consumers/tests/docs are NEVER flagged)
(a3) constant drift-control (duplicate constants must equal the package; fail on divergence)
(b)  derivation: generated cjs == package dist; regenerated Web min == generated + tracked
(c)  package dist byte-reproducible via tsc
(d)  provenance SHAs reproduce
(e)  optimizer absent from runtime imports
(f)  F1/F2 are PIPELINE-OWNED derived artifacts: must EXIST and be byte-equal
     (hard fail on absence or divergence)
(f3) F3 FAILS CLOSED: no divergent feeding implementation anywhere (tracked or
     on-disk gitignored web/); a warning is not sufficient
(g)  golden vectors >= 100; publication-manifest hashes match; FULL 12-item
     artifact inventory verified (per-item SHA-256 + disposition)
```

## Implementation correction — independent review REQUEST CHANGES (F04/F05/F06/F07)

Independent implementation review of `5c9c525` returned `REQUEST CHANGES` with three
P1 findings (not architecture direction):

- `P2-6-F04` (P1) — the ignored/on-disk F1/F2/F3 lifecycle was fail-open: F3
  (`web/lib/feeding.ts` MEALS=12) was warning-only, and F1/F2 were absent-pass.
  Fixed: `prepare-model-assets.mjs` / `prepare-web-model-assets.mjs` now OWN the
  `container-models/feeding-model.cjs` and `agent/public/feeding-model.min.js`
  derived artifacts (pipeline-owned, byte-equal to the single source); the
  divergent on-disk `web/lib/feeding.ts` was ELIMINATED; the gate FAILS CLOSED
  on any divergent feeding implementation (tracked OR on-disk gitignored)
  (contract §4.3/§7).
- `P2-6-F05` (P1) — full-inventory per-artifact provenance was missing.
  Fixed: `publication-manifest.json` now carries the machine-verifiable FULL
  12-item artifact inventory (per-item SHA-256 + disposition), refreshed by
  `scripts/refresh-publication-manifest.mjs`; `write-provenance.mjs` binds the
  same inventory into `agent-provenance.json`/`web-provenance.json`; the gate
  verifies every entry against the actual files (contract §8.1/§9).
- `P2-6-F06` (P1) — root `feeding-model.js` remained a production-build
  dependency. Fixed: preparation/provenance discovery now locates the repo via
  `packages/feeding-model` (src/dist) plus the V5-Lite shadow baseline, without
  requiring root `feeding-model.js`; the Dockerfile no longer COPYs
  `feeding-model.js`; the production build (prepare/build/provenance/Agent and
  Web images/runtime provenance) completes without the parity oracle. Added
  `agent/tests/p2-6/prod-build-no-root-oracle.test.ts` (negative architecture
  test; contract §6.2). The root file remains only for the golden-vector
  generator, parity tests, and reference/audit (parity-oracle role).
- `P2-6-F07` (P2) — stale audit records. Fixed here (HEAD references, F3
  narrative, full-inventory prose, verification counts).

## Local verification

Observed locally (implementation-correction candidate):

```text
npm run check: PASS (typecheck; regenerates deterministic artifacts 7fb29e29 / 8d9064d1)
gate scope vitest (tests/p2-6, web-model-derivation, provenance-contract, ci-contract): 15 passed
npm test (full agent suite): 494 passed
node tests/backend-smoke.test.js (root): PASS (backend smoke test passed)
node scripts/p2-6-model-single-source-gate.mjs: PASS
   (a1)(a2)(a3) no-duplication PASS | (b)(c)(d)(e) PASS
   (f.F1)(f.F2) pipeline-owned byte-equal PASS | (f.F3) no divergent impl anywhere PASS
   (g) golden vectors + full 12-item artifact inventory PASS
npm run p2-6-feeding-model-single-source-gate: PASS (exit 0)
node packages/feeding-model/scripts/refresh-publication-manifest.mjs: PASS (12 artifacts)
```

The gate is green locally and FAILS CLOSED on: tracked/on-disk divergent feeding
implementations (including any reappearing `web/lib/feeding.ts` with MEALS>10),
missing/divergent pipeline-owned F1/F2 artifacts, and any publication-manifest
artifact-inventory mismatch.

Local evidence does not self-certify this candidate: exact-SHA CI and independent
implementation review remain required.

## Gate state block

```text
P2-6 Feeding Model Single Source
  Stage / Contract Registration Authorization: CLOSED / COMPLETED
  Contract Registration: PASS
  Implementation Authorization: OPEN (completed)
  Implementation: PASS
  P2-6 Gate: OPEN

P2-4 Gate: OPEN (frozen)
P2-7 SOP authority: CLOSED
Runtime/Cutover Gate: CLOSED
Compose Replacement Gate: CLOSED
P2 Merge Gate: CLOSED
Architecture Unification Gate: CLOSED
Optimizer Production Gate: CLOSED
Real Device Control Gate: CLOSED
```

## Final independent review — PASS and P2-6 Gate OPEN

Independent implementation review of the candidate chain `94137fa -> 618431b ->
a1edb8f -> 5c9c525` returned `REQUEST CHANGES` (P2-6-F04/F05/F06/F07). The narrow
correction chain `5c9c525 -> 962a354 -> f59a30c -> ae8d2cb -> d000a09` closed all
four (F1/F2 pipeline-owned fail-closed, F3 eliminated, full 12-item provenance
with canonical identity vs runtime presence, root oracle removed from production
build). Final independent re-review of `d000a09` (run `32352472468`) returned
`PASS WITH NON-BLOCKING FINDING`: P2-6-F01 through P2-6-F07 CLOSED/PASS;
P2-6-F08 OPEN/P2 non-blocking (test-quality; resolved by a follow-up test commit).
New P0: 0; Open P1: 0.

```text
P2-6 Contract Registration: PASS
P2-6 Implementation: PASS
P2-6 Feeding Model Single Source Gate: OPEN
P2-6 overall: CLOSED / PASS

P2-7 SOP Authority: CLOSED (requires separate, independently reviewed seal)
Runtime/Cutover Gate: CLOSED
Compose Replacement Gate: CLOSED
P2 Merge Gate: CLOSED
Architecture Unification Gate: CLOSED
Optimizer Production Gate: CLOSED
Real Device Control Gate: CLOSED
```
