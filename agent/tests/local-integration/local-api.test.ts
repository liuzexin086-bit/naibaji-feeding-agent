import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { handleLocalApi, type LocalApiDeps } from "../../src/container/local-api.js";
import { initializeLocalAdmin } from "../../src/container/local-auth.js";
import { createLocalStore, type SqliteLocalStore } from "../../src/local-db/index.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function startApi(options: { env?: Record<string, string>; deps?: LocalApiDeps } = {}): Promise<{ store: SqliteLocalStore; base: string }> {
  const directory = mkdtempSync(join(tmpdir(), "naibaji-local-api-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = createLocalStore({ filename: join(directory, "local.sqlite") }) as SqliteLocalStore;
  store.migrate();
  initializeLocalAdmin(store, "admin@example.com", "correct-horse-battery");
  const server: Server = createServer((request, response) => {
    void handleLocalApi(request, response, store, options.env || {}, options.deps || {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  cleanups.push(() => {
    server.close();
    store.close();
  });
  return { store, base: `http://127.0.0.1:${address.port}` };
}

async function request(base: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function cookieOf(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("missing session cookie");
  return value.split(";", 1)[0];
}

describe("local execution API", () => {
  it("authenticates locally, creates batches and advances atomically", async () => {
    const { base } = await startApi();
    const login = await request(base, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "ADMIN@example.com", password: "correct-horse-battery" }),
    });
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).not.toContain("Secure");
    const cookie = cookieOf(login);
    expect((await request(base, "/api/auth/session", { headers: { cookie } })).status).toBe(200);
    const created = await request(base, "/api/batches", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ name: "一栏", room: "育婴室", startAge: 7, endAge: 16, headCount: 20 }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as {
      batch: { id: string; revision: number; startWeight: number; startWeightSource: string };
      today: {
        mealCount: number;
        singlePowderGrams: number;
        plannedTotalPowderGrams: number;
        setting: { source: string };
        estimatedAverageWeightKg: number;
      };
    };
    expect(createdBody.today.mealCount).toBe(6);
    expect(createdBody.today.singlePowderGrams).toBe(35);
    expect(createdBody.today.plannedTotalPowderGrams).toBe(210);
    expect(createdBody.today.setting.source).toBe("sop_indirect");
    expect(createdBody.batch.startWeight).toBe(3);
    expect(createdBody.batch.startWeightSource).toBe("model_age_standard");
    expect(createdBody.today.estimatedAverageWeightKg).toBe(3);
    const batchId = createdBody.batch.id;
    const payload = {
      expectedRevision: 0,
      idempotencyKey: "advance-0",
      observation: { effectiveHeads: 20, creepGrade: "high", diarrheaGrade: "none", actualPowderGrams: 180 },
    };
    const advanced = await request(base, `/api/batches/${batchId}/advance`, {
      method: "POST", headers: { cookie }, body: JSON.stringify(payload),
    });
    expect(advanced.status).toBe(200);
    const advancedBody = await advanced.json() as {
      batch: { currentDayIndex: number; revision: number };
      today: {
        mealCount: number;
        mealTimes: string[];
        planWindow: { startLocal: string; endLocal: string; endDayOffset: number };
      };
      records: Array<{ estimatedAverageWeightKg: number }>;
    };
    expect(advancedBody.batch.currentDayIndex).toBe(1);
    expect(advancedBody.batch.revision).toBe(1);
    expect(advancedBody.today.mealCount).toBe(10);
    expect(advancedBody.today.mealTimes).toEqual([
      "10:00", "14:00", "16:00", "18:00", "20:00",
      "22:00", "02:00", "04:00", "06:00", "08:00",
    ]);
    expect(advancedBody.today.planWindow).toEqual({
      startLocal: "09:00",
      endLocal: "09:00",
      endDayOffset: 1,
    });
    expect(advancedBody.records[0]?.estimatedAverageWeightKg).toBe(3);
    const replay = await request(base, `/api/batches/${batchId}/advance`, {
      method: "POST", headers: { cookie }, body: JSON.stringify(payload),
    });
    expect(replay.status).toBe(200);
    expect((await replay.json() as { batch: { currentDayIndex: number } }).batch.currentDayIndex).toBe(1);

    const secondAdvance = await request(base, `/api/batches/${batchId}/advance`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: 1,
        idempotencyKey: "advance-1",
        observation: { effectiveHeads: 20, creepGrade: "high", diarrheaGrade: "none", actualPowderGrams: 700 },
      }),
    });
    expect(secondAdvance.status).toBe(200);
    const secondBody = await secondAdvance.json() as {
      batch: { currentDayIndex: number; revision: number };
      today: { mealCount: number };
    };
    expect(secondBody.batch).toMatchObject({ currentDayIndex: 2, revision: 2 });
    expect(secondBody.today.mealCount).toBe(9);

    const anchoredAdvance = await request(base, `/api/batches/${batchId}/advance`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: 2,
        idempotencyKey: "advance-anchored",
        observation: { effectiveHeads: 20, creepGrade: "high", diarrheaGrade: "none", actualPowderGrams: 900 },
      }),
    });
    expect(anchoredAdvance.status).toBe(200);
    const anchoredBody = await anchoredAdvance.json() as { today: { mealCount: number } };
    expect(anchoredBody.today.mealCount).toBe(8);
  });

  it("exposes explicit runtime state in today and rejects invalid runtime enums", async () => {
    const { base } = await startApi();
    const login = await request(base, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "admin@example.com", password: "correct-horse-battery" }),
    });
    const cookie = cookieOf(login);
    const created = await request(base, "/api/batches", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ name: "运行状态", startAge: 7, endAge: 16, headCount: 20 }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as {
      batch: { id: string; revision: number };
      today: { runtimeState: { state: string } };
    };
    expect(createdBody.today.runtimeState.state).toBe("normal");

    const blocked = await request(base, `/api/batches/${createdBody.batch.id}/advance`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: createdBody.batch.revision,
        idempotencyKey: "runtime-blocked",
        observation: {
          effectiveHeads: 20,
          creepGrade: "none",
          diarrheaGrade: "none",
          deviceStatus: "blocked",
          feedingResponse: "refusal",
        },
      }),
    });
    expect(blocked.status).toBe(200);
    const blockedBody = await blocked.json() as {
      batch: { revision: number };
      today: { runtimeState: { state: string; reasons: string[] } };
    };
    expect(blockedBody.today.runtimeState.state).toBe("blocked");
    expect(blockedBody.today.runtimeState.reasons).toEqual(
      expect.arrayContaining(["device_blocked", "feeding_refusal"]),
    );

    const cleared = await request(base, `/api/batches/${createdBody.batch.id}/advance`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: blockedBody.batch.revision,
        idempotencyKey: "runtime-cleared",
        observation: {
          effectiveHeads: 20,
          creepGrade: "none",
          diarrheaGrade: "none",
          deviceStatus: "normal",
          feedingResponse: "normal",
        },
      }),
    });
    expect(cleared.status).toBe(200);
    const clearedBody = await cleared.json() as {
      batch: { revision: number };
      today: { runtimeState: { state: string } };
    };
    expect(clearedBody.today.runtimeState.state).toBe("normal");

    const invalid = await request(base, `/api/batches/${createdBody.batch.id}/advance`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: clearedBody.batch.revision,
        idempotencyKey: "runtime-invalid",
        observation: { deviceStatus: "bogus" },
      }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ code: "NBJ_DEVICE_STATUS_INVALID" });
  });

  it("rejects forged plan fields and writes server authoritative snapshot", async () => {
    const { base } = await startApi();
    const login = await request(base, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "admin@example.com", password: "correct-horse-battery" }),
    });
    const cookie = cookieOf(login);
    const created = await request(base, "/api/batches", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ name: "观察边界", startAge: 7, endAge: 16, headCount: 20 }),
    });
    const createdBody = await created.json() as { batch: { id: string; revision: number } };
    const forged = await request(base, `/api/batches/${createdBody.batch.id}/advance`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: createdBody.batch.revision,
        idempotencyKey: "forged-plan-field",
        observation: {
          effectiveHeads: 20,
          creepGrade: "none",
          diarrheaGrade: "none",
          actualPowderGrams: 0,
          mealCount: 10,
        },
      }),
    });
    expect(forged.status).toBe(400);
    expect(await forged.json()).toEqual({ code: "NBJ_OBSERVATION_PLAN_FIELD_FORBIDDEN" });

    const unknownField = await request(base, `/api/batches/${createdBody.batch.id}/advance`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: createdBody.batch.revision,
        idempotencyKey: "unknown-observation-field",
        observation: { effectiveHeads: 20, mystery: true },
      }),
    });
    expect(unknownField.status).toBe(400);
    expect(await unknownField.json()).toEqual({ code: "NBJ_OBSERVATION_PLAN_FIELD_FORBIDDEN" });

    const allowed = await request(base, `/api/batches/${createdBody.batch.id}/advance`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: createdBody.batch.revision,
        idempotencyKey: "server-snapshot",
        observation: {
          effectiveHeads: 20,
          creepGrade: "none",
          diarrheaGrade: "none",
          actualPowderGrams: 0,
        },
      }),
    });
    expect(allowed.status).toBe(200);
    const allowedBody = await allowed.json() as {
      records: Array<{
        planTotalAtCommit: number;
        feedTimesAtCommit: number;
        policyVersionAtCommit: string;
      }>;
    };
    expect(allowedBody.records[0]).toMatchObject({
      planTotalAtCommit: expect.any(Number),
      feedTimesAtCommit: expect.any(Number),
      policyVersionAtCommit: "execution-contract-v1",
    });
  });

  it("keeps the session cookie Secure behind an HTTPS reverse proxy", async () => {
    const { base } = await startApi();
    const login = await request(base, "/api/auth/login", {
      method: "POST",
      headers: { "x-forwarded-proto": "https" },
      body: JSON.stringify({ email: "admin@example.com", password: "correct-horse-battery" }),
    });
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain("Secure");
  });

  it("rejects a batch window outside the feeding model contract before persistence", async () => {
    const { base } = await startApi();
    const login = await request(base, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "admin@example.com", password: "correct-horse-battery" }),
    });
    const rejected = await request(base, "/api/batches", {
      method: "POST",
      headers: { cookie: cookieOf(login) },
      body: JSON.stringify({ name: "无效窗口", startAge: 21, endAge: 35, headCount: 12 }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ code: "NBJ_END_AGE_INVALID" });
  });

  it("keeps SOP template versions immutable and requires admin", async () => {
    const { base } = await startApi();
    const login = await request(base, "/api/auth/login", {
      method: "POST", body: JSON.stringify({ email: "admin@example.com", password: "correct-horse-battery" }),
    });
    const cookie = cookieOf(login);
    const created = await request(base, "/api/admin/sop/templates", {
      method: "POST", headers: { cookie },
      body: JSON.stringify({
        version: "sop-local-v1",
        name: "本地默认",
        config: { initialMealCount: 10, teachingPowderGramsPerTwenty: 40 },
      }),
    });
    expect(created.status).toBe(201);
    const body = await created.json() as { template: { id: string; version: string } };
    expect(body.template.version).toBe("sop-local-v1");
    const copied = await request(base, "/api/admin/sop/templates", {
      method: "POST", headers: { cookie },
      body: JSON.stringify({ version: "sop-local-v2", name: "本地修订", copyFromId: body.template.id, config: { waterClosedUntilDayAge: 13 } }),
    });
    expect(copied.status).toBe(201);
    const listed = await request(base, "/api/admin/sop/templates", { headers: { cookie } });
    expect((await listed.json() as { templates: Array<{ version: string }> }).templates.map((row) => row.version))
      .toEqual(["sop-local-v2", "sop-local-v1"]);

    const batch = await request(base, "/api/batches", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ name: "采用新 SOP", startAge: 3, endAge: 12, headCount: 20 }),
    });
    expect(batch.status).toBe(201);
    const batchBody = await batch.json() as {
      today: {
        singlePowderGrams: number;
        plannedTotalPowderGrams: number;
        sopVersion: string;
        setting: { source: string };
      };
    };
    expect(batchBody.today).toMatchObject({
      singlePowderGrams: 40,
      plannedTotalPowderGrams: 240,
      sopVersion: "sop-local-v2",
      setting: { source: "sop_indirect" },
    });
  });

  it("returns history for the requested batch session without cross-batch leakage", async () => {
    const { base, store } = await startApi();
    const login = await request(base, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "admin@example.com", password: "correct-horse-battery" }),
    });
    const cookie = cookieOf(login);
    const user = (await request(base, "/api/auth/session", { headers: { cookie } })).json() as Promise<{ user: { id: string } }>;
    const userId = (await user).user.id;
    const create = async (name: string) => {
      const response = await request(base, "/api/batches", {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({ name, startAge: 3, endAge: 12, headCount: 20 }),
      });
      expect(response.status).toBe(201);
      return response.json() as Promise<{ batch: { id: string }; agentSession: { id: string } }>;
    };
    const batchA = await create("批次 A");
    const batchB = await create("批次 B");
    store.appendMessage({
      userId,
      batchId: batchA.batch.id,
      sessionId: batchA.agentSession.id,
      role: "user",
      content: "A 的问题",
      evidence: {},
    });
    store.appendMessage({
      userId,
      batchId: batchA.batch.id,
      sessionId: batchA.agentSession.id,
      role: "assistant",
      content: "A 的回答",
      evidence: {},
    });
    store.appendMessage({
      userId,
      batchId: batchB.batch.id,
      sessionId: batchB.agentSession.id,
      role: "assistant",
      content: "B 的回答",
      evidence: {},
    });

    const detailA = await request(base, `/api/batches/${batchA.batch.id}`, { headers: { cookie } });
    const detailABody = await detailA.json() as {
      agentSession: { id: string; messages: Array<{ content: string }> };
    };
    expect(detailABody.agentSession.id).toBe(batchA.agentSession.id);
    expect(detailABody.agentSession.messages.map((message) => message.content)).toEqual([
      "A 的问题",
      "A 的回答",
    ]);

    const detailB = await request(base, `/api/batches/${batchB.batch.id}`, { headers: { cookie } });
    const detailBBody = await detailB.json() as {
      agentSession: { id: string; messages: Array<{ content: string }> };
    };
    expect(detailBBody.agentSession.id).toBe(batchB.agentSession.id);
    expect(detailBBody.agentSession.messages.map((message) => message.content)).toEqual(["B 的回答"]);
  });

  it("allows admins to create, list, and confirmed-delete local accounts without credential leakage", async () => {
    const { base, store } = await startApi();
    expect((await request(base, "/api/admin/users")).status).toBe(401);
    const adminLogin = await request(base, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "admin@example.com", password: "correct-horse-battery" }),
    });
    const adminCookie = cookieOf(adminLogin);
    const adminSession = await request(base, "/api/auth/session", { headers: { cookie: adminCookie } });
    const adminId = ((await adminSession.json()) as { user: { id: string } }).user.id;

    const created = await request(base, "/api/admin/users", {
      method: "POST",
      headers: { cookie: adminCookie },
      body: JSON.stringify({ email: "  Operator@Example.com ", password: "operator-pass", role: "operator" }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { user: { id: string; email: string; role: string; passwordHash?: string; passwordSalt?: string } };
    expect(createdBody.user).toMatchObject({ email: "operator@example.com", role: "operator" });
    expect(createdBody.user).not.toHaveProperty("passwordHash");
    expect(createdBody.user).not.toHaveProperty("passwordSalt");

    const listed = await request(base, "/api/admin/users", { headers: { cookie: adminCookie } });
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as { users: Array<{ id: string; email: string; passwordHash?: string }> };
    expect(listedBody.users.some((user) => user.id === createdBody.user.id && user.email === "operator@example.com")).toBe(true);
    expect(JSON.stringify(listedBody)).not.toContain("passwordHash");

    const operatorLogin = await request(base, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "operator@example.com", password: "operator-pass" }),
    });
    expect(operatorLogin.status).toBe(200);
    const operatorCookie = cookieOf(operatorLogin);
    expect((await request(base, "/api/admin/users", { headers: { cookie: operatorCookie } })).status).toBe(403);
    const operatorBatch = await request(base, "/api/batches", {
      method: "POST",
      headers: { cookie: operatorCookie },
      body: JSON.stringify({ name: "待删除批次", startAge: 3, endAge: 12, headCount: 20 }),
    });
    expect(operatorBatch.status).toBe(201);
    const operatorBatchBody = await operatorBatch.json() as { batch: { id: string }; agentSession: { id: string } };
    store.appendMessage({
      userId: createdBody.user.id,
      batchId: operatorBatchBody.batch.id,
      sessionId: operatorBatchBody.agentSession.id,
      role: "user",
      content: "operator-owned message",
    });
    store.createSopTemplate({
      id: "operator-owned-template",
      version: "operator-owned-v1",
      name: "Operator owned",
      config: {},
      createdBy: createdBody.user.id,
    });
    const operatorNlTask = store.createSopEditTask({
      templateId: null,
      instruction: "operator-owned SOP edit task",
      createdBy: createdBody.user.id,
    });

    const mismatch = await request(base, `/api/admin/users/${encodeURIComponent(createdBody.user.id)}`, {
      method: "DELETE",
      headers: { cookie: adminCookie },
      body: JSON.stringify({ confirmEmail: "wrong@example.com" }),
    });
    expect(mismatch.status).toBe(400);
    expect((await request(base, "/api/auth/session", { headers: { cookie: operatorCookie } })).status).toBe(200);

    const deleted = await request(base, `/api/admin/users/${encodeURIComponent(createdBody.user.id)}`, {
      method: "DELETE",
      headers: { cookie: adminCookie },
      body: JSON.stringify({ confirmEmail: "operator@example.com" }),
    });
    expect(deleted.status).toBe(200);
    expect((await request(base, "/api/auth/session", { headers: { cookie: operatorCookie } })).status).toBe(401);
    expect(store.getUserById(createdBody.user.id)).toBeNull();
    expect(store.getBatch(createdBody.user.id, operatorBatchBody.batch.id)).toBeNull();
    expect(store.listSopTemplates().find((template) => template.id === "operator-owned-template")?.createdBy).toBe(adminId);
    expect(store.getSopEditTask(operatorNlTask.id)?.createdBy).toBe(adminId);

    const selfDelete = await request(base, `/api/admin/users/${encodeURIComponent(adminId)}`, {
      method: "DELETE",
      headers: { cookie: adminCookie },
      body: JSON.stringify({ confirmEmail: "admin@example.com" }),
    });
    expect(selfDelete.status).toBe(400);
  });

  it("creates, confirms and rejects SOP natural-language draft tasks", async () => {
    const proposal = {
      proposedMarkdown: "# 新 SOP\n\n每日巡栏。",
      config: { teachingFirstLocal: "17:00" },
      changeSummary: "新增模板",
      affectedSections: [],
    };
    const { base } = await startApi({
      deps: {
        createSopEditModel: async () => ({
          invoke: async () => new AIMessage(JSON.stringify(proposal)),
        }),
      },
    });
    const unauthenticated = await request(base, "/api/admin/sop/natural-language/tasks", {
      method: "POST",
      body: JSON.stringify({ instruction: "不应允许" }),
    });
    expect(unauthenticated.status).toBe(401);
    const login = await request(base, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "admin@example.com", password: "correct-horse-battery" }),
    });
    const cookie = cookieOf(login);

    const created = await request(base, "/api/admin/sop/natural-language/tasks", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ instruction: "新建一份简单 SOP" }),
    });
    expect(created.status).toBe(202);
    const createdBody = await created.json() as { task: { id: string; status: string } };
    const taskId = createdBody.task.id;
    expect(createdBody.task.status).toBe("drafting");

    let task: { id: string; status: string } | null = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const listed = await request(base, "/api/admin/sop/natural-language/tasks", {
        headers: { cookie },
      });
      const listedBody = await listed.json() as {
        tasks: Array<{ id: string; status: string }>;
      };
      task = listedBody.tasks.find((item) => item.id === taskId) || null;
      if (task && task.status !== "drafting") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(task?.status).toBe("draft_ready");

    const wrong = await request(base, `/api/admin/sop/natural-language/tasks/${taskId}/confirm`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ version: "v1", name: "新模板", confirmationPhrase: "错误" }),
    });
    expect(wrong.status).toBe(400);

    const confirmed = await request(base, `/api/admin/sop/natural-language/tasks/${taskId}/confirm`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ version: "v1", name: "新模板", confirmationPhrase: "发布 SOP 修改" }),
    });
    expect(confirmed.status).toBe(200);
    const confirmedBody = await confirmed.json() as {
      task: { status: string; publishedTemplateId: string };
      template: { id: string; version: string; status: string };
    };
    expect(confirmedBody.task.status).toBe("published");
    expect(confirmedBody.template.status).toBe("published");
    expect(confirmedBody.task.publishedTemplateId).toBe(confirmedBody.template.id);

    const templates = await request(base, "/api/admin/sop/templates", { headers: { cookie } });
    const templatesBody = await templates.json() as {
      templates: Array<{ id: string; status: string }>;
    };
    expect(templatesBody.templates.find((item) => item.id === confirmedBody.template.id)?.status)
      .toBe("published");

    const created2 = await request(base, "/api/admin/sop/natural-language/tasks", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ instruction: "生成一个随后拒绝的草稿" }),
    });
    const created2Body = await created2.json() as { task: { id: string } };
    let task2: { id: string; status: string } | null = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const listed = await request(base, "/api/admin/sop/natural-language/tasks", {
        headers: { cookie },
      });
      const listedBody = await listed.json() as {
        tasks: Array<{ id: string; status: string }>;
      };
      task2 = listedBody.tasks.find((item) => item.id === created2Body.task.id) || null;
      if (task2 && task2.status !== "drafting") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(task2?.status).toBe("draft_ready");
    const rejected = await request(
      base,
      `/api/admin/sop/natural-language/tasks/${created2Body.task.id}/reject`,
      { method: "POST", headers: { cookie } },
    );
    expect(rejected.status).toBe(200);
    const rejectedBody = await rejected.json() as { task: { status: string } };
    expect(rejectedBody.task.status).toBe("rejected");
  });
});
