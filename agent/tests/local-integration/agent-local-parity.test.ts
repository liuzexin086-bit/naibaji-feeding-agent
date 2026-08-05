import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFeedingTools } from "../../src/container/tools.js";
import { handleLocalApi } from "../../src/container/local-api.js";
import { initializeLocalAdmin } from "../../src/container/local-auth.js";
import { createLocalStore, type SqliteLocalStore } from "../../src/local-db/index.js";

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), "naibaji-agent-local-parity-"));
  const store = createLocalStore({ filename: join(directory, "local.sqlite") }) as SqliteLocalStore;
  store.migrate();
  initializeLocalAdmin(store, "admin@example.com", "correct-horse-battery");
  const server: Server = createServer((request, response) => {
    void handleLocalApi(request, response, store);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  cleanup.push(() => {
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
  const loginData = await login.json() as { user: { id: string } };
  return { base, cookie, store, userId: loginData.user.id };
}

function request(base: string, path: string, init: RequestInit = {}) {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("Agent and local API frozen-decision parity", () => {
  it("returns matching selected/effective modes, refs, meal times, windows, and quantities", async () => {
    const { base, cookie, store, userId } = await setup();
    const createdResponse = await request(base, "/api/batches", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ name: "P0 parity", startAge: 3, endAge: 5, headCount: 20 }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as {
      batch: { id: string };
      agentSession: { id: string };
      today: {
        selectedMode: string;
        effectiveMode: string;
        sopRef: unknown;
        devicePlanRef: unknown;
        setting: unknown;
      };
    };
    const agentContext = {
      storage: { backend: "local" as const, store },
      userId,
      batchId: created.batch.id,
      sessionId: created.agentSession.id,
      evidence: new Map<string, unknown>(),
    };
    const production = createFeedingTools(agentContext)
      .find((tool) => tool.name === "compute_production_plan");
    if (!production) throw new Error("compute_production_plan missing");
    const agentResult = await production.execute("p0-parity", {});
    const canonical = (agentResult.details as {
      data: { canonicalDecision: {
        selectedMode: string;
        effectiveMode: string;
        sopRef: unknown;
        devicePlanRef: unknown;
        decision: { setting: unknown };
      } };
    }).data.canonicalDecision;
    expect(canonical.selectedMode).toBe(created.today.selectedMode);
    expect(canonical.effectiveMode).toBe(created.today.effectiveMode);
    expect(canonical.sopRef).toEqual(created.today.sopRef);
    expect(canonical.devicePlanRef).toEqual(created.today.devicePlanRef);
    expect(canonical.decision.setting).toEqual(created.today.setting);

    const advanced = await request(base, `/api/batches/${created.batch.id}/advance`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        expectedRevision: 0,
        idempotencyKey: "p0-parity-advance",
        observation: { effectiveHeads: 20, creepGrade: "none", diarrheaGrade: "none" },
      }),
    });
    expect(advanced.status).toBe(200);
    const switched = await request(base, `/api/batches/${created.batch.id}/mode`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        mode: "free_feeding",
        expectedRevision: 1,
        idempotencyKey: "p0-parity-free",
      }),
    });
    expect(switched.status).toBe(200);
    const freeToday = (await switched.json() as { today: typeof created.today }).today;
    const freeResult = await production.execute("p0-parity-free", {});
    const freeCanonical = (freeResult.details as typeof agentResult.details as {
      data: { canonicalDecision: typeof canonical };
    }).data.canonicalDecision;
    expect(freeCanonical.selectedMode).toBe("free_feeding");
    expect(freeCanonical.effectiveMode).toBe(freeToday.effectiveMode);
    expect(freeCanonical.sopRef).toEqual(freeToday.sopRef);
    expect(freeCanonical.devicePlanRef).toEqual(freeToday.devicePlanRef);
    expect(freeCanonical.decision.setting).toEqual(freeToday.setting);
  });
});
