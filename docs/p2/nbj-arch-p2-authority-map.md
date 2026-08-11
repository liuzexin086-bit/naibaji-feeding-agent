# NBJ-ARCH-P2 Authority Map

Status: `REVIEW 0 — CHANGES REQUIRED`

Baseline: `76187e1a3d4c7b83a70fc2aabb0a6fb4a8f05232`

Review candidate/checkpoint: `fead997b78afb2b03c372a957f9fe8c19fd6d4a0`

Checkpoint parent: `76187e1a3d4c7b83a70fc2aabb0a6fb4a8f05232`

Remote branch: `nbj-arch-p2`

## Authority vocabulary

- **Authority**: the only source permitted to define or mutate a production fact.
- **Derived**: reconstructable output that cannot override its authority.
- **Migration source**: read-only legacy input accepted by a one-way importer.
- **Archive**: retained for audit/recovery but not loaded by production runtime.
- **Experimental**: cannot publish production parameters or decisions.

## Production fact ownership

| Fact / domain | Current baseline paths | P2 target authority | Allowed target writer | Legacy / derived disposition | Prohibited target runtime path |
|---|---|---|---|---|---|
| User identity and role | Local SQLite users/sessions; Supabase Auth; legacy UI session state | SQLite identity records behind Agent API auth | Auth Application Service | Supabase identity is migration/archive input only | UI-to-Supabase Auth; direct DB access |
| Batch identity/lifecycle | JSON snapshots; Supabase batches; SQLite batches | Domain `Batch` persisted by SQLite Batch Repository | Batch Application Services | JSON/Supabase are one-way migration sources | UI/Agent direct writes; bidirectional sync |
| Selected feeding mode | Batch/decision fields and compatibility projections | Server-side Batch/Operation mode state in SQLite | Explicit mode-change Application Service | Compatibility projection is read-only | Exception, LLM, UI, or old `effectiveMode` field selecting mode |
| `CreepControlState` | Persisted observations plus derived runtime/decision fields | Server-owned state `{ status, startDay, triggerGrade, policyVersion }` persisted in SQLite | Control Transition Service | Observations are transition inputs, not a substitute for the persisted state | Recomputing `startDay` from the latest observation; UI/Agent/model mutation |
| `RuntimeExecutionState` / runtime latches | Persisted observations plus derived runtime/decision fields | Explicit authoritative observations plus deterministic latch transitions persisted in SQLite | Observation / Runtime State Service | Read projections may derive from the persisted transition result | Treating omitted observation as normal; clearing a latch from another domain; latest-observation recomputation on read |
| Daily record | JSON/Supabase snapshot records; SQLite observation payloads | Explicit Domain daily-record/observation contracts in SQLite | Record Observation service | Legacy records imported with source IDs and quarantine | UI recalculation or silent field loss |
| Observation | Optional fields in SQLite `daily_observations`; legacy snapshot fields | Domain `Observation`, including observed vs not-observed state, in SQLite | Record Observation service | Legacy ambiguity is quarantined or explicitly mapped | Missing value coerced to normal/none |
| Feeding decision | SQLite `feeding_decisions`; Supabase Agent/tool branches; legacy recommendations | Domain `FeedingDecision` in SQLite with frozen model/SOP evidence | Decision Application Service | Legacy decisions are immutable audit/import records | LLM, UI, Supabase, or JSON as decision authority |
| Planned vs active decision | Planned/active/flat compatibility fields | `plannedDecision` and `activeDecision` remain separate; `activeDecision` exists only after an explicit apply transaction in SQLite | Decision/Application services | Any current, active, applied, device-setting, `执行中`, or `今日已应用` field derives only from `activeDecision`; without it the field is `null` or `not_applied` | Falling back from `activeDecision` to `plannedDecision`; treating planned or flat setting as applied authority |
| Daily operation plan | SQLite operation plan/confirmation tables | Domain `DailyOperationPlan` in SQLite | Preview/Confirm Plan services | Existing records migrate without rewriting confirmation history | API handler or Agent direct persistence |
| Operation amendment/override | SQLite amendments/action ledger | Domain `OperationAmendment` / `DeviceOverride` in SQLite | Amendment services with explicit confirmation | Existing digests and history preserved | Rewriting a confirmed base plan |
| Device plan | Decision/operation JSON embedded in SQLite; legacy recommendation execution | Domain `DevicePlan` in SQLite, versioned and separately confirmable | Device Plan services | External device adapter is a consumer only | Agent/LLM direct device write or automatic control |
| Operation result/feedback | SQLite operation result and observation feedback; legacy execution records | Domain `OperationResult` / `Feedback` in SQLite | Record Feedback service | Legacy execution records imported with provenance | Optimizer feedback loop into production parameters |
| Business-day actual/execution total | Immutable observations and execution-state calculations; legacy snapshots | Deterministic business-day execution service over authoritative SQLite events | Record Feedback/Execution services | Cached summaries are derived | Latest zero, client aggregate, or snapshot overwriting history |
| Agent session/message | SQLite local sessions/messages; Supabase message store branch; LangGraph checkpoints | SQLite Agent Repository for durable conversation evidence | Agent Application Service | Checkpoints are operational state, not business authority | Supabase production message writes |
| Audit event | SQLite audit tables; legacy JSON/Supabase logs | Append-only SQLite audit repository | Application Services only | Legacy audit imported or archived, never rewritten | UI/Agent fabricating audit facts |
| UI decision projection | Legacy pages calculate/read mixed fields; new UI reads Agent API | Read-only API projection that keeps applied state separate from preview state | Application query service | Optional preview may use `previewDecision` with `previewSource: "planned"` and `isApplied: false`; view models are disposable | Labeling a preview as current/active/applied; UI feeding arithmetic or old flat fields as authority |
| Feeding Model rules | Root `feeding-model.js`, generated/minified artifact, V5 file, legacy backend wrappers, Python model | `packages/feeding-model` single TypeScript source + schema/version/golden vectors | Reviewed model release process | `dist`/Web/CJS are derived; Python and wrappers are experimental/legacy | Independently edited min/CJS/Python/legacy copies |
| Feeding Model publication identity | Version string plus source/artifact hashes in runtime provenance | Versioned model publication manifest under `packages/feeding-model` | Model release process | Container/Web artifacts cite same source digest | Unversioned model load or digest mismatch |
| SOP business rules/publication | Default TS template/engine; versioned Markdown docs; SQLite templates/publication; Supabase templates | `packages/sop` publication contract; active `published` identity/digest persisted in SQLite | SOP publication Application Service | Chroma index and rendered docs are derived | Draft/latest template used by production decision |
| Knowledge index | Chroma plus SQLite chunk metadata | Published SOP digest in SQLite is authority; Chroma is derived index | SOP indexing service | Rebuild from publication and verify digest | Chroma content overriding SOP publication |
| Decision/SOP/model evidence | Mixed JSON evidence fields in SQLite | Immutable decision evidence in SQLite with publication IDs, versions, and SHA-256 digests | Decision service transaction | Older evidence remains immutable | Reading “latest” version during replay |
| Schema version/migration history | `MIGRATION_VERSION=12`; inline inspection/ALTER logic; minimal ledger | Ordered checksum migration ledger in `packages/persistence/migrations` plus SQLite `schema_migrations` | Migration runner only | Existing version is imported into ledger by an approved baseline migration | Runtime ad-hoc schema repair |
| Legacy import provenance | Not yet a formal authority | SQLite import manifest and quarantine tables/files with source SHA-256 | Legacy Import service | Source files remain read-only | Silent discard or two-way sync |
| Runtime configuration | Encrypted local config, environment, Docker secrets | Dedicated encrypted config + secret mounts, referenced by application version | Authenticated admin/config service and deployment | Not a domain fact; backup separately under secret policy | UI-accessible secrets; secrets in SQLite evidence/logs |
| Backup/restore manifest | Ad-hoc local backup directories; no P2 ledger | Versioned backup manifest beside online SQLite backup | Backup service | Backup is a recovery artifact, not live authority | Treating an unverified copy as live DB |
| LangGraph checkpoint | Separate checkpoint SQLite | Operational checkpoint store, disposable/reconcilable against business authority | Agent runtime only | Never used to reconstruct authoritative decision state | Checkpoint overriding SQLite Domain facts |
| Optimizer candidate | Python files/results | Experimental artifact only; no production authority | Offline experiment workflow | Candidate may be reviewed in a future independent Gate | Runtime import, automatic publish, device output |
| V5-Lite result | Root model and legacy/shadow services | Shadow-only derived telemetry until a future authority Gate | Deterministic shadow service | Retained for parity and observation only | Production decision or device authority |

