import { describe, expect, it } from "vitest";
import {
  createLocalAgentMessageStore,
  openLocalAgentStore,
  requireLocalAgentSession,
} from "../../src/agent/local-message-store.js";

function seededStore() {
  const store = openLocalAgentStore(":memory:");
  for (const userId of ["user-a", "user-b"]) {
    store.createBatch({ userId, batchId: "batch-1" });
    store.createSession({ userId, batchId: "batch-1", id: "session-1" });
  }
  store.createBatch({ userId: "user-a", batchId: "batch-2" });
  store.createSession({ userId: "user-a", batchId: "batch-2", id: "session-2" });
  return store;
}

describe("local agent message adapter", () => {
  it("isolates the same session and batch identifiers across users and batches", async () => {
    const store = seededStore();
    try {
      requireLocalAgentSession({
        store,
        userId: "user-a",
        batchId: "batch-1",
        sessionId: "session-1",
      });
      expect(() => requireLocalAgentSession({
        store,
        userId: "user-a",
        batchId: "batch-2",
        sessionId: "session-1",
      })).toThrowError("NBJ_AGENT_SESSION_NOT_FOUND");

      const userA = createLocalAgentMessageStore({
        store,
        userId: "user-a",
        batchId: "batch-1",
      });
      const userB = createLocalAgentMessageStore({
        store,
        userId: "user-b",
        batchId: "batch-1",
      });
      await userA.append({
        id: "message-a",
        userId: "user-a",
        sessionId: "session-1",
        role: "user",
        content: "only-a",
        evidence: {},
      });
      expect((await userA.loadHistory("session-1")).map((row) => row.content))
        .toEqual(["only-a"]);
      expect(await userB.loadHistory("session-1")).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("round-trips local history and replay evidence using the shared message contract", async () => {
    const store = seededStore();
    const adapter = createLocalAgentMessageStore({
      store,
      userId: "user-a",
      batchId: "batch-1",
    });
    try {
      await adapter.append({
        id: "user-message",
        userId: "user-a",
        sessionId: "session-1",
        role: "user",
        content: "hello",
        evidence: { clientMessageId: "client-1", responseMessageId: "assistant-1" },
      });
      await adapter.append({
        id: "assistant-1",
        userId: "user-a",
        sessionId: "session-1",
        role: "assistant",
        content: "world",
        evidence: { clientMessageId: "client-1" },
      });

      expect((await adapter.loadHistory("session-1")).map((row) => row.content))
        .toEqual(["world", "hello"]);
      expect((await adapter.findByClientMessageId("session-1", "client-1")))
        .toHaveLength(2);
      expect((await adapter.findAssistantById("session-1", "assistant-1"))?.content)
        .toBe("world");
      expect((await adapter.findByResponseMessageId("session-1", "assistant-1"))[0]?.content)
        .toBe("hello");
    } finally {
      store.close();
    }
  });
});
