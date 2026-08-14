# NBJ-ARCH-P2 P2-6 Feeding Model Single Source Contract Registration

Status: `P2-6 CONTRACT REGISTRATION — MICRO-CORRECTION COMMITTED (P2-6-F01.1 / F01.2 / F01.3) — RE-REVIEW PENDING — IMPLEMENTATION NOT AUTHORIZED`

Independent contract registration review of `19ae8322fb412304593cbdbbcc5f2968d34d312e` returned `REQUEST CHANGES` with `P2-6-F01` (target authority contradicted the frozen Authority Map; root transitional sources and V5-Lite were promoted to authority), `P2-6-F02` (missing frozen ≥100 golden-vector parity and Expected Delta pre-approval governance), and `P2-6-F03` (`.bak.*` incorrectly described as tracked). The correction is recorded in §13.2; the findings stay OPEN until an independent re-review closes them.

Registration baseline: `e3148e9b327564cd7d17fc40e9de813982284ab6` (branch `nbj-arch-p2`, "P2-4 record final independent PASS and open P2-4 Gate")

P2-4 closure context: P2-4 Gate is `OPEN` (frozen at `e3148e9b327564cd7d17fc40e9de813982284ab6` — independent final PASS recorded by that commit). P2-7 SOP authority work, runtime/cutover, Compose replacement, merge/tag/PR/deploy, optimizer production, and real-device control are explicitly out of scope here (see §10).

This checkpoint is a docs-only contract registration candidate. It creates no authority by itself and does not self-certify. Only an independent review of this registration may open P2-6 contract registration review; implementation authorization stays CLOSED until that verdict (see §11).

## 1. Registration boundary

This docs-only checkpoint registers the P2-6 Feeding Model Single Source contract and its gate requirements as a candidate. It does not modify feeding-model implementation, generated artifacts, migrations, runtime, tests, workflows, or any file outside `docs/p2/nbj-arch-p2-6-contract.md`. It opens only P2-6 contract registration review.

No implementation of the no-duplication gate, no provenance regeneration, no artifact rewrite, and no version-identity or backward-compat migration is authorized by this registration. The required proofs and fixtures listed in §9 are recorded for a future implementation checkpoint, not built here.

## 2. Objective

P2-6 establishes one one-way, traceable, replay-safe SINGLE-SOURCE path whose TARGET authority is the `packages/feeding-model` package (frozen Authority Map rows 46-47/88). The root files exist only as the migration parity oracle:

```text
BASELINE parity oracle (transitional, NOT target authority)
  feeding-model.js   -- parity only (baseline behavior oracle)
  v5lite-model.js    -- V5-Lite shadow-only baseline (never production authority)
        | parity only
        v
packages/feeding-model   (P2-6 TARGET authority)
  single TypeScript implementation + schema + >=100 golden vectors
  + versioned publication manifest
        |
        +-- derived Agent CJS artifact
        +-- derived Web artifact (min)
        +-- publication / provenance (SHA-256, per-artifact)
        |
        v
  consumers (Agent container, Web, backend) via frozen target consumption boundaries
  -- production consumers consume ONLY the package authority or its verified
     derived/public API; the root parity fixture is never a production dependency
```

The contract freeze (i) declares the single authoritative implementation source (`packages/feeding-model`), (ii) fixes the one-way derivation direction (package -> all production artifacts), (iii) draws the consumption boundaries (production consumers bind to the package or its derived/public API), (iv) requires a no-duplication architecture gate, and (v) binds version / hash / provenance identity with backward-compatibility rules. Everything restates and is bound by the verified inventory recorded at the registration baseline (§3). P2-6 must never let a second implementation of feeding-model semantics — including the root JS files after migration — become a production authority.

## 3. Verified inventory (bound by this contract)

The facts below are the verified on-disk/committed inventory at HEAD `e3148e9b327564cd7d17fc40e9de813982284ab6`, taken from the independent inventory audit (`E:/plan/.tmp/p2-6-feeding-model-inventory.md`, gitignored). Where the inventory has unknowns they are marked explicitly; no unverified value is asserted.

### 3.1 Committed source and artifact SHAs (SHA-256 over committed bytes) — CONFIRMED at HEAD