## Current runtime conflicts that P2 must close

1. Electron starts the JSON backend while its page also reads/writes Supabase and calls the Feeding Agent API.
2. The TypeScript Agent compiles both SQLite and Supabase storage/tool branches.
3. Root smoke CI actively validates the legacy JSON backend, so CI transition must preserve migration fixtures while removing it from production gates.
4. Feeding and SOP facts are spread across source, generated artifacts, wrappers, Markdown, SQLite publications, and legacy services.
5. Schema mutation and repositories are concentrated in `agent/src/local-db/index.ts`, coupling persistence behavior and migration logic.

## Baseline executable and artifact scope registry

This registry classifies the tracked baseline. A classification describes permitted P2 treatment; it does not claim that isolation is already implemented.

| Scope | Baseline paths/artifacts | P2 treatment |
|---|---|---|
| Target-production API/runtime | `agent/src/container/server.ts`, `local-api.ts`, local auth/config, Agent Docker target | Move behind API/Application/Domain boundaries without changing behavior. |
| Target-production domain candidates | `agent/src/decision/`, `agent/src/operations/`, `agent/src/sop/`, typed shared contracts | Extract dependency-free contracts and behavior; do not preserve framework/storage imports. |
| Target-production SQLite path | `agent/src/local-db/schema.ts`, `agent/src/local-db/index.ts` | Split repositories and replace ad-hoc migration logic with checksum ledger. |
| Target-production orchestration | `agent/src/agent/`, LangGraph runtime/tools, provider adapters | Retain only as Application consumer/narration/orchestration; no fact ownership. |
| Target-production Web/admin | `agent/ui/liquid-index.html`, `admin.html`, `admin.js`, Nginx Web target | Migrate to one Web app and API-only clients; remove business calculation/direct storage. |
| Target-derived model artifact | `.generated-models/*.cjs`, generated Web `feeding-model.min.js` | Generate from the single model publication; never edit independently. |
| Target-derived knowledge/runtime | Chroma index, embedding service, LangGraph checkpoint DB | Rebuildable/operational state; cannot override SOP/Decision/SQLite authority. |
| Transitional production source | root `feeding-model.js`, `v5lite-model.js`, `agent/src/model/production-model.ts` | Move feeding source into package; keep V5-Lite shadow-only until separately retired/gated. |
| Legacy executable v1 | `main.js`, root Electron package/build, `backend/src/**`, root `index.html` | Move to `legacy/electron-v1` / `legacy/json-backend-v1`; migration fixture only, no production execution. |
| Legacy Supabase runtime | `supabase-client.js`, `supabase-setup.sql`, `README-SUPABASE.md`, Agent Supabase REST/message/tool/storage branches | Move to `legacy/supabase-v1` or migration tooling; eliminate compiled production branches. |
| Legacy/reference model copies | backend model wrappers, `feeding-model-simple.js`, older model/reference files | Archive or convert to parity fixtures; no independent source authority. |
| Experimental optimizer | `optimizer/**/*.py`, simulation JSON, plots, calibration/search output | Keep EXPERIMENTAL; hash artifacts and prove zero production consumers. |
| Docs-only SOP/history | `docs/feeding-agent-sop-v3.md` through `v6.md`, formula/design/history documents | Retain as references or explicit import sources; not runtime authority unless published and digested. |
| CI/test evidence | `.github/workflows/agent-safety.yml`, root/Agent/Python tests | Evolve from legacy smoke toward P2 layered gates while preserving baseline receipts. |
| Not in baseline | ignored local `web/`, generated directories, backups, releases, local databases | Excluded from P2 baseline; require separate authorization and provenance before use. |

