import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleLocalApi } from "../../src/container/local-api.js";
import {
  computeFrozenBatchDecision,
  loadFrozenBatchDecisionContext,
} from "../../src/decision/batch-decision-service.js";
import { initializeLocalAdmin } from "../../src/container/local-auth.js";
import { createLocalStore, type SqliteLocalStore } from "../../src/local-db/index.js";
import type { DevicePlanSnapshot } from "../../src/shared/local-store-contract.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function startApi(): Promise<{
  store: SqliteLocalStore;
  filename: string;
  base: string;
  cookie: string;
  userId: string;
}> {
  const directory = mkdtempSync(join(tmpdir(), "naibaji-mode-switch-"));
  const filename = join(directory, "local.sqlite");
  const store = createLocalStore({ filename }) as SqliteLocalStore;
  store.migrate();
  initializeLocalAdmin(store, "admin@example.com", "correct-horse-battery");
  const server: Server = createServer((request, response) => {
    void handleLocalApi(request, response, store);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  cleanups.push(() => {
    server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${address.port}`;
  const login = await apiRequest(base, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "admin@example.com", password: "correct-horse-battery" }),
  });
  const setCookie = login.headers.get("set-cookie");
  if (!setCookie) throw new Error("missing session cookie");
  const loginBody = await login.json() as { user: { id: string } };
  return { store, filename, base, cookie: setCookie.split(";", 1)[0], userId: loginBody.user.id };
}

function apiRequest(base: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function slotRows(first: { startLocal: string; endLocal: string }) {
  return Array.from({ length: 8 }, (_, index) => ({
    slot: index + 1,
    enabled: index === 0,
    label: `时段 ${index + 1}`,
    startLocal: index === 0 ? first.startLocal : "09:00",
    endLocal: index === 0 ? first.endLocal : "10:00",
  }));
}

function mutateBatchConfig(
  filename: string,
  batchId: string,
  mutate: (config: Record<string, unknown>) => void,
): void {
  const database = new DatabaseSync(filename);
  try {
    const row = database.prepare("SELECT data_json FROM batches WHERE id = ?").get(batchId) as {
      data_json?: string;
    } | undefined;
    if (!row?.data_json) throw new Error("missing batch data");
    const data = JSON.parse(row.data_json) as { config?: Record<string, unknown> };
    if (!data.config) throw new Error("missing batch config");
    mutate(data.config);
    database.prepare("UPDATE batches SET data_json = ? WHERE id = ?")
      .run(JSON.stringify(data), batchId);
  } finally {
    database.close();
  }
}

async function createBatch(base: string, cookie: string): Promise<{
  batch: { id: string; revision: number; selectedMode: string; devicePlanVersion: string;
    devicePlanSha256: string; availableModes: string[] };
  today: {
    selectedMode: string;
    effectiveMode: string;
    sopRef: {
      templateId: string;
      version: string;
      sourceSha256: string;
      collectionRevision: string;
      parserVersion: string;
      embeddingModel: string;
    };
    devicePlanRef: { version: string; sha256: string };
    mealTimes: string[];
    freeWindows: unknown[];
    setting: { mode: string; freeWindows: unknown[] };
  };
}> {
  const response = await apiRequest(base, "/api/batches", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ name: "模式测试", startAge: 3, endAge: 12, headCount: 20 }),
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<never>;
}

describe("batch device plan snapshot and mode switching", () => {
  it("freezes all eight published slots and gives a republished slot program a new immutable device hash", async () => {
    const { store, base, cookie, userId } = await startApi();
    const firstPublish = await apiRequest(base, "/api/admin/sop/templates", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        version: "slots-v1",
        name: "八时段一版",
        config: { freeFeedingTemplate: { windows: slotRows({ startLocal: "23:00", endLocal: "02:00" }) } },
      }),
    });
    expect(firstPublish.status).toBe(201);
    const firstBatch = await createBatch(base, cookie);
    const firstSnapshot = (store.getBatch(userId, firstBatch.batch.id)!.data.config as Record<string, unknown>)
      .devicePlanSnapshot as DevicePlanSnapshot;

    const secondPublish = await apiRequest(base, "/api/admin/sop/templates", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        version: "slots-v2",
        name: "八时段二版",
        config: { freeFeedingTemplate: { windows: slotRows({ startLocal: "22:00", endLocal: "01:00" }) } },
      }),
    });
    expect(secondPublish.status).toBe(201);
    const secondBatch = await createBatch(base, cookie);
    const secondSnapshot = (store.getBatch(userId, secondBatch.batch.id)!.data.config as Record<string, unknown>)
      .devicePlanSnapshot as DevicePlanSnapshot;

    expect(firstSnapshot.templates.free_feeding.slots).toHaveLength(8);
    expect(secondSnapshot.templates.free_feeding.slots).toHaveLength(8);
    expect(firstSnapshot.templates.free_feeding.windows).toEqual([{ startLocal: "23:00", endLocal: "02:00" }]);
    expect(secondSnapshot.templates.free_feeding.windows).toEqual([{ startLocal: "22:00", endLocal: "01:00" }]);
    expect(secondSnapshot.sha256).not.toBe(firstSnapshot.sha256);
    expect((store.getBatch(userId, firstBatch.batch.id)!.data.config as Record<string, unknown>)
      .devicePlanSnapshot).toEqual(firstSnapshot);
  });

  it("freezes two independent templates and switches with revision, idempotency, and audit safety", async () => {
    const { store, filename, base, cookie, userId } = await startApi();
    const created = await createBatch(base, cookie);
    expect(created.batch).toMatchObject({
      revision: 0,
      selectedMode: "timed_quantity",
      availableModes: ["timed_quantity", "free_feeding"],
    });
    expect(created.batch.devicePlanVersion).toBeTruthy();
    expect(created.batch.devicePlanSha256).toMatch(/^[A-F0-9]{64}$/);
    expect(created.today.mealTimes).toEqual([
      "17:00", "20:00", "23:00", "02:00", "05:00", "08:00",
    ]);

    const storedAtCreation = store.getBatch(userId, created.batch.id);
    expect(storedAtCreation).not.toBeNull();
    const creationConfig = storedAtCreation!.data.config as Record<string, unknown>;
    const frozen = structuredClone(creationConfig.devicePlanSnapshot) as DevicePlanSnapshot;
    expect(frozen.templates.timed_quantity).toMatchObject({
      mealTimes: [
        "10:00", "14:00", "16:00", "18:00", "20:00",
        "22:00", "02:00", "04:00", "06:00", "08:00",
      ],
      excludedMealTimes: ["00:00", "12:00"],
      precisionGrams: 1,
    });
    expect(frozen.templates.free_feeding.windows).toHaveLength(1);
    expect(frozen.templates.free_feeding.windows.length).toBeLessThanOrEqual(8);
    expect(frozen.templates.free_feeding.slots).toHaveLength(8);
    expect(frozen.templates.free_feeding.slots.map((slot) => slot.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(frozen.templates.free_feeding.slots.filter((slot) => slot.enabled)).toHaveLength(1);
    expect(frozen.templates.free_feeding.stageConditions).toEqual({
      earliestBatchDay: 1,
      requiresOperatorSelection: true,
    });
    expect(frozen.templates.free_feeding.exceptionBlockers).toContain("milk_control");
    const frozenSop = creationConfig.sopTemplate as Record<string, unknown>;
    expect(created.today).toMatchObject({
      selectedMode: "timed_quantity",
      effectiveMode: "timed_quantity",
      sopRef: {
        templateId: frozenSop.templateId,
        version: frozenSop.version,
        sourceSha256: frozenSop.sourceSha256,
        collectionRevision: frozenSop.collectionRevision,
        parserVersion: frozenSop.parserVersion,
        embeddingModel: frozenSop.embeddingModel,
      },
      devicePlanRef: { version: frozen.version, sha256: frozen.sha256 },
    });

    const locked = await apiRequest(base, `/api/batches/${created.batch.id}/mode`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ mode: "free_feeding", expectedRevision: 0, idempotencyKey: "day-0" }),
    });
    expect(locked.status).toBe(409);
    expect(await locked.json()).toEqual({ code: "NBJ_BATCH_MODE_FIRST_DAY_LOCKED" });

    const advanced = await apiRequest(base, `/api/batches/${created.batch.id}/advance`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: 0,
        idempotencyKey: "advance-day-0",
        observation: { effectiveHeads: 20, creepGrade: "high", diarrheaGrade: "none", actualPowderGrams: 0 },
      }),
    });
    expect(advanced.status).toBe(200);

    const day1ActualZero = await apiRequest(base, `/api/batches/${created.batch.id}/records`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: 1,
        idempotencyKey: "day1-actual-zero",
        observation: { effectiveHeads: 20, creepGrade: "none", diarrheaGrade: "none", actualPowderGrams: 0 },
      }),
    });
    expect(day1ActualZero.status).toBe(200);

    const switchPayload = {
      mode: "free_feeding",
      expectedRevision: 2,
      idempotencyKey: "switch-free-1",
    };
    const switched = await apiRequest(base, `/api/batches/${created.batch.id}/mode`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify(switchPayload),
    });
    expect(switched.status).toBe(200);
    const switchedBody = await switched.json() as {
      batch: { revision: number; selectedMode: string; devicePlanSha256: string };
      today: { freeWindows: unknown[]; setting: { mode: string; freeWindows: unknown[] } };
    };
    expect(switchedBody.batch).toMatchObject({ revision: 3, selectedMode: "free_feeding" });
    expect(switchedBody.batch.devicePlanSha256).toBe(frozen.sha256);
    expect(switchedBody.today.setting.mode).toBe("free_feeding");
    expect(switchedBody.today.setting.freeWindows).toEqual(frozen.templates.free_feeding.windows);
    expect(switchedBody.today.freeWindows).toEqual(frozen.templates.free_feeding.windows);

    const replay = await apiRequest(base, `/api/batches/${created.batch.id}/mode`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify(switchPayload),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(switchedBody);

    const afterFree = store.getBatch(userId, created.batch.id)!;
    const afterFreeConfig = afterFree.data.config as Record<string, unknown>;
    expect(afterFreeConfig.devicePlanSnapshot).toEqual(frozen);
    expect(afterFreeConfig.selectedMode).toBe("free_feeding");

    const stale = await apiRequest(base, `/api/batches/${created.batch.id}/mode`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ mode: "timed_quantity", expectedRevision: 2, idempotencyKey: "stale-switch" }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ code: "NBJ_BATCH_STALE" });

    const switchedBack = await apiRequest(base, `/api/batches/${created.batch.id}/mode`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ mode: "timed_quantity", expectedRevision: 3, idempotencyKey: "switch-timed-2" }),
    });
    expect(switchedBack.status).toBe(200);
    expect((await switchedBack.json() as { batch: { revision: number; selectedMode: string } }).batch)
      .toMatchObject({ revision: 4, selectedMode: "timed_quantity" });

    const secondAdvance = await apiRequest(base, `/api/batches/${created.batch.id}/advance`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: 4,
        idempotencyKey: "advance-day-1",
        observation: { effectiveHeads: 20, creepGrade: "high", diarrheaGrade: "none" },
      }),
    });
    expect(secondAdvance.status).toBe(200);
    const secondAdvanceBody = await secondAdvance.json() as { today: { mealTimes: string[] } };
    expect(secondAdvanceBody.today.mealTimes).toEqual([
      "10:00", "14:00", "16:00", "18:00", "22:00", "02:00", "04:00", "06:00", "08:00",
    ]);
    expect(store.getBatch(userId, created.batch.id)!.data.config).toMatchObject({
      selectedMode: "timed_quantity",
      devicePlanSnapshot: frozen,
    });

    const auditDb = new DatabaseSync(filename, { readOnly: true });
    cleanups.push(() => auditDb.close());
    const auditRows = auditDb.prepare(`
      SELECT action, details_json FROM audit_events
      WHERE batch_id = ? AND action = 'batch.mode_switched'
      ORDER BY created_at ASC
    `).all(created.batch.id) as Array<{ action: string; details_json: string }>;
    expect(auditRows).toHaveLength(2);
    expect(JSON.parse(auditRows[0]!.details_json)).toMatchObject({
      fromMode: "timed_quantity",
      toMode: "free_feeding",
      previousRevision: 2,
      newRevision: 3,
      devicePlanVersion: frozen.version,
      devicePlanSha256: frozen.sha256,
    });
  });

  it("fails closed without a frozen SOP and returns no numeric payload", async () => {
    const { base, cookie, filename } = await startApi();
    const created = await createBatch(base, cookie);
    mutateBatchConfig(filename, created.batch.id, (config) => {
      delete config.sopTemplate;
    });

    const response = await apiRequest(base, `/api/batches/${created.batch.id}`, { headers: { cookie } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "NBJ_FROZEN_SOP_MISSING" });
  });

  it("rejects free mode before the frozen earliest day without changing selected mode", async () => {
    const { base, cookie, filename } = await startApi();
    const created = await createBatch(base, cookie);
    const advanced = await apiRequest(base, `/api/batches/${created.batch.id}/advance`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: 0,
        idempotencyKey: "advance-eligibility",
        observation: { effectiveHeads: 20, creepGrade: "none", diarrheaGrade: "none" },
      }),
    });
    expect(advanced.status).toBe(200);
    mutateBatchConfig(filename, created.batch.id, (config) => {
      const snapshot = config.devicePlanSnapshot as Record<string, unknown> & {
        templates: {
          free_feeding: { stageConditions: Record<string, unknown> };
        };
      };
      snapshot.templates.free_feeding.stageConditions = {
        earliestBatchDay: 3,
        requiresOperatorSelection: true,
      };
      snapshot.sha256 = createHash("sha256")
        .update(JSON.stringify({
          version: snapshot.version,
          firstDay: snapshot.firstDay,
          templates: snapshot.templates,
        }).normalize("NFC"), "utf8")
        .digest("hex")
        .toUpperCase();
    });
    const switched = await apiRequest(base, `/api/batches/${created.batch.id}/mode`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        mode: "free_feeding",
        expectedRevision: 1,
        idempotencyKey: "eligibility-free",
      }),
    });
    expect(switched.status).toBe(409);
    expect(await switched.json()).toEqual({ code: "NBJ_FREE_FEEDING_NOT_ELIGIBLE" });
    const batch = await apiRequest(base, `/api/batches/${created.batch.id}`, {
      headers: { cookie },
    });
    expect((await batch.json() as { batch: { selectedMode: string } }).batch.selectedMode)
      .toBe("timed_quantity");
  });

  it("rejects free mode when frozen exception blocker schema is invalid", async () => {
    const { base, cookie, filename } = await startApi();
    const created = await createBatch(base, cookie);
    const advanced = await apiRequest(base, `/api/batches/${created.batch.id}/advance`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: 0,
        idempotencyKey: "advance-blocker-schema",
        observation: { effectiveHeads: 20, creepGrade: "none", diarrheaGrade: "none" },
      }),
    });
    expect(advanced.status).toBe(200);
    mutateBatchConfig(filename, created.batch.id, (config) => {
      const snapshot = config.devicePlanSnapshot as Record<string, unknown> & {
        templates: {
          free_feeding: { exceptionBlockers: string[] };
        };
      };
      snapshot.templates.free_feeding.exceptionBlockers = ["something_random"];
      snapshot.sha256 = createHash("sha256")
        .update(JSON.stringify({
          version: snapshot.version,
          firstDay: snapshot.firstDay,
          templates: snapshot.templates,
        }).normalize("NFC"), "utf8")
        .digest("hex")
        .toUpperCase();
    });
    const switched = await apiRequest(base, `/api/batches/${created.batch.id}/mode`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        mode: "free_feeding",
        expectedRevision: 1,
        idempotencyKey: "blocker-schema-free",
      }),
    });
    expect(switched.status).toBe(409);
    expect(await switched.json()).toEqual({ code: "NBJ_FREE_FEEDING_NOT_ELIGIBLE" });
    const batch = await apiRequest(base, `/api/batches/${created.batch.id}`, {
      headers: { cookie },
    });
    expect((await batch.json() as { batch: { selectedMode: string } }).batch.selectedMode)
      .toBe("timed_quantity");
  });

  it("routes confirmed-plan mode switch through mode_change amendment and applies atomically", async () => {
    const { base, cookie, store, userId } = await startApi();
    const created = await createBatch(base, cookie);
    const day0 = await apiRequest(base, `/api/batches/${created.batch.id}/today-operations`, {
      headers: { cookie },
    });
    const day0Body = await day0.json() as { plan: { id: string; operationsSha256: string } };
    const day0Confirm = await apiRequest(
      base,
      `/api/batches/${created.batch.id}/today-operations/confirm`,
      {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({
          planId: day0Body.plan.id,
          operationsSha256: day0Body.plan.operationsSha256,
          idempotencyKey: "confirm-day0-mode-amendment",
        }),
      },
    );
    expect(day0Confirm.status).toBe(200);
    const advanced = await apiRequest(base, `/api/batches/${created.batch.id}/advance`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: 0,
        idempotencyKey: "advance-mode-amendment",
        observation: { effectiveHeads: 20, creepGrade: "none", diarrheaGrade: "none", actualPowderGrams: 0 },
      }),
    });
    expect(advanced.status).toBe(200);
    const day1ActualZero = await apiRequest(base, `/api/batches/${created.batch.id}/records`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: 1,
        idempotencyKey: "mode-amendment-day1-actual-zero",
        observation: { effectiveHeads: 20, creepGrade: "none", diarrheaGrade: "none", actualPowderGrams: 0 },
      }),
    });
    expect(day1ActualZero.status).toBe(200);
    const day1 = await apiRequest(base, `/api/batches/${created.batch.id}/today-operations`, {
      headers: { cookie },
    });
    const day1Body = await day1.json() as { plan: { id: string; operationsSha256: string } };
    const day1Confirm = await apiRequest(
      base,
      `/api/batches/${created.batch.id}/today-operations/confirm`,
      {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({
          planId: day1Body.plan.id,
          operationsSha256: day1Body.plan.operationsSha256,
          idempotencyKey: "confirm-day1-mode-amendment",
        }),
      },
    );
    expect(day1Confirm.status).toBe(200);
    const currentBatch = store.getBatch(userId, created.batch.id)!;
    const currentData = currentBatch.data as {
      config: Record<string, unknown>;
      records?: unknown[];
    };
    const canonical = computeFrozenBatchDecision(loadFrozenBatchDecisionContext({
      batchId: currentBatch.batchId,
      revision: currentBatch.revision,
      currentDayIndex: currentBatch.currentDay,
      config: currentData.config,
      records: Array.isArray(currentData.records) ? currentData.records : [],
    }));
    store.saveDecision({
      userId,
      batchId: created.batch.id,
      decision: canonical.decision,
    });
    const activeBefore = store.getActiveDecisionRecord(userId, created.batch.id);
    expect(activeBefore).not.toBeNull();
    const beforeRecordToday = await apiRequest(base, `/api/batches/${created.batch.id}`, {
      headers: { cookie },
    });
    const beforeRecordTodayBody = await beforeRecordToday.json() as {
      today: { activeDecisionId: string | null };
    };
    expect(beforeRecordTodayBody.today.activeDecisionId).toBe(activeBefore!.id);
    const recordAfterConfirm = await apiRequest(base, `/api/batches/${created.batch.id}/records`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: 2,
        idempotencyKey: "mode-amendment-record-after-confirm",
        observation: { effectiveHeads: 20, creepGrade: "none", diarrheaGrade: "none", actualPowderGrams: 0 },
      }),
    });
    expect(recordAfterConfirm.status).toBe(200);
    const recordAfterConfirmBody = await recordAfterConfirm.json() as {
      records: Array<{ activeDecisionIdAtCommit: string | null }>;
    };
    expect(recordAfterConfirmBody.records.at(-1)?.activeDecisionIdAtCommit)
      .toBe(activeBefore!.id);

    const switched = await apiRequest(base, `/api/batches/${created.batch.id}/mode`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        mode: "free_feeding",
        expectedRevision: 3,
        idempotencyKey: "mode-amendment-create",
      }),
    });
    expect(switched.status).toBe(200);
    const amendmentBody = await switched.json() as {
      amendment: {
        id: string;
        amendmentSha256: string;
        originKind: string;
        status: string;
      };
    };
    expect(amendmentBody.amendment).toMatchObject({
      originKind: "mode_change",
      status: "pending",
    });
    const batchBefore = store.getBatch(userId, created.batch.id);
    expect(batchBefore?.data.config).toMatchObject({ selectedMode: "timed_quantity" });

    const confirmed = await apiRequest(
      base,
      `/api/batches/${created.batch.id}/amendments/${amendmentBody.amendment.id}/confirm`,
      {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({
          expectedRevision: 3,
          expectedAmendmentSha256: amendmentBody.amendment.amendmentSha256,
          idempotencyKey: "confirm-mode-amendment",
        }),
      },
    );
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json() as { amendment: { status: string; decisionId: string | null } }).amendment)
      .toMatchObject({ status: "confirmed", decisionId: null });
    expect(store.getBatch(userId, created.batch.id)?.data.config)
      .toMatchObject({ selectedMode: "timed_quantity" });

    const applied = await apiRequest(
      base,
      `/api/batches/${created.batch.id}/amendments/${amendmentBody.amendment.id}/apply`,
      {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({
          expectedRevision: 3,
          expectedAmendmentSha256: amendmentBody.amendment.amendmentSha256,
          idempotencyKey: "apply-mode-amendment",
        }),
      },
    );
    expect(applied.status).toBe(200);
    const appliedBody = await applied.json() as {
      amendment: { status: string; decisionId: string | null };
    };
    expect(appliedBody.amendment).toMatchObject({ status: "applied" });
    expect(appliedBody.amendment.decisionId).toBeTruthy();
    expect(store.getBatch(userId, created.batch.id)?.data.config)
      .toMatchObject({ selectedMode: "free_feeding" });
    expect(store.getBatch(userId, created.batch.id)?.revision).toBe(4);

    const activeAfter = store.getActiveDecisionRecord(userId, created.batch.id);
    expect(activeAfter).not.toBeNull();
    expect(activeAfter!.id).not.toBe(activeBefore!.id);
    const recordAfterApply = await apiRequest(base, `/api/batches/${created.batch.id}/records`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: 4,
        idempotencyKey: "mode-amendment-record-after-apply",
        observation: { effectiveHeads: 20, creepGrade: "none", diarrheaGrade: "none", actualPowderGrams: 0 },
      }),
    });
    expect(recordAfterApply.status).toBe(200);
    const recordAfterApplyBody = await recordAfterApply.json() as {
      records: Array<{ activeDecisionIdAtCommit: string | null }>;
    };
    expect(recordAfterApplyBody.records.at(-1)?.activeDecisionIdAtCommit)
      .toBe(activeAfter!.id);
  });

  it("rejects mode switch when cumulative actual is unknown or already executed", async () => {
    const { base, cookie } = await startApi();
    const unknownBatch = await createBatch(base, cookie);
    const unknownAdvance = await apiRequest(base, `/api/batches/${unknownBatch.batch.id}/advance`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: 0,
        idempotencyKey: "advance-unknown-actual",
        observation: { effectiveHeads: 20, creepGrade: "none", diarrheaGrade: "none" },
      }),
    });
    expect(unknownAdvance.status).toBe(200);
    const unknownSwitch = await apiRequest(base, `/api/batches/${unknownBatch.batch.id}/mode`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        mode: "free_feeding",
        expectedRevision: 1,
        idempotencyKey: "switch-unknown-actual",
      }),
    });
    expect(unknownSwitch.status).toBe(409);
    expect(await unknownSwitch.json()).toEqual({ code: "NBJ_MODE_SWITCH_ACTUAL_UNKNOWN" });

    const executedBatch = await createBatch(base, cookie);
    const executedAdvance = await apiRequest(base, `/api/batches/${executedBatch.batch.id}/advance`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: 0,
        idempotencyKey: "advance-executed-actual",
        observation: { effectiveHeads: 20, creepGrade: "none", diarrheaGrade: "none", actualPowderGrams: 180 },
      }),
    });
    expect(executedAdvance.status).toBe(200);
    const executedDayActual = await apiRequest(base, `/api/batches/${executedBatch.batch.id}/records`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: 1,
        idempotencyKey: "executed-day-actual",
        observation: { effectiveHeads: 20, creepGrade: "none", diarrheaGrade: "none", actualPowderGrams: 180 },
      }),
    });
    expect(executedDayActual.status).toBe(200);
    const executedSwitch = await apiRequest(base, `/api/batches/${executedBatch.batch.id}/mode`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        mode: "free_feeding",
        expectedRevision: 2,
        idempotencyKey: "switch-executed-actual",
      }),
    });
    expect(executedSwitch.status).toBe(409);
    expect(await executedSwitch.json())
      .toEqual({ code: "NBJ_MODE_SWITCH_AFTER_EXECUTION_BLOCKED" });

    const allowedBatch = await createBatch(base, cookie);
    const allowedAdvance = await apiRequest(base, `/api/batches/${allowedBatch.batch.id}/advance`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: 0,
        idempotencyKey: "advance-allowed-actual",
        observation: { effectiveHeads: 20, creepGrade: "none", diarrheaGrade: "none", actualPowderGrams: 0 },
      }),
    });
    expect(allowedAdvance.status).toBe(200);
    const allowedDayActual = await apiRequest(base, `/api/batches/${allowedBatch.batch.id}/records`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: 1,
        idempotencyKey: "allowed-day-actual",
        observation: { effectiveHeads: 20, creepGrade: "none", diarrheaGrade: "none", actualPowderGrams: 0 },
      }),
    });
    expect(allowedDayActual.status).toBe(200);
    const allowedSwitch = await apiRequest(base, `/api/batches/${allowedBatch.batch.id}/mode`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        mode: "free_feeding",
        expectedRevision: 2,
        idempotencyKey: "switch-allowed-actual",
      }),
    });
    expect(allowedSwitch.status).toBe(200);
  });

  it("fails mode_change apply when batch state changes after confirm", async () => {
    const { base, cookie, store, userId } = await startApi();
    const created = await createBatch(base, cookie);
    const advance = await apiRequest(base, `/api/batches/${created.batch.id}/advance`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: 0,
        idempotencyKey: "apply-blocked-advance",
        observation: { effectiveHeads: 20, creepGrade: "none", diarrheaGrade: "none", actualPowderGrams: 0 },
      }),
    });
    expect(advance.status).toBe(200);
    const dayActual = await apiRequest(base, `/api/batches/${created.batch.id}/records`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: 1,
        idempotencyKey: "apply-blocked-day-zero",
        observation: { effectiveHeads: 20, creepGrade: "none", diarrheaGrade: "none", actualPowderGrams: 0 },
      }),
    });
    expect(dayActual.status).toBe(200);
    const today = await apiRequest(base, `/api/batches/${created.batch.id}/today-operations`, {
      headers: { cookie },
    });
    const todayBody = await today.json() as { plan: { id: string; operationsSha256: string } };
    const confirmed = await apiRequest(
      base,
      `/api/batches/${created.batch.id}/today-operations/confirm`,
      {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({
          planId: todayBody.plan.id,
          operationsSha256: todayBody.plan.operationsSha256,
          idempotencyKey: "apply-blocked-confirm-plan",
        }),
      },
    );
    expect(confirmed.status).toBe(200);
    const batch = store.getBatch(userId, created.batch.id)!;
    const data = batch.data as { config: Record<string, unknown>; records?: unknown[] };
    const canonical = computeFrozenBatchDecision(loadFrozenBatchDecisionContext({
      batchId: batch.batchId,
      revision: batch.revision,
      currentDayIndex: batch.currentDay,
      config: data.config,
      records: Array.isArray(data.records) ? data.records : [],
    }));
    store.saveDecision({ userId, batchId: created.batch.id, decision: canonical.decision });
    const modeSwitch = await apiRequest(base, `/api/batches/${created.batch.id}/mode`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        mode: "free_feeding",
        expectedRevision: 2,
        idempotencyKey: "apply-blocked-mode-create",
      }),
    });
    expect(modeSwitch.status).toBe(200);
    const amendment = (await modeSwitch.json() as {
      amendment: { id: string; amendmentSha256: string };
    }).amendment;
    const confirmAmendment = await apiRequest(
      base,
      `/api/batches/${created.batch.id}/amendments/${amendment.id}/confirm`,
      {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({
          expectedRevision: 2,
          expectedAmendmentSha256: amendment.amendmentSha256,
          idempotencyKey: "apply-blocked-confirm-amendment",
        }),
      },
    );
    expect(confirmAmendment.status).toBe(200);
    const executed = await apiRequest(base, `/api/batches/${created.batch.id}/records`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: 2,
        idempotencyKey: "apply-blocked-executed",
        observation: { effectiveHeads: 20, creepGrade: "none", diarrheaGrade: "none", actualPowderGrams: 180 },
      }),
    });
    expect(executed.status).toBe(200);
    const applied = await apiRequest(
      base,
      `/api/batches/${created.batch.id}/amendments/${amendment.id}/apply`,
      {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({
          expectedRevision: 3,
          expectedAmendmentSha256: amendment.amendmentSha256,
          idempotencyKey: "apply-blocked-apply",
        }),
      },
    );
    expect(applied.status).toBe(400);
    expect(await applied.json()).toEqual({ code: "NBJ_AMENDMENT_STALE" });
  });

  it("fails closed on a stale or tampered frozen SOP receipt and returns no numeric payload", async () => {
    const { base, cookie, filename } = await startApi();
    const created = await createBatch(base, cookie);
    mutateBatchConfig(filename, created.batch.id, (config) => {
      const frozen = config.sopTemplate as Record<string, unknown>;
      frozen.snapshotSha256 = "0".repeat(64);
    });

    const response = await apiRequest(base, `/api/batches/${created.batch.id}`, { headers: { cookie } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "NBJ_FROZEN_SOP_SNAPSHOT_DIGEST_MISMATCH" });
  });

  it("fails closed without a frozen device snapshot and returns no numeric payload", async () => {
    const { base, cookie, filename } = await startApi();
    const created = await createBatch(base, cookie);
    mutateBatchConfig(filename, created.batch.id, (config) => {
      delete config.devicePlanSnapshot;
    });

    const response = await apiRequest(base, `/api/batches/${created.batch.id}`, { headers: { cookie } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "NBJ_FROZEN_DEVICE_PLAN_MISSING" });
  });

  it("fails closed on a tampered frozen device snapshot and returns no numeric payload", async () => {
    const { base, cookie, filename } = await startApi();
    const created = await createBatch(base, cookie);
    mutateBatchConfig(filename, created.batch.id, (config) => {
      const snapshot = config.devicePlanSnapshot as Record<string, unknown>;
      snapshot.sha256 = "0".repeat(64);
    });

    const response = await apiRequest(base, `/api/batches/${created.batch.id}`, { headers: { cookie } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "NBJ_FROZEN_DEVICE_PLAN_DIGEST_MISMATCH" });
  });

  it("keeps free-feeding mode active when diarrhea is recorded and leaves device exceptions to feedback", async () => {
    const { base, cookie } = await startApi();
    const created = await createBatch(base, cookie);
    const advanced = await apiRequest(base, `/api/batches/${created.batch.id}/advance`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: 0,
        idempotencyKey: "advance-with-diarrhea",
        observation: { effectiveHeads: 20, creepGrade: "none", diarrheaGrade: "mild", actualPowderGrams: 0 },
      }),
    });
    expect(advanced.status).toBe(200);
    const day1ActualZero = await apiRequest(base, `/api/batches/${created.batch.id}/records`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: 1,
        idempotencyKey: "diarrhea-day1-actual-zero",
        observation: { effectiveHeads: 20, creepGrade: "none", diarrheaGrade: "none", actualPowderGrams: 0 },
      }),
    });
    expect(day1ActualZero.status).toBe(200);
    const switched = await apiRequest(base, `/api/batches/${created.batch.id}/mode`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ mode: "free_feeding", expectedRevision: 2, idempotencyKey: "free-blocked" }),
    });
    expect(switched.status).toBe(200);
    const body = await switched.json() as {
      batch: { selectedMode: string };
      today: { setting: { mode: string }; exceptionActions: Array<{ type: string }> };
    };
    expect(body.batch.selectedMode).toBe("free_feeding");
    expect(body.today.setting.mode).toBe("free_feeding");
    expect(body.today.exceptionActions.map((action) => action.type)).not.toContain("diarrhea");
  });
});