| Artifact | Verified SHA-256 at HEAD |
|---|---|
| `feeding-model.js` (root baseline production source / parity oracle — transitional per frozen Authority Map) | `35a0dd40e66d4c1fc4dc4ef6fb20cf44c28f70aa284eb5dadfe6f05f0e760c6d` |
| `v5lite-model.js` (root V5-Lite shadow baseline source — shadow-only, never production authority) | `124385a11fd247013c7c4dd14fe95642ddebf0b9621a797e72eb91794ec16eae` |
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
1 root feeding-model.js                    (BASELINE production source / parity oracle — transitional; move into package)
2 root feeding-model.min.js                (committed minified artifact, derived from baseline source)
3 root feeding-model-simple.js             (separate minimal daily-control model, naibaji-simple-v2, research only)
4 root v5lite-model.js                     (V5-Lite SHADOW baseline source — shadow-only, never production authority)
5 agent/src/model/production-model.ts      (transitional production source -> move into packages/feeding-model)
6 backend/src/models/* + feedingPlanService.js (legacy re-export wrappers)
7 .generated-models/*.cjs                  (byte-equal to root sources)
8 container-models/*.cjs                   (v5lite equal; feeding DIVERGES — F1)
9 agent/public/*                           (feeding-model.min.js DIVERGES — F2)
10 web/lib/feeding.ts                      (ignored separate impl, MEALS=12 — F3 business delta)
11 optimizer/model.py                      (experimental Python surrogate)
12 packages/feeding-model                  (P2-6 TARGET authority: single TypeScript implementation + schema + golden vectors + versioned publication manifest — NOT yet present)
```

No committed JSON or unified single model source exists at the baseline. P2-6 therefore distinguishes two layers (frozen Authority Map rows 46-48/57/86/88):

```text
BASELINE / PARITY SEED (current, transitional)
  feeding-model.js    — baseline production behavior source / parity oracle
  v5lite-model.js     — V5-Lite shadow baseline source (shadow-only)

P2-6 TARGET AUTHORITY (after implementation)
  packages/feeding-model — single TypeScript implementation
                         + schema + golden vectors + versioned publication manifest
```

The future implementation checkpoint must MOVE the feeding source into `packages/feeding-model`, keep V5-Lite shadow-only until separately retired/gated, derive every artifact from the single source (eliminating F1/F2), and treat F3 as a business behavior delta governed by the Expected Delta process (§8), never as a silently registered flavor.

## 4. Freeze item 1 — SINGLE AUTHORITATIVE SOURCE (two layers, per frozen Authority Map)

P2-6 separates the CURRENT baseline/parity seeds from the P2-6 TARGET authority. Freezing the current transitional state as the target would contradict the frozen Authority Map, which targets `packages/feeding-model` and keeps V5-Lite shadow-only.

### 4.1 Baseline / parity seed (current, transitional — NOT the P2-6 target)

- Root `feeding-model.js` is the baseline production behavior source and the migration **parity oracle**: candidate `packages/feeding-model` behavior must equal it by default (§8).
- Root `v5lite-model.js` is a **shadow baseline source only**: V5-Lite remains shadow-only derived telemetry (frozen Authority Map row 57) and must NEVER become a production decision or device authority.
- `backend/src/models/feedingModel.js` and `backend/src/models/v5liteModel.js` are pure re-exports (`require('../../../feeding-model')`, `require('../../../v5lite-model')`) and MUST stay re-exports — never diverging copies.
- `feeding-model-simple.js` (+ its test `feeding-model-simple.test.js` and the root `feeding-model-simple-文字公式说明.md` doc) and the ignored on-disk `.bak.*` backups, if present, are historical/research evidence, NOT authority (`.bak.*` is NOT git-tracked — root `.gitignore:45`).
- `agent/src/model/production-model.ts` is a transitional production source (frozen Authority Map row 88); the implementation checkpoint must move it into `packages/feeding-model`.
- No other file may contain a second implementation of the same model semantics.

### 4.2 P2-6 TARGET authority (after implementation)

```text
packages/feeding-model (frozen Authority Map rows 46-47):
  single TypeScript implementation
  + schema
  + golden vectors (>= 100, §8)
  + versioned model publication manifest (version + source/artifact SHA-256)
  -> dist/Web/CJS artifacts are DERIVED, never independently edited
```

The future implementation checkpoint must MOVE the feeding source into the package; once the package is the registered publication authority, the root `feeding-model.js` baseline file may remain only as a parity/reference fixture and must no longer be an independent production authority.

### 4.3 Divergence governance (F1/F2/F3)

The inventory's F1/F2/F3 divergences (§3.4) are KNOWN DIVERGENCES with distinct governance:

- `F1` (container-models feeding CJS) and `F2` (agent/public min): deterministically generated artifacts in the future implementation checkpoint — each must be produced BY the single-source generation pipeline (§5/§7), byte-verifiable against provenance; elimination of the divergent copies is the default; no independently hand-edited flavor may remain.
- `F3` (`web/lib/feeding.ts`, MEALS=12 vs the 10-meal cap): this is a **business behavior delta**, not a cosmetic flavor. It may NOT be legalized by registering a "reviewed frozen flavor". It must be either eliminated (Web consumes the single source / its derived artifact) or — if the 12-meal behavior is genuinely intended — approved ONLY through the frozen Expected Delta registry (compatibility contract §5) with an independent pre-approval BEFORE implementation, a version identity bump, and provenance regeneration (§8).

This contract does NOT bless F1/F2/F3 silently.

## 5. Freeze item 2 — GENERATION / DERIVATION DIRECTION

### 5.1 Current baseline derivation (inventory fact, transitional)

Today the preparation scripts derive artifacts one-way from the ROOT files. This is a BASELINE FACT, not the P2-6 target:

```text
feeding-model.js / v5lite-model.js (root BASELINE sources, transitional)
  -> agent/scripts/prepare-model-assets.mjs
       => agent/.generated-models/feeding-model.cjs   (byte-equal to source)
       => agent/.generated-models/v5lite-model.cjs    (byte-equal to source)
       consumed by the Agent container at /app/.generated-models/*
  -> agent/scripts/prepare-web-model-assets.mjs
       = terser minify of root feeding-model.js
       => agent/.generated-web/feeding-model.min.js
       with syncRoot option writing the tracked root feeding-model.min.js
```

### 5.2 P2-6 TARGET derivation (frozen direction)

After implementation, ALL production feeding artifacts are derived ONE-WAY from the `packages/feeding-model` publication authority — never from the root files:

```text
packages/feeding-model (single TS authority + versioned publication manifest)
  -> derived Agent CJS artifact   (Agent container /app/.generated-models/*)
  -> derived Web artifact (min)   (tracked root feeding-model.min.js is the synced copy)
  -> publication / provenance     (per-artifact SHA-256, §8.1)
```

The implementation checkpoint must re-point the preparation scripts (`prepare-model-assets.mjs`, `prepare-web-model-assets.mjs`) at the package publication; the root JS files then serve only as the parity oracle / reference fixture (§4.1) and must no longer feed production artifacts.

Rules (both layers):
- NEVER hand-edit any `.generated-*` artifact.
- NEVER hand-maintain `feeding-model.min.js`; it must equal the generated web artifact byte-for-byte (asserted by `agent/tests/web-model-derivation.test.ts`).
- Generation runs ONLY through the frozen preparation scripts.
- Derived artifacts are gitignored EXCEPT the tracked root `feeding-model.min.js`.

At the baseline the byte-parity holds for `.generated-models/*.cjs` and the root min (F5, §3.4); the `container-models` feeding flavor (F1) and `agent/public` min (F2) are the divergences the implementation checkpoint must eliminate or deterministically regenerate from the single source (§4.3).

## 6. Freeze item 3 — CONSUMPTION BOUNDARIES

### 6.1 Current baseline consumption (inventory facts, transitional)

- Agent container consumes `.generated-models/*.cjs` only.
- Web (Next.js app: `web/app/dashboard.tsx`, `web/app/api/batches/[id]/export/route.ts`) consumes `web/lib/feeding.ts` — which is the F3 DIVERGENT separate implementation (`MEALS=12`, §3.4), NOT the tracked/generated min. At this baseline the Web production path does not consume the authoritative source; F3 is a business behavior delta that must be eliminated or pre-approved through the frozen Expected Delta registry (§4.3, §8), never silently registered.
- The static gitignored `agent/public/index.html:8` (and `agent/public/admin.html:8`) load `feeding-model.min.js`, which on disk is the F2 DIVERGENT `agent/public/feeding-model.min.js` (SHA `3bfef506...`, §3.4) — not the tracked root min `00fc4c4e...`. This is likewise a known divergence to be eliminated or deterministically regenerated (§4.3); `web/index.html` does not exist.
- Backend today consumes the ROOT sources via re-export (`backend/src/models/feedingModel.js` -> `require('../../../feeding-model')`). This is a BASELINE inventory fact, NOT a P2-6 target obligation.
- The optimizer (`optimizer/model.py` "可微前向传播 V3" + `optimizer/contracts.py` + `optimizer/search.py` `MODEL_VERSION="feeding-model+v5-lite@optimizer-v3"`) is a SEPARATE Python optimization surrogate — it may optimize against the model but is NOT a production decision authority and must NEVER be imported by agent/backend/web runtime (the inventory's import grep confirms it is used only experimentally; see §7.e gate assertion).
- Tests consume sources/artifacts through the frozen scripts only.

### 6.2 P2-6 TARGET consumption (frozen boundary)

After implementation, production consumers MUST consume ONLY the `packages/feeding-model` authority or its verified derived/public API:

```text
Agent container  -> derived Agent CJS artifact (from package publication, §5.2)
Web (Next.js)    -> package-derived Web artifact / public API ONLY
                   (F3 elimination or pre-approved Expected Delta, §4.3/§8)
agent/public html -> package-derived min ONLY (F2 eliminated, §4.3)
Backend          -> package authority or its verified derived/public API;
                    the root re-export MUST be re-pointed to the package and
                    the root parity fixture must NOT remain a production dependency
Optimizer        -> separate Python surrogate, NOT a decision authority,
                    NEVER imported by agent/backend/web runtime
Tests            -> consume the package authority / derived artifacts via the
                    frozen scripts only
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

## 8. Freeze item 5 — MODEL VERSION / HASH / PROVENANCE, BEHAVIORAL PARITY AND BACKWARD COMPATIBILITY

### 8.1 Version and provenance identity

Version identity comes from the sources:
- baseline `feeding-model.js` self-version `'naibaji-v2'`;
- baseline `v5lite-model.js` identity (shadow-only);
- optimizer `MODEL_VERSION` string must reference the source model identity (surrogate is not a decision authority, §6);
- the P2-6 TARGET authority (`packages/feeding-model`) must own the versioned model publication manifest (frozen Authority Map row 47).

Provenance (TARGET REQUIREMENT, not a description of today's state): at the implementation checkpoint, EVERY artifact in the §3.5 inventory — including each divergence (F1/F2/F3) and every derived artifact — must carry its own SHA-256 identity, bound through the provenance pipeline (`write-provenance.mjs` / `agent-provenance.json` / `web-provenance.json`) and verified by `ci-runtime-check.mjs` (including `agentVersion.schemaVersion === 16`) and the `provenance-contract` tests. Today `write-provenance.mjs` binds the core path (root source, generated CJS, generated/gitignored Web min); the implementation checkpoint must extend it to cover the full inventory so no divergence exists without a provenance identity.

### 8.2 Behavioral parity and golden vectors (frozen Compatibility Contract §4)

The implementation checkpoint MUST execute the frozen golden-vector parity suite and prove the default result:

```text
P2-6 default business delta = 0

>= 100 representative + boundary golden vectors
baseline root production model (feeding-model.js)
vs
packages/feeding-model candidate

accepted input domain: identical
units: identical
rounding: identical
caps: identical
control-start behavior: identical
output fields: identical
deterministic result: identical

baseline output == candidate output
delta count = 0
missing rows = 0
unexpected duplicates = 0
orphans = 0
```

Hash equality is required where ordering and serialization are contractually canonical; otherwise compare normalized typed values and separately prove canonical reserialization (compatibility contract §4).

### 8.3 Expected Delta governance

A version identity bump IDENTIFIES an already-approved semantic change; it does NOT authorize one. The frozen chain is:

```text
semantic change
  -> Expected Delta registry entry MUST already exist (compatibility contract §5)
  -> independent approval BEFORE implementation
  -> version identity bump
  -> provenance regeneration
```

Without a pre-approved Expected Delta entry, the default rule is: semantic change = 0. In particular, F3's `MEALS=12` vs the 10-meal cap can never become an allowed P2-6 delta merely by bumping `naibaji-v2` -> v3 (§4.3). Convenience, cleanup, performance, or a preferable new business rule is not an approved delta (compatibility contract §5).

### 8.4 Rules

- Any semantic change to model logic requires: pre-approved Expected Delta entry + version identity bump + full provenance regeneration.
- Patch/build-only changes must NOT change semantics; derivation stays byte-reproducible.
- A provenance mismatch fails closed at runtime/CI.
- Backward compatibility: consumers may rely on the frozen artifact contract (fields, modes, API surface) until a new version identity is explicitly registered through the publication manifest.
- No silent dual-write or copy-paste of model logic.

```text
source SHA-256 --write-provenance.mjs--> provenance JSON (per-artifact, full inventory)
  --ci-runtime-check.mjs (schemaVersion===16)--> fail-closed check
  --provenance-contract tests--> reproducible at the checkpoint
semantic change => Expected Delta pre-approval => version bump => provenance regeneration
build/patch only => derivation stays byte-reproducible (no semantic change)
mismatch         => fails closed at runtime/CI
consumers        => rely on frozen artifact contract until a new identity is registered
```

## 9. Required proofs / fixtures for implementation acceptance (listed, NOT implemented)

The following are future implementation-acceptance requirements recorded by this contract; none are built by this docs-only checkpoint:

- byte-reproducible generation at a pinned commit;
- tracked min equals generated min;
- provenance JSON regenerated with a PER-ARTIFACT SHA-256 identity for every item of the §3.5 inventory (incl. each divergence);
- **behavioral parity suite: >= 100 representative + boundary golden vectors, baseline (`feeding-model.js`) vs candidate (`packages/feeding-model`), default delta count = 0** (compatibility contract §4, §8.2);
- **Expected Delta registry: zero unapproved semantic deltas; every intentional change has a pre-approved entry BEFORE implementation (§8.3)**;
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
- silent blessing of the F1/F2/F3 divergences (§3.4): F1/F2 only through deterministic single-source regeneration (§4.3), F3 only through a pre-approved Expected Delta entry (§8.3) — a "frozen flavor" registration alone can never legalize a business behavior delta.

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

### 13.2 First independent registration review — REQUEST CHANGES and correction (P2-6-F01 / F02 / F03)

Independent contract registration review of `19ae8322fb412304593cbdbbcc5f2968d34d312e` returned `REQUEST CHANGES` with:

- `P2-6-F01` (P1) — target authority contradicted the frozen Authority Map (rows 46-48/57/86/88): the draft froze the root transitional sources (and V5-Lite) as the authority set. Fixed: §4 now separates the baseline/parity seed (`feeding-model.js` as parity oracle, `v5lite-model.js` as shadow-only baseline) from the P2-6 TARGET authority (`packages/feeding-model` single TypeScript source + schema + golden vectors + versioned publication manifest); `agent/src/model/production-model.ts` is transitional; F1/F2 become deterministically generated artifacts and F3 is governed as a business behavior delta, not a flavor (§4.3).
- `P2-6-F02` (P1) — missing the frozen >= 100 golden-vector parity suite and Expected Delta pre-approval governance, and the "version bump authorizes semantic change" ambiguity. Fixed: §8 now freezes default business delta = 0, the >= 100 golden-vector parity dimensions, the Expected Delta pre-approval chain (registry entry -> independent approval BEFORE implementation -> version bump -> provenance regeneration), and states provenance as a per-artifact TARGET requirement covering the full §3.5 inventory (§8.1-§8.3); §9 lists the parity suite and Expected Delta proofs.
- `P2-6-F03` (P2) — `.bak.*` described as tracked. Fixed: §4.1 now says the ignored on-disk `.bak.*` backups, if present, are NOT git-tracked (root `.gitignore:45`).

The correction stays docs-only (only `docs/p2/nbj-arch-p2-6-contract.md`); the findings stay OPEN until an independent re-review closes them. Implementation authorization and the P2-6 Gate remain CLOSED.

### 13.3 Second independent registration re-review — REQUEST CHANGES and micro-correction (P2-6-F01.1 / F01.2 / F01.3)

Independent re-review of `cdbbd9d27f908bd705d284df4eda5047556c651f` closed `P2-6-F02` (golden-vector parity + Expected Delta governance) and `P2-6-F03` (`.bak.*` tracked wording), and confirmed `P2-6-F01`'s core §3/§4 two-layer correction. It then returned `REQUEST CHANGES` because the contract's other frozen chapters still carried root-authority TARGET semantics:

- `P2-6-F01.1` — §2 Objective still declared "root authoritative sources (feeding-model.js, v5lite-model.js) -> generated artifacts -> consumers" as the target flow. Fixed: §2 now freezes the TARGET flow `baseline parity oracle -> packages/feeding-model -> derived artifacts -> consumers`, with V5-Lite marked shadow-only and the root parity fixture excluded from production.
- `P2-6-F01.2` — §5 Freeze item 2 still froze derivation from "feeding-model.js / v5lite-model.js (root authoritative)". Fixed: §5 is split into §5.1 "Current baseline derivation (inventory fact, transitional)" and §5.2 "P2-6 TARGET derivation" (packages/feeding-model -> all production artifacts; preparation scripts re-pointed at the package publication).
- `P2-6-F01.3` — §6 froze "Backend -> root sources via re-export only" as a target consumption rule. Fixed: §6 is split into §6.1 baseline consumption facts and §6.2 the P2-6 TARGET consumption boundary (production consumers consume only the package authority or its verified derived/public API; the root re-export must be re-pointed to the package; the root parity fixture is never a production dependency).

The micro-correction stays docs-only (only `docs/p2/nbj-arch-p2-6-contract.md`); `P2-6-F01` remains OPEN until the independent re-review confirms the root-authority target semantics are gone. Implementation authorization and the P2-6 Gate remain CLOSED.
