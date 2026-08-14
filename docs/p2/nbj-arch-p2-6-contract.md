# NBJ-ARCH-P2 P2-6 Feeding Model Single Source Contract Registration

Status: `P2-6 CONTRACT REGISTRATION — CANDIDATE / INDEPENDENT REVIEW PENDING — IMPLEMENTATION NOT AUTHORIZED`

Registration baseline: `e3148e9b327564cd7d17fc40e9de813982284ab6` (branch `nbj-arch-p2`, "P2-4 record final independent PASS and open P2-4 Gate")

P2-4 closure context: P2-4 Gate is `OPEN` (frozen at `e3148e9b327564cd7d17fc40e9de813982284ab6` — independent final PASS recorded by that commit). P2-7 SOP authority work, runtime/cutover, Compose replacement, merge/tag/PR/deploy, optimizer production, and real-device control are explicitly out of scope here (see §10).

This checkpoint is a docs-only contract registration candidate. It creates no authority by itself and does not self-certify. Only an independent review of this registration may open P2-6 contract registration review; implementation authorization stays CLOSED until that verdict (see §11).

## 1. Registration boundary

This docs-only checkpoint registers the P2-6 Feeding Model Single Source contract and its gate requirements as a candidate. It does not modify feeding-model implementation, generated artifacts, migrations, runtime, tests, workflows, or any file outside `docs/p2/nbj-arch-p2-6-contract.md`. It opens only P2-6 contract registration review.

No implementation of the no-duplication gate, no provenance regeneration, no artifact rewrite, and no version-identity or backward-compat migration is authorized by this registration. The required proofs and fixtures listed in §9 are recorded for a future implementation checkpoint, not built here.

## 2. Objective

P2-6 establishes one one-way, traceable, replay-safe single-source path for the feeding model:

```text
root authoritative sources (feeding-model.js, v5lite-model.js)
  -> generated artifacts (.generated-models/*.cjs, .generated-web min, tracked root min)
  -> consumers (Agent container, Web, backend) via frozen consumption boundaries
with provenance, SHA-256 version identity, and a no-duplication architecture gate
```

The contract freeze (i) declares the single authoritative implementation source, (ii) fixes the one-way derivation direction, (iii) draws the consumption boundaries, (iv) requires a no-duplication architecture gate, and (v) binds version / hash / provenance identity with backward-compatibility rules. Everything restates and is bound by the verified inventory recorded at the registration baseline (§3). P2-6 must never let a second implementation of feeding-model semantics become a production authority.

## 3. Verified inventory (bound by this contract)

The facts below are the verified on-disk/committed inventory at HEAD `e3148e9b327564cd7d17fc40e9de813982284ab6`, taken from the independent inventory audit (`E:/plan/.tmp/p2-6-feeding-model-inventory.md`, gitignored). Where the inventory has unknowns they are marked explicitly; no unverified value is asserted.

### 3.1 Committed source and artifact SHAs (SHA-256 over committed bytes) — CONFIRMED at HEAD

| Artifact | Verified SHA-256 at HEAD |
|---|---|
| `feeding-model.js` (root authoritative source) | `35a0dd40e66d4c1fc4dc4ef6fb20cf44c28f70aa284eb5dadfe6f05f0e760c6d` |
| `v5lite-model.js` (root authoritative V5-Lite source) | `124385a11fd247013c7c4dd14fe95642ddebf0b9621a797e72eb91794ec16eae` |
| `feeding-model.min.js` (root tracked minified artifact) | `00fc4c4e828901dc648548842549e14e0bfdd14f97883a78f89d0094b9208893` |
| `.generated-models/feeding-model.cjs` | byte-equal to `feeding-model.js` |
| `.generated-models/v5lite-model.cjs` | byte-equal to `v5lite-model.js` |

### 3.2 Version facts — CONFIRMED

- `feeding-model.js` returns version `'naibaji-v2'` (train-export + module), same export surface in min form: `WEIGHT_STANDARD`, `INTERNAL`, `CREEP_GRADE_VALUES`, `validateBatchConfig`, `getDailyCapacity`, `getRampFactor`, `milkToGain`, `generatePlan`, `computeControlPlan`, `computeDailyStats`, `exportTrainingData`.
- `feeding-model-simple.js` declares `MODEL_VERSION = 'naibaji-simple-v2'`, age range 3–30, exports `createFeedingBatch` / `restoreFeedingBatch`. It is the separate minimal daily-control model (historical/research evidence only — see §4).
- `agent/src/model/production-model.ts` sets `modelVersion = "feeding-model+V5-Lite@2026-08-03-control-v2"` (transitional production source — §4).

### 3.3 Authority-map classification — CONFIRMED

