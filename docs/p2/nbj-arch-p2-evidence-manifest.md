# NBJ-ARCH-P2 Evidence Manifest

Status: `P2-1 IMPLEMENTATION REVIEW PASS WITH NON-BLOCKING FINDINGS — P2-1 GATE OPEN`

Baseline: `76187e1a3d4c7b83a70fc2aabb0a6fb4a8f05232`

Historical Review 0 checkpoint: `fead997b78afb2b03c372a957f9fe8c19fd6d4a0` — `REQUEST CHANGES`

Accepted corrected checkpoint: `fec5659a7f514201ea1f090cc2c7e9c02aeb57db` — `PASS`

Corrected checkpoint parent: `fead997b78afb2b03c372a957f9fe8c19fd6d4a0`

Remote branch: `nbj-arch-p2`

CI preflight receipt: [nbj-arch-p2-ci-preflight-receipt.md](./nbj-arch-p2-ci-preflight-receipt.md)

P2-1 Final Review Seal: [nbj-arch-p2-review-1-final.md](./nbj-arch-p2-review-1-final.md)

Captured: 2026-08-11

Hash semantics: lowercase SHA-256 over raw committed file content bytes (as returned by `git show <ref>:<path>`), unless otherwise stated. These are not Git object IDs.

## 1. Immutable Git baseline

| Item | Value | Evidence method |
|---|---|---|
| Main merge commit | `76187e1a3d4c7b83a70fc2aabb0a6fb4a8f05232` | `git rev-parse 'HEAD^{commit}'` before branch creation |
| Merge parents | `413a4c0012711ae3aaa3023f68f3c665b2f5cfad`, `8fc677826169ba8a7b9888dd4c298435a6aeeaab` | `git log -1 --format=%P` |
| Reviewed feature head | `8fc677826169ba8a7b9888dd4c298435a6aeeaab` | PR #1 / merge parent |
| Git tree | `fb345a916960a18e41fd4f93bd2f30cb182726e6` | `git rev-parse 'HEAD^{tree}'` |
| P1 annotated tag | `nbj-execution-contract-p1-baseline-20260811` | Tag peels to the same commit/tree |
| Annotated tag object | `0777f9b0d199ffa962796e4a234ec5ee11d3d452` (`tag`) | `git rev-parse <tag>` plus `git cat-file -t` |
| P2 remote branch | `nbj-arch-p2` | Remote review candidate is reachable from the named branch |
| P2-0 original review checkpoint | `fead997b78afb2b03c372a957f9fe8c19fd6d4a0` | Independent Review 0: `REQUEST CHANGES` |
| P2-0 original checkpoint parent | `76187e1a3d4c7b83a70fc2aabb0a6fb4a8f05232` | `git rev-parse fead997^` |
| P2-0.1 corrected checkpoint | `fec5659a7f514201ea1f090cc2c7e9c02aeb57db` | Independent re-review: `PASS` |
| P2-0.1 corrected checkpoint parent | `fead997b78afb2b03c372a957f9fe8c19fd6d4a0` | `git rev-parse fec5659^` |
| P2-1 reviewed implementation checkpoint | `edbe4335f8436abdd2084776fecaf4dc9e22cff2` | Independent P2-1 review: `PASS WITH NON-BLOCKING FINDINGS` |
| P2-1 reviewed checkpoint parent | `b861e2c8f9e1c462a67b26fe0b32e0cfb29852a8` | Exact parent supplied with the review verdict |
| P2-1 remote CI | run `31558952869`, `agent-safety`, success | Exact reviewed checkpoint CI evidence |
| Post-merge CI | run `31465609647`, `workflow_dispatch`, main, success | `gh run view 31465609647` |

The ignored `.planning/` directory and ignored local `web/` directory are not in this Git tree and are not P2 baseline artifacts.

Checkpoint `fead997b78afb2b03c372a957f9fe8c19fd6d4a0` contains the four original `docs/p2/` contract documents and no runtime, schema, CI, lock, UI, model, or data changes. P2-0.1 is limited to correcting those documents and adding the independent Review 0 receipt.

## 2. Toolchain and dependency seal

| Item | Frozen value | Artifact SHA-256 |
|---|---|---|
| Node | `24.18.0` | Workflow, `agent/package.json`, and Agent Dockerfile |
| Python | `3.10.9` | Workflow `actions/setup-python@v5` input |
| Root npm lock | committed lockfile | `d9dbc93ff2f66cff9ba272b324c42885e43b2f1089f71f564eee9dda55d70354` |
| Agent npm lock | committed lockfile | `502dd14829dc3f71497f7ad7376137b8aa0410a74528e47a22b50e6a51be0c83` |
| Optimizer requirements | `numpy==2.2.6`; `matplotlib==3.9.4` | `ec4fc4e12b8beb10b8cc972d6de9bb52dde7b4d1fa8622851f38eef708aa92b8` |
| Safety workflow | `.github/workflows/agent-safety.yml` | `1449f24cb7e778e9caa6ffedf90508e23a910a32524b064ac190c718313c517f` |

