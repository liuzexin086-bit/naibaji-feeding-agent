# NBJ-ARCH-P2 Review 0 Receipt

Status: `REQUEST CHANGES`

Reviewed checkpoint: `fead997b78afb2b03c372a957f9fe8c19fd6d4a0`

Baseline / checkpoint parent: `76187e1a3d4c7b83a70fc2aabb0a6fb4a8f05232`

Remote branch: `nbj-arch-p2`

Review date: 2026-08-11

## Scope reviewed

Review 0 examined only the four P2-0 contract documents committed at `fead997b78afb2b03c372a957f9fe8c19fd6d4a0`. It did not authorize or review P2-1 implementation, runtime behavior, CI changes, model changes, database schema changes, merge, deployment, or tagging.

## Findings

| Finding | Severity | Review result | Required correction |
|---|---|---|---|
| `P1-001` checkpoint identity contradiction | P1 | The four documents call an already committed and pushed checkpoint “uncommitted.” | Remove the claim and bind the reviewed checkpoint, parent baseline, and remote branch. |
| `P1-002` Review 0 self-attestation | P1 | The implementation checkpoint declares its own Review 0 PASS and opens its own Contract Gate. | Record this independent `REQUEST CHANGES` receipt; keep the Contract Gate and P2-1 authorization CLOSED until a later review accepts a corrected checkpoint. |
| `P1-003` planned/active projection ambiguity | P1 | Falling back from an absent active decision to the planned decision permits planned data to appear applied. | Keep planned and active decisions separate. Applied/current/device semantics derive only from `activeDecision`; optional planned preview must be explicitly non-applied. |
| `P1-004` control/runtime authority conflation | P1 | Creep-control state and runtime execution latches share one broad authority row. | Split persisted `CreepControlState` from observation-driven `RuntimeExecutionState` / latches and state each writer and forbidden transition. |
| `P2-001` P2 branch CI push coverage | P2 | The current workflow has no push run for `nbj-arch-p2`. | Non-blocking for docs-only P2-0.1, but before any P2-1 runtime or Domain change CI must cover pushes to `main` and `nbj-arch-p2`, plus pull requests targeting `main`. |
| `P2-002` hash wording precision | P2 | “Git blob bytes” can be confused with a Git object representation or object ID. | Define hashes as lowercase SHA-256 over raw committed file content returned by `git show <ref>:<path>` and state that they are not Git object IDs. |

## Verdict and Gates

```text
P2-0 Review 0: REQUEST CHANGES
P2-0 Contract Gate: CLOSED
P2-1 Structural Implementation Authorization: CLOSED
P2 Runtime/Cutover Gate: CLOSED
P2 Merge Gate: CLOSED
Architecture Unification Gate: CLOSED
```

P2-0.1 is authorized only to correct these documentation findings. It cannot self-certify a PASS. A later independent review must evaluate the corrected checkpoint before either the P2-0 Contract Gate or P2-1 authorization can open.
