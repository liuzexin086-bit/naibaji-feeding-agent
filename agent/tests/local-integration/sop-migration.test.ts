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
  const directory = mkdtempSync(join(tmpdir(), "naibaji-sop-migration-"));
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
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("missing session cookie");
  const body = await login.json() as { user: { id: string } };
  return { store, filename, base, cookie, userId: body.user.id };
}

function request(base: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function eightFreeFeedingSlots() {
  const starts = ["09:00", "12:00", "15:00", "18:00", "21:00", "00:00", "03:00", "06:00"];
  const ends = ["09:30", "12:30", "15:30", "18:30", "21:30", "00:30", "03:30", "06:30"];
  return starts.map((startLocal, index) => ({
    slot: index + 1,
    enabled: true,
    label: `自由采食时段 ${index + 1}`,
    startLocal,
    endLocal: ends[index],
  }));
}

describe("administrator SOP migration", () => {
  it("previews and atomically applies a published SOP while refreshing only a pending today plan", async () => {
    const { filename, base, cookie, userId } = await startApi();
    const created = await request(base, "/api/batches", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ name: "迁移测试批次", startAge: 3, endAge: 12, headCount: 20 }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { batch: { id: string; revision: number; sopVersion: string } };

    const existingPlanResponse = await request(base, `/api/batches/${createdBody.batch.id}/today-operations`, { headers: { cookie } });
    const existingPlan = (await existingPlanResponse.json() as {
      plan: { id: string; operationsSha256: string; status: string; operations: Array<{ title: string }> };
    }).plan;
    expect(existingPlan.operations.find((item) => item.title.includes("首日教学程序"))?.title).toContain("35 g/20头/次");

    const published = await request(base, "/api/admin/sop/templates", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        version: "migration-v2-30g",
        name: "30g 与八窗口",
        sourceMarkdown: "# 超早期断奶\n\n30g/20头/次，D1 自由采食。",
        config: {
          teachingPowderGramsPerTwenty: 30,
          freeFeedingTemplate: { windows: eightFreeFeedingSlots() },
        },
      }),
    });
    expect(published.status).toBe(201);
    const target = await published.json() as { template: { id: string; version: string } };

    const adminBatches = await request(base, "/api/admin/batches", { headers: { cookie } });
    expect((await adminBatches.json() as { batches: Array<{ id: string; userId: string; userEmail: string }> }).batches)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: createdBody.batch.id, userId, userEmail: "admin@example.com" })]));

    const preview = await request(base, `/api/admin/batches/${createdBody.batch.id}/sop-migration/preview?userId=${encodeURIComponent(userId)}&templateId=${target.template.id}`, { headers: { cookie } });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      canMigrate: true,
      confirmationPhrase: "迁移 SOP",
      currentSop: { version: createdBody.batch.sopVersion },
      targetSop: { version: target.template.version },
      ruleChanges: {
        teachingPowderGramsPerTwenty: { from: 35, to: 30 },
        freeFeeding: { to: { enabledSlotCount: 8 } },
      },
      todayOperation: { effect: "refresh_pending" },
    });

    const rejected = await request(base, `/api/admin/batches/${createdBody.batch.id}/sop-migration`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ userId, templateId: target.template.id, expectedRevision: 0, confirmationPhrase: "确认", idempotencyKey: "migration-rejected" }),
    });
    expect(await rejected.json()).toEqual({ code: "NBJ_SOP_MIGRATION_CONFIRMATION_REQUIRED" });

    const migrated = await request(base, `/api/admin/batches/${createdBody.batch.id}/sop-migration`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ userId, templateId: target.template.id, expectedRevision: 0, confirmationPhrase: "迁移 SOP", idempotencyKey: "migration-accepted" }),
    });
    expect(migrated.status).toBe(200);
    const migratedBody = await migrated.json() as {
      batch: { revision: number; sopVersion: string };
      todayOperation: { id: string; status: string; basedOnBatchRevision: number; sopTemplateId: string; operationsSha256: string };
      replayed: boolean;
    };
    expect(migratedBody).toMatchObject({
      batch: { revision: 1, sopVersion: target.template.version },
      todayOperation: { id: existingPlan.id, status: "pending", basedOnBatchRevision: 1, sopTemplateId: target.template.id },
      replayed: false,
    });
    expect(migratedBody.todayOperation.operationsSha256).not.toBe(existingPlan.operationsSha256);

    const refreshedPlanResponse = await request(base, `/api/batches/${createdBody.batch.id}/today-operations`, { headers: { cookie } });
    const refreshedPlan = (await refreshedPlanResponse.json() as {
      plan: { id: string; basedOnBatchRevision: number; operations: Array<{ title: string }> };
    }).plan;
    expect(refreshedPlan).toMatchObject({ id: existingPlan.id, basedOnBatchRevision: 1 });
    expect(refreshedPlan.operations.find((item) => item.title.includes("首日教学程序"))?.title).toContain("30 g/20头/次");

    const replay = await request(base, `/api/admin/batches/${createdBody.batch.id}/sop-migration`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ userId, templateId: target.template.id, expectedRevision: 0, confirmationPhrase: "迁移 SOP", idempotencyKey: "migration-accepted" }),
    });
    expect(await replay.json()).toMatchObject({ replayed: true, batch: { revision: 1, sopVersion: target.template.version } });

    const database = new DatabaseSync(filename, { readOnly: true });
    const auditRows = database.prepare("SELECT action, details_json FROM audit_events WHERE batch_id = ? AND action = 'batch.sop_migrated'")
      .all(createdBody.batch.id) as Array<{ action: string; details_json: string }>;
    database.close();
    expect(auditRows).toHaveLength(1);
    expect(JSON.parse(auditRows[0]!.details_json)).toMatchObject({
      actorUserId: userId,
      targetTemplateId: target.template.id,
      previousRevision: 0,
      newRevision: 1,
      previousDailyOperationPlan: { id: existingPlan.id, status: "pending" },
    });
  });

  it("refuses migration after today operations have been confirmed", async () => {
    const { base, cookie, userId } = await startApi();
    const created = await request(base, "/api/batches", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ name: "已确认批次", startAge: 3, endAge: 12, headCount: 20 }),
    });
    const batch = await created.json() as { batch: { id: string; revision: number } };
    const planResponse = await request(base, `/api/batches/${batch.batch.id}/today-operations`, { headers: { cookie } });
    const plan = (await planResponse.json() as { plan: { id: string; operationsSha256: string } }).plan;
    const confirmed = await request(base, `/api/batches/${batch.batch.id}/today-operations/confirm`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ planId: plan.id, operationsSha256: plan.operationsSha256, idempotencyKey: "confirmed-before-migration" }),
    });
    expect(confirmed.status).toBe(200);
    const published = await request(base, "/api/admin/sop/templates", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ version: "migration-confirmed-v2", name: "确认后版本", config: { teachingPowderGramsPerTwenty: 30 } }),
    });
    const target = await published.json() as { template: { id: string } };
    const migration = await request(base, `/api/admin/batches/${batch.batch.id}/sop-migration`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ userId, templateId: target.template.id, expectedRevision: 0, confirmationPhrase: "迁移 SOP", idempotencyKey: "confirmed-migration" }),
    });
    expect(migration.status).toBe(409);
    expect(await migration.json()).toEqual({ code: "NBJ_SOP_MIGRATION_TODAY_CONFIRMED" });
  });
});
