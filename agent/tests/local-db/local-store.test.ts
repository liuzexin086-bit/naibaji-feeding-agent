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
import { loadFrozenBatchDecisionContext } from "../../src/decision/batch-decision-service.js";
import type { FeedingDecision } from "../../src/shared/agent-v2-contract.js";

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
      "feeding_decisions",
      "agent_sessions",
      "agent_messages",
      "audit_events",
    ]));
    expect(database.prepare("SELECT count(*) AS count FROM schema_migrations").get()?.count).toBe(1);
    expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    const indexes = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
    `).all().map((row) => String(row.name));
    expect(indexes).toEqual(expect.arrayContaining([
      "batches_user_revision_idx",
      "daily_observations_batch_date_revision_idx",
      "daily_operation_plans_batch_business_date_idx",
      "daily_operation_confirmations_plan_idx",
      "feeding_decisions_batch_date_revision_idx",
      "agent_messages_session_batch_idx",
    ]));
    database.close();
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
    legacy.exec("DELETE FROM schema_migrations; INSERT INTO schema_migrations (version, applied_at) VALUES (3, '2026-08-04T00:00:00.000Z');");
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

  it("rejects stale decisions and round-trips complete evidence without recalculation", () => {
    const store = memoryStore();
    store.createBatch({ userId: "user-a", batchId: "batch-1", revision: 7 });

    expect(() => store.saveDecision({
      userId: "user-a",
      decision: decision("batch-1", 6),
    })).toThrowError(expect.objectContaining({ code: "LOCAL_STORE_STALE_REVISION" }));

    const expected = decision("batch-1", 7);
    store.saveDecision({ userId: "user-a", decision: expected, idempotencyKey: "decision-7" });
    expect(store.getActiveDecision("user-a", "batch-1", "2026-07-31")).toEqual(expected);
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
