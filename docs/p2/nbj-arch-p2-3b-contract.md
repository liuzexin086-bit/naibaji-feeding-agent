# NBJ-ARCH-P2 P2-3B Migration Runner Ownership & Legacy Fixture Closure

Status: `CONTRACT REGISTERED — IMPLEMENTATION AUTHORIZATION OPEN`

Registration baseline: `6e83245aee33a5ec4de76249f4310e550b77dc96`

P2-3A Ordered Migration Ledger: `CLOSED / PASS`

P2-3 overall: `IN PROGRESS`

P2-4 Legacy JSON Import Authorization: `CLOSED`

## 1. Objective

P2-3B closes the remaining P2-3 ownership, execution, and compatibility-evidence
gaps without changing the accepted P2-3A ledger semantics. It must establish one
Persistence-owned migration authority, ensure that schema DDL occurs only while
applying an identified registered migration, and prove compatibility with an
immutable sanitized legacy SQLite source fixture or an independently accepted
contract amendment.

This registration authorizes a later implementation checkpoint. It does not
implement P2-3B, close P2-3, or open P2-4.

## 2. Migration authority closure

The default target remains the frozen Authority Map contract:

```text
packages/persistence/migrations
→ owns migration definitions, identity, ordering, validation, and orchestration

Migration runner only
→ is the sole writer of schema version and migration history

local-db
→ may provide the SQLite connection/adapter and transactional execution seam
→ must not own migration identity, registry policy, or migration orchestration
```

The implementation must prove that there is one migration registry and one
orchestrator. No compatibility wrapper, runtime startup hook, repository, or
adapter may maintain a second list of versions, names, checksums, or migration
operations.

If dependency analysis shows that the literal `packages/persistence/migrations`
path would create dual authority or violate the frozen dependency direction, the
implementation must stop. A separately reviewed contract amendment must then
name the replacement authority and prove that it remains singular. The
implementer cannot amend this target implicitly or declare the current
`local-db` ownership equivalent.

## 3. No ad-hoc schema mutation

For a rich database that has applied the complete registered migration chain:

```text
pending migrations = 0
→ schema DDL count = 0
```

When no migration is pending, startup/restart must not execute `CREATE TABLE`,
`CREATE INDEX`, `DROP`, `ALTER TABLE`, schema rebuilds, or conditional structural
repair, including `IF NOT EXISTS` variants. All retained structural repair must:

- have a migration version, immutable name, and checksum;
- be represented in the canonical migration body;
- execute only while that registered migration is actually pending;
- write its ledger row in the same transaction as its schema/data effects;
- fail and roll back atomically on any validation or execution error.

The accepted v12 migration identity, canonical body, name, and checksum are
immutable. Retained compatibility repair must therefore move to one or more new
forward migration identities; it must not edit, replay, alias, or silently
reinterpret v12. A new identity may encode only the already frozen compatibility
structure/repair behavior needed to preserve supported databases. It may not
introduce new business rules or unrelated schema.

P2-3B must not satisfy this rule by deleting compatibility repair without
replacement evidence. Fresh, N-1, and supported historical databases must still
reach the accepted schema and retain their frozen business data and evidence.

## 4. Required DDL and tamper proofs

Tests must compute deterministic digests from normalized SQLite evidence. The
schema digest must include the ordered relevant `sqlite_schema` fields and
normalize only representation that SQLite may vary without semantic change. The
business digest must cover the frozen rows used by the fixture and preserve raw
payload bytes where serialization is contractually significant.

### 4.1 Zero-DDL rich restart

```text
apply all registered migrations
→ capture ledger rows, normalized schema digest, and business digest
→ start/migrate the same database again
→ pending migrations = 0
→ ledger before == ledger after
→ schema digest before == schema digest after
→ business digest before == business digest after
→ observed schema DDL count = 0
```

Digest equality alone is insufficient for the final assertion: the test must
instrument the migration/startup seam or SQLite connection so an executed schema
DDL statement fails the zero-DDL check even if its final schema is unchanged.

### 4.2 Tamper before DDL

For both persisted checksum tampering and persisted name tampering:

