import { afterEach, describe, expect, it, vi } from "vitest";
import { openLocalAgentStore } from "../../src/agent/local-message-store.js";
import { createFeedingTools } from "../../src/container/tools.js";

afterEach(() => vi.restoreAllMocks());

function contextFor(userId: string) {
  const store = openLocalAgentStore(":memory:");
  store.createBatch({
    userId: "user-a",
    batchId: "batch-1",
    revision: 3,
    currentDay: 0,
    data: {
      config: { startAge: 3, endAge: 5, startWeight: 2.3, headCount: 20 },
      records: [],
      current_day_index: 0,
      control_start_day: -1,
    },
  });
  return {
    store,
    context: {
      storage: { backend: "local" as const, store },
      userId,
      batchId: "batch-1",
      sessionId: "session-1",
      evidence: new Map<string, unknown>(),
    },
  };
}

async function executeTool(
  name: string,
  context: ReturnType<typeof contextFor>["context"],
) {
  const tool = createFeedingTools(context).find((item) => item.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.execute("call-1", {}, new AbortController().signal);
}

describe("local deterministic tools", () => {
  it("reads batch.data and returns an empty SOP task list without Supabase", async () => {
    const { store, context } = contextFor("user-a");
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network must not be used"));
    try {
      const output = await executeTool("get_batch_context", context);
      const details = output.details as {
        data: { batch: { revision: number }; openTasks: unknown[]; fullFeedingCurve: unknown[] };
      };
      expect(details.data.batch.revision).toBe(3);
      expect(details.data.openTasks).toEqual([]);
      expect(details.data.fullFeedingCurve).toHaveLength(3);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("keeps local production plans user-isolated", async () => {
    const allowed = contextFor("user-a");
    const denied = {
      ...allowed.context,
      userId: "user-b",
      evidence: new Map<string, unknown>(),
    };
    try {
      const plan = await executeTool("compute_production_plan", allowed.context);
      expect((plan.details as { data: { fullFeedingCurve: unknown[] } })
        .data.fullFeedingCurve).toHaveLength(3);
      await expect(executeTool("compute_production_plan", denied))
        .rejects.toThrowError("NBJ_BATCH_NOT_FOUND");
    } finally {
      allowed.store.close();
    }
  });
});
