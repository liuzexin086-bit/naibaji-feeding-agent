# NBJ-ARCH-P2 Evidence Manifest

Status: `P2-4 CONTRACT REGISTRATION — PENDING INDEPENDENT REVIEW`

Baseline: `76187e1a3d4c7b83a70fc2aabb0a6fb4a8f05232`

Historical Review 0 checkpoint: `fead997b78afb2b03c372a957f9fe8c19fd6d4a0` — `REQUEST CHANGES`

Accepted corrected checkpoint: `fec5659a7f514201ea1f090cc2c7e9c02aeb57db` — `PASS`

Corrected checkpoint parent: `fead997b78afb2b03c372a957f9fe8c19fd6d4a0`

Remote branch: `nbj-arch-p2`

CI preflight receipt: [nbj-arch-p2-ci-preflight-receipt.md](./nbj-arch-p2-ci-preflight-receipt.md)

P2-1 Final Review Seal: [nbj-arch-p2-review-1-final.md](./nbj-arch-p2-review-1-final.md)

P2-2A Final Review Seal: [nbj-arch-p2-review-2a-final.md](./nbj-arch-p2-review-2a-final.md)

P2-2B Repository Boundary Evidence: [nbj-arch-p2-2b-repository-boundary.md](./nbj-arch-p2-2b-repository-boundary.md)

P2-2B / P2-2 Final Review Seal: [nbj-arch-p2-review-2b-final.md](./nbj-arch-p2-review-2b-final.md)

P2-3A Migration Ledger Evidence: [nbj-arch-p2-3a-migration-ledger.md](./nbj-arch-p2-3a-migration-ledger.md)

P2-3A Final Review Seal: [nbj-arch-p2-review-3a-final.md](./nbj-arch-p2-review-3a-final.md)

P2-3B Contract: [nbj-arch-p2-3b-contract.md](./nbj-arch-p2-3b-contract.md)

P2-3 Final Closure Seal: [nbj-arch-p2-review-3-final.md](./nbj-arch-p2-review-3-final.md)

P2-4 Legacy JSON Import Contract: [nbj-arch-p2-4-contract.md](./nbj-arch-p2-4-contract.md)

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
| P2-2A reviewed implementation checkpoint | `865db7b2f3840aca716d7003984373e921da1756` | Independent P2-2A review: `PASS WITH NON-BLOCKING FINDINGS` |
| P2-2A reviewed checkpoint parent | `1e85f994d441b034ae6dfde65e89ba1ec3d46c27` | Exact reviewed parent |
| P2-2A remote CI | run `31571087260`, `agent-safety`, success | Exact reviewed checkpoint CI evidence including the P2-2 Persistence gate |
| P2-2B reviewed implementation checkpoint | `ae4edf7c209ec951d6d13dad0df47e3cf0ad9c1e` | Independent P2-2B review: `PASS` |
| P2-2B reviewed checkpoint parent | `b4b1921858aac464ce1382594cd1825a37bf780c` | Exact reviewed parent |
| P2-2B remote CI | run `31581143939`, `agent-safety`, success | Exact reviewed checkpoint CI evidence; full suite was 393 passed / 1 skipped / 394 total |
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

At the sealed P2-2 baseline, `schema_migrations` contains only `version` and
`applied_at`. P2-3A implementation evidence below upgrades it to the ordered
five-column ledger; that candidate state remains independently review-pending.

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
| `P2-F-001`: chat observation normalization drops explicit diarrhea `none` | CLOSED by P2-2A | Independent P2-2A review accepted the complete Chat/API/Domain/repository/SQLite close-reopen evidence chain; `P2-ED-001` is CLOSED and `P2-PRE-03` is PASS. |
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

## 13. P2-2A Observation Persistence Round-trip

```text
P2-2 Implementation: COMPLETE / REVIEW PENDING
P2-2 Gate: CLOSED
P2-2A Observation Persistence Round-trip: IMPLEMENTED / INDEPENDENT ACCEPTANCE PENDING
P2-ED-001: IMPLEMENTED THROUGH PERSISTENCE / ACCEPTANCE PENDING
P2-F-001: OPEN
P2-PRE-03: BLOCKED
```

P2-2A implementation is limited to a dependency-direction-safe persistence
contract, pure legacy JSON codec, and SQLite adapter over the existing
`daily_observations` table. It does not add a table, migration, API route,
LangGraph integration, UI path, model/SOP rule, or legacy removal.

