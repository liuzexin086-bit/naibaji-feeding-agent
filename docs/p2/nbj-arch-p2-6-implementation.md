# NBJ-ARCH-P2 P2-6 Feeding Model Single Source Implementation

Status: `IMPLEMENTATION CANDIDATE — INDEPENDENT REVIEW PENDING — GATE NOT SELF-CERTIFYING`

Contract registration: `PASS` (frozen `nbj-arch-p2-6-contract.md`, micro-correction chain `P2-6-F01.1 / F01.2 / F01.3`)

Implementation authorization: `OPEN`

Branch `nbj-arch-p2` at HEAD `94137fa`. This checkpoint is the implementation
candidate for the P2-6 single-source feeding model per the frozen contract.
It is local evidence; it does not self-certify. Exact-SHA CI and an independent
implementation review are required before the P2-6 Gate may open.

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
  eliminated by default from the tracked baseline. `web/` is gitignored and out of
  the P2 baseline, so a CI checkout has no `web/` and the gate passes. The gate
  fails only if a DIVERGENT feeding implementation appears in the TRACKED tree;
  an on-disk (untracked) `web/lib/feeding.ts` is reported as a non-failing
  warning `F3-ON-DISK-GITIGNORED` with remediation text (eliminate it so Web
  consumes the package-derived artifact, or register the 12-meal behavior only
  through the frozen Expected Delta registry, §4.3/§8.3). F1/F2 remain hard-fail
  when the on-disk copies diverge from the derived artifacts.

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
(f)  F1/F2 hard-fail on divergence; F3 fails only if divergent impl is TRACKED
     (untracked web/lib/feeding.ts -> non-failing F3-ON-DISK-GITIGNORED warning)
(g)  golden vectors >= 100; publication-manifest hashes match
```

## Local verification

Observed locally at HEAD `94137fa`:

```text
npm run check: PASS (typecheck; regenerates deterministic artifacts 7fb29e29 / 8d9064d1)
gate scope vitest (tests/p2-6, web-model-derivation, provenance-contract, ci-contract): 11 passed
npm test (full agent suite): 61 files / 490 passed
node tests/backend-smoke.test.js (root): PASS (backend smoke test passed)
node scripts/p2-6-model-single-source-gate.mjs: PASS
   (a1) logic-definition scan PASS | (a3) constant drift-control PASS | (b)(c)(d)(e) PASS
   (f.F1)(f.F2) PASS | (f.F3) no divergent impl in tracked tree PASS | (g) PASS
   -> non-failing warning F3-ON-DISK-GITIGNORED for gitignored web/lib/feeding.ts (MEALS=12)
npm run p2-6-feeding-model-single-source-gate: PASS (exit 0)
```

The gate is green locally: `npm run p2-6-feeding-model-single-source-gate` (check +
gate .mjs + gate-scope vitest) exits 0. The re-scoped no-duplication gate per the
captain's disposition: (a1) flags only tracked files that DEFINE protected model-logic
functions outside the frozen DEFINE allowlist; (a2) reference/consumer/test/doc files are
never flagged; (a3) duplicate constants outside the DEFINE allowlist must equal the
package's exported constant (agent-v2-contract.ts `CREEP_GRADE_VALUES` equals the
package, confirmed) and fail on divergence; (f.F3) fails only if a divergent feeding
implementation is TRACKED, while the gitignored on-disk `web/lib/feeding.ts` is a
non-failing `F3-ON-DISK-GITIGNORED` warning with remediation text.

Local evidence does not self-certify this candidate: exact-SHA CI and independent
implementation review remain required.

## Gate state block

```text
P2-6 Feeding Model Single Source
  Stage / Contract Registration Authorization: OPEN
  Contract Registration: PASS
  Implementation Authorization: OPEN
  Implementation: CANDIDATE / INDEPENDENT REVIEW PENDING / GATE NOT SELF-CERTIFYING
  P2-6 Gate: CLOSED

P2-4 Gate: OPEN
P2-7 SOP authority: CLOSED
Runtime/Cutover Gate: CLOSED
Compose Replacement Gate: CLOSED
P2 Merge Gate: CLOSED
Architecture Unification Gate: CLOSED
Optimizer Production Gate: CLOSED
Real Device Control Gate: CLOSED
```