## 3. Runtime contracts

| Contract | Frozen value | Evidence |
|---|---|---|
| SQLite schema | `12` | `agent/src/local-db/schema.ts` `MIGRATION_VERSION` |
| Migration implementation | inline schema/column inspection plus migration logic | `agent/src/local-db/index.ts` |
| Decision policy | `execution-contract-v1` | runtime provenance contract and decision code |
| Production model version | `feeding-model+V5-Lite@2026-08-03-control-v2` | `agent/src/model/production-model.ts` |
| Default SOP version | `2026.08.03-v6-first-day-sop` | `agent/src/sop/engine.ts` |
| Local storage default | SQLite in local Compose | `AGENT_STORAGE_BACKEND=${AGENT_STORAGE_BACKEND:-local}` |
| API container | Node `24.18.0-slim` | `agent/Dockerfile` |
| Web container | Nginx `1.29.1-alpine` | `agent/Dockerfile` |
| Tunnel | `cloudflare/cloudflared:2026.7.0` | local Compose |
| Chroma | `chromadb/chroma:1.5.9` | local Compose |
| Embedding model revision | `BAAI/bge-small-zh-v1.5@534b6bfaaf500e70bcb9f3771cebc940c23b219d` | local Compose |

The current `schema_migrations` table contains only `version` and `applied_at`; checksum, name, and application version are P2 target requirements, not baseline facts.

## 4. Source and generated artifact hashes

| Artifact | Role | SHA-256 |
|---|---|---|
| `feeding-model.js` | tracked production source at baseline | `35a0dd40e66d4c1fc4dc4ef6fb20cf44c28f70aa284eb5dadfe6f05f0e760c6d` |
| generated Agent `feeding-model.cjs` | derived; byte-equivalent to source | `35a0dd40e66d4c1fc4dc4ef6fb20cf44c28f70aa284eb5dadfe6f05f0e760c6d` |
| `v5lite-model.js` | tracked V5-Lite shadow source | `124385a11fd247013c7c4dd14fe95642ddebf0b9621a797e72eb91794ec16eae` |
| generated Agent `v5lite-model.cjs` | derived; byte-equivalent to source | `124385a11fd247013c7c4dd14fe95642ddebf0b9621a797e72eb91794ec16eae` |
| generated/tracked Web `feeding-model.min.js` | derived minified artifact | `00fc4c4e828901dc648548842549e14e0bfdd14f97883a78f89d0094b9208893` |
| `agent/ui/liquid-index.html` | tracked production UI source | `0ee23cfe4ce35b4c190c9beec55142380fd2be4d87359cbdb19362cbc4be0deb` |
| `agent/src/sop/engine.ts` | current default SOP engine/source | `f520d9af5e2203d6611e9b9737a5bf3cf4fdfea4777f647321eb7b5ebf30f711` |
| `agent/src/sop/types.ts` | current SOP types | `e5ef32d96418290971a5d100d0a2a559cd917c16d3dc577139223d9341e2618c` |
| `agent/src/knowledge/sop-publication.ts` | current publication workflow | `5147763d5f33f03a261f238e7dcbe78cb782ff718568b4bd87e965d51e0cd4c4` |
| `docs/feeding-agent-sop-v6.md` | current tracked SOP reference document | `04551bf99f7cc8ea9409dfa39244dde864c4280b6c4a5fbc1470b4ca81b71882` |
| local Compose | runtime topology | `a9b423f193f0182f4bbf5562b1a25272c1f0e52691d426c2d3c9f454797583e4` |

There is no single baseline SOP source digest spanning code, Markdown, and active SQLite publication. That is an authority conflict P2-7 must close. A deployed database's active SOP publication must be captured separately before migration; it cannot be inferred from this Git manifest.

## 5. Post-merge CI evidence

Run `31465609647` checked out `main` at `76187e1` and completed every job step successfully:

| Gate | Result |
|---|---|
| Root JSON-backend smoke | PASS |
| Python optimizer | 12/12 PASS plus `compileall` |
| Agent full suite | 365 passed, 1 skipped, 366 total |
| P0 release gate | 99/99 PASS |
| P1 safety gate | 192/192 PASS |
| Typecheck / build / clean-source | PASS |
| Agent Docker build | PASS; ephemeral image `sha256:1909afff71078d79ac76c3872521b45d29d5a8d53a84bed93549131fb1f6c02d` |
| Web Docker build | PASS; ephemeral image `sha256:ee8f592122747f206529166545fa73bc93d4c20ede249d5361e264202beab5c1` |
| Compose config | PASS |
| Runtime provenance and UI E2E | PASS; `commit=76187e1a3d4c7b83a70fc2aabb0a6fb4a8f05232` |