The adapter encodes `not_observed` by omission and observed values—including
explicit diarrhea `none`—as their value. Invalid owned values fail closed and
are returned as quarantine entries on list; non-authoritative legacy metadata is
not treated as an observation field. Acceptance requires the real temporary
SQLite close/reopen evidence recorded by the P2-2A test suite.

Local implementation evidence (not an independent acceptance verdict):

| Check | Result |
|---|---|
| `npm run check` | PASS |
| `npm run p2-2-persistence-gate` | PASS — 4 files / 7 tests |
| P2-2A SQLite round-trip | PASS — temporary SQLite close/reopen preserved omitted diarrhea, explicit `none`, mild, powder `null`, and powder `0`; invalid legacy row was quarantined |
| `npm test` | PASS — 51 files / 392 tests |
| `npm run p2-1-domain-gate` | PASS — 9 files / 19 tests |
| `npm run p0-release-gate` | PASS — 7 files / 100 tests |
| `npm run p1-safety-gate` | PASS — 16 files / 194 tests |
| `npm run build` | PASS |
| `git diff --check` | PASS |

These local results were subsequently accepted by the independent P2-2A review
recorded below. P2-2 overall remains in progress and no Runtime/Cutover or later
Gate is opened by this evidence.

## 14. P2-2A Final Review Seal