Tracked (in git HEAD):
- `feeding-model.js`, `feeding-model.min.js`, `v5lite-model.js` (root)
- `agent/src/model/production-model.ts` (transitional production source)
- `backend/src/models/feedingModel.js` = `module.exports = require('../../../feeding-model')` (legacy re-export wrapper)
- `backend/src/models/v5liteModel.js` = `module.exports = require('../../../v5lite-model')` (legacy re-export wrapper)
- `backend/src/services/feedingPlanService.js` (legacy service; exports `FeedingPlanService`)

Gitignored / generated-on-disk (present, NOT committed):
- `agent/.generated-models/feeding-model.cjs` (+ `v5lite-model.cjs`) [`agent/.gitignore:5`]
- `agent/container-models/feeding-model.cjs` (+ `v5lite-model.cjs`) [`agent/.gitignore:4`]
- `agent/public/feeding-model.min.js` (+ `v5lite-model.js`) [`agent/.gitignore:3`]
- `web/lib/feeding.ts` [`.gitignore:21 web/`]

Experimental Python:
- `optimizer/model.py` (Differentially-differentiable forward "可微前向传播 V3", numpy-only, NOT production)
- `packages/feeding-model` (P2-6 single-source target) DOES NOT EXIST at HEAD.

### 3.4 Known divergences the contract must address (findings F1–F5)

`F1` — `agent/container-models/feeding-model.cjs` on disk (SHA `61001d8629c51b7b9f6ccc59cec5ece2bb21fe5a4ad76db186d5dcde6a640465`) is NOT byte-equivalent to `feeding-model.js` (`35a0dd40...`). `git diff`: 16 insertions / 46 deletions. The container feeding-model flavor diverges from the authoritative source.

`F2` — `agent/public/feeding-model.min.js` on disk (SHA `3bfef50697fef9bd3820e97cb133e5f7bfa7dcd13e76a9b616e0b10bef99c0a9`) DIFFERS from the root committed `feeding-model.min.js` (`00fc4c4e...`). Two distinct minified artifacts exist.

`F3` — ignored `web/lib/feeding.ts` is a SEPARATE feeding implementation with different arithmetic: `MEALS=12` vs `feeding-model.js` which caps feed times at 10/day (`feedTimes=Array.fill(10)`, "起始/最高 10 次"). Concrete numeric divergence.

`F4` — `v5lite-model.cjs` is byte-equal to `v5lite-model.js` in BOTH `.generated-models` and `container-models`; `container-models` diverges only for the feeding (non-lite) model (F1).

`F5` — Root on-disk `feeding-model.js` / `v5lite-model.js` / `feeding-model.min.js` match committed hashes → no worktree drift on tracked feeding files.

### 3.5 Distinct feeding-model artifacts at HEAD (count / classification)

```text
1 root feeding-model.js                    (authoritative source)
2 root feeding-model.min.js                (committed minified artifact)
3 root feeding-model-simple.js             (separate minimal daily-control model, naibaji-simple-v2)
4 root v5lite-model.js                     (V5-Lite shadow source)
5 agent/src/model/production-model.ts      (transitional TS wrapper -> loads .generated-models)
6 backend/src/models/* + feedingPlanService.js (legacy re-export wrappers)
7 .generated-models/*.cjs                  (byte-equal to root sources)
8 container-models/*.cjs                   (v5lite equal; feeding DIVERGES — F1)
9 agent/public/*                           (feeding-model.min.js DIVERGES — F2)
10 web/lib/feeding.ts                      (ignored separate impl, MEALS=12 — F3)
11 optimizer/model.py                      (experimental Python surrogate)
12 packages/feeding-model                  (TARGET authority, not yet present)
```

No committed JSON or unified single model source exists at the baseline. P2-6 therefore freezes `feeding-model.js` (and `v5lite-model.js`) as the single tracked authoritative source and defines derivation + parity for every derived artifact on disk, eliminating F1/F2/F3 divergence risk in the future implementation checkpoint.

## 4. Freeze item 1 — SINGLE AUTHORITATIVE SOURCE

- Root `feeding-model.js` and root `v5lite-model.js` (repo root) are the ONLY authoritative implementations of feeding-model logic.
- `backend/src/models/feedingModel.js` and `backend/src/models/v5liteModel.js` are pure re-exports (`require('../../../feeding-model')`, `require('../../../v5lite-model')`) and MUST stay re-exports — never diverging copies.
- `feeding-model-simple.js` (+ its test `feeding-model-simple.test.js` and the `feeding-model-simple-文字公式说明.md` doc) and the `.bak.20260706_091444` tracked backups are historical/research evidence, NOT authority.
- No other file may contain a second implementation of the same model semantics.

