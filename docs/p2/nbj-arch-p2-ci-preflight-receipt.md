# NBJ-ARCH-P2 CI Preflight Receipt

Status: `PASS — P2-001 CLOSED`

Workflow commit: `7912b1721a11e441a741e7bdcd4e7ebf367f1a76`

Workflow commit parent: `c5365fdb8007681a551415edeea7d21326c3485f`

Remote branch: `nbj-arch-p2`

Workflow: `.github/workflows/agent-safety.yml`

Evidence date: 2026-08-12

## Scope and identity

The preflight commit changes only `.github/workflows/agent-safety.yml`. It adds CI trigger coverage for pushes to `main` and `nbj-arch-p2` and for pull requests targeting `main`; it retains `workflow_dispatch`. It contains no Domain, runtime, schema, persistence, migration, model, UI, database, or business-rule change.

## Remote execution evidence

| Field | Evidence |
|---|---|
| Run | [`31550812177`](https://github.com/liuzexin086-bit/naibaji-feeding-agent/actions/runs/31550812177) |
| Event | `push` |
| Head branch | `nbj-arch-p2` |
| Head SHA | `7912b1721a11e441a741e7bdcd4e7ebf367f1a76` |
| Workflow | `agent-safety` |
| Job | `safety` |
| Conclusion | `success` |

The successful job covered the root smoke test, Python optimizer tests, Agent typecheck and full tests, P0 release gate, P1 safety gate, Agent build, clean-source gate, Agent/Web image builds, Compose config, and runtime provenance/UI E2E.

## Gate decision

```text
P2-001: CLOSED — CI PREFLIGHT PASS
P2-1 CI Preflight: PASS
P2-1 Domain Implementation Authorization: OPEN

P2-PRE-03: BLOCKED
P2-F-001: OPEN BLOCKER
P2-ED-001: REGISTERED / IMPLEMENTATION PENDING

P2 Runtime/Cutover Gate: CLOSED
P2 Compose Replacement Gate: CLOSED
P2 Merge Gate: CLOSED
Architecture Unification Gate: CLOSED
Optimizer Production Gate: CLOSED
Real Device Control Gate: CLOSED
```

This receipt closes only the CI preflight blocker and authorizes the P2-1 Domain stage under the accepted architecture contract. It does not authorize later persistence, migration, application, Agent, UI, runtime/cutover, Compose replacement, merge, deployment, tagging, optimizer production, or real device control stages.
