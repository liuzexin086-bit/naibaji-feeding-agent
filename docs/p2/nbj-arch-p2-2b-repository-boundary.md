# P2-2B Repository Boundary

Status: `IMPLEMENTATION EVIDENCE — REVIEW PENDING`

Baseline: `b4b1921858aac464ce1382594cd1825a37bf780c`

Scope: repository extraction only. Runtime/cutover, Application, Agent,
UI, LangGraph, schema/migration, JSON/Supabase migration, model/SOP,
Compose, P2-3, merge, deployment, and device-control gates remain closed.

## Ownership boundary

The observation persistence path has three intentionally separate layers:

1. **Domain-owned observation** — `Observation` fields and their tagged
   presence semantics (`not_observed` versus observed values). Domain parsing
   validates only this projection.
2. **Persistence envelope** — `ObservationStoreRow`,
   `ObservationStoreInput`, and `ObservationEnvelope` retain row identity,
   timestamps, revision/idempotency fields, and the complete JSON `raw`
   payload. These contracts are owned by `src/persistence` and do not import
   the legacy `shared/local-store-contract.ts` types.
3. **Legacy/UI/runtime metadata** — unknown keys in `raw` are retained as
   opaque metadata. They are not promoted into `Observation`, calculated by
   the repository, or silently discarded.

## Collision and round-trip policy

`domainObservationToLegacyPayload(observation, raw)` is an overlay codec, not
a full-payload replacement:

- it deep-clones the supplied raw payload;
- Domain-owned keys are authoritative on collision;
- an observed Domain presence writes its value;
- a `not_observed` presence removes that Domain-owned key (omission remains
  distinct from explicit `none`);
- `actualPowderGrams` preserves explicit `null` versus numeric zero;
- optional Domain `id` and `recordedAt` are written only when present;
- all unknown metadata remains in the cloned payload.

On append, close, and reopen, the repository returns both the validated
Domain projection and the full persisted `raw` payload. If an owned value is
invalid, list returns a quarantine entry carrying the untouched raw payload
and the stable `PERSISTENCE_OBSERVATION_INVALID` reason. This checkpoint does
not claim that the new codec replaces every legacy payload consumer; it only
establishes the lossless boundary required before a later authorized cutover.

## Findings closed by this checkpoint

- `P2-2-F01`: persistence-owned input/row/envelope contracts replace the
  legacy type dependency; `asObservationStorePort` is the minimal translation
  seam over the unchanged `LocalStore` API.
- `P2-2-F02`: the architecture test recursively scans every `.ts` below
  `src/persistence`, deterministically and without following symlinks, and
  proves nested forbidden-import detection with a temporary fixture.
- `P2-2-F03`: Domain, envelope, and opaque metadata ownership plus the
  collision policy are explicit and covered by codec and close/reopen tests.

No runtime path is cut over by this document.
