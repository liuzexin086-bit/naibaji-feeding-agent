import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openLocalAgentStore } from "../../src/agent/local-message-store.js";
import { createFeedingTools } from "../../src/container/tools.js";
import { digestFrozenSopSnapshot } from "../../src/decision/batch-decision-service.js";
import { defaultFreeFeedingSlots } from "../../src/decision/free-feeding-slots.js";
import type { DevicePlanSnapshot } from "../../src/shared/local-store-contract.js";

afterEach(() => vi.restoreAllMocks());

function frozenDevicePlan(): DevicePlanSnapshot {
  const slots = defaultFreeFeedingSlots().map((slot, index) => index === 0
    ? { ...slot, startLocal: "09:00", endLocal: "23:00" }
    : slot);
  const snapshot: DevicePlanSnapshot = {
    version: "device-plan@test-v1",
    sha256: "",
    firstDay: {
      mode: "timed_quantity",
      mealTimes: ["17:00", "20:00", "23:00", "02:00", "05:00", "08:00"],
    },
    templates: {
      timed_quantity: {
        mealTimes: ["10:00", "14:00", "16:00", "18:00", "20:00", "22:00", "02:00", "04:00", "06:00", "08:00"],
        excludedMealTimes: ["00:00", "12:00"],
        precisionGrams: 1,
        reductionPriority: ["20:00", "16:00", "04:00", "14:00", "06:00", "18:00", "02:00", "22:00", "10:00"],
      },
      free_feeding: {
        slots,
        windows: [{ startLocal: "09:00", endLocal: "23:00" }],
        stageConditions: {},
        exceptionBlockers: [],
      },
    },
  };
  snapshot.sha256 = createHash("sha256").update(JSON.stringify({
    version: snapshot.version,
    firstDay: snapshot.firstDay,
    templates: snapshot.templates,
  }).normalize("NFC"), "utf8").digest("hex").toUpperCase();
  return snapshot;
}

function frozenConfig() {
  const sopTemplate = {
    templateId: "sop-test",
    version: "sop@test-v1",
    sourceSha256: "a".repeat(64),
    collectionRevision: "collection@test-v1",
    parserVersion: "parser@test-v1",
    embeddingModel: "embedding@test-v1",
    config: {
      teachingProgramEnabled: true,
      teachingFirstLocal: "17:00",
      teachingIntervalHours: 3,
      teachingEndLocal: "08:00",
      teachingDirectTotalPowderGrams: 0,
      teachingPowderGramsPerTwenty: 35,
    },
  };
  return {
    startAge: 3,
    endAge: 5,
    startWeight: 2.3,
    headCount: 20,
    effectiveHeads: 20,
    selectedMode: "timed_quantity" as const,
    planStartDate: "2026-07-31",
    controlStartDay: -1,
    sopTemplate: { ...sopTemplate, snapshotSha256: digestFrozenSopSnapshot(sopTemplate) },
    devicePlanSnapshot: frozenDevicePlan(),
  };
}

function contextFor(userId: string) {
  const store = openLocalAgentStore(":memory:");
  store.createBatch({
    userId: "user-a",
    batchId: "batch-1",
    revision: 3,
    currentDay: 0,
    data: {
      config: frozenConfig(),
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
  it("reads batch.data without Supabase and retains the frozen deterministic curve", async () => {
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

  it("materializes the local timeline as one frozen daily operation plan instead of an empty task list", async () => {
    const { store, context } = contextFor("user-a");
    try {
      const first = await executeTool("get_today_timeline", context);
      const replay = await executeTool("get_today_timeline", context);
      const firstData = (first.details as { data: {
        dailyOperationPlan: { id: string; status: string; operations: Array<{ code: string }> };
        tasks: Array<{ code: string }>;
      } }).data;
      const replayData = (replay.details as { data: { dailyOperationPlan: { id: string } } }).data;
      expect(firstData.dailyOperationPlan.status).toBe("pending");
      expect(firstData.dailyOperationPlan.operations.map((item) => item.code))
        .toContain("first_day_teaching");
      expect(firstData.tasks).toEqual(firstData.dailyOperationPlan.operations);
      expect(replayData.dailyOperationPlan.id).toBe(firstData.dailyOperationPlan.id);
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

  it("fails closed when its frozen device snapshot is absent", async () => {
    const { store, context } = contextFor("user-a");
    try {
      const batch = store.getBatch("user-a", "batch-1");
      if (!batch) throw new Error("test batch missing");
      const config = { ...(batch.data.config as Record<string, unknown>) };
      delete config.devicePlanSnapshot;
      store.createBatch({
        userId: "user-a",
        batchId: "batch-without-device-snapshot",
        data: { ...batch.data, config },
      });
      const unsafeContext = { ...context, batchId: "batch-without-device-snapshot" };
      await expect(executeTool("compute_production_plan", unsafeContext))
        .rejects.toThrowError("NBJ_FROZEN_DEVICE_PLAN_MISSING");
    } finally {
      store.close();
    }
  });

  it("previews diarrhea adjustment from the current observation and keeps a frozen receipt", async () => {
    const { store, context } = contextFor("user-a");
    try {
      const previewContext = {
        ...context,
        evidence: new Map<string, unknown>(),
        observation: { diarrheaGrade: "mild" as const, actualPowderGrams: 120 },
      };
      const tool = createFeedingTools(previewContext)
        .find((item) => item.name === "preview_diarrhea_adjustment");
      if (!tool) throw new Error("missing preview tool");
      const output = await tool.execute(
        "call-1",
        { observedAt: "2026-08-05T10:00:00.000Z" },
        new AbortController().signal,
      );
      const details = output.details as {
        data: {
          worstGrade: string;
          cumulativePowderGrams: number;
          cumulativeSource: string;
          deviceOperation: { mode: string; manualDispositionRequired: boolean };
        };
        evidenceReceipt: { receiptId: string };
      };
      expect(details.data.worstGrade).toBe("mild");
      expect(details.data.cumulativePowderGrams).toBe(120);
      expect(details.data.cumulativeSource).toBe("observation");
      expect(details.data.deviceOperation.mode).toBe("timed_quantity");
      expect(details.data.deviceOperation.manualDispositionRequired).toBe(false);
      expect(details.evidenceReceipt.receiptId).toMatch(/^nbj-receipt-[0-9a-f]{24}$/);
    } finally {
      store.close();
    }
  });
});
