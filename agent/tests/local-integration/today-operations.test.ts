import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { handleLocalApi } from "../../src/container/local-api.js";
import { initializeLocalAdmin } from "../../src/container/local-auth.js";
import { createLocalStore, type SqliteLocalStore } from "../../src/local-db/index.js";

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
  const directory = mkdtempSync(join(tmpdir(), "naibaji-today-operations-"));
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
  const login = await request(base, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "admin@example.com", password: "correct-horse-battery" }),
  });
  const setCookie = login.headers.get("set-cookie");
  if (!setCookie) throw new Error("missing session cookie");
  const body = await login.json() as { user: { id: string } };
  return { store, filename, base, cookie: setCookie.split(";", 1)[0], userId: body.user.id };
}

function request(base: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("today operations API", () => {
  it("returns one frozen current-day plan and confirms it once without changing the batch revision", async () => {
    const { store, filename, base, cookie, userId } = await startApi();
    const created = await request(base, "/api/batches", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ name: "当日任务测试", startAge: 3, endAge: 12, headCount: 20 }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { batch: { id: string; revision: number } };

    const first = await request(base, `/api/batches/${createdBody.batch.id}/today-operations`, {
      headers: { cookie },
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { plan: {
      id: string; businessDate: string; status: string; basedOnBatchRevision: number;
      operationsSha256: string; operations: Array<{ code: string }>;
    } };
    expect(firstBody.plan).toMatchObject({ status: "pending", basedOnBatchRevision: 0 });
    expect(firstBody.plan.operations.map((item) => item.code)).toEqual([
      "first_day_admission",
      "first_day_health_check",
      "first_day_water_stop",
      "first_day_mode_setup",
      "first_day_teaching",
    ]);

    const second = await request(base, `/api/batches/${createdBody.batch.id}/today-operations`, {
      headers: { cookie },
    });
    expect((await second.json() as { plan: { id: string; operationsSha256: string } }).plan)
      .toEqual(expect.objectContaining({ id: firstBody.plan.id, operationsSha256: firstBody.plan.operationsSha256 }));
    const wrongDate = await request(base, `/api/batches/${createdBody.batch.id}/today-operations?dateLocal=2000-01-01`, {
      headers: { cookie },
    });
    expect(wrongDate.status).toBe(400);
    expect(await wrongDate.json()).toEqual({ code: "NBJ_DAILY_OPERATION_DATE_INVALID" });

    const confirmed = await request(base, `/api/batches/${createdBody.batch.id}/today-operations/confirm`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        planId: firstBody.plan.id,
        operationsSha256: firstBody.plan.operationsSha256,
        idempotencyKey: "today-operations-confirm-1",
      }),
    });
    expect(confirmed.status).toBe(200);
    const confirmedBody = await confirmed.json() as {
      plan: { status: string };
      confirmation: { id: string; operationsSha256: string };
      replayed: boolean;
    };
    expect(confirmedBody).toMatchObject({
      plan: { status: "confirmed" },
      confirmation: { operationsSha256: firstBody.plan.operationsSha256 },
      replayed: false,
    });
    expect(store.getBatch(userId, createdBody.batch.id)?.revision).toBe(0);

    const afterConfirmation = await request(base, `/api/batches/${createdBody.batch.id}/today-operations`, {
      headers: { cookie },
    });
    expect(await afterConfirmation.json()).toMatchObject({
      plan: { id: firstBody.plan.id, status: "confirmed" },
      confirmation: { id: confirmedBody.confirmation.id },
    });

    const duplicate = await request(base, `/api/batches/${createdBody.batch.id}/today-operations/confirm`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        planId: firstBody.plan.id,
        operationsSha256: firstBody.plan.operationsSha256,
        idempotencyKey: "today-operations-confirm-2",
      }),
    });
    expect(await duplicate.json()).toMatchObject({
      replayed: true,
      confirmation: { id: confirmedBody.confirmation.id },
    });

    const database = new DatabaseSync(filename, { readOnly: true });
    const audit = database.prepare(`
      SELECT action, details_json FROM audit_events WHERE batch_id = ?
    `).get(createdBody.batch.id) as { action: string; details_json: string };
    expect(audit.action).toBe("daily_operations.confirmed");
    expect(JSON.parse(audit.details_json)).toMatchObject({
      planId: firstBody.plan.id,
      businessDate: firstBody.plan.businessDate,
      basedOnBatchRevision: 0,
      actorUserId: userId,
      sopSourceSha256: expect.stringMatching(/^[A-F0-9]{64}$/),
      devicePlanSha256: expect.stringMatching(/^[A-F0-9]{64}$/),
    });
    database.close();
  });

  it("concurrently replays one canonical day confirmation and one audit event", async () => {
    const { filename, base, cookie } = await startApi();
    const created = await request(base, "/api/batches", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ name: "并发确认", startAge: 3, endAge: 12, headCount: 20 }),
    });
    const createdBody = await created.json() as { batch: { id: string } };
    const planResponse = await request(base, `/api/batches/${createdBody.batch.id}/today-operations`, { headers: { cookie } });
    const plan = (await planResponse.json() as { plan: { id: string; operationsSha256: string } }).plan;
    const confirm = (idempotencyKey: string) => request(base, `/api/batches/${createdBody.batch.id}/today-operations/confirm`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ planId: plan.id, operationsSha256: plan.operationsSha256, idempotencyKey }),
    });
    const [left, right] = await Promise.all([confirm("concurrent-left"), confirm("concurrent-right")]);
    expect(left.status).toBe(200);
    expect(right.status).toBe(200);
    const [leftBody, rightBody] = await Promise.all([
      left.json() as Promise<{ confirmation: { id: string }; replayed: boolean }>,
      right.json() as Promise<{ confirmation: { id: string }; replayed: boolean }>,
    ]);
    expect(leftBody.confirmation.id).toBe(rightBody.confirmation.id);
    expect([leftBody.replayed, rightBody.replayed].filter((value) => !value)).toHaveLength(1);

    const database = new DatabaseSync(filename, { readOnly: true });
    expect(database.prepare("SELECT count(*) AS count FROM daily_operation_confirmations").get())
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT count(*) AS count FROM audit_events WHERE action = 'daily_operations.confirmed'").get())
      .toEqual({ count: 1 });
    database.close();
  });

  it("materializes diarrhea feedback into today operations and writes the confirmed device decision", async () => {
    const { store, base, cookie, userId } = await startApi();
    const created = await request(base, "/api/batches", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ name: "腹泻反馈闭环", startAge: 3, endAge: 12, headCount: 20 }),
    });
    const createdBody = await created.json() as { batch: { id: string; revision: number } };
    const batchId = createdBody.batch.id;

    const saved = await request(base, `/api/batches/${batchId}/records`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: 0,
        idempotencyKey: "record-diarrhea-1",
        observation: { recordedAt: "2026-08-05T10:00:00+08:00", effectiveHeads: 20, creepGrade: "none", diarrheaGrade: "mild", actualPowderGrams: 0 },
      }),
    });
    expect(saved.status).toBe(200);
    const savedBody = await saved.json() as {
      feedback: {
        kind: string;
        operations: Array<{ code: string }>;
        proposedSetting: { kind: string; dailyPowderGrams: number };
      };
    };
    expect(savedBody.feedback).toMatchObject({
      kind: "diarrhea",
      operations: [{ code: "feedback_diarrhea_confirm" }],
      proposedSetting: { kind: "diarrhea" },
    });

    const planResponse = await request(base, `/api/batches/${batchId}/today-operations`, { headers: { cookie } });
    const planBody = await planResponse.json() as {
      plan: {
        status: string;
        id: string;
        operationsSha256: string;
        proposedSetting: { kind: string; dailyPowderGrams: number };
        feedbackOrigin: { id: string; kind: string };
        operations: Array<{ code: string; feedbackRef: { originId: string } }>;
      };
    };
    expect(planBody.plan).toMatchObject({
      status: "pending",
      proposedSetting: { kind: "diarrhea" },
      feedbackOrigin: { kind: "diarrhea" },
    });
    expect(planBody.plan.operations.map((item) => item.code)).toContain("feedback_diarrhea_confirm");
    expect(planBody.plan.operations.find((item) => item.code === "feedback_diarrhea_confirm")?.feedbackRef)
      .toMatchObject({ originId: planBody.plan.feedbackOrigin.id });

    const confirmed = await request(base, `/api/batches/${batchId}/today-operations/confirm`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        planId: planBody.plan.id,
        operationsSha256: planBody.plan.operationsSha256,
        idempotencyKey: "confirm-diarrhea-feedback",
      }),
    });
    const confirmedBody = await confirmed.json() as {
      confirmation: { deviceSetting: { mode: string; dailyPowderGrams: number }; decisionId: string };
      decision: { status: string; evidence: { modelVersion: string } };
    };
    expect(confirmedBody.confirmation.deviceSetting).toMatchObject({
      mode: "timed_quantity",
      dailyPowderGrams: planBody.plan.proposedSetting.dailyPowderGrams,
    });
    expect(confirmedBody.confirmation.decisionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(confirmedBody.decision).toMatchObject({
      status: "active",
      evidence: { modelVersion: "daily-operation-confirmation@1" },
    });
    expect(store.getBatch(userId, batchId)?.revision).toBe(1);

    const batchAfter = await request(base, `/api/batches/${batchId}`, { headers: { cookie } });
    const batchAfterBody = await batchAfter.json() as {
      today: { setting: { dailyPowderGrams: number; singlePowderGrams: number; mealCount: number } };
    };
    expect(batchAfterBody.today.setting.dailyPowderGrams).toBe(confirmedBody.confirmation.deviceSetting.dailyPowderGrams);
    expect(batchAfterBody.today.setting.singlePowderGrams).toBe(confirmedBody.confirmation.deviceSetting.singlePowderGrams);
    expect(batchAfterBody.today.setting.mealCount).toBe(confirmedBody.confirmation.deviceSetting.mealCount);
  });

  it("removes pending diarrhea handling after the latest grade returns to none", async () => {
    const { base, cookie } = await startApi();
    const created = await request(base, "/api/batches", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ name: "腹泻结束清理", startAge: 3, endAge: 12, headCount: 20 }),
    });
    const createdBody = await created.json() as { batch: { id: string } };
    const batchId = createdBody.batch.id;

    const mild = await request(base, `/api/batches/${batchId}/records`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: 0,
        idempotencyKey: "diarrhea-then-none-mild",
        observation: { effectiveHeads: 20, creepGrade: "none", diarrheaGrade: "mild", actualPowderGrams: 120 },
      }),
    });
    expect(mild.status).toBe(200);
    const mildBody = await mild.json() as {
      feedback: { kind: string; operations: Array<{ code: string }> } | null;
    };
    expect(mildBody.feedback).toMatchObject({
      kind: "diarrhea",
      operations: [{ code: "feedback_diarrhea_confirm" }],
    });

    const activePlan = await request(base, `/api/batches/${batchId}/today-operations`, {
      headers: { cookie },
    });
    const activeBody = await activePlan.json() as {
      plan: { operations: Array<{ code: string }> };
    };
    expect(activeBody.plan.operations.map((item) => item.code)).toContain("feedback_diarrhea_confirm");

    const none = await request(base, `/api/batches/${batchId}/records`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: 1,
        idempotencyKey: "diarrhea-then-none-none",
        observation: { effectiveHeads: 20, creepGrade: "none", diarrheaGrade: "none", actualPowderGrams: 180 },
      }),
    });
    expect(none.status).toBe(200);
    const noneBody = await none.json() as {
      feedback: { kind: string } | null;
    };
    expect(noneBody.feedback).toBeNull();

    const clearedPlan = await request(base, `/api/batches/${batchId}/today-operations`, {
      headers: { cookie },
    });
    const clearedBody = await clearedPlan.json() as {
      plan: { operations: Array<{ code: string }> };
    };
    expect(clearedBody.plan.operations.map((item) => item.code))
      .not.toContain("feedback_diarrhea_confirm");
  });

  it("keeps pending diarrhea feedback after a same-day observation omits diarrheaGrade", async () => {
    const { base, cookie } = await startApi();
    const created = await request(base, "/api/batches", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ name: "腹泻事件历史", startAge: 3, endAge: 12, headCount: 20 }),
    });
    const createdBody = await created.json() as { batch: { id: string } };
    const batchId = createdBody.batch.id;

    const mild = await request(base, `/api/batches/${batchId}/records`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: 0,
        idempotencyKey: "event-history-mild",
        observation: {
          recordedAt: "2026-08-05T10:00:00+08:00",
          effectiveHeads: 20,
          creepGrade: "none",
          diarrheaGrade: "mild",
          actualPowderGrams: 0,
        },
      }),
    });
    expect(mild.status).toBe(200);

    const omitted = await request(base, `/api/batches/${batchId}/records`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: 1,
        idempotencyKey: "event-history-omitted",
        observation: {
          recordedAt: "2026-08-05T14:00:00+08:00",
          effectiveHeads: 20,
          creepGrade: "none",
          actualPowderGrams: 180,
        },
      }),
    });
    expect(omitted.status).toBe(200);

    const planResponse = await request(base, `/api/batches/${batchId}/today-operations`, {
      headers: { cookie },
    });
    const planBody = await planResponse.json() as {
      plan: { operations: Array<{ code: string }> };
    };
    expect(planBody.plan.operations.map((item) => item.code)).toContain("feedback_diarrhea_confirm");
  });

  it("materializes creep-control feedback into the next day plan after sustained creep", async () => {
    const { base, cookie } = await startApi();
    const created = await request(base, "/api/batches", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ name: "教槽控奶反馈闭环", startAge: 3, endAge: 12, headCount: 20 }),
    });
    const createdBody = await created.json() as { batch: { id: string } };
    const batchId = createdBody.batch.id;
    const observation = { effectiveHeads: 20, creepGrade: "high", diarrheaGrade: "none", actualPowderGrams: 500 };
    const advance = (expectedRevision: number, key: string) => request(base, `/api/batches/${batchId}/advance`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision,
        idempotencyKey: key,
        observation,
      }),
    });
    const record = (expectedRevision: number, key: string) => request(base, `/api/batches/${batchId}/records`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision,
        idempotencyKey: key,
        observation,
      }),
    });
    const firstAdvance = await advance(0, "creep-advance-day1");
    expect(firstAdvance.status).toBe(200);
    const day1 = await record(1, "creep-day-1");
    expect(day1.status).toBe(200);
    const day1Body = await day1.json() as { batch: { currentDayIndex: number; revision: number } };
    expect(day1Body.batch).toMatchObject({ currentDayIndex: 1, revision: 2 });
    const advanced = await advance(2, "creep-advance-day2");
    const advancedBody = await advanced.json() as {
      batch: { currentDayIndex: number; revision: number };
      feedback: { kind: string; operations: Array<{ code: string }>; proposedSetting: { controlStartDay: number } };
    };
    expect(advancedBody.batch).toMatchObject({ currentDayIndex: 2, revision: 3 });
    expect(advancedBody.feedback).toMatchObject({
      kind: "creep_control",
      operations: [{ code: "feedback_creep_control_confirm" }],
      proposedSetting: { controlStartDay: 2 },
    });
    const planResponse = await request(base, `/api/batches/${batchId}/today-operations`, { headers: { cookie } });
    const planBody = await planResponse.json() as {
      plan: {
        proposedSetting: { kind: string; controlStartDay: number };
        feedbackOrigin: { kind: string; controlStartDay: number };
        operations: Array<{ code: string }>;
      };
    };
    expect(planBody.plan).toMatchObject({
      proposedSetting: { kind: "creep_control", controlStartDay: 2 },
      feedbackOrigin: { kind: "creep_control", controlStartDay: 2 },
    });
    expect(planBody.plan.operations.map((item) => item.code)).toContain("feedback_creep_control_confirm");
  });
});
