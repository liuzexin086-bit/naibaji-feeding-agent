import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalStore,
  LocalStoreError,
  type LocalStore,
} from "../../src/local-db/index.js";
import { digestFrozenSopSnapshot } from "../../src/decision/batch-decision-service.js";
import { DECISION_POLICY_VERSION } from "../../src/shared/agent-v2-contract.js";
import { loadFrozenBatchDecisionContext } from "../../src/decision/batch-decision-service.js";
import type { FeedingDecision } from "../../src/shared/agent-v2-contract.js";
import {
  AGENT_APPLICATION_VERSION,
  LEGACY_APPLICATION_VERSION,
} from "../../src/local-db/migration-ledger.js";

const cleanupDirectories: string[] = [];

afterEach(() => {
  for (const directory of cleanupDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function memoryStore(): LocalStore {
  const store = createLocalStore({ filename: ":memory:" });
  store.migrate();
  return store;
}

function fileStore(): { directory: string; filename: string; store: LocalStore } {
  const directory = mkdtempSync(join(tmpdir(), "naibaji-local-db-"));
  cleanupDirectories.push(directory);
  const filename = join(directory, "agent.sqlite");
  const store = createLocalStore({ filename });
  store.migrate();
  return { directory, filename, store };
}

function replaceWithLegacyMigrationLedger(
  database: DatabaseSync,
  version: number,
  appliedAt: string,
): void {
  database.exec(`
    DROP TABLE IF EXISTS schema_migrations_legacy;
    DROP TABLE schema_migrations;
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  database.prepare(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  ).run(version, appliedAt);
}

function decision(
  batchId: string,
  revision: number,
  overrides: Partial<FeedingDecision> = {},
): FeedingDecision {
  return {
    revision,
    batchId,
    dateLocal: "2026-07-31",
    setting: {
      mode: "timed_quantity",
      dayAge: 3,
      dailyPowderGrams: 600,
      singlePowderGrams: 50,
      mealCount: 12,
      timedMeals: [{ timeLocal: "08:00", powderGrams: 50 }],
      freeWindows: [],
      precisionGrams: 1,
      source: "sop_direct",
    },
    risk: {
      level: "normal",
      score: 0,
      overCurveRatio: 1,
      reasons: ["within curve"],
    },
    evidence: {
      sopVersion: "sop@2026-07-31",
      modelVersion: "production@2",
      calculationDate: "2026-07-31",
      reasons: ["SOP direct total"],
      inputs: { nested: { headCount: 20 }, suspicious: "'; DROP TABLE users; --" },
      steps: [{ name: "authority", value: { source: "sop_direct" }, explanation: "SOP wins" }],
    },
    status: "active",
    ...overrides,
  };
}

function dailyOperations() {
  return [{
    code: "daily_patrol",
    title: "日常巡栏",
    dueWindow: { startLocal: "09:00", endLocal: "10:00" },
    sopSection: "SOP.日常巡栏",
    requiredObservationFields: ["diarrheaGrade"],
    safetyNotes: ["异常按 SOP 升级。"],
  }];
}

function dailyOperationsSha256(operations: ReturnType<typeof dailyOperations>): string {
  return createHash("sha256")
    .update(JSON.stringify(operations).normalize("NFC"), "utf8")
    .digest("hex")
    .toUpperCase();
}

describe("SQLite local store", () => {
  it("applies the migration idempotently with all required tables and indexes", () => {
    const { filename, store } = fileStore();
    store.migrate();
    store.close();

    const database = new DatabaseSync(filename, { readOnly: true });
    const tables = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
    `).all().map((row) => String(row.name));
    expect(tables).toEqual(expect.arrayContaining([
      "users",
      "batches",
      "daily_observations",
      "daily_operation_plans",
      "daily_operation_confirmations",
      "daily_operation_amendments",
      "daily_operation_amendment_actions",
      "feeding_decisions",
      "agent_sessions",
      "agent_messages",
      "audit_events",
    ]));
    expect(database.prepare("SELECT count(*) AS count FROM schema_migrations").get()?.count).toBe(4);
    expect(database.prepare("PRAGMA table_info(schema_migrations)").all()
      .map((row) => String(row.name))).toEqual([
        "version",
        "name",
        "checksum",
        "application_version",
        "applied_at",
      ]);
    expect(database.prepare(`
      SELECT version, name, checksum, application_version
      FROM schema_migrations ORDER BY version
    `).all()).toMatchObject([
      {
        version: 12,
        name: "audited-schema-v12-baseline",
        application_version: AGENT_APPLICATION_VERSION,
      },
      {
        version: 13,
        name: "registered-schema-v13-repair",
        application_version: AGENT_APPLICATION_VERSION,
      },
      {
        version: 14,
        name: "registered-schema-v14-import",
        application_version: AGENT_APPLICATION_VERSION,
      },
      {
        version: 15,
        name: "registered-schema-v15-import-evidence",
        application_version: AGENT_APPLICATION_VERSION,
      },
    ]);
    expect(String(database.prepare(
      "SELECT checksum FROM schema_migrations WHERE version = 12",
    ).get()?.checksum)).toMatch(/^[A-F0-9]{64}$/);
    expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    const indexes = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
    `).all().map((row) => String(row.name));
    expect(indexes).toEqual(expect.arrayContaining([
      "batches_user_revision_idx",
      "daily_observations_batch_date_revision_idx",
      "daily_operation_plans_batch_business_date_idx",
      "daily_operation_confirmations_plan_idx",
      "daily_operation_amendments_batch_date_idx",
      "daily_operation_amendment_actions_amendment_idx",
      "feeding_decisions_batch_date_revision_idx",
      "agent_messages_session_batch_idx",
    ]));
    database.close();
  });

  it("imports a legacy v12 ledger without changing data or its audit timestamp", () => {
    const { filename, store } = fileStore();
    store.createBatch({
      userId: "user-a",
      batchId: "legacy-v12-batch",
      revision: 4,
      currentDay: 2,
      data: { preserved: true },
    });
    store.close();

    const legacy = new DatabaseSync(filename);
    replaceWithLegacyMigrationLedger(legacy, 12, "2026-08-08T00:00:00.000Z");
    legacy.close();

    const upgraded = createLocalStore({ filename });
    upgraded.migrate();
    expect(upgraded.getBatch("user-a", "legacy-v12-batch")).toMatchObject({
      revision: 4,
      currentDay: 2,
      data: { preserved: true },
    });
    upgraded.close();

    const database = new DatabaseSync(filename, { readOnly: true });
    expect(database.prepare("SELECT * FROM schema_migrations_legacy").all())
      .toEqual([{ version: 12, applied_at: "2026-08-08T00:00:00.000Z" }]);
    expect(database.prepare(`
      SELECT version, application_version, applied_at FROM schema_migrations
    `).get()).toEqual({
      version: 12,
      application_version: LEGACY_APPLICATION_VERSION,
      applied_at: "2026-08-08T00:00:00.000Z",
    });
    expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    database.close();
  });

  it("keeps the frozen idempotent repair behavior after rich v12 is recorded", () => {
    const { filename, store } = fileStore();
    store.close();

    const damaged = new DatabaseSync(filename);
    // removing the v13-v15 ledger rows makes [12] an exact registered
    // prefix again, so the retained v13 repair re-applies on restart
    damaged.exec("DELETE FROM schema_migrations WHERE version IN (13, 14, 15);");
    damaged.exec("ALTER TABLE users DROP COLUMN password_salt;");
    damaged.close();

    const repaired = createLocalStore({ filename });
    repaired.migrate();
    repaired.close();

    const database = new DatabaseSync(filename, { readOnly: true });
    expect(database.prepare("PRAGMA table_info(users)").all()
      .map((row) => String(row.name))).toContain("password_salt");
    expect(database.prepare("SELECT count(*) AS count FROM schema_migrations").get()?.count)
      .toBe(4);
    database.close();
  });

  it("does not reconstruct frozen batch evidence on a rich-v12 restart", () => {
    const { filename, store } = fileStore();
    const frozenData = {
      config: {
        sopTemplate: {
          templateId: "frozen-sop",
          version: "2026.08.13",
          sourceSha256: "A".repeat(64),
          collectionRevision: "frozen:1",
          parserVersion: "sop-parser@1",
          embeddingModel: "bge-m3",
          config: { freeFeedingWindows: [{ startLocal: "09:00", endLocal: "18:00" }] },
          snapshotSha256: "B".repeat(64),
        },
        devicePlanSnapshot: {
          version: "device-plan@frozen",
          firstDay: {
            mode: "timed_quantity",
            mealTimes: ["17:00", "20:00", "23:00", "02:00", "05:00", "08:00"],
          },
          templates: {
            timed_quantity: {
              mealTimes: ["09:00"],
              excludedMealTimes: [],
              precisionGrams: 1,
              reductionPriority: ["09:00"],
            },
            free_feeding: {
              windows: [{ startLocal: "00:00", endLocal: "23:59" }],
              slots: [],
              stageConditions: {},
              exceptionBlockers: [],
            },
          },
          sha256: "C".repeat(64),
        },
      },
      records: [],
    };
    store.createBatch({
      userId: "user-a",
      batchId: "damaged-frozen-evidence",
      revision: 1,
      currentDay: 1,
      data: frozenData,
    });
    store.close();

    const damaged = structuredClone(frozenData);
    delete (damaged.config.sopTemplate as Partial<typeof damaged.config.sopTemplate>)
      .snapshotSha256;
    delete (damaged.config.devicePlanSnapshot.templates.free_feeding as Partial<
      typeof damaged.config.devicePlanSnapshot.templates.free_feeding
    >).slots;
    const damagedJson = JSON.stringify(damaged);
    const database = new DatabaseSync(filename);
    database.prepare(
      "UPDATE batches SET data_json = ? WHERE user_id = ? AND id = ?",
    ).run(damagedJson, "user-a", "damaged-frozen-evidence");
    database.close();

    const restarted = createLocalStore({ filename });
    restarted.migrate();
    restarted.close();

    const checked = new DatabaseSync(filename, { readOnly: true });
    const restartedJson = checked.prepare(
      "SELECT data_json FROM batches WHERE user_id = ? AND id = ?",
    ).get("user-a", "damaged-frozen-evidence")?.data_json;
    checked.close();
    expect(restartedJson).toBe(damagedJson);
  });

  it("backfills a missing frozen SOP digest once for legacy batches without changing their revision", () => {
    const { filename, store } = fileStore();
    const sopSnapshot = {
      templateId: "legacy-sop",
      version: "2026.08.04",
      sourceSha256: "A".repeat(64),
      collectionRevision: "legacy:1",
      parserVersion: "sop-parser@1",
      embeddingModel: "bge-m3",
      config: { freeFeedingWindows: [{ startLocal: "09:00", endLocal: "18:00" }] },
    };
    const legacyDevicePlan = {
      version: "device-plan@legacy",
      firstDay: { mode: "timed_quantity", mealTimes: ["17:00", "20:00", "23:00", "02:00", "05:00", "08:00"] },
      templates: {
        timed_quantity: { mealTimes: ["09:00"], excludedMealTimes: [], precisionGrams: 1, reductionPriority: ["09:00"] },
        free_feeding: {
          windows: [{ startLocal: "00:00", endLocal: "23:59" }],
          stageConditions: {},
          exceptionBlockers: [],
        },
      },
    };
    const legacyDeviceDigest = createHash("sha256")
      .update(JSON.stringify(legacyDevicePlan).normalize("NFC"), "utf8")
      .digest("hex").toUpperCase();
    const legacyConfig = {
      startAge: 3,
      endAge: 12,
      effectiveHeads: 20,
      startWeight: 1.5,
      planStartDate: "2026-08-04",
      controlStartDay: -1,
      selectedMode: "free_feeding",
      sopTemplate: sopSnapshot,
      devicePlanSnapshot: { ...legacyDevicePlan, sha256: legacyDeviceDigest },
    };
    store.createBatch({
      userId: "user-a",
      batchId: "legacy-batch",
      revision: 7,
      currentDay: 2,
      data: { config: legacyConfig, records: [] },
    });
    store.close();

    const legacy = new DatabaseSync(filename);
    legacy.prepare("UPDATE batches SET data_json = ? WHERE user_id = ? AND id = ?").run(
      JSON.stringify({ config: legacyConfig, records: [] }),
      "user-a",
      "legacy-batch",
    );
    replaceWithLegacyMigrationLedger(legacy, 3, "2026-08-04T00:00:00.000Z");
    legacy.close();

    const upgraded = createLocalStore({ filename });
    upgraded.migrate();
    const batch = upgraded.getBatch("user-a", "legacy-batch")!;
    const frozen = ((batch.data.config as Record<string, unknown>).sopTemplate as Record<string, unknown>);
    const devicePlan = ((batch.data.config as Record<string, unknown>).devicePlanSnapshot as Record<string, unknown>);
    expect(batch).toMatchObject({ revision: 7, currentDay: 2 });
    expect(frozen.snapshotSha256).toBe(digestFrozenSopSnapshot(sopSnapshot));
    expect(((devicePlan.templates as Record<string, unknown>).free_feeding as Record<string, unknown>).slots)
      .toHaveLength(8);
    expect(loadFrozenBatchDecisionContext({
      batchId: batch.batchId,
      revision: batch.revision,
      currentDayIndex: batch.currentDay,
      config: batch.data.config as Record<string, unknown>,
      records: batch.data.records as Record<string, unknown>[],
    }).devicePlan.templates.free_feeding.windows).toEqual([{ startLocal: "00:00", endLocal: "23:59" }]);
    upgraded.close();
  });

  it("migrates schema version 7 to 10 while preserving business data counts", () => {
    const { filename, store } = fileStore();
    store.createBatch({
      userId: "user-a",
      batchId: "batch-v7",
      revision: 4,
      currentDay: 1,
      data: { config: {}, records: [] },
    });
    const operations = dailyOperations();
    const plan = store.ensureDailyOperationPlan({
      userId: "user-a",
      batchId: "batch-v7",
      businessDate: "2026-08-06",
      basedOnBatchRevision: 4,
      sopTemplateId: "sop-v7",
      sopSourceSha256: "A".repeat(64),
      devicePlanVersion: "device-v7",
      devicePlanSha256: "B".repeat(64),
      selectedMode: "timed_quantity",
      effectiveMode: "timed_quantity",
      operations,
      operationsSha256: dailyOperationsSha256(operations),
    });
    store.confirmDailyOperationPlan({
      userId: "user-a",
      batchId: "batch-v7",
      businessDate: plan.businessDate,
      planId: plan.id,
      operationsSha256: plan.operationsSha256,
      confirmedBy: "user-a",
      idempotencyKey: "confirm-v7-base",
    });
    store.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      DROP TABLE daily_operation_amendments;
    `);
    replaceWithLegacyMigrationLedger(legacy, 7, "2026-08-06T00:00:00.000Z");
    legacy.close();

    const upgraded = createLocalStore({ filename });
    upgraded.migrate();
    const database = new DatabaseSync(filename, { readOnly: true });
    const counts = (table: string): number =>
      Number((database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count);
    expect(counts("users")).toBeGreaterThanOrEqual(1);
    expect(counts("batches")).toBe(1);
    expect(counts("daily_operation_plans")).toBe(1);
    expect(counts("daily_operation_confirmations")).toBe(1);
    expect(counts("audit_events")).toBe(1);
    expect(database.prepare("SELECT count(*) AS count FROM schema_migrations WHERE version = 12").get())
      .toEqual({ count: 1 });
    expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    database.close();
    upgraded.close();
  });

  it("rebuilds v8 amendment tables and restores their indexes during migration to 11", () => {
    const { filename, store } = fileStore();
    store.createBatch({
      userId: "user-a",
      batchId: "batch-v8-index",
      revision: 3,
      data: { config: {}, records: [] },
    });
    const operations = dailyOperations();
    const plan = store.ensureDailyOperationPlan({
      userId: "user-a",
      batchId: "batch-v8-index",
      businessDate: "2026-08-06",
      basedOnBatchRevision: 3,
      sopTemplateId: "sop-v8",
      sopSourceSha256: "A".repeat(64),
      devicePlanVersion: "device-v8",
      devicePlanSha256: "B".repeat(64),
      selectedMode: "timed_quantity",
      effectiveMode: "timed_quantity",
      operations,
      operationsSha256: dailyOperationsSha256(operations),
    });
    const confirmation = store.confirmDailyOperationPlan({
      userId: "user-a",
      batchId: "batch-v8-index",
      businessDate: plan.businessDate,
      planId: plan.id,
      operationsSha256: plan.operationsSha256,
      confirmedBy: "user-a",
      idempotencyKey: "confirm-v8-index-base",
    }).confirmation;
    store.ensureDailyOperationAmendment({
      userId: "user-a",
      batchId: "batch-v8-index",
      businessDate: plan.businessDate,
      basePlanId: plan.id,
      baseConfirmationId: confirmation.id,
      originId: "origin-v8-index",
      originKind: "diarrhea",
      severity: "mild",
      priority: "routine",
      operations,
      proposal: null,
      basedOnBatchRevision: 3,
      idempotencyKey: "amendment-v8-index",
    });
    store.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      ALTER TABLE daily_operation_amendments RENAME TO daily_operation_amendments_v9_old;
      CREATE TABLE daily_operation_amendments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        business_date TEXT NOT NULL,
        base_plan_id TEXT NOT NULL,
        base_confirmation_id TEXT,
        origin_id TEXT NOT NULL,
        origin_kind TEXT NOT NULL CHECK (origin_kind IN ('diarrhea', 'creep_control')),
        severity TEXT NOT NULL CHECK (severity IN ('mild', 'moderate', 'severe')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'applied')),
        operations_json TEXT NOT NULL CHECK (json_valid(operations_json)),
        proposal_json TEXT CHECK (proposal_json IS NULL OR json_valid(proposal_json)),
        decision_id TEXT,
        amendment_sha256 TEXT NOT NULL,
        based_on_batch_revision INTEGER NOT NULL CHECK (based_on_batch_revision >= 0),
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        UNIQUE (user_id, origin_id),
        UNIQUE (user_id, idempotency_key),
        FOREIGN KEY (user_id, batch_id) REFERENCES batches(user_id, id) ON DELETE CASCADE,
        FOREIGN KEY (base_plan_id) REFERENCES daily_operation_plans(id) ON DELETE CASCADE,
        FOREIGN KEY (base_confirmation_id) REFERENCES daily_operation_confirmations(id) ON DELETE SET NULL,
        FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL
      ) STRICT;
      INSERT INTO daily_operation_amendments (
        id, user_id, batch_id, business_date, base_plan_id, base_confirmation_id,
        origin_id, origin_kind, severity, status, operations_json, proposal_json,
        decision_id, amendment_sha256, based_on_batch_revision, idempotency_key,
        created_at, decided_at, decided_by
      )
      SELECT
        id, user_id, batch_id, business_date, base_plan_id, base_confirmation_id,
        origin_id, origin_kind, severity, status, operations_json, proposal_json,
        decision_id, amendment_sha256, based_on_batch_revision, idempotency_key,
        created_at, decided_at, decided_by
      FROM daily_operation_amendments_v9_old;
      DROP TABLE daily_operation_amendments_v9_old;
    `);
    replaceWithLegacyMigrationLedger(legacy, 8, "2026-08-06T00:00:00.000Z");
    legacy.close();

    const upgraded = createLocalStore({ filename });
    upgraded.migrate();
    const database = new DatabaseSync(filename, { readOnly: true });
    const indexes = database.prepare("PRAGMA index_list('daily_operation_amendments')").all()
      .map((row) => String(row.name));
    expect(indexes).toContain("daily_operation_amendments_batch_date_idx");
    expect(database.prepare("SELECT count(*) AS count FROM daily_operation_amendments").get())
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT count(*) AS count FROM daily_operation_amendment_actions").get())
      .toEqual({ count: 0 });
    expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    database.close();
    upgraded.close();
  });

  it("migrates the exact v9 amendment status contract to v10 without breaking supersede", () => {
    const { filename, store } = fileStore();
    store.createBatch({
      userId: "user-a",
      batchId: "batch-v9-status",
      revision: 2,
      data: { config: {}, records: [] },
    });
    const operations = dailyOperations();
    const plan = store.ensureDailyOperationPlan({
      userId: "user-a",
      batchId: "batch-v9-status",
      businessDate: "2026-08-07",
      basedOnBatchRevision: 2,
      sopTemplateId: "sop-v9",
      sopSourceSha256: "A".repeat(64),
      devicePlanVersion: "device-v9",
      devicePlanSha256: "B".repeat(64),
      selectedMode: "timed_quantity",
      effectiveMode: "timed_quantity",
      operations,
      operationsSha256: dailyOperationsSha256(operations),
    });
    const confirmation = store.confirmDailyOperationPlan({
      userId: "user-a",
      batchId: "batch-v9-status",
      businessDate: plan.businessDate,
      planId: plan.id,
      operationsSha256: plan.operationsSha256,
      confirmedBy: "user-a",
      idempotencyKey: "confirm-v9-status-base",
    }).confirmation;
    store.ensureDailyOperationAmendment({
      userId: "user-a",
      batchId: "batch-v9-status",
      businessDate: plan.businessDate,
      basePlanId: plan.id,
      baseConfirmationId: confirmation.id,
      originId: "origin-v9-status",
      originKind: "diarrhea",
      severity: "mild",
      priority: "routine",
      operations,
      proposal: null,
      basedOnBatchRevision: 2,
      idempotencyKey: "amendment-v9-status",
    });
    store.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec("PRAGMA foreign_keys = OFF;");
    legacy.exec(`
      ALTER TABLE daily_operation_amendments RENAME TO daily_operation_amendments_v10_old;
      CREATE TABLE daily_operation_amendments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        business_date TEXT NOT NULL,
        base_plan_id TEXT NOT NULL,
        base_confirmation_id TEXT,
        origin_id TEXT NOT NULL,
        origin_kind TEXT NOT NULL CHECK (origin_kind IN ('diarrhea', 'creep_control')),
        severity TEXT CHECK (severity IS NULL OR severity IN ('mild', 'moderate', 'severe')),
        priority TEXT NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine', 'warning', 'critical')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'applied')),
        operations_json TEXT NOT NULL CHECK (json_valid(operations_json)),
        proposal_json TEXT CHECK (proposal_json IS NULL OR json_valid(proposal_json)),
        decision_id TEXT,
        amendment_sha256 TEXT NOT NULL,
        based_on_batch_revision INTEGER NOT NULL CHECK (based_on_batch_revision >= 0),
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        UNIQUE (user_id, origin_id),
        UNIQUE (user_id, idempotency_key),
        FOREIGN KEY (user_id, batch_id) REFERENCES batches(user_id, id) ON DELETE CASCADE,
        FOREIGN KEY (base_plan_id) REFERENCES daily_operation_plans(id) ON DELETE CASCADE,
        FOREIGN KEY (base_confirmation_id) REFERENCES daily_operation_confirmations(id) ON DELETE SET NULL,
        FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL
      ) STRICT;
      INSERT INTO daily_operation_amendments (
        id, user_id, batch_id, business_date, base_plan_id, base_confirmation_id,
        origin_id, origin_kind, severity, priority, status, operations_json,
        proposal_json, decision_id, amendment_sha256, based_on_batch_revision,
        idempotency_key, created_at, decided_at, decided_by
      )
      SELECT
        id, user_id, batch_id, business_date, base_plan_id, base_confirmation_id,
        origin_id, origin_kind, severity, priority, status, operations_json,
        proposal_json, decision_id, amendment_sha256, based_on_batch_revision,
        idempotency_key, created_at, decided_at, decided_by
      FROM daily_operation_amendments_v10_old;
      DROP TABLE daily_operation_amendments_v10_old;
    `);
    replaceWithLegacyMigrationLedger(legacy, 9, "2026-08-07T00:00:00.000Z");
    legacy.close();

    const upgraded = createLocalStore({ filename });
    upgraded.migrate();
    expect(upgraded.supersedeDailyOperationAmendments({
      userId: "user-a",
      batchId: "batch-v9-status",
      businessDate: plan.businessDate,
      originKind: "diarrhea",
      reason: "explicit_none",
      sourceObservationId: "observation-v9-none",
    })).toBe(1);
    const amendments = upgraded.getDailyOperationAmendments(
      "user-a",
      "batch-v9-status",
      plan.businessDate,
    );
    expect(amendments[0]?.status).toBe("superseded");
    const database = new DatabaseSync(filename, { readOnly: true });
    const indexes = database.prepare("PRAGMA index_list('daily_operation_amendments')").all()
      .map((row) => String(row.name));
    expect(indexes).toContain("daily_operation_amendments_batch_date_idx");
    expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version)
      .toBe(15);
    expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    database.close();
    upgraded.close();
  });

  it("preserves v9 amendment action history and replay after migration to v11", () => {
    const { filename, store } = fileStore();
    store.createBatch({
      userId: "user-a",
      batchId: "batch-v9-actions",
      revision: 2,
      data: { config: {}, records: [] },
    });
    const operations = dailyOperations();
    const plan = store.ensureDailyOperationPlan({
      userId: "user-a",
      batchId: "batch-v9-actions",
      businessDate: "2026-08-07",
      basedOnBatchRevision: 2,
      sopTemplateId: "sop-v9-actions",
      sopSourceSha256: "A".repeat(64),
      devicePlanVersion: "device-v9-actions",
      devicePlanSha256: "B".repeat(64),
      selectedMode: "timed_quantity",
      effectiveMode: "timed_quantity",
      operations,
      operationsSha256: dailyOperationsSha256(operations),
    });
    const confirmation = store.confirmDailyOperationPlan({
      userId: "user-a",
      batchId: "batch-v9-actions",
      businessDate: plan.businessDate,
      planId: plan.id,
      operationsSha256: plan.operationsSha256,
      confirmedBy: "user-a",
      idempotencyKey: "confirm-v9-actions-base",
    }).confirmation;
    const proposal = {
      kind: "creep_control" as const,
      businessDate: plan.businessDate,
      mode: "timed_quantity" as const,
      dayAge: 4,
      dailyPowderGrams: 500,
      singlePowderGrams: 50,
      mealCount: 10,
      timedMeals: [{ timeLocal: "10:00", powderGrams: 50 }],
      freeWindows: [],
      precisionGrams: 1,
      source: "sop_indirect" as const,
      rationale: ["migration fixture"],
      manualDispositionRequired: false,
      proposalDigest: "",
    };
    const created = store.ensureDailyOperationAmendment({
      userId: "user-a",
      batchId: "batch-v9-actions",
      businessDate: plan.businessDate,
      basePlanId: plan.id,
      baseConfirmationId: confirmation.id,
      originId: "origin-v9-actions",
      originKind: "diarrhea",
      severity: "mild",
      priority: "routine",
      operations,
      proposal,
      basedOnBatchRevision: 2,
      idempotencyKey: "amendment-v9-actions",
    });
    const amendment = created.amendment;
    const confirmed = store.decideDailyOperationAmendment({
      userId: "user-a",
      batchId: "batch-v9-actions",
      amendmentId: amendment.id,
      action: "confirm",
      decidedBy: "user-a",
      expectedRevision: 2,
      expectedAmendmentSha256: amendment.amendmentSha256,
      idempotencyKey: "confirm-v9-actions",
    });
    expect(confirmed.amendment.status).toBe("confirmed");
    expect(confirmed.amendment.decisionId).toBeNull();
    const applied = store.decideDailyOperationAmendment({
      userId: "user-a",
      batchId: "batch-v9-actions",
      amendmentId: amendment.id,
      action: "apply",
      decidedBy: "user-a",
      expectedRevision: 2,
      expectedAmendmentSha256: amendment.amendmentSha256,
      idempotencyKey: "apply-v9-actions",
    });
    expect(applied.amendment.status).toBe("applied");
    expect(applied.amendment.decisionId).toMatch(/^[0-9a-f-]{36}$/);
    store.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec("PRAGMA foreign_keys = OFF;");
    legacy.exec(`
      ALTER TABLE daily_operation_amendments RENAME TO daily_operation_amendments_v10_old;
      CREATE TABLE daily_operation_amendments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        business_date TEXT NOT NULL,
        base_plan_id TEXT NOT NULL,
        base_confirmation_id TEXT,
        origin_id TEXT NOT NULL,
        origin_kind TEXT NOT NULL CHECK (origin_kind IN ('diarrhea', 'creep_control')),
        severity TEXT CHECK (severity IS NULL OR severity IN ('mild', 'moderate', 'severe')),
        priority TEXT NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine', 'warning', 'critical')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'applied')),
        operations_json TEXT NOT NULL CHECK (json_valid(operations_json)),
        proposal_json TEXT CHECK (proposal_json IS NULL OR json_valid(proposal_json)),
        decision_id TEXT,
        amendment_sha256 TEXT NOT NULL,
        based_on_batch_revision INTEGER NOT NULL CHECK (based_on_batch_revision >= 0),
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        UNIQUE (user_id, origin_id),
        UNIQUE (user_id, idempotency_key),
        FOREIGN KEY (user_id, batch_id) REFERENCES batches(user_id, id) ON DELETE CASCADE,
        FOREIGN KEY (base_plan_id) REFERENCES daily_operation_plans(id) ON DELETE CASCADE,
        FOREIGN KEY (base_confirmation_id) REFERENCES daily_operation_confirmations(id) ON DELETE SET NULL,
        FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL
      ) STRICT;
      INSERT INTO daily_operation_amendments (
        id, user_id, batch_id, business_date, base_plan_id, base_confirmation_id,
        origin_id, origin_kind, severity, priority, status, operations_json,
        proposal_json, decision_id, amendment_sha256, based_on_batch_revision,
        idempotency_key, created_at, decided_at, decided_by
      )
      SELECT
        id, user_id, batch_id, business_date, base_plan_id, base_confirmation_id,
        origin_id, origin_kind, severity, priority, status, operations_json,
        proposal_json, decision_id, amendment_sha256, based_on_batch_revision,
        idempotency_key, created_at, decided_at, decided_by
      FROM daily_operation_amendments_v10_old;
      DROP TABLE daily_operation_amendments_v10_old;
    `);
    replaceWithLegacyMigrationLedger(legacy, 9, "2026-08-07T00:00:00.000Z");
    legacy.close();

    const upgraded = createLocalStore({ filename });
    upgraded.migrate();
    const upgradedAmendments = upgraded.getDailyOperationAmendments(
      "user-a",
      "batch-v9-actions",
      plan.businessDate,
    );
    expect(upgradedAmendments).toHaveLength(1);
    expect(upgradedAmendments[0]?.status).toBe("applied");
    expect(upgradedAmendments[0]?.decisionId).toBe(applied.amendment.decisionId);

    const confirmReplay = upgraded.decideDailyOperationAmendment({
      userId: "user-a",
      batchId: "batch-v9-actions",
      amendmentId: amendment.id,
      action: "confirm",
      decidedBy: "user-a",
      expectedRevision: 2,
      expectedAmendmentSha256: amendment.amendmentSha256,
      idempotencyKey: "confirm-v9-actions",
    });
    expect(confirmReplay.replayed).toBe(true);
    expect(confirmReplay.amendment.status).toBe("confirmed");
    expect(confirmReplay.amendment.decisionId).toBeNull();

    const applyReplay = upgraded.decideDailyOperationAmendment({
      userId: "user-a",
      batchId: "batch-v9-actions",
      amendmentId: amendment.id,
      action: "apply",
      decidedBy: "user-a",
      expectedRevision: 2,
      expectedAmendmentSha256: amendment.amendmentSha256,
      idempotencyKey: "apply-v9-actions",
    });
    expect(applyReplay.replayed).toBe(true);
    expect(applyReplay.amendment.status).toBe("applied");
    expect(applyReplay.amendment.decisionId).toBe(applied.amendment.decisionId);

    const database = new DatabaseSync(filename, { readOnly: true });
    expect(database.prepare("SELECT count(*) AS count FROM daily_operation_amendments").get())
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT count(*) AS count FROM daily_operation_amendment_actions").get())
      .toEqual({ count: 2 });
    const actionRows = database.prepare(`
      SELECT action FROM daily_operation_amendment_actions
      ORDER BY created_at ASC, id ASC
    `).all().map((row) => String(row.action));
    expect(actionRows).toEqual(["confirm", "apply"]);
    const actionIndexes = database.prepare("PRAGMA index_list('daily_operation_amendment_actions')").all()
      .map((row) => String(row.name));
    expect(actionIndexes).toContain("daily_operation_amendment_actions_amendment_idx");
    const actionTableSql = database.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'daily_operation_amendment_actions'
    `).get() as { sql: string };
    expect(actionTableSql.sql).toContain("'cancel'");
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    database.close();
    upgraded.close();
  });

  it("migrates an exact v10 action table to v11 preserving confirm/apply replay", () => {
    const { filename, store } = fileStore();
    store.createBatch({
      userId: "user-a",
      batchId: "batch-v10-actions",
      revision: 2,
      data: { config: {}, records: [] },
    });
    const operations = dailyOperations();
    const plan = store.ensureDailyOperationPlan({
      userId: "user-a",
      batchId: "batch-v10-actions",
      businessDate: "2026-08-07",
      basedOnBatchRevision: 2,
      sopTemplateId: "sop-v10-actions",
      sopSourceSha256: "A".repeat(64),
      devicePlanVersion: "device-v10-actions",
      devicePlanSha256: "B".repeat(64),
      selectedMode: "timed_quantity",
      effectiveMode: "timed_quantity",
      operations,
      operationsSha256: dailyOperationsSha256(operations),
    });
    const confirmation = store.confirmDailyOperationPlan({
      userId: "user-a",
      batchId: "batch-v10-actions",
      businessDate: plan.businessDate,
      planId: plan.id,
      operationsSha256: plan.operationsSha256,
      confirmedBy: "user-a",
      idempotencyKey: "confirm-v10-actions-base",
    }).confirmation;
    const proposal = {
      kind: "diarrhea" as const,
      businessDate: plan.businessDate,
      mode: "timed_quantity" as const,
      dayAge: 4,
      dailyPowderGrams: 500,
      singlePowderGrams: 50,
      mealCount: 10,
      timedMeals: [{ timeLocal: "10:00", powderGrams: 50 }],
      freeWindows: [],
      precisionGrams: 1,
      source: "sop_indirect" as const,
      rationale: ["v10 migration fixture"],
      manualDispositionRequired: false,
      proposalDigest: "",
    };
    const created = store.ensureDailyOperationAmendment({
      userId: "user-a",
      batchId: "batch-v10-actions",
      businessDate: plan.businessDate,
      basePlanId: plan.id,
      baseConfirmationId: confirmation.id,
      originId: "origin-v10-actions",
      originKind: "diarrhea",
      severity: "mild",
      priority: "routine",
      operations,
      proposal,
      basedOnBatchRevision: 2,
      idempotencyKey: "amendment-v10-actions",
    });
    const amendment = created.amendment;
    store.decideDailyOperationAmendment({
      userId: "user-a",
      batchId: "batch-v10-actions",
      amendmentId: amendment.id,
      action: "confirm",
      decidedBy: "user-a",
      expectedRevision: 2,
      expectedAmendmentSha256: amendment.amendmentSha256,
      idempotencyKey: "confirm-v10-actions",
    });
    const applied = store.decideDailyOperationAmendment({
      userId: "user-a",
      batchId: "batch-v10-actions",
      amendmentId: amendment.id,
      action: "apply",
      decidedBy: "user-a",
      expectedRevision: 2,
      expectedAmendmentSha256: amendment.amendmentSha256,
      idempotencyKey: "apply-v10-actions",
    });
    store.close();

    const beforeRead = new DatabaseSync(filename, { readOnly: true });
    const beforeRows = beforeRead.prepare(`
      SELECT action, response_json FROM daily_operation_amendment_actions
      ORDER BY action, created_at, id
    `).all() as Array<{ action: string; response_json: string }>;
    beforeRead.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec("PRAGMA foreign_keys = OFF;");
    legacy.exec(`
      ALTER TABLE daily_operation_amendment_actions RENAME TO daily_operation_amendment_actions_v10_old;
      CREATE TABLE daily_operation_amendment_actions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        amendment_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('confirm', 'reject', 'apply')),
        idempotency_key TEXT NOT NULL,
        expected_batch_revision INTEGER NOT NULL CHECK (expected_batch_revision >= 0),
        expected_amendment_sha256 TEXT NOT NULL,
        resulting_status TEXT NOT NULL,
        decision_id TEXT,
        response_json TEXT NOT NULL CHECK (json_valid(response_json)),
        created_at TEXT NOT NULL,
        UNIQUE (user_id, idempotency_key),
        FOREIGN KEY (user_id, batch_id) REFERENCES batches(user_id, id) ON DELETE CASCADE,
        FOREIGN KEY (amendment_id) REFERENCES daily_operation_amendments(id) ON DELETE CASCADE
      ) STRICT;
      INSERT INTO daily_operation_amendment_actions (
        id, user_id, batch_id, amendment_id, action, idempotency_key,
        expected_batch_revision, expected_amendment_sha256, resulting_status,
        decision_id, response_json, created_at
      )
      SELECT
        id, user_id, batch_id, amendment_id, action, idempotency_key,
        expected_batch_revision, expected_amendment_sha256, resulting_status,
        decision_id, response_json, created_at
      FROM daily_operation_amendment_actions_v10_old;
      DROP TABLE daily_operation_amendment_actions_v10_old;
    `);
    replaceWithLegacyMigrationLedger(legacy, 10, "2026-08-07T00:00:00.000Z");
    legacy.close();

    const upgraded = createLocalStore({ filename });
    upgraded.migrate();
    const confirmReplay = upgraded.decideDailyOperationAmendment({
      userId: "user-a",
      batchId: "batch-v10-actions",
      amendmentId: amendment.id,
      action: "confirm",
      decidedBy: "user-a",
      expectedRevision: 2,
      expectedAmendmentSha256: amendment.amendmentSha256,
      idempotencyKey: "confirm-v10-actions",
    });
    expect(confirmReplay.replayed).toBe(true);
    const applyReplay = upgraded.decideDailyOperationAmendment({
      userId: "user-a",
      batchId: "batch-v10-actions",
      amendmentId: amendment.id,
      action: "apply",
      decidedBy: "user-a",
      expectedRevision: 2,
      expectedAmendmentSha256: amendment.amendmentSha256,
      idempotencyKey: "apply-v10-actions",
    });
    expect(applyReplay.replayed).toBe(true);
    expect(applyReplay.amendment.decisionId).toBe(applied.amendment.decisionId);

    const database = new DatabaseSync(filename, { readOnly: true });
    expect(database.prepare("SELECT count(*) AS count FROM daily_operation_amendment_actions").get())
      .toEqual({ count: 2 });
    const afterRows = database.prepare(`
      SELECT action, response_json FROM daily_operation_amendment_actions
      ORDER BY action, created_at, id
    `).all() as Array<{ action: string; response_json: string }>;
    expect(afterRows).toEqual(beforeRows);
    const actionTableSql = database.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'daily_operation_amendment_actions'
    `).get() as { sql: string };
    expect(actionTableSql.sql).toContain("'cancel'");
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version)
      .toBe(15);
    database.close();
    upgraded.close();
  });

  it("migrates an exact v11 amendment contract to v12 preserving mode_change, actions, and one-active unique", () => {
    const { filename, store } = fileStore();
    store.createBatch({
      userId: "user-a",
      batchId: "batch-v11-actions",
      revision: 2,
      data: { config: {}, records: [] },
    });
    const operations = dailyOperations();
    const plan = store.ensureDailyOperationPlan({
      userId: "user-a",
      batchId: "batch-v11-actions",
      businessDate: "2026-08-08",
      basedOnBatchRevision: 2,
      sopTemplateId: "sop-v11-actions",
      sopSourceSha256: "A".repeat(64),
      devicePlanVersion: "device-v11-actions",
      devicePlanSha256: "B".repeat(64),
      selectedMode: "timed_quantity",
      effectiveMode: "timed_quantity",
      operations,
      operationsSha256: dailyOperationsSha256(operations),
    });
    const confirmation = store.confirmDailyOperationPlan({
      userId: "user-a",
      batchId: "batch-v11-actions",
      businessDate: plan.businessDate,
      planId: plan.id,
      operationsSha256: plan.operationsSha256,
      confirmedBy: "user-a",
      idempotencyKey: "confirm-v11-actions-base",
    }).confirmation;
    const proposal = {
      kind: "diarrhea" as const,
      businessDate: plan.businessDate,
      mode: "timed_quantity" as const,
      dayAge: 4,
      dailyPowderGrams: 500,
      singlePowderGrams: 50,
      mealCount: 10,
      timedMeals: [{ timeLocal: "10:00", powderGrams: 50 }],
      freeWindows: [],
      precisionGrams: 1,
      source: "sop_indirect" as const,
      rationale: ["v11 migration fixture"],
      manualDispositionRequired: false,
      proposalDigest: "",
    };
    const ensure = (originId: string, originKind: "diarrhea" | "creep_control", idempotencyKey: string) =>
      store.ensureDailyOperationAmendment({
        userId: "user-a",
        batchId: "batch-v11-actions",
        businessDate: plan.businessDate,
        basePlanId: plan.id,
        baseConfirmationId: confirmation.id,
        originId,
        originKind,
        severity: originKind === "diarrhea" ? "moderate" : null,
        priority: originKind === "diarrhea" ? "warning" : "routine",
        operations,
        proposal,
        basedOnBatchRevision: 2,
        idempotencyKey,
      }).amendment;
    const decide = (amendmentId: string, action: "confirm" | "reject" | "apply" | "cancel", key: string) =>
      store.decideDailyOperationAmendment({
        userId: "user-a",
        batchId: "batch-v11-actions",
        amendmentId,
        action,
        decidedBy: "user-a",
        expectedRevision: 2,
        expectedAmendmentSha256: store.getDailyOperationAmendment("user-a", "batch-v11-actions", amendmentId)!.amendmentSha256,
        idempotencyKey: key,
      });
    const pending = ensure("v11-pending", "diarrhea", "v11-pending-key");
    const confirmed = ensure("v11-confirmed", "diarrhea", "v11-confirmed-key");
    decide(confirmed.id, "confirm", "v11-confirm-key");
    const applied = ensure("v11-applied", "diarrhea", "v11-applied-key");
    decide(applied.id, "confirm", "v11-apply-confirm-key");
    const appliedResult = decide(applied.id, "apply", "v11-apply-key");
    const rejected = ensure("v11-rejected", "diarrhea", "v11-rejected-key");
    decide(rejected.id, "reject", "v11-reject-key");
    const cancelled = ensure("v11-cancelled", "diarrhea", "v11-cancelled-key");
    decide(cancelled.id, "confirm", "v11-cancel-confirm-key");
    decide(cancelled.id, "cancel", "v11-cancel-key");
    const superseded = ensure("v11-superseded", "creep_control", "v11-superseded-key");
    store.supersedeDailyOperationAmendments({
      userId: "user-a",
      batchId: "batch-v11-actions",
      businessDate: plan.businessDate,
      originKind: "creep_control",
      reason: "newer_observation",
      sourceObservationId: "obs-v11-superseded",
    });
    store.close();

    const beforeRead = new DatabaseSync(filename, { readOnly: true });
    const amendmentCountBefore = Number(
      (beforeRead.prepare("SELECT count(*) AS count FROM daily_operation_amendments").get() as { count: number }).count,
    );
    const actionCountBefore = Number(
      (beforeRead.prepare("SELECT count(*) AS count FROM daily_operation_amendment_actions").get() as { count: number }).count,
    );
    beforeRead.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec("PRAGMA foreign_keys = OFF;");
    legacy.exec(`
      ALTER TABLE daily_operation_amendments RENAME TO daily_operation_amendments_v11_old;
      CREATE TABLE daily_operation_amendments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        business_date TEXT NOT NULL,
        base_plan_id TEXT NOT NULL,
        base_confirmation_id TEXT,
        origin_id TEXT NOT NULL,
        origin_kind TEXT NOT NULL CHECK (origin_kind IN ('diarrhea', 'creep_control')),
        severity TEXT CHECK (severity IS NULL OR severity IN ('mild', 'moderate', 'severe')),
        priority TEXT NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine', 'warning', 'critical')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'applied', 'superseded', 'cancelled')),
        operations_json TEXT NOT NULL CHECK (json_valid(operations_json)),
        proposal_json TEXT CHECK (proposal_json IS NULL OR json_valid(proposal_json)),
        decision_id TEXT,
        amendment_sha256 TEXT NOT NULL,
        based_on_batch_revision INTEGER NOT NULL CHECK (based_on_batch_revision >= 0),
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        UNIQUE (user_id, origin_id),
        UNIQUE (user_id, idempotency_key)
      ) STRICT;
      INSERT INTO daily_operation_amendments (
        id, user_id, batch_id, business_date, base_plan_id, base_confirmation_id,
        origin_id, origin_kind, severity, priority, status, operations_json,
        proposal_json, decision_id, amendment_sha256, based_on_batch_revision,
        idempotency_key, created_at, decided_at, decided_by
      )
      SELECT
        id, user_id, batch_id, business_date, base_plan_id, base_confirmation_id,
        origin_id, origin_kind, severity, priority, status, operations_json,
        proposal_json, decision_id, amendment_sha256, based_on_batch_revision,
        idempotency_key, created_at, decided_at, decided_by
      FROM daily_operation_amendments_v11_old;
      DROP TABLE daily_operation_amendments_v11_old;
    `);
    replaceWithLegacyMigrationLedger(legacy, 11, "2026-08-08T00:00:00.000Z");
    legacy.close();

    const upgraded = createLocalStore({ filename });
    upgraded.migrate();
    expect(upgraded.decideDailyOperationAmendment({
      userId: "user-a",
      batchId: "batch-v11-actions",
      amendmentId: confirmed.id,
      action: "confirm",
      decidedBy: "user-a",
      expectedRevision: 2,
      expectedAmendmentSha256: confirmed.amendmentSha256,
      idempotencyKey: "v11-confirm-key",
    }).replayed).toBe(true);
    expect(upgraded.decideDailyOperationAmendment({
      userId: "user-a",
      batchId: "batch-v11-actions",
      amendmentId: applied.id,
      action: "apply",
      decidedBy: "user-a",
      expectedRevision: 2,
      expectedAmendmentSha256: applied.amendmentSha256,
      idempotencyKey: "v11-apply-key",
    }).amendment.decisionId).toBe(appliedResult.amendment.decisionId);
    expect(upgraded.decideDailyOperationAmendment({
      userId: "user-a",
      batchId: "batch-v11-actions",
      amendmentId: rejected.id,
      action: "reject",
      decidedBy: "user-a",
      expectedRevision: 2,
      expectedAmendmentSha256: rejected.amendmentSha256,
      idempotencyKey: "v11-reject-key",
    }).replayed).toBe(true);
    expect(upgraded.decideDailyOperationAmendment({
      userId: "user-a",
      batchId: "batch-v11-actions",
      amendmentId: cancelled.id,
      action: "cancel",
      decidedBy: "user-a",
      expectedRevision: 2,
      expectedAmendmentSha256: cancelled.amendmentSha256,
      idempotencyKey: "v11-cancel-key",
    }).replayed).toBe(true);

    const database = new DatabaseSync(filename, { readOnly: true });
    expect(Number((database.prepare("SELECT count(*) AS count FROM daily_operation_amendments").get() as { count: number }).count))
      .toBe(amendmentCountBefore);
    expect(Number((database.prepare("SELECT count(*) AS count FROM daily_operation_amendment_actions").get() as { count: number }).count))
      .toBe(actionCountBefore);
    const amendmentSql = database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'daily_operation_amendments'
    `).get() as { sql: string };
    expect(amendmentSql.sql).toContain("mode_change");
    const indexes = (database.prepare("PRAGMA index_list(feeding_decisions)").all() as Array<{ name: string }>)
      .map((row) => row.name);
    expect(indexes).toContain("feeding_decisions_one_active_idx");
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version).toBe(15);
    expect(database.prepare("SELECT * FROM schema_migrations_legacy").all())
      .toEqual([{ version: 11, applied_at: "2026-08-08T00:00:00.000Z" }]);
    database.close();
    upgraded.close();
  });

  it("fails V12 migration when duplicate active decisions already exist", () => {
    const { filename, store } = fileStore();
    store.createBatch({
      userId: "user-a",
      batchId: "batch-dup-active",
      revision: 1,
      data: { config: {}, records: [] },
    });
    store.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec("DROP INDEX IF EXISTS feeding_decisions_one_active_idx;");
    const first = decision("batch-dup-active", 1);
    const second = decision("batch-dup-active", 2);
    const insert = legacy.prepare(`
      INSERT INTO feeding_decisions (
        user_id, id, batch_id, session_id, revision, date_local,
        sop_version, model_version, calculation_date, device_setting_json,
        evidence_json, decision_json, status, idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)
    `);
    insert.run(
      "user-a", "active-1", "batch-dup-active", null, first.revision, first.dateLocal,
      first.evidence.sopVersion, first.evidence.modelVersion, first.evidence.calculationDate,
      JSON.stringify(first.setting), JSON.stringify(first.evidence), JSON.stringify(first),
      "2026-08-08T00:00:00Z", "2026-08-08T00:00:00Z",
    );
    insert.run(
      "user-a", "active-2", "batch-dup-active", null, second.revision, second.dateLocal,
      second.evidence.sopVersion, second.evidence.modelVersion, second.evidence.calculationDate,
      JSON.stringify(second.setting), JSON.stringify(second.evidence), JSON.stringify(second),
      "2026-08-08T00:00:00Z", "2026-08-08T00:00:00Z",
    );
    replaceWithLegacyMigrationLedger(legacy, 11, "2026-08-08T00:00:00Z");
    legacy.close();

    const upgraded = createLocalStore({ filename });
    expect(() => upgraded.migrate()).toThrow("duplicate active decisions");
    upgraded.close();
  });

  it("isolates batches and safely binds SQL-injection-shaped identifiers", () => {
    const store = memoryStore();
    const injected = "batch'; DROP TABLE batches; --";
    store.createBatch({
      userId: "user-a",
      batchId: injected,
      revision: 4,
      currentDay: 2,
      data: { label: "Robert'); DROP TABLE users;--" },
    });
    store.createBatch({ userId: "user-b", batchId: injected, revision: 1 });

    expect(store.getBatch("user-a", injected)).toMatchObject({ revision: 4, currentDay: 2 });
    expect(store.getBatch("user-b", injected)).toMatchObject({ revision: 1 });
    expect(store.getBatch("other-user", injected)).toBeNull();
    expect(store.getBatch("user-a", "' OR 1=1 --")).toBeNull();
    store.close();
  });

  it("isolates messages by user, session, and batch", () => {
    const store = memoryStore();
    for (const userId of ["user-a", "user-b"]) {
      store.createBatch({ userId, batchId: "batch-1" });
      store.createSession({ userId, batchId: "batch-1", id: "session-1" });
    }
    store.createBatch({ userId: "user-a", batchId: "batch-2" });
    store.createSession({ userId: "user-a", batchId: "batch-2", id: "session-2" });
    store.appendMessage({
      userId: "user-a",
      batchId: "batch-1",
      sessionId: "session-1",
      role: "user",
      content: "secret-a ' OR 1=1 --",
      idempotencyKey: "message-a",
    });
    store.appendMessage({
      userId: "user-b",
      batchId: "batch-1",
      sessionId: "session-1",
      role: "assistant",
      content: "secret-b",
      idempotencyKey: "message-b",
    });

    expect(store.listMessages("user-a", "batch-1", "session-1").map((item) => item.content))
      .toEqual(["secret-a ' OR 1=1 --"]);
    expect(store.listMessages("user-b", "batch-1", "session-1").map((item) => item.content))
      .toEqual(["secret-b"]);
    expect(store.listMessages("user-a", "batch-2", "session-1")).toEqual([]);
    expect(() => store.appendMessage({
      userId: "user-a",
      batchId: "batch-2",
      sessionId: "session-1",
      role: "user",
      content: "cross-batch",
    })).toThrowError(expect.objectContaining({ code: "LOCAL_STORE_SESSION_NOT_FOUND" }));
    store.close();
  });

  it("returns the latest limited message window in chronological order", () => {
    const store = memoryStore();
    store.createBatch({ userId: "user-a", batchId: "batch-1" });
    store.createSession({ userId: "user-a", batchId: "batch-1", id: "session-1" });
    for (let index = 0; index < 1005; index += 1) {
      store.appendMessage({
        userId: "user-a",
        batchId: "batch-1",
        sessionId: "session-1",
        role: "user",
        content: `message-${index}`,
        id: `message-${index}`,
        idempotencyKey: `message-key-${index}`,
      });
    }
    const messages = store.listMessages("user-a", "batch-1", "session-1", { limit: 1000 });
    expect(messages).toHaveLength(1000);
    expect(messages[0]?.id).toBe("message-5");
    expect(messages.at(-1)?.id).toBe("message-1004");
    store.close();
  });

  it("rejects stale decisions and round-trips complete evidence without recalculation", () => {
    const store = memoryStore();
    store.createBatch({ userId: "user-a", batchId: "batch-1", revision: 7 });

    expect(() => store.saveDecision({
      userId: "user-a",
      decision: decision("batch-1", 6),
    })).toThrowError(expect.objectContaining({ code: "LOCAL_STORE_STALE_REVISION" }));

    const expected = decision("batch-1", 7);
    store.saveDecision({ userId: "user-a", decision: expected, idempotencyKey: "decision-7" });
    expect(store.getActiveDecision("user-a", "batch-1", "2026-07-31")).toEqual({
      ...expected,
      evidence: {
        ...expected.evidence,
        inputs: {
          ...expected.evidence.inputs,
          decisionPolicyVersion: DECISION_POLICY_VERSION,
        },
      },
    });
    expect(store.getActiveDecision("user-b", "batch-1", "2026-07-31")).toBeNull();
    store.close();
  });

  it("deduplicates daily observations by user-scoped idempotency key", () => {
    const { filename, store } = fileStore();
    store.createBatch({ userId: "user-a", batchId: "batch-1", revision: 3 });
    const input = {
      userId: "user-a",
      batchId: "batch-1",
      dateLocal: "2026-07-31",
      batchRevision: 3,
      data: { diarrheaGrade: "none" },
      idempotencyKey: "observation-2026-07-31",
    } as const;
    const first = store.appendDailyObservation(input);
    const replay = store.appendDailyObservation({ ...input, data: { diarrheaGrade: "severe" } });
    expect(replay).toEqual(first);
    store.close();

    const database = new DatabaseSync(filename, { readOnly: true });
    expect(database.prepare("SELECT count(*) AS count FROM daily_observations").get()?.count).toBe(1);
    database.close();
  });

  it("normalizes observation timestamps and rejects invalid timestamps", () => {
    const store = memoryStore();
    store.createBatch({ userId: "user-a", batchId: "batch-timestamps", revision: 3 });
    const first = store.appendDailyObservation({
      userId: "user-a",
      batchId: "batch-timestamps",
      dateLocal: "2026-08-05",
      batchRevision: 3,
      observedAt: "2026-08-05T10:00:00+08:00",
      data: { recordedAt: "2026-08-05T10:00:00+08:00" },
      idempotencyKey: "timestamp-observation-1",
    });
    expect(first.observedAt).toBe("2026-08-05T02:00:00.000Z");
    expect(first.data.recordedAt).toBe("2026-08-05T02:00:00.000Z");
    const second = store.appendDailyObservation({
      userId: "user-a",
      batchId: "batch-timestamps",
      dateLocal: "2026-08-05",
      batchRevision: 3,
      observedAt: "2026-08-05T03:00:00Z",
      data: { recordedAt: "2026-08-05T03:00:00Z" },
      idempotencyKey: "timestamp-observation-2",
    });
    expect(second.observedAt).toBe("2026-08-05T03:00:00.000Z");
    expect(store.listObservations("user-a", "batch-timestamps").map((row) => row.observedAt))
      .toEqual([
        "2026-08-05T02:00:00.000Z",
        "2026-08-05T03:00:00.000Z",
      ]);
    expect(() => store.appendDailyObservation({
      userId: "user-a",
      batchId: "batch-timestamps",
      dateLocal: "2026-08-05",
      batchRevision: 3,
      observedAt: "2026-08-05 10:00",
      data: { recordedAt: "2026-08-05 10:00" },
      idempotencyKey: "timestamp-observation-invalid",
    })).toThrowError(expect.objectContaining({ code: "LOCAL_STORE_INVALID_TIMESTAMP" }));
    expect(store.listObservations("user-a", "batch-timestamps")).toHaveLength(2);
    store.close();
  });

  it("materializes one immutable daily plan and confirms it without changing the batch revision", () => {
    const { filename, store } = fileStore();
    store.createBatch({ userId: "user-a", batchId: "batch-operations", revision: 6 });
    const operations = dailyOperations();
    const operationsSha256 = dailyOperationsSha256(operations);
    const planInput = {
      userId: "user-a",
      batchId: "batch-operations",
      businessDate: "2026-08-04",
      basedOnBatchRevision: 6,
      sopTemplateId: "frozen-sop-v1",
      sopSourceSha256: "A".repeat(64),
      devicePlanVersion: "device-v1",
      devicePlanSha256: "B".repeat(64),
      selectedMode: "timed_quantity" as const,
      effectiveMode: "timed_quantity" as const,
      operations,
      operationsSha256,
    };
    const first = store.ensureDailyOperationPlan(planInput);
    const replay = store.ensureDailyOperationPlan({ ...planInput, basedOnBatchRevision: 999 });
    expect(replay).toEqual(first);
    expect(first.status).toBe("pending");

    const confirmed = store.confirmDailyOperationPlan({
      userId: "user-a",
      batchId: "batch-operations",
      businessDate: first.businessDate,
      planId: first.id,
      operationsSha256: first.operationsSha256,
      confirmedBy: "user-a",
      idempotencyKey: "confirm-operations-1",
    });
    const dayReplay = store.confirmDailyOperationPlan({
      userId: "user-a",
      batchId: "batch-operations",
      businessDate: first.businessDate,
      planId: first.id,
      operationsSha256: first.operationsSha256,
      confirmedBy: "user-a",
      idempotencyKey: "confirm-operations-2",
    });
    expect(confirmed.replayed).toBe(false);
    expect(dayReplay).toEqual({ confirmation: confirmed.confirmation, replayed: true });
    expect(store.getDailyOperationPlan("user-a", "batch-operations", first.businessDate))
      .toMatchObject({ id: first.id, status: "confirmed", operationsSha256 });
    expect(store.getBatch("user-a", "batch-operations")?.revision).toBe(6);
    store.close();

    const database = new DatabaseSync(filename, { readOnly: true });
    const audit = database.prepare(`
      SELECT action, details_json FROM audit_events WHERE batch_id = ?
    `).get("batch-operations") as { action: string; details_json: string };
    expect(audit.action).toBe("daily_operations.confirmed");
    expect(JSON.parse(audit.details_json)).toMatchObject({
      planId: first.id,
      businessDate: "2026-08-04",
      operationsSha256,
      basedOnBatchRevision: 6,
      sopTemplateId: "frozen-sop-v1",
      sopSourceSha256: "A".repeat(64),
      devicePlanVersion: "device-v1",
      devicePlanSha256: "B".repeat(64),
    });
    database.close();
  });

  it("persists feedback proposals and writes an active device decision on confirmation", () => {
    const { filename, store } = fileStore();
    store.createBatch({ userId: "user-a", batchId: "batch-feedback", revision: 6 });
    const oldDecision = {
      ...decision("batch-feedback", 5),
      dateLocal: "2026-08-04",
      status: "active" as const,
    };
    const seed = new DatabaseSync(filename);
    seed.prepare(`
      INSERT INTO feeding_decisions (
        user_id, id, batch_id, session_id, revision, date_local,
        sop_version, model_version, calculation_date, device_setting_json,
        evidence_json, decision_json, status, idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "user-a",
      "old-decision-id",
      "batch-feedback",
      null,
      5,
      oldDecision.dateLocal,
      oldDecision.evidence.sopVersion,
      oldDecision.evidence.modelVersion,
      oldDecision.evidence.calculationDate,
      JSON.stringify(oldDecision.setting),
      JSON.stringify(oldDecision.evidence),
      JSON.stringify(oldDecision),
      oldDecision.status,
      null,
      "2026-08-04T08:00:00.000Z",
      "2026-08-04T08:00:00.000Z",
    );
    seed.close();
    const proposal = {
      kind: "creep_control" as const,
      businessDate: "2026-08-04",
      mode: "timed_quantity" as const,
      dayAge: 4,
      dailyPowderGrams: 90,
      singlePowderGrams: 30,
      mealCount: 3,
      timedMeals: [{ timeLocal: "14:00", powderGrams: 30 }],
      freeWindows: [],
      precisionGrams: 1,
      source: "sop_indirect" as const,
      rationale: ["教槽控奶"],
      manualDispositionRequired: false,
      proposalDigest: "A".repeat(64),
      cumulativePowderGrams: 120,
    };
    const feedbackOrigin = {
      id: "origin-1",
      kind: "creep_control" as const,
      businessDate: "2026-08-04",
      status: "proposed" as const,
      sourceObservation: {
        recordedAt: "2026-08-04T09:00:00.000Z",
        creepGrade: "high" as const,
      },
      reason: "教槽持续采食，启动控奶",
      proposal,
      createdAt: "2026-08-04T09:00:00.000Z",
    };
    const operations = [{
      ...dailyOperations()[0],
      code: "feedback_creep_control_confirm",
      title: "教槽持续采食控奶启动确认",
      dueWindow: { startLocal: "09:00", endLocal: "09:00", endDayOffset: 1 },
      sopSection: "现场反馈.腹泻",
      feedbackRef: {
        originId: "origin-1",
        kind: "creep_control" as const,
        proposalDigest: proposal.proposalDigest,
        requiresDeviceConfirmation: true,
      },
    }];
    const planInput = {
      userId: "user-a",
      batchId: "batch-feedback",
      businessDate: "2026-08-04",
      basedOnBatchRevision: 6,
      sopTemplateId: "frozen-sop-v1",
      sopSourceSha256: "A".repeat(64),
      devicePlanVersion: "device-v1",
      devicePlanSha256: "B".repeat(64),
      selectedMode: "timed_quantity" as const,
      effectiveMode: "timed_quantity" as const,
      operations,
      operationsSha256: dailyOperationsSha256(operations),
      proposedSetting: proposal,
      feedbackOrigin,
    };
    const plan = store.ensureDailyOperationPlan(planInput);
    expect(plan.proposedSetting).toEqual(proposal);
    expect(plan.feedbackOrigin).toEqual(feedbackOrigin);
    expect(plan.operations[0]?.feedbackRef).toMatchObject({
      originId: "origin-1",
      kind: "creep_control",
      requiresDeviceConfirmation: true,
    });

    const confirmed = store.confirmDailyOperationPlan({
      userId: "user-a",
      batchId: "batch-feedback",
      businessDate: plan.businessDate,
      planId: plan.id,
      operationsSha256: plan.operationsSha256,
      confirmedBy: "user-a",
      idempotencyKey: "confirm-feedback-1",
    });
    expect(confirmed.confirmation.deviceSetting).toEqual({
      mode: proposal.mode,
      dayAge: proposal.dayAge,
      dailyPowderGrams: proposal.dailyPowderGrams,
      singlePowderGrams: proposal.singlePowderGrams,
      mealCount: proposal.mealCount,
      timedMeals: proposal.timedMeals,
      freeWindows: proposal.freeWindows,
      precisionGrams: proposal.precisionGrams,
      source: proposal.source,
    });
    expect(confirmed.confirmation.decisionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.getActiveDecision("user-a", "batch-feedback", plan.businessDate))
      .toMatchObject({
        revision: 6,
        dateLocal: "2026-08-04",
        status: "active",
        evidence: { modelVersion: "daily-operation-confirmation@1" },
      });

    const dayReplay = store.confirmDailyOperationPlan({
      userId: "user-a",
      batchId: "batch-feedback",
      businessDate: plan.businessDate,
      planId: plan.id,
      operationsSha256: plan.operationsSha256,
      confirmedBy: "user-a",
      idempotencyKey: "confirm-feedback-2",
    });
    expect(dayReplay).toEqual({ confirmation: confirmed.confirmation, replayed: true });
    store.close();

    const database = new DatabaseSync(filename, { readOnly: true });
    const rows = database.prepare(`
      SELECT status FROM feeding_decisions
      WHERE user_id = ? AND batch_id = ? AND date_local = ?
      ORDER BY created_at ASC
    `).all("user-a", "batch-feedback", "2026-08-04") as Array<{ status: string }>;
    expect(rows.map((row) => row.status)).toEqual(["superseded", "active"]);
    database.close();
  });

  it("adds v10 feedback columns and amendment tables to an existing daily operations database", () => {
    const { filename, store } = fileStore();
    store.close();
    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      ALTER TABLE daily_operation_plans DROP COLUMN proposed_setting_json;
      ALTER TABLE daily_operation_plans DROP COLUMN feedback_origin_json;
      ALTER TABLE daily_operation_confirmations DROP COLUMN device_setting_json;
      ALTER TABLE daily_operation_confirmations DROP COLUMN decision_id;
    `);
    replaceWithLegacyMigrationLedger(legacy, 6, "2026-08-05T00:00:00.000Z");
    legacy.close();
    const upgraded = createLocalStore({ filename });
    upgraded.migrate();
    const database = new DatabaseSync(filename, { readOnly: true });
    const planColumns = database.prepare("PRAGMA table_info(daily_operation_plans)").all()
      .map((row) => String(row.name));
    const confirmationColumns = database.prepare("PRAGMA table_info(daily_operation_confirmations)").all()
      .map((row) => String(row.name));
    const amendmentTables = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'daily_operation_amendments'
    `).all();
    const actionTables = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'daily_operation_amendment_actions'
    `).all();
    expect(planColumns).toEqual(expect.arrayContaining([
      "proposed_setting_json",
      "feedback_origin_json",
    ]));
    expect(confirmationColumns).toEqual(expect.arrayContaining([
      "device_setting_json",
      "decision_id",
    ]));
    expect(amendmentTables).toHaveLength(1);
    expect(actionTables).toHaveLength(1);
    expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version).toBe(15);
    database.close();
    upgraded.close();
  });

  it("refreshes only pending daily plans when materialized operations change", () => {
    const { store } = fileStore();
    store.createBatch({ userId: "user-a", batchId: "batch-refresh", revision: 6 });
    const firstOps = dailyOperations();
    const baseInput = {
      userId: "user-a",
      batchId: "batch-refresh",
      businessDate: "2026-08-05",
      basedOnBatchRevision: 6,
      sopTemplateId: "frozen-sop-v1",
      sopSourceSha256: "A".repeat(64),
      devicePlanVersion: "device-v1",
      devicePlanSha256: "B".repeat(64),
      selectedMode: "timed_quantity" as const,
      effectiveMode: "timed_quantity" as const,
    };
    const first = store.ensureDailyOperationPlan({
      ...baseInput,
      operations: firstOps,
      operationsSha256: dailyOperationsSha256(firstOps),
    });
    const changedOps = firstOps.map((item) => ({ ...item, title: "日常巡栏（刷新）" }));
    const refreshed = store.ensureDailyOperationPlan({
      ...baseInput,
      operations: changedOps,
      operationsSha256: dailyOperationsSha256(changedOps),
    });
    expect(refreshed.id).toBe(first.id);
    expect(refreshed.operationsSha256).not.toBe(first.operationsSha256);
    expect(refreshed.operations[0].title).toBe("日常巡栏（刷新）");

    store.confirmDailyOperationPlan({
      userId: "user-a",
      batchId: "batch-refresh",
      businessDate: refreshed.businessDate,
      planId: refreshed.id,
      operationsSha256: refreshed.operationsSha256,
      confirmedBy: "user-a",
      idempotencyKey: "refresh-confirm-1",
    });
    const thirdOps = changedOps.map((item) => ({ ...item, title: "不应刷新" }));
    const locked = store.ensureDailyOperationPlan({
      ...baseInput,
      operations: thirdOps,
      operationsSha256: dailyOperationsSha256(thirdOps),
    });
    expect(locked.operationsSha256).toBe(refreshed.operationsSha256);
    store.close();
  });

  it("fails predictably after close and allows close to be repeated", () => {
    const store = memoryStore();
    store.close();
    store.close();
    expect(() => store.migrate()).toThrowError(LocalStoreError);
    expect(() => store.getBatch("user-a", "batch-1"))
      .toThrowError(expect.objectContaining({ code: "LOCAL_STORE_CLOSED" }));
  });

  it("lists accounts and deletes an account atomically after transferring SOP ownership", () => {
    const store = memoryStore();
    const admin = store.createUser({
      id: "admin-a",
      email: "admin@example.com",
      passwordHash: "hash-admin",
      passwordSalt: "salt-admin",
      role: "admin",
    });
    const target = store.createUser({
      id: "operator-a",
      email: "operator@example.com",
      passwordHash: "hash-operator",
      passwordSalt: "salt-operator",
      role: "operator",
    });
    store.createBatch({ userId: target.id, batchId: "owned-batch" });
    store.createSession({ userId: target.id, batchId: "owned-batch", id: "owned-session" });
    store.appendMessage({
      userId: target.id,
      batchId: "owned-batch",
      sessionId: "owned-session",
      role: "user",
      content: "owned message",
    });
    store.createSopTemplate({
      id: "owned-template",
      version: "owned-v1",
      name: "Owned",
      config: {},
      createdBy: target.id,
    });

    expect(store.listUsers().map((user) => user.email)).toEqual([
      "admin@example.com",
      "operator@example.com",
    ]);
    expect(() => store.deleteUser({
      userId: target.id,
      actorUserId: admin.id,
      confirmEmail: "wrong@example.com",
    })).toThrowError(expect.objectContaining({ code: "LOCAL_STORE_USER_CONFIRM_MISMATCH" }));

    store.deleteUser({
      userId: target.id,
      actorUserId: admin.id,
      confirmEmail: target.email,
    });
    expect(store.getUserById(target.id)).toBeNull();
    expect(store.getBatch(target.id, "owned-batch")).toBeNull();
    expect(store.listSessions(target.id, "owned-batch")).toEqual([]);
    expect(store.listSopTemplates().find((template) => template.id === "owned-template")?.createdBy)
      .toBe(admin.id);
    store.close();
  });

  it("protects the current administrator and duplicate normalized emails", () => {
    const store = memoryStore();
    const admin = store.createUser({
      id: "admin-a",
      email: "ADMIN@example.com",
      passwordHash: "hash-admin",
      passwordSalt: "salt-admin",
      role: "admin",
    });
    expect(() => store.createUser({
      email: " admin@EXAMPLE.com ",
      passwordHash: "hash-other",
      passwordSalt: "salt-other",
      role: "operator",
    })).toThrowError(expect.objectContaining({ code: "LOCAL_STORE_USER_EXISTS" }));
    expect(() => store.deleteUser({
      userId: admin.id,
      actorUserId: admin.id,
      confirmEmail: admin.email,
    })).toThrowError(expect.objectContaining({ code: "LOCAL_STORE_USER_SELF_DELETE" }));
    store.close();
  });
});