The CI image IDs are evidence from an ephemeral runner, not pullable release images or registry digests. Local `:ci` images predate the post-merge run and are not baseline evidence.

## 6. Known baseline findings

| Finding | Severity for P2-0 | Disposition |
|---|---|---|
| Agent development dependency audit reports 1 high + 1 critical; production-pruned image reports 0 | Non-blocking carryover | Enter P2 security/supply-chain review; do not rewrite P1 baseline. |
| `P2-001`: CI coverage for the P2 branch | CLOSED on 2026-08-12 | Commit `7912b1721a11e441a741e7bdcd4e7ebf367f1a76` covers pushes to `main` and `nbj-arch-p2` plus pull requests targeting `main`; exact-SHA push run `31550812177` passed. P2-1 Domain implementation is authorized; later runtime/cutover Gates remain CLOSED. |
| Root CI smoke validates the legacy JSON backend | Architecture debt | Convert to migration/legacy fixture coverage before production-path removal. |
| Supabase remains a compiled Agent backend and direct legacy UI path | Architecture debt | P2-5/P2-11 removal Gate. |
| Migration ledger lacks checksum/name/application version | Architecture debt | P2-3 blocking acceptance item. |
| Active production DB and active published SOP are environment data, not committed fixtures | Evidence gap | Capture sanitized, hashed fixtures before migration implementation. |
| No registry-published immutable Docker digest exists for the ephemeral P1 images | Evidence limitation | Rebuild from baseline and prove runtime provenance; do not claim pullability. |
| `P2-F-001`: chat observation normalization drops explicit diarrhea `none` | P1 / P2 Merge blocker | Independent P2-1 review verified the Chat/Domain fix and closure evidence; persistence acceptance remains pending under `P2-ED-001`, so this Merge blocker remains OPEN. |
| Actual operator deployment path and live authority are not repository-verifiable | Evidence gap | P1 Docker is the reviewed canonical contract, but Electron/legacy UI and an ignored nested D1 repository exist locally. Capture deployment inventory and read-only data-source snapshots before migration. |
| Electron passes `?api=` to root `index.html`, but no consumer was found in that file | Legacy integration ambiguity | Treat the handoff as legacy/unresolved; do not infer that JSON backend and legacy UI are correctly integrated. |

## 7. Evidence reproduction rules

- Git artifact hashes must use raw committed file content bytes returned by `git show <ref>:<path>`, not a CRLF-transformed Windows worktree and not a Git object ID.
- Runtime provenance must bind commit, schema, decision policy, source hashes, generated artifact hashes, and UI hash.
- Database/SOP evidence must be captured from a read-only copy and include source SHA-256; secrets must never enter this manifest.
- Generated files and ignored local workspaces are evidence only when recreated from the committed baseline by a documented command.
- Every later P2 checkpoint appends evidence; it does not overwrite this baseline section.

## 8. Supplemental P2-0 audit receipt

An independent read-only prerequisite audit ran:

- Python optimizer unittest: 12/12 PASS under local Python `3.10.9`.
- Targeted Agent suites (`observation-feedback`, `amendments`, `langgraph-runtime`): 56/56 PASS under local Node `24.16.0`.

The targeted Node receipt is supplemental because it was not run under the frozen Node `24.18.0`; the exact-version remote P1 receipt remains run `31465609647`. The audit found `P2-F-001` by source-path review despite the existing suites being green, demonstrating the need for a new chat-endpoint regression.

## 9. P2-0 Final Seal review receipt

Independent re-review of remote branch `nbj-arch-p2` at `fec5659a7f514201ea1f090cc2c7e9c02aeb57db` confirmed:

- the remote branch matched the reviewed SHA;
- `fec5659` had sole parent `fead997`;
- the correction contained one commit and exactly five `docs/p2/*` changes;
- P1-001 through P1-004 and P2-002 were closed;
- no P0 or P1 finding was introduced;
- `P2-001` remained open as a pre-P2-1 CI blocker;
- `P2-F-001` / `P2-ED-001` remained open as a P2 Merge blocker.

Verdict: `P2-0.1 PASS`. This Final Seal records that independent verdict and does not self-review its own commit.

## 10. P2-001 CI preflight receipt