```text
AUTHORITY SET (frozen at HEAD e3148e9):
  feeding-model.js   — SHA 35a0dd40e66d4c1fc4dc4ef6fb20cf44c28f70aa284eb5dadfe6f05f0e760c6d
  v5lite-model.js    — SHA 124385a11fd247013c7c4dd14fe95642ddebf0b9621a797e72eb91794ec16eae
RE-EXPORT WHITELIST (backend, never a copy):
  backend/src/models/feedingModel.js -> require('../../../feeding-model')
  backend/src/models/v5liteModel.js  -> require('../../../v5lite-model')
HISTORICAL / RESEARCH ONLY (not authority):
  feeding-model-simple.js / feeding-model-simple.test.js
  feeding-model-simple-文字公式说明.md  / .bak.20260706_091444 tracked backups
```

The inventory's F1/F2/F3 divergences (§3.4) are KNOWN DIVERGENCES that the future implementation checkpoint must eliminate or explicitly register as reviewed frozen flavors (each with provenance and version identity). This contract does NOT bless them silently.

## 5. Freeze item 2 — GENERATION / DERIVATION DIRECTION

Artifacts are derived ONE-WAY from the authoritative sources through the frozen preparation scripts:

```text
feeding-model.js / v5lite-model.js (root authoritative)
  -> agent/scripts/prepare-model-assets.mjs
       => agent/.generated-models/feeding-model.cjs   (byte-equal to source)
       => agent/.generated-models/v5lite-model.cjs    (byte-equal to source)
       consumed by the Agent container at /app/.generated-models/*
  -> agent/scripts/prepare-web-model-assets.mjs
       = terser minify of root feeding-model.js
       => agent/.generated-web/feeding-model.min.js
       with syncRoot option writing the tracked root feeding-model.min.js
```

Rules:
- NEVER hand-edit any `.generated-*` artifact.
- NEVER hand-maintain `feeding-model.min.js`; it must equal the generated web artifact byte-for-byte (asserted by `agent/tests/web-model-derivation.test.ts`).
- Generation runs ONLY through the preparation scripts (`prepare-model-assets.mjs`, `prepare-web-model-assets.mjs`).
- Derived artifacts are gitignored EXCEPT the tracked root `feeding-model.min.js`.

At the baseline the byte-parity holds for `.generated-models/*.cjs` and the root min (F5, §3.4); the `container-models` feeding flavor (F1) and `agent/public` min (F2) are the divergences the implementation checkpoint must eliminate or register (§4).

## 6. Freeze item 3 — CONSUMPTION BOUNDARIES