All future executable files and persisted artifacts must enter this registry before they can pass a P2 checkpoint. `unclassified = 0` is a Contract/Final Gate invariant.

At the P1 baseline, `server.ts` explicitly rejects `AGENT_STORAGE_BACKEND=supabase` with `NBJ_SUPABASE_RUNTIME_DISABLED`; however, Supabase adapters, branches, dependencies, and tests remain compiled. P2-5 must remove that dead/transitional production surface rather than merely rely on the startup rejection.

The ignored local `web/` directory is also a nested Git repository and uses D1/Drizzle plus a separate feeding implementation. It remains out of this baseline even if it is runnable locally.

## Target readers

- Web reads API response contracts only.
- API handlers read transport/auth inputs and Application results only.
- Application Services read Domain contracts and Repository interfaces.
- Persistence reads Domain/repository contracts and SQLite rows.
- Agent Runtime reads Application results and verified evidence receipts.
- Device adapters read confirmed Device Plans only and remain disabled until an independent device-control Gate.
- Backup/restore tooling reads SQLite through safe backup APIs or isolated copies; it never becomes a live writer.

## Boundary rules to automate

Target dependency direction:

```text
Web -> API Contracts
API -> Application
Application -> Domain + Repository Contracts
Persistence -> Domain + Repository Contracts
Agent Runtime -> Application + Contracts
Feeding Model -> no UI/API/persistence dependency
SOP -> no UI/LangGraph dependency
```

Required negative checks include:

```text
domain -X-> HTTP / SQLite / LangGraph / React
UI -X-> Supabase / JSON files / SQLite / feeding arithmetic
Agent Runtime -X-> SQL / device I/O / duplicate feeding rules
production runtime -X-> optimizer / legacy
```

## Cutover rule

An old writer is disabled only after the new authority has parity, migration, rollback, and independent review evidence. An old reader is removed only after all consumers use the new API. No target row in this map is considered implemented merely because this contract names it.
