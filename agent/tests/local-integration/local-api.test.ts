import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleLocalApi } from "../../src/container/local-api.js";
import { initializeLocalAdmin } from "../../src/container/local-auth.js";
import { createLocalStore, type SqliteLocalStore } from "../../src/local-db/index.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function startApi(): Promise<{ store: SqliteLocalStore; base: string }> {
  const directory = mkdtempSync(join(tmpdir(), "naibaji-local-api-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = createLocalStore({ filename: join(directory, "local.sqlite") }) as SqliteLocalStore;
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
    const cookie = cookieOf(login);
    expect((await request(base, "/api/auth/session", { headers: { cookie } })).status).toBe(200);
    const created = await request(base, "/api/batches", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ name: "一栏", room: "育婴室", startAge: 3, endAge: 12, headCount: 20 }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as {
      batch: { id: string; revision: number };
      today: {
        mealCount: number;
        singlePowderGrams: number;
        plannedTotalPowderGrams: number;
        setting: { source: string };
      };
    };
    expect(createdBody.today.mealCount).toBe(6);
    expect(createdBody.today.singlePowderGrams).toBe(35);
    expect(createdBody.today.plannedTotalPowderGrams).toBe(210);
    expect(createdBody.today.setting.source).toBe("sop_indirect");
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
});
