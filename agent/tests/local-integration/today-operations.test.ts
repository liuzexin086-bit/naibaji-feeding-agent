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
});
