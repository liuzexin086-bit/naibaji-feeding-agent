# NBJ-ARCH-P2 Evidence Manifest

Status: `REVIEW 0 PASS — checkpoint uncommitted`

Captured: 2026-08-11

Hash semantics: lowercase SHA-256 of Git blob bytes unless stated otherwise.

## 1. Immutable Git baseline

| Item | Value | Evidence method |
|---|---|---|
| Main merge commit | `76187e1a3d4c7b83a70fc2aabb0a6fb4a8f05232` | `git rev-parse 'HEAD^{commit}'` before branch creation |
| Merge parents | `413a4c0012711ae3aaa3023f68f3c665b2f5cfad`, `8fc677826169ba8a7b9888dd4c298435a6aeeaab` | `git log -1 --format=%P` |
| Reviewed feature head | `8fc677826169ba8a7b9888dd4c298435a6aeeaab` | PR #1 / merge parent |
| Git tree | `fb345a916960a18e41fd4f93bd2f30cb182726e6` | `git rev-parse 'HEAD^{tree}'` |
| P1 annotated tag | `nbj-execution-contract-p1-baseline-20260811` | Tag peels to the same commit/tree |
| Annotated tag object | `0777f9b0d199ffa962796e4a234ec5ee11d3d452` (`tag`) | `git rev-parse <tag>` plus `git cat-file -t` |
| P2 working branch | local `nbj-arch-p2` from `76187e1` | Branch created only after commit/tree equality check |
| Post-merge CI | run `31465609647`, `workflow_dispatch`, main, success | `gh run view 31465609647` |

The ignored `.planning/` directory and ignored local `web/` directory are not in this Git tree and are not P2 baseline artifacts.

P2-0 worktree policy permits only the four `docs/p2/` evidence documents before checkpoint review. At capture time there were no staged files and no runtime, schema, CI, lock, UI, model, or data changes.

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
| Main pushes do not match the workflow's current branch filter | Non-blocking carryover | P2 CI must cover target main/P2 branches before closure. |
| Root CI smoke validates the legacy JSON backend | Architecture debt | Convert to migration/legacy fixture coverage before production-path removal. |
| Supabase remains a compiled Agent backend and direct legacy UI path | Architecture debt | P2-5/P2-11 removal Gate. |
| Migration ledger lacks checksum/name/application version | Architecture debt | P2-3 blocking acceptance item. |
| Active production DB and active published SOP are environment data, not committed fixtures | Evidence gap | Capture sanitized, hashed fixtures before migration implementation. |
| No registry-published immutable Docker digest exists for the ephemeral P1 images | Evidence limitation | Rebuild from baseline and prove runtime provenance; do not claim pullability. |
| `P2-F-001`: chat observation normalization drops explicit diarrhea `none` | P1 / P2 Merge blocker | `server.ts` emits no `diarrheaGrade` for `none`; the chat tool therefore cannot close an earlier event from current chat context. Resolve through `P2-ED-001` or remove chat observation authority, then add endpoint regression coverage. |
| Actual operator deployment path and live authority are not repository-verifiable | Evidence gap | P1 Docker is the reviewed canonical contract, but Electron/legacy UI and an ignored nested D1 repository exist locally. Capture deployment inventory and read-only data-source snapshots before migration. |
| Electron passes `?api=` to root `index.html`, but no consumer was found in that file | Legacy integration ambiguity | Treat the handoff as legacy/unresolved; do not infer that JSON backend and legacy UI are correctly integrated. |

## 7. Evidence reproduction rules

- Git artifact hashes must use committed blob bytes, not a CRLF-transformed Windows worktree.
- Runtime provenance must bind commit, schema, decision policy, source hashes, generated artifact hashes, and UI hash.
- Database/SOP evidence must be captured from a read-only copy and include source SHA-256; secrets must never enter this manifest.
- Generated files and ignored local workspaces are evidence only when recreated from the committed baseline by a documented command.
- Every later P2 checkpoint appends evidence; it does not overwrite this baseline section.

## 8. Supplemental P2-0 audit receipt

An independent read-only prerequisite audit ran:

- Python optimizer unittest: 12/12 PASS under local Python `3.10.9`.
- Targeted Agent suites (`observation-feedback`, `amendments`, `langgraph-runtime`): 56/56 PASS under local Node `24.16.0`.

The targeted Node receipt is supplemental because it was not run under the frozen Node `24.18.0`; the exact-version remote P1 receipt remains run `31465609647`. The audit found `P2-F-001` by source-path review despite the existing suites being green, demonstrating the need for a new chat-endpoint regression.
