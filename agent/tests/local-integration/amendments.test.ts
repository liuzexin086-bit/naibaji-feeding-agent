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
  const directory = mkdtempSync(join(tmpdir(), "naibaji-amendments-"));
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

describe("post-confirmation amendments", () => {
  it("returns one canonical amendment for repeated and concurrent ensure calls", async () => {
    const { store, base, cookie, userId } = await startApi();
    const created = await request(base, "/api/batches", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ name: "并发修订", startAge: 3, endAge: 12, headCount: 20 }),
    });
    const createdBody = await created.json() as { batch: { id: string } };
    const batchId = createdBody.batch.id;
    const planResponse = await request(
      base,
      `/api/batches/${batchId}/today-operations`,
      { headers: { cookie } },
    );
    const planBody = await planResponse.json() as {
      plan: { id: string; businessDate: string; operationsSha256: string };
    };
    const confirmationResponse = await request(
      base,
      `/api/batches/${batchId}/today-operations/confirm`,
      {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({
          planId: planBody.plan.id,
          operationsSha256: planBody.plan.operationsSha256,
          idempotencyKey: "confirm-concurrent-base",
        }),
      },
    );
    const confirmationBody = await confirmationResponse.json() as {
      confirmation: { id: string };
    };
    const batch = store.getBatch(userId, batchId)!;
    const originId = "origin-concurrent";
    const baseInput = {
      userId,
      batchId,
      businessDate: planBody.plan.businessDate,
      basePlanId: planBody.plan.id,
      baseConfirmationId: confirmationBody.confirmation.id,
      originId,
      originKind: "diarrhea" as const,
      severity: "mild" as const,
      operations: [{
        code: "feedback_diarrhea_confirm",
        title: "腹泻处置确认（轻度）",
        dueWindow: { startLocal: "09:00", endLocal: "09:00", endDayOffset: 1 as const },
        sopSection: "现场反馈.腹泻",
        requiredObservationFields: ["diarrheaGrade"],
        safetyNotes: [],
        feedbackRef: { originId, kind: "diarrhea" as const, requiresDeviceConfirmation: true },
      }],
      proposal: null,
      basedOnBatchRevision: batch.revision,
    };
    const first = Promise.resolve().then(() => store.ensureDailyOperationAmendment({
      ...baseInput,
      idempotencyKey: "concurrent-amendment-1",
    }));
    const second = Promise.resolve().then(() => store.ensureDailyOperationAmendment({
      ...baseInput,
      idempotencyKey: "concurrent-amendment-2",
    }));
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.amendment.id).toBe(secondResult.amendment.id);
    expect(store.getDailyOperationAmendments(userId, batchId, planBody.plan.businessDate))
      .toHaveLength(1);
  });

  it("creates one canonical amendment, keeps the confirmed plan immutable, and confirms with audit", async () => {
    const { store, filename, base, cookie, userId } = await startApi();
    const created = await request(base, "/api/batches", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ name: "确认后修订", startAge: 3, endAge: 12, headCount: 20 }),
    });
    const createdBody = await created.json() as { batch: { id: string } };
    const batchId = createdBody.batch.id;

    const planResponse = await request(
      base,
      `/api/batches/${batchId}/today-operations`,
      { headers: { cookie } },
    );
    const planBody = await planResponse.json() as {
      plan: {
        id: string;
        businessDate: string;
        operationsSha256: string;
        status: string;
      };
    };
    const confirmed = await request(
      base,
      `/api/batches/${batchId}/today-operations/confirm`,
      {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({
          planId: planBody.plan.id,
          operationsSha256: planBody.plan.operationsSha256,
          idempotencyKey: "confirm-amendment-base",
        }),
      },
    );
    expect(confirmed.status).toBe(200);
    const originalPlan = planBody.plan;

    const observation = {
      recordedAt: "2026-08-05T10:00:00+08:00",
      effectiveHeads: 20,
      creepGrade: "none",
      diarrheaGrade: "mild",
      actualPowderGrams: 120,
    };
    const saved = await request(base, `/api/batches/${batchId}/records`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: store.getBatch(userId, batchId)?.revision ?? 0,
        idempotencyKey: "record-amendment-1",
        observation,
      }),
    });
    expect(saved.status).toBe(200);

    const today = await request(base, `/api/batches/${batchId}/today-operations`, {
      headers: { cookie },
    });
    const todayBody = await today.json() as {
      plan: typeof originalPlan;
      amendments: Array<{
        id: string;
        status: string;
        originId: string;
        amendmentSha256: string;
        proposal: { kind: string } | null;
      }>;
    };
    expect(todayBody.amendments).toHaveLength(1);
    expect(todayBody.amendments[0]).toMatchObject({
      status: "pending",
      proposal: { kind: "diarrhea" },
    });
    expect(todayBody.plan).toMatchObject({
      id: originalPlan.id,
      operationsSha256: originalPlan.operationsSha256,
      status: "confirmed",
    });

    await request(base, `/api/batches/${batchId}/records`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: store.getBatch(userId, batchId)?.revision ?? 0,
        idempotencyKey: "record-amendment-2",
        observation,
      }),
    });
    const todayDup = await request(base, `/api/batches/${batchId}/today-operations`, {
      headers: { cookie },
    });
    const dupBody = await todayDup.json() as {
      amendments: Array<{ id: string; originId: string }>;
    };
    expect(dupBody.amendments).toHaveLength(1);
    expect(dupBody.amendments[0].id).toBe(todayBody.amendments[0].id);

    const amendment = dupBody.amendments[0];
    const revision = store.getBatch(userId, batchId)?.revision ?? 0;
    const decision = await request(
      base,
      `/api/batches/${batchId}/amendments/${amendment.id}/confirm`,
      {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({
          expectedRevision: revision,
          expectedAmendmentSha256: amendment.amendmentSha256,
          idempotencyKey: "confirm-amendment",
        }),
      },
    );
    expect(decision.status).toBe(200);
    const decisionBody = await decision.json() as {
      amendment: { status: string; decisionId: string | null };
    };
    expect(decisionBody.amendment.status).toBe("confirmed");
    expect(decisionBody.amendment.decisionId).toMatch(/^[0-9a-f-]{36}$/);

    const stale = await request(
      base,
      `/api/batches/${batchId}/amendments/${amendment.id}/reject`,
      {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({
          expectedRevision: revision + 1,
          expectedAmendmentSha256: amendment.amendmentSha256,
          idempotencyKey: "stale-amendment",
        }),
      },
    );
    expect(stale.status).toBeGreaterThanOrEqual(400);

    const database = new DatabaseSync(filename, { readOnly: true });
    const audit = database.prepare(`
      SELECT action, count(*) AS count FROM audit_events
      WHERE action IN (
        'daily_operation_amendments.created',
        'daily_operation_amendments.confirmed',
        'daily_operation_amendments.rejected'
      )
      GROUP BY action ORDER BY action
    `).all() as Array<{ action: string; count: number }>;
    expect(audit.map((row) => row.action)).toEqual([
      "daily_operation_amendments.confirmed",
      "daily_operation_amendments.created",
    ]);
    database.close();
  });

  it("keeps severe amendments proposal-less and rejects them without a device decision", async () => {
    const { store, base, cookie, userId } = await startApi();
    const created = await request(base, "/api/batches", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ name: "严重修订", startAge: 3, endAge: 12, headCount: 20 }),
    });
    const createdBody = await created.json() as { batch: { id: string } };
    const batchId = createdBody.batch.id;
    const planResponse = await request(
      base,
      `/api/batches/${batchId}/today-operations`,
      { headers: { cookie } },
    );
    const planBody = await planResponse.json() as {
      plan: { id: string; operationsSha256: string };
    };
    await request(base, `/api/batches/${batchId}/today-operations/confirm`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        planId: planBody.plan.id,
        operationsSha256: planBody.plan.operationsSha256,
        idempotencyKey: "confirm-severe-base",
      }),
    });
    const saved = await request(base, `/api/batches/${batchId}/records`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: store.getBatch(userId, batchId)?.revision ?? 0,
        idempotencyKey: "record-severe-amendment",
        observation: {
          recordedAt: "2026-08-05T10:00:00+08:00",
          effectiveHeads: 20,
          creepGrade: "none",
          diarrheaGrade: "severe",
          actualPowderGrams: 120,
        },
      }),
    });
    expect(saved.status).toBe(200);
    const today = await request(base, `/api/batches/${batchId}/today-operations`, {
      headers: { cookie },
    });
    const todayBody = await today.json() as {
      amendments: Array<{
        id: string;
        status: string;
        severity: string;
        proposal: unknown;
        amendmentSha256: string;
      }>;
    };
    expect(todayBody.amendments[0]).toMatchObject({
      status: "pending",
      severity: "severe",
      proposal: null,
    });
    const amendment = todayBody.amendments[0];
    const rejected = await request(
      base,
      `/api/batches/${batchId}/amendments/${amendment.id}/reject`,
      {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({
          expectedRevision: store.getBatch(userId, batchId)?.revision ?? 0,
          expectedAmendmentSha256: amendment.amendmentSha256,
          idempotencyKey: "reject-severe-amendment",
        }),
      },
    );
    expect(rejected.status).toBe(200);
    const rejectedBody = await rejected.json() as {
      amendment: { status: string; decisionId: string | null };
    };
    expect(rejectedBody.amendment.status).toBe("rejected");
    expect(rejectedBody.amendment.decisionId).toBeNull();
  });
});