CI preflight commit `7912b1721a11e441a741e7bdcd4e7ebf367f1a76` has sole parent `c5365fdb8007681a551415edeea7d21326c3485f` and changes only `.github/workflows/agent-safety.yml`. The workflow now covers:

- pushes to `main`;
- pushes to `nbj-arch-p2`;
- pull requests targeting `main`;
- manual `workflow_dispatch` runs.

GitHub Actions push run [`31550812177`](https://github.com/liuzexin086-bit/naibaji-feeding-agent/actions/runs/31550812177) executed exact head SHA `7912b1721a11e441a741e7bdcd4e7ebf367f1a76` and completed with conclusion `success`. All safety-job steps passed, including the root smoke test, optimizer tests, Agent typecheck/tests, P0 release gate, P1 safety gate, builds, clean-source gate, image builds, Compose config, and runtime provenance/UI E2E.

Verdict: `P2-001 CLOSED — CI PREFLIGHT PASS`. P2-1 Domain implementation is authorized; subsequent stage Gates remain unchanged.

## 11. P2-1 Domain checkpoint evidence

The P2-1 Domain checkpoint adds framework-free contracts under `agent/src/domain/` for
observations, runtime latches, creep control, planned/active decisions, and operation
state transitions. The Domain architecture test scans every module and rejects HTTP,
SQLite, LangGraph, UI, and LLM/provider imports. Root review also corrected the chat
projection and current-turn explicit-none closure; the evidence below is local
implementation evidence, now independently reviewed by the P2-1 Final Review Seal.
The Chat/Domain portion is accepted; persistence acceptance remains pending.

Focused local evidence:

| Check | Result |
|---|---|
| `npm run check` | PASS |
| `npm run p2-1-domain-gate` | PASS — 8 files / 18 tests |
| `git diff --check` | PASS |
| Full suite (reviewed checkpoint) | PASS — 385 passed / 1 skipped / 386 total |
| `npm run p0-release-gate` | PASS — 7 files / 100 tests |
| `npm run p1-safety-gate` | PASS — 16 files / 194 tests |
| `npm run build` | PASS |
| Chat transport regression | PASS — real HTTP `/api/feeding-agent/chat` accepts complete UI payload, retains explicit `none`, distinguishes omission, rejects invalid selected values with 400, and captures no application/device claim |
| Earlier-abnormal closure | PASS — prior moderate + current explicit `none` returns ended/no device operation in preview; sync/evaluation returns no feedback |

The chat adapter projects only `diarrheaGrade` and `actualPowderGrams` before delegating
validation to the Domain observation parser; richer UI metadata is not treated as chat
tampering. It maps the tagged presence contract to the existing Agent transport shape
without persisting, confirming, applying, or controlling a device. SQLite/persistence
wiring remains a later P2 stage.

Post-preflight evidence required by `P2-003` was checked against run
[`31551632349`](https://github.com/liuzexin086-bit/naibaji-feeding-agent/actions/runs/31551632349):
the run completed successfully on `nbj-arch-p2` at `b861e2c8f9e1c462a67b26fe0b32e0cfb29852a8`
and passed the pre-existing safety workflow. That run predates this local Domain
checkpoint and therefore is evidence for the preflight baseline, not remote execution
of the new `p2-1-domain-gate`.

## 12. P2-1 Final Review Seal

Independent review of checkpoint `edbe4335f8436abdd2084776fecaf4dc9e22cff2`
(parent `b861e2c8f9e1c462a67b26fe0b32e0cfb29852`) returned
`PASS WITH NON-BLOCKING FINDINGS`. Remote [agent-safety run 31558952869](https://github.com/liuzexin086-bit/naibaji-feeding-agent/actions/runs/31558952869)
completed successfully. The reviewed full-suite wording is `385 passed / 1 skipped /
386 total`.

| State | Decision |
|---|---|
| P2-1 Implementation | PASS |
| P2-1 Independent Review | PASS |
| P2-1 Gate | OPEN |
| P2-2 Persistence Boundary Authorization | OPEN |
| P2-ED-001 | PARTIALLY ACCEPTED — CHAT/DOMAIN FIX VERIFIED, PERSISTENCE ACCEPTANCE PENDING |
| P2-F-001 | OPEN |
| P2-PRE-03 | BLOCKED |
| P2 Merge / Runtime-Cutover / Compose / Architecture-Unification / Optimizer-Production / Real-Device | CLOSED |

Non-blocking findings are `P2-1-F01` legacy optional Chat adapter and pending
persistence, `P2-1-F02` temporary dual Domain models, `P2-1-F03` development
dependency audit with 1 high and 1 critical versus 0 in the production-pruned
image, and `P2-1-F04` Actions Node20 deprecation. No P2-2 implementation is
included or authorized by this seal beyond its boundary authorization.