Independent review of checkpoint `865db7b2f3840aca716d7003984373e921da1756`
(parent `1e85f994d441b034ae6dfde65e89ba1ec3d46c27`) returned
`PASS WITH NON-BLOCKING FINDINGS`. Remote [agent-safety run 31571087260](https://github.com/liuzexin086-bit/naibaji-feeding-agent/actions/runs/31571087260)
executed that exact SHA via `push` and completed successfully, including the new
P2-2 Persistence gate and every pre-existing safety, build, image, Compose, and
runtime-provenance/UI-E2E step.

```text
P2-2A Implementation: PASS
P2-2A Independent Review: PASS
P2-2A Gate: OPEN

P2-ED-001: CLOSED — ACCEPTED
P2-F-001: CLOSED
P2-PRE-03: PASS

P2-2 overall: IN PROGRESS
P2-2B Repository Extraction Authorization: OPEN

P2 Merge Gate: CLOSED
Runtime/Cutover Gate: CLOSED
Compose Replacement Gate: CLOSED
Architecture Unification Gate: CLOSED
Optimizer Production Gate: CLOSED
Real Device Control Gate: CLOSED
```

Non-blocking findings carried into P2-2B are:

- `P2-2-F01`: the persistence port still references the legacy
  `shared/local-store-contract.ts` input/row types;
- `P2-2-F02`: the persistence architecture scanner currently scans only
  top-level `src/persistence/*.ts` files and must become recursive before the
  directory is split;
- `P2-2-F03`: Domain-owned observation fields are intentionally not a drop-in
  replacement for legacy UI/runtime metadata; metadata ownership must be made
  explicit before Application/Persistence cutover.

These findings do not reopen the accepted explicit-none semantic chain. They do
keep P2-2 in progress and every Runtime/Cutover or later Gate CLOSED.

## 15. P2-2B Repository Extraction Implementation Evidence

The implementation checkpoint remains within the authorized Repository
Extraction scope and has not changed schema, migration, API, Application,
Agent, UI, LangGraph, model, SOP, Compose, JSON/Supabase, or device-control
paths. The local evidence is:

| Check | Result |
|---|---|
| Persistence-owned contracts | PASS — no imports from `shared/local-store-contract.ts`; LocalStore compatibility is isolated behind `asObservationStorePort`. |
| Recursive architecture scan | PASS — every `.ts` below `src/persistence/**` is scanned in deterministic order; nested forbidden-import fixture fails as expected. |
| Metadata boundary | PASS — Domain projection, cloned raw envelope, Domain-owned collision overlay, unknown metadata retention, and untouched quarantine payload are documented and tested. |
| Explicit-none freeze | PASS — omitted diarrhea remains `not_observed`; explicit `none` remains observed `none`; powder `null` remains distinct from zero. |
| `npm run check` | PASS |
| `npm run p2-2-persistence-gate` | PASS — 4 files / 9 tests |

This implementation evidence was subsequently accepted by the independent
P2-2B review recorded below. The review closes P2-2 without opening
Runtime/Cutover, Compose Replacement, Merge, or other later Gates.

## 16. P2-2B / P2-2 Final Review Seal

Independent review of checkpoint `ae4edf7c209ec951d6d13dad0df47e3cf0ad9c1e`
(parent `b4b1921858aac464ce1382594cd1825a37bf780c`) returned `PASS`.
Remote [agent-safety run 31581143939](https://github.com/liuzexin086-bit/naibaji-feeding-agent/actions/runs/31581143939)
executed that exact SHA via `push` and completed successfully. Typecheck, the
full suite (`393 passed / 1 skipped / 394 total`), P2-1 Domain, P2-2
Persistence, P0, P1, build, clean-source, image builds, Compose config, and
runtime-provenance/UI-E2E all passed.

The independent review confirmed that Persistence contracts no longer depend on
legacy LocalStore types (`P2-2-F01`), recursive architecture enforcement covers
nested dependencies (`P2-2-F02`), and the Domain/Persistence/opaque-metadata
ownership boundary is explicit and lossless (`P2-2-F03`). No schema, migration,
API, Application, LangGraph, UI, model, SOP, Compose, runtime cutover, optimizer,
or device-control change was present. The P2-2A explicit-none semantics remain
frozen.

```text
P2-2A Implementation: PASS
P2-2A Independent Review: PASS
P2-2A Gate: OPEN

P2-2B Implementation: PASS
P2-2B Independent Review: PASS
P2-2B Gate: OPEN

P2-2-F01: CLOSED
P2-2-F02: CLOSED
P2-2-F03: CLOSED

P2-2 Persistence Boundary: PASS
P2-2 Gate: OPEN

P2-3 Migration Ledger Authorization: OPEN

P2 Merge Gate: CLOSED
Runtime/Cutover Gate: CLOSED
Compose Replacement Gate: CLOSED
Architecture Unification Gate: CLOSED
Optimizer Production Gate: CLOSED
Real Device Control Gate: CLOSED
```

This docs-only seal records the independent verdict and does not certify its own
commit. P2-2 is complete and there is no P2-2C. P2-3 implementation is not part
of this checkpoint.

## 17. P2-3A Ordered Migration Ledger Implementation Evidence

P2-3A keeps business schema version `12` and replaces the two-column migration
marker with required `version`, `name`, `checksum`, `application_version`, and
`applied_at` metadata. Definitions are positive, unique, and strictly ordered;
applied rows must be an exact registered prefix; name or checksum drift fails
closed before pending migration code runs.

The old ledger is retained as `schema_migrations_legacy`. Historical v3-v11
rows are preserved without invented names or checksums. An old v12 row imports
the audited v12 identity, retains its original `applied_at`, uses
`legacy-unknown` for its unprovable first application version, and does not
record a second ledger application. The frozen idempotent compatibility checks
for schema structure still run on every startup to preserve LocalStore behavior,
while the frozen snapshot business-data backfill runs only during actual first
v12 application. Earlier real fixtures apply that one-time backfill inside the
same transaction before writing the new row.

```text
P2-3 Authorization: OPEN
P2-3A Implementation: COMPLETE / P2-3A.1 CORRECTION RE-REVIEW PENDING
P2-3A Gate: CLOSED
P2-4 JSON Import Authorization: CLOSED

P2 Merge Gate: CLOSED
Runtime/Cutover Gate: CLOSED
Compose Replacement Gate: CLOSED
Architecture Unification Gate: CLOSED
Optimizer Production Gate: CLOSED
Real Device Control Gate: CLOSED
```

Focused local implementation evidence is provided by
`npm run p2-3a-migration-gate`, covering the real LocalStore migration fixtures
and pure ledger invariants. Full regression evidence and an independent verdict
are required before this checkpoint can be sealed.

Independent remote review of checkpoint
`7d8da7fc0ce06dbfd6d6a6928de712cdc31869d4` returned `REQUEST CHANGES` with
P1 `P2-3A-F01`: rich-v12 restart reran the one-time frozen snapshot backfill.
The P2-3A.1 correction keeps structural repair on restart, confines frozen
business-evidence backfill to actual first v12 application, and adds a raw
`batches.data_json` equality regression. At the correction checkpoint, remote
re-review remained pending; the accepted verdict is recorded separately below.

## 18. P2-3A Final Review Seal

Independent remote re-review accepted implementation checkpoint
`7d8da7fc0ce06dbfd6d6a6928de712cdc31869d4` together with correction
checkpoint `7e4101bebadbce8aed43a1b02a0f7f61f67aebc6`. `P2-3A-F01` is CLOSED and
the P2-3A Gate is OPEN. The QA dispatch remains separately recorded as
`BLOCKED — INFRASTRUCTURE / NO VERDICT`; the remote review PASS does not rewrite
that ledger.

Exact-SHA `agent-safety` run `31659156393` completed successfully for the
correction checkpoint. Its authoritative full-suite count is
`406 passed / 1 skipped / 407 total`; P2-3A Migration passed `35/35`.

```text
P2-3A Implementation: PASS
P2-3A.1 Correction: PASS
P2-3A Independent Remote Review: PASS
P2-3A-F01: CLOSED
P2-3A Gate: OPEN
P2-3A Final Review Seal: PASS

P2-3 overall: IN PROGRESS
P2-4 Authorization: CLOSED
Runtime/Cutover Gate: CLOSED
Compose Replacement Gate: CLOSED
P2 Merge Gate: CLOSED
Architecture Unification Gate: CLOSED
Optimizer Production Gate: CLOSED
Real Device Control Gate: CLOSED
```

## 18.1 P2-3 Final Closure Seal Independent Review

Independent remote review examined Final Closure Seal checkpoint
`2fb45b25f6880f03f563fd472d8143bfed8699b5`, with parent
`c9165b269339cca1c2ec94bd63750d765b836079`. The checkpoint is exactly one
commit ahead, changes exactly the three registered `docs/p2/**` files, and
contains no implementation, runtime, schema, test, fixture, or workflow change.

Exact-SHA [agent-safety run 31680852943](https://github.com/liuzexin086-bit/naibaji-feeding-agent/actions/runs/31680852943)
executed the Seal SHA via `push` and completed with `success`. The full Agent
suite was `413 passed / 1 skipped / 414 total`; P2-1 was `20/20`, P2-2 `9/9`,
P2-3A `35/35`, P2-3B `46/46`, P0 `100/100`, P1 `197/197`, optimizer `12/12`,
and typecheck, build, clean-source, both images, Compose, and runtime
provenance/UI checks all passed.

The independent verdict recorded P0 = 0, P1 = 0, and P2 blocking findings = 0.
It accepted the three historical P1 closure mappings, preserved P2-3A/P2-3B
invariants and F01/F02 history, retained the two distinct local-QA receipts, and
confirmed that the Seal did not self-certify.

```text
P2-3 Closure Contract Review: CLOSED / PASS
P2-3 Final Closure Seal: PASS
P2-3 overall: CLOSED / PASS
P2-4 Legacy JSON Import Authorization: OPEN
```

## 18.2 P2-4 Contract / Execution Plan Registration Candidate

Repository inventory at baseline
`2fb45b25f6880f03f563fd472d8143bfed8699b5` found the JSON Database v1 format
in `backend/src/storage/jsonDatabase.js`: `meta.schemaVersion: 1` plus
`batches`, `dailyRecords`, `weighSamples`, `recommendations`, `approvals`,
`executions`, `sceneStates`, `modelRegistry`, and `auditLogs`. Browser
`localStorage` batch snapshots are a distinct source family. Supabase JSONB,
training/shadow exports, optimizer results, and research synthesis are not
silently treated as JSON Database v1.

No importer, import route, import manifest, durable generic quarantine,
destination-backup flow, or committed JSON Database v1 fixture exists at this
baseline. Existing backend snapshot upsert uses replacement/recomputation
semantics and is not accepted as one-way import. The P2-3B fixture is SQLite,
not JSON.

The docs-only [P2-4 contract](./nbj-arch-p2-4-contract.md) therefore registers
blocking implementation criteria for:

- raw source and owner-manifest SHA-256 identity;
- read-only source handling and preserved IDs/revisions/timestamps;
- collection-by-collection mapped/archive/quarantine disposition;
- deterministic import provenance, same-source replay, duplicates, conflicts,
  and target-collision fail-closed behavior;
- durable raw quarantine and complete field/row traceability;
- content-bearing zero-loss counters and no silent discard;
- transaction, destination backup, isolated restore, and rollback receipts;
- sanitized real JSON v1 fixtures or an independently accepted equivalence
  amendment;
- a dedicated `p2-4-legacy-json-import-gate` and all frozen regression gates.

Independent architecture pre-review returned `PASS` for this registration map.
Independent domain pre-review could not be allocated because of the runtime
agent thread limit and remains `BLOCKED — INFRASTRUCTURE / NO VERDICT`; this
candidate does not claim a domain verdict.

```text
P2-4 Legacy JSON Import Authorization: OPEN
P2-4 Contract Registration: PENDING INDEPENDENT REVIEW
P2-4 Implementation Authorization: CLOSED
P2-4 Implementation: NOT STARTED
P2-4 Gate: CLOSED

Runtime/Cutover Gate: CLOSED
Compose Replacement Gate: CLOSED
P2 Merge Gate: CLOSED
Architecture Unification Gate: CLOSED
Optimizer Production Gate: CLOSED
Real Device Control Gate: CLOSED
```

This registration candidate is docs-only and does not certify itself. No
import implementation, schema, test, fixture, workflow, runtime, PR, merge,
tag, or deployment is included.

At the P2-3A Seal checkpoint, the bound contract had no P2-3B definition. That
Seal did not create or authorize one, complete P2-3 overall, or authorize P2-4.
The later registration below preserves that historical boundary.

## 19. P2-3 Closure Contract Review and P2-3B Registration

After the P2-3A Seal, a closure mapping returned `REQUEST CHANGES` for three
P2-3-level gaps that do not reopen P2-3A:

1. the accepted ledger remains owned under `agent/src/local-db` instead of the
   frozen single Persistence migration authority;
2. a rich-v12 restart with no pending ledger application still permits ad-hoc
   schema DDL through structural repair;
3. generated historical SQLite fixtures do not by themselves satisfy the
   explicitly required sanitized legacy SQLite copy, and no independently
   accepted reconstructed-fixture equivalence amendment exists.

The P2-3B contract registers migration-runner ownership, zero-DDL rich restart,
tamper-before-DDL, immutable sanitized fixture provenance, and complete P2-3A
invariant preservation as blocking acceptance criteria. This registration is
docs-only. It changes no implementation, schema, migration identity, runtime, or
later-stage authority.

```text
Registration baseline: 6e83245aee33a5ec4de76249f4310e550b77dc96

P2-3A Ordered Migration Ledger: CLOSED / PASS
P2-3A Gate: OPEN
P2-3A-F01: CLOSED

P2-3 Closure Contract Review: REQUEST CHANGES
P2-3B Contract: REGISTERED
P2-3B Implementation Authorization: OPEN
P2-3B Implementation: NOT STARTED
P2-3B Gate: CLOSED

P2-3 overall: IN PROGRESS
P2-4 Legacy JSON Import Authorization: CLOSED
Runtime/Cutover Gate: CLOSED
Compose Replacement Gate: CLOSED
P2 Merge Gate: CLOSED
Architecture Unification Gate: CLOSED
Optimizer Production Gate: CLOSED
Real Device Control Gate: CLOSED
```

The registration checkpoint is not implementation evidence and does not review
or certify itself. P2-3B requires a separate implementation checkpoint,
independent review, and exact-SHA CI before any P2-3 closure or P2-4
authorization may change.

## 20. P2-3B Implementation Candidate

Independent review of registration checkpoint
`d8a9208338b792fbcc4e3c0dbb314f9275abf842` returned `PASS WITH
NON-BLOCKING FINDING`. `P2-3B-F01` clarified that registration wording cannot
self-open authorization; authorization became OPEN only from that independent
verdict.

The separately reviewable implementation candidate is documented in
[nbj-arch-p2-3b-implementation.md](./nbj-arch-p2-3b-implementation.md). It moves
schema, structural operations, and migration authority to
`packages/persistence/migrations`, registers
retained repair as forward v13 while preserving the exact sealed v12 checksum,
removes zero-pending startup DDL, instruments the real SQLite authorizer seam,
adds name/checksum tamper-before-DDL proofs, binds a sanitized real legacy v5
fixture to raw main/WAL and output hashes, and adds the dedicated
`p2-3b-migration-ownership-gate`.

At that candidate checkpoint, local evidence recorded `46/46` dedicated-gate
tests and a local `414/414` summary. The authoritative exact-SHA remote count
is recorded below as `413 passed / 1 skipped / 414 total`. P2-1 (`20/20`),
P2-2 (`9/9`), P2-3A (`35/35`),
P0 (`100/100`), P1 (`197/197`), build, clean-source, both Docker targets, and
an in-container migration-package import smoke also passed. This was local
candidate evidence and is superseded by the exact-SHA CI and independent
remote-review receipts below.

The local independent-QA leaf produced no report across two bounded attempts
and was interrupted. That dispatch is `BLOCKED — INFRASTRUCTURE / NO VERDICT`;
the implementation candidate does not claim independent acceptance.

```text
P2-3B Contract Registration: PASS
P2-3B Implementation Authorization: OPEN
P2-3B Implementation: CANDIDATE / INDEPENDENT REVIEW PENDING
P2-3B Gate: CLOSED
P2-3 overall: IN PROGRESS
P2-4 Authorization: CLOSED
```

## 21. P2-3B Correction and Independent Remote Review

Implementation checkpoint `b280f64e821614c74c9a00fb601de385971c3493`
received `REQUEST CHANGES` for `P2-3B-F02`: fixture-backed proofs did not yet
bind complete content-bearing post-migration evidence. Correction checkpoint
`c9165b269339cca1c2ec94bd63750d765b836079`, with parent `b280f64`, changes
only the fixture manifest and two P2-3B test files. It changes no production
implementation or SQLite fixture binary.

The correction binds the complete ledger, normalized schema, business rows,
raw JSON/message payloads, frozen SOP snapshot, device plan, eight free-feeding
slots, and complete daily operation plan. Zero-pending restart and persisted
name/checksum tamper now operate on a temporary copy of the real sanitized
legacy fixture and require zero DDL plus exact preservation of the complete
evidence object.

Independent remote re-review returned `PASS`, closed `P2-3B-F02`, and accepted
P2-3B implementation overall. Exact-SHA
[run 31677062701](https://github.com/liuzexin086-bit/naibaji-feeding-agent/actions/runs/31677062701)
executed `c9165b269339cca1c2ec94bd63750d765b836079` via `push` and completed with
`success`. Its precise full-suite result is `413 passed / 1 skipped / 414
total`, not `414 passed`; all dedicated P2 and legacy gates, builds, images,
Compose config, and runtime provenance/UI checks passed.

The historical local QA dispatch remains `BLOCKED — INFRASTRUCTURE / NO
VERDICT`. The later local QA `PASS` is retained as a separate receipt and does
not rewrite that historical record.

```text
P2-3B Contract Registration: PASS
P2-3B Implementation Authorization: OPEN
P2-3B Implementation: PASS
P2-3B Independent Remote Review: PASS
P2-3B-F02: CLOSED / PASS
P2-3B Gate: OPEN
```

## 22. P2-3 Final Closure Seal Candidate

The docs-only [P2-3 Final Closure Seal Candidate](./nbj-arch-p2-review-3-final.md)
maps each original P2-3 Closure Contract Review blocker to accepted remote
evidence:

1. canonical migration identity, ordering, validation, structural operations,
   and orchestration are owned by `packages/persistence/migrations`;
2. a real-fixture zero-pending restart executes no DDL, and name/checksum
   tamper fails before DDL while preserving complete evidence;
3. the sanitized legacy fixture is provenance-bound and its post-migration
   schema, business, raw-payload, and frozen-plan evidence is exact and
   immutable.

This candidate does not certify its own docs commit. Only its independent
review may close the historical P2-3 Closure Contract Review and P2-3 overall.
P2-4 and every later Gate remain CLOSED.

```text
P2-3 Closure Contract Review: REMEDIATED / FINAL CLOSURE SEAL PENDING
P2-3 Final Closure Seal: PENDING INDEPENDENT REVIEW
P2-3 overall: IN PROGRESS — FINAL CLOSURE SEAL PENDING

P2-4 Authorization: CLOSED
Runtime/Cutover Gate: CLOSED
Compose Replacement Gate: CLOSED
P2 Merge Gate: CLOSED
Architecture Unification Gate: CLOSED
Optimizer Production Gate: CLOSED
Real Device Control Gate: CLOSED
```
