import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalStore,
  LocalStoreError,
  type LocalStore,
} from "../../src/local-db/index.js";
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
      "feeding_decisions",
      "agent_sessions",
      "agent_messages",
      "audit_events",
    ]));
    expect(database.prepare("SELECT count(*) AS count FROM schema_migrations").get()?.count).toBe(1);
    const indexes = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
    `).all().map((row) => String(row.name));
    expect(indexes).toEqual(expect.arrayContaining([
      "batches_user_revision_idx",
      "daily_observations_batch_date_revision_idx",
      "feeding_decisions_batch_date_revision_idx",
      "agent_messages_session_batch_idx",
    ]));
    database.close();
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
