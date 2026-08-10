import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleLocalApi } from "../../src/container/local-api.js";
import { initializeLocalAdmin } from "../../src/container/local-auth.js";
import { createLocalStore, type SqliteLocalStore } from "../../src/local-db/index.js";
import {
  computeFrozenBatchDecision,
  loadFrozenBatchDecisionContext,
} from "../../src/decision/batch-decision-service.js";
import type { DevicePlanSnapshot, LocalBatch } from "../../src/shared/local-store-contract.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function startApi(): Promise<{
  store: SqliteLocalStore;
  base: string;
  cookie: string;
  userId: string;
}> {
  const directory = mkdtempSync(join(tmpdir(), "naibaji-free-window-"));
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
  return { store, base, cookie: setCookie.split(";", 1)[0], userId: loginBody.user.id };
}

function apiRequest(base: string, path: string, init: RequestInit = {}): Promise<Response> {
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

function expectedWindows() {
  return eightFreeFeedingSlots().map(({ startLocal, endLocal }) => ({ startLocal, endLocal }));
}

function batchSnapshot(batch: LocalBatch): DevicePlanSnapshot {
  const data = batch.data as { config: Record<string, unknown> };
  return data.config.devicePlanSnapshot as DevicePlanSnapshot;
}

function freeDecisionWindows(batch: LocalBatch): Array<{ startLocal: string; endLocal: string }> {
  const data = batch.data as { config: Record<string, unknown>; records?: unknown[] };
  const context = loadFrozenBatchDecisionContext({
    batchId: batch.batchId,
    revision: batch.revision,
    currentDayIndex: 1,
    config: { ...data.config, selectedMode: "free_feeding" },
    records: [],
  });
  return computeFrozenBatchDecision(context, 1, batch.revision).decision.setting.freeWindows;
}

async function createBatch(base: string, cookie: string): Promise<{ batch: { id: string; revision: number } }> {
  const response = await apiRequest(base, "/api/batches", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ name: "八窗口测试", startAge: 3, endAge: 12, headCount: 20 }),
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ batch: { id: string; revision: number } }>;
}

async function publishEightWindowSop(base: string, cookie: string): Promise<{ template: { id: string; version: string } }> {
  const response = await apiRequest(base, "/api/admin/sop/templates", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({
      version: "free-windows-v8",
      name: "八窗口 SOP",
      config: { freeFeedingTemplate: { windows: eightFreeFeedingSlots() } },
    }),
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ template: { id: string; version: string } }>;
}

describe("free window propagation", () => {
  it("publishes and freezes all eight enabled windows into a new batch and planned decision", async () => {
    const { base, cookie, store, userId } = await startApi();
    await publishEightWindowSop(base, cookie);
    const created = await createBatch(base, cookie);
    const batch = store.getBatch(userId, created.batch.id);
    expect(batch).not.toBeNull();
    const snapshot = batchSnapshot(batch!);
    expect(snapshot.templates.free_feeding.slots).toHaveLength(8);
    expect(snapshot.templates.free_feeding.windows).toEqual(expectedWindows());
    expect(freeDecisionWindows(batch!)).toEqual(expectedWindows());
  });

  it("keeps an old batch frozen at its original single window after publishing an eight-window SOP", async () => {
    const { base, cookie, store, userId } = await startApi();
    const created = await createBatch(base, cookie);
    const before = store.getBatch(userId, created.batch.id)!;
    const beforeSnapshot = batchSnapshot(before);
    expect(beforeSnapshot.templates.free_feeding.windows).toEqual([
      { startLocal: "00:00", endLocal: "23:59" },
    ]);

    await publishEightWindowSop(base, cookie);

    const after = store.getBatch(userId, created.batch.id)!;
    expect(batchSnapshot(after).templates.free_feeding.windows).toEqual([
      { startLocal: "00:00", endLocal: "23:59" },
    ]);
    expect(batchSnapshot(after).templates.free_feeding.slots.filter((slot) => slot.enabled)).toHaveLength(1);
  });

  it("previews and applies SOP migration from one frozen window to eight", async () => {
    const { base, cookie, store, userId } = await startApi();
    const created = await createBatch(base, cookie);
    const target = await publishEightWindowSop(base, cookie);

    const preview = await apiRequest(
      base,
      `/api/admin/batches/${created.batch.id}/sop-migration/preview?userId=${encodeURIComponent(userId)}&templateId=${target.template.id}`,
      { headers: { cookie } },
    );
    expect(preview.status).toBe(200);
    const previewBody = await preview.json() as {
      ruleChanges: {
        freeFeeding: {
          from: { enabledSlotCount: number };
          to: { enabledSlotCount: number };
        };
      };
    };
    expect(previewBody.ruleChanges.freeFeeding).toMatchObject({
      from: { enabledSlotCount: 1 },
      to: { enabledSlotCount: 8 },
    });

    const migrated = await apiRequest(base, `/api/admin/batches/${created.batch.id}/sop-migration`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        userId,
        templateId: target.template.id,
        expectedRevision: 0,
        confirmationPhrase: "迁移 SOP",
        idempotencyKey: "free-window-migration",
      }),
    });
    expect(migrated.status).toBe(200);

    const batch = store.getBatch(userId, created.batch.id)!;
    expect(batchSnapshot(batch).templates.free_feeding.windows).toEqual(expectedWindows());
    expect(freeDecisionWindows(batch)).toEqual(expectedWindows());
  });

  it("returns all eight canonical windows in Today after switching a new batch to free feeding", async () => {
    const { base, cookie } = await startApi();
    await publishEightWindowSop(base, cookie);
    const created = await createBatch(base, cookie);
    const batchId = created.batch.id;

    const advance = await apiRequest(base, `/api/batches/${batchId}/advance`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: 0,
        idempotencyKey: "eight-window-advance",
        observation: { effectiveHeads: 20, creepGrade: "none", diarrheaGrade: "none", actualPowderGrams: 0 },
      }),
    });
    expect(advance.status).toBe(200);
    const advanceBody = await advance.json() as { batch: { revision: number } };

    const record = await apiRequest(base, `/api/batches/${batchId}/records`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: advanceBody.batch.revision,
        idempotencyKey: "eight-window-day-zero",
        observation: { effectiveHeads: 20, creepGrade: "none", diarrheaGrade: "none", actualPowderGrams: 0 },
      }),
    });
    expect(record.status).toBe(200);
    const recordBody = await record.json() as { batch: { revision: number } };

    const mode = await apiRequest(base, `/api/batches/${batchId}/mode`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        mode: "free_feeding",
        expectedRevision: recordBody.batch.revision,
        idempotencyKey: "eight-window-free-mode",
      }),
    });
    expect(mode.status).toBe(200);

    const today = await apiRequest(base, `/api/batches/${batchId}`, { headers: { cookie } });
    expect(today.status).toBe(200);
    const todayBody = await today.json() as {
      today: {
        plannedDecision: {
          setting: {
            mode: string;
            freeWindows: Array<{ startLocal: string; endLocal: string }>;
          };
        };
      };
    };
    expect(todayBody.today.plannedDecision.setting.mode).toBe("free_feeding");
    expect(todayBody.today.plannedDecision.setting.freeWindows).toEqual(expectedWindows());
  });
});