- Agent container consumes `.generated-models/*.cjs` only.
- Web (Next.js app: `web/app/dashboard.tsx`, `web/app/api/batches/[id]/export/route.ts`) consumes `web/lib/feeding.ts` — which is the F3 DIVERGENT separate implementation (`MEALS=12`, §3.4), NOT the tracked/generated min. At this baseline the Web production path does not consume the authoritative source; this divergence must be eliminated or registered with provenance as part of the future implementation checkpoint (§4).
- The static gitignored `agent/public/index.html:8` (and `agent/public/admin.html:8`) load `feeding-model.min.js`, which on disk is the F2 DIVERGENT `agent/public/feeding-model.min.js` (SHA `3bfef506...`, §3.4) — not the tracked root min `00fc4c4e...`. This is likewise a known divergence to be eliminated or registered; `web/index.html` does not exist.
- Backend consumes the root sources via re-export only (§4).
- The optimizer (`optimizer/model.py` "可微前向传播 V3" + `optimizer/contracts.py` + `optimizer/search.py` `MODEL_VERSION="feeding-model+v5-lite@optimizer-v3"`) is a SEPARATE Python optimization surrogate — it may optimize against the model but is NOT a production decision authority and must NEVER be imported by agent/backend/web runtime (the inventory's import grep confirms it is used only experimentally; see §8.e gate assertion).
- Tests consume sources/artifacts through the frozen scripts only.

```text
Agent container  -> /app/.generated-models/*.cjs only
Web (Next.js)    -> web/lib/feeding.ts ONLY (F3 DIVERGENT impl, MEALS=12)
                   -- DIVERGENCE to eliminate/register, NOT the authoritative source
agent/public html -> loads agent/public/feeding-model.min.js (F2 DIVERGENT min)
                   -- DIVERGENCE to eliminate/register
Backend          -> root sources via re-export only
Optimizer        -> separate Python surrogate, NOT a decision authority,
                    NEVER imported by agent/backend/web runtime
Tests            -> consume sources/artifacts via the frozen scripts only
```

## 7. Freeze item 4 — NO-DUPLICATION ARCHITECTURE GATE

The contract requires a dedicated CI-enforced command named:

```text
p2-6-feeding-model-single-source-gate
```

It must assert at least:

```text
(a) no duplicate model implementation files exist outside the frozen source list
    (inventory/static check listing EVERY file that may contain model logic,
     with the re-export whitelist for backend)
(b) generated artifacts are byte-derivable from the sources via the frozen scripts
    (derivation test)
(c) tracked feeding-model.min.js equals the generated web artifact
(d) provenance SHAs (write-provenance.mjs / agent-provenance.json / web-provenance.json)
    are reproducible at the checkpoint
(e) the optimizer surrogate is absent from production runtime imports
```

The gate must cover the FULL artifact inventory including the ignored directories (`.generated-models`, `container-models`, `agent/public`, `web/lib/feeding.ts`), i.e. the twelve-item classification of §3.5, so that F1/F2/F3 cannot silently recur.

Gate wiring follows the P2-4 pattern (`agent/package.json` script `p2-4-legacy-json-import-gate` + `P2-4 Legacy JSON Import gate` step in the `agent-safety` workflow). For P2-6 the equivalent would be a `p2-6-feeding-model-single-source-gate` script plus an `agent-safety` step — to be implemented ONLY after contract registration PASS.

## 8. Freeze item 5 — MODEL VERSION / HASH / PROVENANCE AND BACKWARD COMPATIBILITY

Version identity comes from the authoritative sources:
- `feeding-model.js` self-version `'naibaji-v2'`;
- `v5lite-model.js` identity;
- optimizer `MODEL_VERSION` string must reference the source model identity (surrogate is not a decision authority, §6).

Every model artifact and source is SHA-256 bound through `write-provenance.mjs` and verified by `ci-runtime-check.mjs` (including `agentVersion.schemaVersion === 16`) and the `provenance-contract` tests (incl. `provenance-contract.test.ts`, `ci-contract.test.ts`).

Rules:
- Any semantic change to model logic requires a version identity bump AND full provenance regeneration.
- Patch/build-only changes must NOT change semantics; derivation stays byte-reproducible.
- A provenance mismatch fails closed at runtime/CI.
- Backward compatibility: consumers may rely on the frozen artifact contract (fields, modes, API surface) until a new version identity is explicitly registered.
- No silent dual-write or copy-paste of model logic.

```text
source SHA-256 (root/frozen) --write-provenance.mjs--> provenance JSON
  --ci-runtime-check.mjs (schemaVersion===16)--> fail-closed check
  --provenance-contract tests--> reproducible at the checkpoint
semantic change  => version identity bump + full provenance regeneration
build/patch only => derivation stays byte-reproducible (no semantic change)
mismatch         => fails closed at runtime/CI
consumers        => rely on frozen artifact contract until a new identity is registered
```

## 9. Required proofs / fixtures for implementation acceptance (listed, NOT implemented)

The following are future implementation-acceptance requirements recorded by this contract; none are built by this docs-only checkpoint:

- byte-reproducible generation at a pinned commit;
- tracked min equals generated min;
- provenance JSON regenerated;
- zero orphan model copies;
- optimizer-runtime-import negative test;
- version-bump migration of provenance (as applicable).

## 10. Explicit exclusions

This registration does not authorize any of the following:

- any feeding-model implementation change;
- P2-7 SOP authority work;
- runtime/cutover (Application/API/UI/LangGraph);
- Compose replacement;
- merge / tag / PR / deploy;
- optimizer production;
- real-device control;
- silent blessing of the F1/F2/F3 divergences (§3.4) without a reviewed, provenance-bound frozen-flavor registration (§4).

## 11. Registration acceptance

Independent review of this docs-only checkpoint with P0 = 0 and P1 = 0. Implementation authorization stays CLOSED until that verdict. The P2-6 Gate remains CLOSED until implementation, evidence, exact-SHA CI, and independent implementation review all pass.

## 12. Closing state block

```text
P2-6 Feeding Model Single Source
  Stage / Contract Registration Authorization: OPEN
  Contract Registration: CANDIDATE / INDEPENDENT REVIEW PENDING
  Implementation Authorization: CLOSED
  P2-6 Gate: CLOSED

P2-4 Gate: OPEN (frozen at e3148e9b327564cd7d17fc40e9de813982284ab6)
P2-7 SOP authority: CLOSED
Runtime/Cutover Gate: CLOSED
Compose Replacement Gate: CLOSED
P2 Merge Gate: CLOSED
Architecture Unification Gate: CLOSED
Optimizer Production Gate: CLOSED
Real Device Control Gate: CLOSED
```

## 13. Audit history

### 13.1 Registration checkpoint

This checkpoint records the P2-6 contract registration candidate at baseline `e3148e9b327564cd7d17fc40e9de813982284ab6`, scoped to `docs/p2/nbj-arch-p2-6-contract.md` only (docs-only). It freezes the five items in §4–§8, binds the verified inventory (§3) including the F1/F2/F3 divergences, and requires the §7 no-duplication gate. It does not self-certify: registration acceptance requires the independent review of §11 with P0 = 0 and P1 = 0.