```text
tamper an applied ledger identity
→ capture normalized schema and business digests
→ migrate()
→ fail closed before any migration/startup schema mutation
→ schema digest unchanged
→ business digest unchanged
→ observed schema DDL count = 0
→ no pending migration is applied and no ledger row is changed
```

This proof extends P2-3A's callback non-execution evidence to every possible
startup structural-mutation path.

## 5. Sanitized legacy SQLite evidence

The preferred evidence is an immutable sanitized copy of a real legacy SQLite
database. The committed fixture set must include:

- the source fixture as a non-secret, non-production-writable test artifact;
- lowercase SHA-256 over the raw committed fixture bytes;
- an origin statement naming the source application/schema version or observed
  schema state without exposing operator, farm, credential, or device secrets;
- a sanitization record listing removed, replaced, redacted, and retained field
  classes and proving that IDs/relations required for migration remain coherent;
- a fixture manifest binding source SHA-256, byte size, SQLite/schema version,
  table/index inventory, expected migration start version, and expected outcome;
- a test that verifies the manifest hash before opening the fixture;
- copy-to-temporary-directory execution, with the committed source opened only
  for verification and never mutated in place;
- post-migration integrity, ledger, schema, row-count, relationship, digest, and
  frozen-evidence assertions.

The fixture and manifest must contain no secrets, personal data, live endpoints,
tokens, credentials, or device-control authority.

If a real sanitized copy cannot be provided, implementation must stop before
claiming compatibility closure. A separate independent contract amendment must
define the reconstructed fixture's provenance, construction recipe, schema
fidelity, data-shape coverage, known limitations, deterministic hash, and why it
is accepted as equivalent. The implementer may not self-approve equivalence.

## 6. Frozen P2-3A invariants

P2-3B must preserve all independently accepted P2-3A behavior:

- ledger columns remain `version`, `name`, `checksum`, `application_version`,
  and `applied_at`;
- versions remain positive, unique, and strictly ordered;
- applied rows remain an exact registered prefix;
- applied name/checksum drift fails closed before later migration or DDL;
- historical two-column rows remain losslessly preserved in
  `schema_migrations_legacy` without invented v3-v11 identities;
- imported legacy v12 retains its original `applied_at` and uses
  `legacy-unknown` for the unprovable first application version;
- first-v12 frozen snapshot backfill executes exactly once, only when v12 is
  actually first applied;
- rich-v12 restart does not reconstruct or reserialize frozen business evidence;
- `application_version` remains first-applier audit identity and `applied_at`
  remains audit metadata outside migration identity;
- migration validation, effects, and ledger insertion remain atomic.
- the accepted v12 name, canonical body, and checksum remain byte-for-byte
  identity-equivalent to the sealed P2-3A definition.

Any required change to those invariants is a stop condition and requires a new
reviewed contract amendment; it is not authorized by P2-3B.

## 7. Scope and file boundary

Implementation may touch only the minimum migration-authority package, SQLite
adapter/connection seam, architecture and migration tests, sanitized fixture and
manifest, necessary package/CI gates, and `docs/p2/**` evidence.

P2-3B does not authorize:

- JSON or Supabase import;
- Application, API, UI, LangGraph, Agent, or runtime cutover;
- Compose replacement;
- Feeding Model or SOP business-rule changes;
- schema changes unrelated to registering the existing audited repair path;
- optimizer production or real device control;
- merge, tag, PR, deployment, P2-4 implementation, or P2 Final Closure.

## 8. Required verification and review

The implementation checkpoint must add a dedicated P2-3B gate and run:

```text
npm run check
npm run p2-1-domain-gate
npm run p2-2-persistence-gate
npm run p2-3a-migration-gate
npm run p2-3b-migration-ownership-gate
npm test
npm run p0-release-gate
npm run p1-safety-gate
npm run build
git diff --check
```

Independent review must verify ownership singularity, absence of ad-hoc DDL,
both hard proofs, fixture provenance/sanitization/immutability, full preservation
of P2-3A invariants, no business/schema-version drift beyond registered repair,
and no work from an unauthorized later stage.

## 9. Registered state

```text
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

Opening implementation authorization permits only an independently reviewable
P2-3B candidate. It does not assert implementation quality, open the P2-3B Gate,
close P2-3 overall, or authorize P2-4.
