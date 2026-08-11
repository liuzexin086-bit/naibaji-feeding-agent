import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AIMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { RunnableLambda } from "@langchain/core/runnables";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeSharedCheckpointSavers,
  getSharedCheckpointSaver,
  NodeSqliteCheckpointSaver,
} from "../src/agent/langgraph/checkpoint.js";
import {
  createAgentGraphRuntime,
  graphThreadId,
} from "../src/agent/langgraph/runtime.js";
import { classifyDeterministicIntent, staticEvidencePlan, staticToolArguments } from "../src/agent/langgraph/router.js";
import type { FeedingTool } from "../src/container/tools.js";

const tempDirs: string[] = [];
const savers: NodeSqliteCheckpointSaver[] = [];

afterEach(() => {
  for (const saver of savers.splice(0)) saver.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fakeModel(responses: AIMessage[]) {
  let calls = 0;
  const runnable = new RunnableLambda({ func: async () => responses[calls++] ?? new AIMessage("fallback") });
  return { bindTools: () => runnable, get calls() { return calls; } };
}

function tool(name: string, execute: FeedingTool["execute"]): FeedingTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute,
  };
}

function syncTool(overrides: Record<string, unknown> = {}) {
  return tool("sync_observation_feedback", async () => receiptResult("sync_observation_feedback", "b", {
    status: "ok",
    reason: "测试反馈",
    dailyOperationPlan: {
      id: "plan-sync",
      businessDate: "2026-08-04",
      operationsSha256: "d".repeat(64),
      status: "pending",
      operations: [{ title: "腹泻处置确认（轻度）", dueWindow: { startLocal: "09:00", endLocal: "09:00", endDayOffset: 1 } }],
    },
    feedbackOrigin: {
      id: "origin-1",
      kind: "diarrhea",
      businessDate: "2026-08-04",
      status: "proposed",
      sourceObservation: { recordedAt: "2026-08-04T09:00:00.000Z", diarrheaGrade: "mild", actualPowderGrams: 120 },
      reason: "测试反馈",
    },
    proposedSetting: null,
    ...overrides,
  }, 3, [0, 1, 4, 9, 120, 2026]));
}

function receiptResult(toolName: string, batchId: string, data: unknown, revision = 3, numericWhitelist = [42]) {
  const payload = {
    toolName,
    batchId,
    revision,
    sopSourceSha256: "a".repeat(64),
    devicePlanSha256: "b".repeat(64),
    data,
  };
  const inputDigest = createHash("sha256")
    .update(JSON.stringify(payload).normalize("NFC"), "utf8")
    .digest("hex").toUpperCase();
  return {
    details: {
      data,
      evidenceReceipt: {
        receiptId: `nbj-receipt-${inputDigest.slice(0, 24).toLowerCase()}`,
        batchId,
        revision,
        sopSourceSha256: "a".repeat(64),
        devicePlanSha256: "b".repeat(64),
        inputDigest,
        numericWhitelist,
      },
    },
  };
}

function input(message = "你好") {
  return {
    userId: "u", batchId: "b", sessionId: "s", clientMessageId: `cm-${message}`,
    message, history: [], systemPrompt: "只使用确定性证据", signal: new AbortController().signal, resume: false,
  };
}

describe("LangGraph v2 deterministic runtime", () => {
  it("uses a scoped thread id and fixed safety-priority intent router", () => {
    expect(graphThreadId("u1", "b1", "s1")).toBe("nbj:u1:b1:s1");
    expect(classifyDeterministicIntent("腹泻且弱仔拒食").kind).toBe("exception");
    expect(classifyDeterministicIntent("弱仔需要补喂").kind).toBe("laggard");
    expect(classifyDeterministicIntent("断奶首日要做什么").kind).toBe("knowledge");
    expect(staticEvidencePlan("timeline_or_today_operations")).toEqual({
      requiredTools: ["sync_observation_feedback", "get_today_timeline"], responseKind: "deterministic",
    });
  });

  it("routes diarrhea exceptions to the deterministic preview tool", () => {
    expect(staticEvidencePlan("exception", "已录入轻度腹泻，请给出具体设备操作。")).toEqual({
      requiredTools: ["sync_observation_feedback", "preview_diarrhea_adjustment"], responseKind: "deterministic",
    });
    expect(staticEvidencePlan("exception", "设备堵塞了")).toEqual({
      requiredTools: ["check_data_quality"], responseKind: "deterministic",
    });
    expect(staticToolArguments("preview_diarrhea_adjustment", "已录入重度腹泻，请给出具体设备操作。"))
      .toMatchObject({ grades: ["severe"] });
    expect(String(staticToolArguments("preview_diarrhea_adjustment", "已录入轻度腹泻，请给出具体设备操作。").observedAt))
      .toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00$/);
    expect(staticToolArguments("preview_diarrhea_adjustment", "已下粉120g，轻度腹泻"))
      .toMatchObject({ grades: ["mild"], cumulativePowderGrams: 120 });
    expect(staticToolArguments("preview_diarrhea_adjustment", "已下粉120，轻度腹泻"))
      .toMatchObject({ grades: ["mild"], cumulativePowderGrams: 120 });
    expect(staticToolArguments("preview_diarrhea_adjustment", "已下粉120克，轻度腹泻"))
      .toMatchObject({ grades: ["mild"], cumulativePowderGrams: 120 });
    expect(staticToolArguments("preview_diarrhea_adjustment", "轻度腹泻"))
      .not.toHaveProperty("cumulativePowderGrams");
  });

  it("returns a concrete diarrhea adjustment preview with batch day and age", async () => {
    const contextData = {
      batch: { current_day_index: 1, config: { name: "批次 A" } },
      canonicalDecision: { selectedMode: "timed_quantity", effectiveMode: "timed_quantity" },
      selectedDecision: {
        setting: {
          dayAge: 4,
          timedMeals: [{ timeLocal: "10:00", powderGrams: 30 }],
          freeWindows: [],
        },
      },
    };
    const previewData = {
      worstGrade: "mild",
      status: "individual_intervention",
      decision: {
        setting: {
          mode: "timed_quantity",
          dailyPowderGrams: 150,
          singlePowderGrams: 25,
          mealCount: 6,
          timedMeals: [
            { timeLocal: "10:00", powderGrams: 25 },
            { timeLocal: "14:00", powderGrams: 25 },
          ],
        },
      },
      deviceOperation: {
        mode: "timed_quantity",
        remainingDailyPowderGrams: 150,
        singlePowderGrams: 25,
        timedMeals: [
          { timeLocal: "10:00", powderGrams: 25 },
          { timeLocal: "14:00", powderGrams: 25 },
        ],
        clearFreeFeedingWindows: true,
        requiresHumanApproval: true,
        manualDispositionRequired: false,
      },
      cumulativePowderGrams: 120,
      cumulativeSource: "observation",
      adjustedProgramTotal: 150,
      remainingDeliverable: 30,
      targetSlot: "10:00",
      targetAlreadyHappened: false,
      severeException: null,
    };
    const runtime = createAgentGraphRuntime({
      model: fakeModel([new AIMessage("不应调用")]) as never,
      tools: [
        syncTool(),
        tool("get_batch_context", async () => receiptResult(
          "get_batch_context", "b", contextData, 3, [0, 1, 2, 4, 10, 14, 25, 30, 120, 150],
        )),
        tool("preview_diarrhea_adjustment", async () => receiptResult(
          "preview_diarrhea_adjustment", "b", previewData, 3, [0, 1, 2, 4, 10, 14, 25, 120, 150],
        )),
      ],
    });
    const result = await runtime.run(input("已录入轻度腹泻，请给出具体设备操作。"));
    expect(result).toMatchObject({ intent: "exception", status: "completed" });
    expect(result.text).toContain("批次 A");
    expect(result.text).toContain("第2天");
    expect(result.text).toContain("日龄4");
    expect(result.text).toContain("按个体处置");
    expect(result.text).toContain("设备程序保持不变");
    expect(result.text).toContain("不生成设备调整提案");
  });

  it("routes a general follow-up to diarrhea preview when the batch has a recorded diarrhea", async () => {
    const contextData = {
      batch: {
        current_day_index: 1,
        config: { name: "批次 A" },
        records: [
          { recordedAt: "2026-08-05T08:00:00.000Z", diarrheaGrade: "none", actualPowderGrams: 80 },
          { recordedAt: "2026-08-05T09:00:00.000Z", diarrheaGrade: "mild", actualPowderGrams: 100 },
        ],
      },
      canonicalDecision: { selectedMode: "timed_quantity", effectiveMode: "timed_quantity" },
      selectedDecision: {
        setting: {
          dayAge: 4,
          timedMeals: [{ timeLocal: "10:00", powderGrams: 30 }],
          freeWindows: [],
        },
      },
    };
    const previewData = {
      worstGrade: "mild",
      status: "individual_intervention",
      decision: {
        setting: {
          mode: "timed_quantity",
          dailyPowderGrams: 150,
          singlePowderGrams: 25,
          mealCount: 6,
          timedMeals: [
            { timeLocal: "10:00", powderGrams: 25 },
            { timeLocal: "14:00", powderGrams: 25 },
          ],
        },
      },
      deviceOperation: {
        mode: "timed_quantity",
        remainingDailyPowderGrams: 150,
        singlePowderGrams: 25,
        timedMeals: [
          { timeLocal: "10:00", powderGrams: 25 },
          { timeLocal: "14:00", powderGrams: 25 },
        ],
        clearFreeFeedingWindows: true,
        requiresHumanApproval: true,
        manualDispositionRequired: false,
      },
      cumulativePowderGrams: 100,
      cumulativeSource: "latest_record",
      adjustedProgramTotal: 150,
      remainingDeliverable: 50,
      targetSlot: "10:00",
      targetAlreadyHappened: false,
      severeException: null,
    };
    const runtime = createAgentGraphRuntime({
      model: fakeModel([new AIMessage("不应调用")]) as never,
      tools: [
        syncTool(),
        tool("get_batch_context", async () => receiptResult(
          "get_batch_context", "b", contextData, 3, [0, 1, 2, 4, 10, 25, 30, 100, 150],
        )),
        tool("preview_diarrhea_adjustment", async () => receiptResult(
          "preview_diarrhea_adjustment", "b", previewData, 3, [0, 1, 2, 4, 10, 25, 30, 100, 150],
        )),
      ],
    });
    const result = await runtime.run(input("现在怎么办"));
    expect(result).toMatchObject({ intent: "exception", status: "completed" });
    expect(result.text).toContain("按个体处置");
    expect(result.text).toContain("设备程序保持不变");
  });

  it("returns an ended response when the latest diarrhea record returns to none", async () => {
    const contextData = {
      batch: {
        current_day_index: 1,
        config: { name: "批次 A" },
        records: [
          { recordedAt: "2026-08-05T09:00:00.000Z", diarrheaGrade: "mild", actualPowderGrams: 120 },
          { recordedAt: "2026-08-05T15:00:00.000Z", diarrheaGrade: "none", actualPowderGrams: 180 },
        ],
      },
      canonicalDecision: { selectedMode: "timed_quantity", effectiveMode: "timed_quantity" },
      selectedDecision: {
        setting: {
          dayAge: 4,
          timedMeals: [{ timeLocal: "10:00", powderGrams: 30 }],
          freeWindows: [],
        },
      },
    };
    const endedData = {
      status: "ended",
      reason: "最近腹泻记录已恢复为无，无需生成腹泻减餐预览。",
      deviceOperation: null,
      manualDispositionRequired: false,
    };
    const runtime = createAgentGraphRuntime({
      model: fakeModel([new AIMessage("不应调用")]) as never,
      tools: [
        syncTool(),
        tool("get_batch_context", async () => receiptResult(
          "get_batch_context", "b", contextData, 3, [0, 1, 2, 4, 10, 30, 120, 180],
        )),
        tool("preview_diarrhea_adjustment", async () => receiptResult(
          "preview_diarrhea_adjustment", "b", endedData, 3, [0, 1, 2, 4, 10, 30, 120, 180],
        )),
      ],
    });
    const result = await runtime.run(input("腹泻结束了，现在怎么办"));
    expect(result).toMatchObject({ intent: "exception", status: "completed" });
    expect(result.text).toContain("最近腹泻记录已恢复为“无”");
    expect(result.text).toContain("不再保留待确认的腹泻处置项");
  });

  it("renders reduce-one-meal diarrhea response instead of time-based allowance", async () => {
    const contextData = {
      batch: {
        current_day_index: 1,
        config: { name: "批次 A" },
        records: [
          { recordedAt: "2026-08-05T09:00:00.000Z", diarrheaGrade: "moderate", actualPowderGrams: 500 },
        ],
      },
      canonicalDecision: { selectedMode: "timed_quantity", effectiveMode: "timed_quantity" },
      selectedDecision: {
        setting: {
          dayAge: 4,
          timedMeals: [{ timeLocal: "10:00", powderGrams: 30 }],
          freeWindows: [],
        },
      },
    };
    const previewData = {
      worstGrade: "moderate",
      status: "feeding_reduction_proposal",
      decision: {
        setting: {
          mode: "timed_quantity",
          dailyPowderGrams: 150,
          singlePowderGrams: 25,
          mealCount: 5,
          timedMeals: [{ timeLocal: "14:00", powderGrams: 25 }],
        },
      },
      deviceOperation: {
        mode: "timed_quantity",
        remainingDailyPowderGrams: 150,
        singlePowderGrams: 25,
        timedMeals: [{ timeLocal: "14:00", powderGrams: 25 }],
        clearFreeFeedingWindows: true,
        requiresHumanApproval: true,
        manualDispositionRequired: false,
      },
      cumulativePowderGrams: 100,
      cumulativeSource: "observation",
      adjustedProgramTotal: 150,
      remainingDeliverable: 50,
      targetSlot: "10:00",
      targetAlreadyHappened: false,
      severeException: null,
    };
    const runtime = createAgentGraphRuntime({
      model: fakeModel([new AIMessage("不应调用")]) as never,
      tools: [
        syncTool(),
        tool("get_batch_context", async () => receiptResult(
          "get_batch_context", "b", contextData, 3, [0, 1, 2, 4, 10, 30, 500],
        )),
        tool("preview_diarrhea_adjustment", async () => receiptResult(
          "preview_diarrhea_adjustment", "b", previewData, 3, [0, 1, 2, 4, 10, 30, 500],
        )),
      ],
    });
    const result = await runtime.run(input("腹泻后设备怎么设"));
    expect(result.status).toBe("completed");
    expect(result.text).toContain("中度腹泻整栏减餐待确认提案");
    expect(result.text).toContain("独立人工确认后应用");
    expect(result.text).toContain("目标餐次 10:00");
  });

  it("converts cumulative overrun to manual-only even when no meals remain", async () => {
    const contextData = {
      batch: {
        current_day_index: 1,
        config: { name: "批次 A" },
        records: [
          { recordedAt: "2026-08-05T09:00:00.000Z", diarrheaGrade: "mild", actualPowderGrams: 100 },
        ],
      },
      canonicalDecision: { selectedMode: "timed_quantity", effectiveMode: "timed_quantity" },
      selectedDecision: {
        setting: {
          dayAge: 4,
          timedMeals: [{ timeLocal: "10:00", powderGrams: 30 }],
          freeWindows: [],
        },
      },
    };
    const previewData = {
      worstGrade: "mild",
      status: "manual_only",
      decision: null,
      deviceOperation: null,
      cumulativePowderGrams: 100,
      cumulativeSource: "latest_record",
      adjustedProgramTotal: 89,
      remainingDeliverable: 0,
      targetSlot: "10:00",
      targetAlreadyHappened: false,
      manualDispositionRequired: true,
      severeException: null,
    };
    const runtime = createAgentGraphRuntime({
      model: fakeModel([new AIMessage("不应调用")]) as never,
      tools: [
        syncTool(),
        tool("get_batch_context", async () => receiptResult(
          "get_batch_context", "b", contextData, 3, [0, 1, 2, 4, 10, 30, 89, 100],
        )),
        tool("preview_diarrhea_adjustment", async () => receiptResult(
          "preview_diarrhea_adjustment", "b", previewData, 3, [0, 1, 2, 4, 10, 30, 89, 100],
        )),
      ],
    });
    const result = await runtime.run(input("腹泻后设备怎么设"));
    expect(result.status).toBe("completed");
    expect(result.text).toContain("人工处置");
    expect(result.text).toContain("调整后整日程序总量 89g");
    expect(result.text).toContain("不生成可执行设备提案");
  });

  it("gives every general turn the verified batch context", async () => {
    let seen: BaseMessage[] = [];
    const model = {
      bindTools: () => new RunnableLambda({
        func: async (messages: BaseMessage[]) => {
          seen = messages;
          return new AIMessage("明白");
        },
      }),
    };
    const runtime = createAgentGraphRuntime({
      model: model as never,
      tools: [
        syncTool(),
        tool("get_batch_context", async () => receiptResult("get_batch_context", "b", {
          batch: { current_day_index: 0, config: { name: "批次 B" } },
          canonicalDecision: { selectedMode: "timed_quantity", effectiveMode: "timed_quantity" },
          selectedDecision: { setting: { dayAge: 3, timedMeals: [], freeWindows: [] } },
        }, 3, [0, 3])),
      ],
    });
    const result = await runtime.run(input("你好"));
    expect(result.status).toBe("completed");
    const contextMessage = seen.find((message) =>
      message instanceof SystemMessage && String(message.content).includes("已核实现场上下文：\n批次"));
    expect(String(contextMessage?.content ?? "")).toContain("第1天");
    expect(String(contextMessage?.content ?? "")).toContain("日龄3");
  });

  it("returns manual-only for moderate when cumulative powder is missing", async () => {
    const contextData = {
      batch: { current_day_index: 1, config: { name: "批次 A" } },
      canonicalDecision: { selectedMode: "timed_quantity", effectiveMode: "timed_quantity" },
      selectedDecision: {
        setting: {
          dayAge: 4,
          timedMeals: [{ timeLocal: "10:00", powderGrams: 30 }],
          freeWindows: [],
        },
      },
    };
    const previewData = {
      worstGrade: "moderate",
      status: "manual_only",
      decision: null,
      deviceOperation: null,
      cumulativePowderGrams: null,
      cumulativeSource: "missing",
      adjustedProgramTotal: 150,
      remainingDeliverable: 150,
      targetSlot: null,
      targetAlreadyHappened: false,
      manualDispositionRequired: true,
      severeException: null,
    };
    const runtime = createAgentGraphRuntime({
      model: fakeModel([new AIMessage("不应调用")]) as never,
      tools: [
        syncTool(),
        tool("get_batch_context", async () => receiptResult(
          "get_batch_context", "b", contextData, 3, [0, 1, 2, 4, 10, 25, 150],
        )),
        tool("preview_diarrhea_adjustment", async () => receiptResult(
          "preview_diarrhea_adjustment", "b", previewData, 3, [0, 1, 2, 4, 10, 25, 150],
        )),
      ],
    });
    const result = await runtime.run(input("已录入中度腹泻，请给出具体设备操作。"));
    expect(result.status).toBe("completed");
    expect(result.text).toContain("中度腹泻人工处置要求");
    expect(result.text).toContain("累计实际未录入");
    expect(result.text).toContain("不生成可执行设备提案");
  });

  it("returns manual-only response for severe diarrhea", async () => {
    const contextData = {
      batch: { current_day_index: 1, config: { name: "批次 A" } },
      canonicalDecision: { selectedMode: "timed_quantity", effectiveMode: "timed_quantity" },
      selectedDecision: {
        setting: {
          dayAge: 4,
          timedMeals: [{ timeLocal: "10:00", powderGrams: 30 }],
          freeWindows: [],
        },
      },
    };
    const previewData = {
      worstGrade: "severe",
      status: "manual_only",
      decision: null,
      deviceOperation: null,
      cumulativePowderGrams: 120,
      cumulativeSource: "observation",
      adjustedProgramTotal: 100,
      remainingDeliverable: 0,
      targetSlot: "10:00",
      targetAlreadyHappened: false,
      manualDispositionRequired: true,
      severeException: "严重异常：暂停常规增量，执行现场检查并进入人工处置。",
    };
    const runtime = createAgentGraphRuntime({
      model: fakeModel([new AIMessage("不应调用")]) as never,
      tools: [
        syncTool(),
        tool("get_batch_context", async () => receiptResult(
          "get_batch_context", "b", contextData, 3, [0, 1, 2, 4, 10, 20, 30, 100, 120],
        )),
        tool("preview_diarrhea_adjustment", async () => receiptResult(
          "preview_diarrhea_adjustment", "b", previewData, 3, [0, 1, 2, 4, 10, 20, 30, 100, 120],
        )),
      ],
    });
    const result = await runtime.run(input("已录入重度腹泻，请给出具体设备操作。"));
    expect(result.status).toBe("completed");
    expect(result.text).toContain("已记录重度腹泻");
    expect(result.text).toContain("不自动修改奶爸机饲喂程序");
    expect(result.text).toContain("立即隔离");
    expect(result.text).toContain("现场兽医");
  });

  it("asks for the diarrhea grade when the preview cannot derive one", async () => {
    const runtime = createAgentGraphRuntime({
      model: fakeModel([new AIMessage("不应调用")]) as never,
      tools: [
        syncTool(),
        tool("get_batch_context", async () => receiptResult("get_batch_context", "b", { safe: true })),
        tool("preview_diarrhea_adjustment", async () => {
          throw new Error("NBJ_DIARRHEA_GRADE_REQUIRED");
        }),
      ],
    });
    const result = await runtime.run(input("腹泻了怎么办"));
    expect(result).toMatchObject({ intent: "exception", status: "safe_block" });
    expect(result.text).toContain("请补充腹泻档位");
    expect(result.text).toContain("累计下粉量请在页面“今日数据”录入并保存");
    expect(result.text).toContain("120g");
  });

  it("uses the static timeline evidence plan instead of model-selected tool calls", async () => {
    const execution: string[] = [];
    const model = fakeModel([new AIMessage("43 克")]);
    const runtime = createAgentGraphRuntime({
      model: model as never,
      tools: [
        syncTool(),
        tool("get_batch_context", async () => {
          execution.push("context");
          return receiptResult("get_batch_context", "b", { safe: true });
        }),
        tool("get_today_timeline", async () => {
          execution.push("timeline");
          return receiptResult("get_today_timeline", "b", {
            dailyOperationPlan: {
              id: "plan-1",
              businessDate: "2026-08-04",
              operationsSha256: "c".repeat(64),
              status: "pending",
            },
          });
        }),
      ],
    });
    const result = await runtime.run(input("今天有哪些今日操作和巡栏任务？"));
    expect(execution).toEqual(["context", "timeline"]);
    expect(model.calls).toBe(0);
    expect(result).toMatchObject({
      intent: "timeline_or_today_operations",
      status: "completed",
      toolExecutions: 2,
      text: expect.stringContaining("今日常规操作已按冻结 SOP 汇总"),
    });
    expect(result.toolEvidence.map((event) => event.name))
      .toEqual(["get_batch_context", "sync_observation_feedback", "get_today_timeline"]);
  });

  it("renders the verified current batch and device settings instead of a fixed acknowledgement", async () => {
    const contextData = {
      batch: { current_day_index: 1, config: { name: "批次 A" } },
      canonicalDecision: { selectedMode: "free_feeding", effectiveMode: "free_feeding" },
      selectedDecision: {
        setting: {
          dayAge: 4,
          singlePowderGrams: 186,
          dailyPowderGrams: 1860,
          mealCount: 10,
          suggestedDailyPowderGrams: 1860,
          suggestedDailyMealCount: 12,
          timedMeals: [],
          freeWindows: [{ startLocal: "09:00", endLocal: "18:00" }],
        },
      },
    };
    const runtime = createAgentGraphRuntime({
      model: fakeModel([new AIMessage("43 克"), new AIMessage("43 克")]) as never,
      tools: [
        syncTool(),
        tool("get_batch_context", async () => receiptResult(
          "get_batch_context", "b", contextData, 3, [0, 1, 2, 4, 9, 10, 12, 18, 186, 1860],
        )),
        tool("compute_production_plan", async () => receiptResult(
          "compute_production_plan", "b", { safe: true }, 3, [0, 1, 2, 4, 9, 10, 12, 18, 186, 1860],
        )),
      ],
    });
    const device = await runtime.run(input("当前批次的设备怎么设置"));
    expect(device).toMatchObject({
      intent: "device_plan_or_mode",
      status: "completed",
      text: expect.stringContaining("建议单日下粉总量 1860g（模型按12次计算）"),
    });
    expect(device.text).not.toContain("单次下粉 186g");
    const overview = await runtime.run({ ...input("当前批次数据"), clientMessageId: "batch-overview" });
    expect(overview).toMatchObject({ intent: "batch_overview", status: "completed" });
    expect(overview.text).toContain("自由采食时间段：09:00–18:00");
  });

  it("renders today operation titles from the verified timeline receipt", async () => {
    const runtime = createAgentGraphRuntime({
      model: fakeModel([new AIMessage("43 克")]) as never,
      tools: [
        syncTool(),
        tool("get_batch_context", async () => receiptResult("get_batch_context", "b", {
          batch: { current_day_index: 1, config: { name: "批次 A" } },
          canonicalDecision: { selectedMode: "timed_quantity", effectiveMode: "timed_quantity" },
          selectedDecision: { setting: { dayAge: 4, timedMeals: [], freeWindows: [] } },
        }, 3, [1, 2, 4, 9, 0, 10])),
        tool("get_today_timeline", async () => receiptResult("get_today_timeline", "b", {
          dailyOperationPlan: {
            id: "plan-1",
            businessDate: "2026-08-05",
            operationsSha256: "c".repeat(64),
            status: "pending",
            operations: [{ title: "日常巡栏", dueWindow: { startLocal: "09:00", endLocal: "10:00" } }],
          },
        }, 3, [-8, -5, 0, 1, 2, 4, 5, 8, 9, 10, 2026])),
      ],
    });
    await expect(runtime.run(input("今天有哪些今日操作？"))).resolves.toMatchObject({
      intent: "timeline_or_today_operations",
      status: "completed",
      text: expect.stringContaining("09:00–10:00 日常巡栏"),
    });
  });

  it("renders amendment state in deterministic today-operation output", async () => {
    const runtime = createAgentGraphRuntime({
      model: fakeModel([new AIMessage("不应调用")]) as never,
      tools: [
        syncTool(),
        tool("get_batch_context", async () => receiptResult("get_batch_context", "b", {
          batch: { current_day_index: 1, config: { name: "批次 A" } },
          canonicalDecision: { selectedMode: "timed_quantity", effectiveMode: "timed_quantity" },
          selectedDecision: { setting: { dayAge: 4, timedMeals: [], freeWindows: [] } },
        }, 3, [1, 2, 4, 9, 0, 10])),
        tool("get_today_timeline", async () => receiptResult("get_today_timeline", "b", {
          dailyOperationPlan: {
            id: "plan-1",
            businessDate: "2026-08-05",
            operationsSha256: "c".repeat(64),
            status: "confirmed",
            operations: [{ title: "日常巡栏", dueWindow: { startLocal: "09:00", endLocal: "10:00" } }],
          },
          amendments: [{
            id: "amendment-1",
            originKind: "diarrhea",
            severity: "mild",
            priority: "routine",
            status: "pending",
            decisionId: null,
            proposalDigest: "D".repeat(64),
          }],
        }, 3, [0, 1, 2, 4, 5, 8, 9, 10, 2026])),
      ],
    });
    const result = await runtime.run(input("今天有哪些今日操作？"));
    expect(result).toMatchObject({ intent: "timeline_or_today_operations", status: "completed" });
    expect(result.text).toContain("确认后修订 1 项");
    expect(result.text).toContain("待确认 1");
  });

  it("renders protected batch facts deterministically without calling the LLM", async () => {
    const model = fakeModel([new AIMessage("不应调用")]);
    const runtime = createAgentGraphRuntime({
      model: model as never,
      tools: [
        syncTool({
          proposedSetting: {
            kind: "diarrhea",
            businessDate: "2026-08-04",
            mode: "timed_quantity",
            dayAge: 4,
            dailyPowderGrams: 90,
            singlePowderGrams: 30,
            mealCount: 3,
            timedMeals: [{ timeLocal: "14:00", powderGrams: 30 }],
            freeWindows: [],
            precisionGrams: 1,
            source: "sop_indirect",
            rationale: ["腹泻调整"],
            manualDispositionRequired: false,
            proposalDigest: "A".repeat(64),
          },
        }),
        tool("get_batch_context", async () => receiptResult("get_batch_context", "b", {
          batch: { current_day_index: 1, config: { name: "批次 A" } },
          canonicalDecision: { selectedMode: "timed_quantity", effectiveMode: "timed_quantity" },
          selectedDecision: { setting: { dayAge: 4, timedMeals: [], freeWindows: [] } },
        }, 3, [0, 1, 4, 9, 30, 90, 120, 2026])),
      ],
    });
    const result = await runtime.run(input("当前批次数据"));
    expect(result).toMatchObject({ intent: "batch_overview", status: "completed" });
    expect(model.calls).toBe(0);
    expect(result.text).toContain("确定性事实");
    expect(result.text).toContain("feedback_diarrhea=proposed");
    expect(result.text).toContain("feedbackDailyPowderGrams=90 g");
  });

  it("answers first-day SOP flow from frozen knowledge results", async () => {
    const execution: string[] = [];
    const runtime = createAgentGraphRuntime({
      model: fakeModel([new AIMessage("断奶第 1 天：17:00 第一次教奶；每 3 小时供奶一次；第二天切换自由采食。以现场执行台显示为准。")]) as never,
      tools: [
        syncTool(),
        tool("get_batch_context", async () => {
          execution.push("context");
          return receiptResult("get_batch_context", "b", {
            batch: { current_day_index: 0, config: { name: "批次 A" } },
            canonicalDecision: { selectedMode: "free_feeding", effectiveMode: "free_feeding" },
          });
        }),
        tool("search_feeding_knowledge", async () => {
          execution.push("knowledge");
          return {
            details: {
              data: {
                status: "ok",
                source: "dense+lexical",
                results: [{
                  sectionId: "d0",
                  title: "断奶第 1 天",
                  text: "17:00 第一次教奶；每 3 小时供奶一次；第二天切换自由采食。",
                  score: 0.9,
                }],
              },
            },
          };
        }),
      ],
    });
    const result = await runtime.run(input("断奶首日要做什么"));
    expect(execution).toEqual(["context", "knowledge"]);
    expect(result.intent).toBe("knowledge");
    expect(result.status).toBe("completed");
    expect(result.text).toContain("断奶第 1 天");
    expect(result.text).toContain("17:00 第一次教奶");
  });

  it("uses deterministic facts for a protected device plan instead of LLM narration", async () => {
    const contextData = {
      batch: { current_day_index: 1, config: { name: "批次 A" } },
      canonicalDecision: { selectedMode: "timed_quantity", effectiveMode: "timed_quantity" },
      selectedDecision: {
        setting: {
          dayAge: 5,
          singlePowderGrams: 35,
          dailyPowderGrams: 210,
          mealCount: 3,
          timedMeals: [
            { timeLocal: "10:00" },
            { timeLocal: "14:00" },
            { timeLocal: "16:00" },
          ],
          freeWindows: [],
        },
      },
    };
    const narration = "当前批次为定时定量模式：单次下粉 35g，程序总量 210g，配奶时间点 10:00、14:00、16:00。以现场执行台显示为准。";
    const model = fakeModel([new AIMessage(narration)]);
    const runtime = createAgentGraphRuntime({
      model: model as never,
      tools: [
        syncTool(),
        tool("get_batch_context", async () => receiptResult(
          "get_batch_context", "b", contextData, 3, [0, 3, 5, 10, 14, 16, 35, 210],
        )),
        tool("compute_production_plan", async () => receiptResult(
          "compute_production_plan", "b", { safe: true }, 3, [0, 3, 5, 10, 14, 16, 35, 210],
        )),
      ],
    });
    const result = await runtime.run(input("当前批次的设备怎么设置"));
    expect(result).toMatchObject({
      intent: "device_plan_or_mode",
      status: "completed",
    });
    expect(result.text).toContain("确定性事实");
    expect(result.text).toContain("singlePowderGrams=35 g");
    expect(result.text).toContain("dailyPowderGrams=210 g");
    expect(result.text).not.toContain("当前批次为定时定量模式：单次下粉");
    expect(model.calls).toBe(0);
  });

  it("never calls the LLM for a protected device intent even if it would return a tool call", async () => {
    const runtime = createAgentGraphRuntime({
      model: fakeModel([new AIMessage({ content: "", tool_calls: [
        { id: "must-not-run", name: "shell", args: {}, type: "tool_call" },
      ] })]) as never,
      tools: [
        syncTool(),
        tool("get_batch_context", async () => receiptResult("get_batch_context", "b", { safe: true }, 3)),
        tool("compute_production_plan", async () => receiptResult("compute_production_plan", "b", { value: 42 }, 3)),
      ],
    });
    const result = await runtime.run(input("当前批次的设备怎么设置"));
    expect(result).toMatchObject({
      intent: "device_plan_or_mode",
      status: "completed",
      text: expect.stringContaining("确定性事实"),
    });
  });

  it("blocks a narration model that tries to choose a tool", async () => {
    const runtime = createAgentGraphRuntime({
      model: fakeModel([new AIMessage({ content: "", tool_calls: [
        { id: "bad", name: "shell", args: {}, type: "tool_call" },
      ] })]) as never,
      tools: [tool("get_batch_context", async () => receiptResult("get_batch_context", "b", { safe: true }))],
    });
    const result = await runtime.run(input("你好"));
    expect(result).toMatchObject({
      status: "completed",
      text: expect.stringContaining("我会基于当前批次的冻结 SOP 和确定性证据协助说明"),
    });
  });

  it("discards LLM explanation segments that contain numbers", async () => {
    const tools = [tool("get_batch_context", async () =>
      receiptResult("get_batch_context", "b", { dailyPowderGrams: 42 }))];
    const accepted = createAgentGraphRuntime({
      model: fakeModel([new AIMessage("明白")]) as never,
      tools,
    });
    await expect(accepted.run(input("你好"))).resolves.toMatchObject({ text: "明白" });
    const rejected = createAgentGraphRuntime({
      model: fakeModel([new AIMessage("今日总下粉 四十二 克")]) as never,
      tools,
    });
    await expect(rejected.run({ ...input("你好"), clientMessageId: "numeric-reject" }))
      .resolves.toMatchObject({
        status: "completed",
        text: expect.stringContaining("我会基于当前批次的冻结 SOP 和确定性证据协助说明"),
      });
  });

  it("fails closed without exposing numbers when the frozen receipt is missing or tampered", async () => {
    const missing = createAgentGraphRuntime({
      model: fakeModel([new AIMessage("42")]) as never,
      tools: [tool("get_batch_context", async () => ({ details: { data: { unsafe: true } } }))],
    });
    await expect(missing.run(input("今天怎么喂"))).resolves.toMatchObject({
      status: "safe_block",
      text: expect.stringContaining("NBJ_AGENT_FROZEN_SNAPSHOT_REQUIRED"),
    });

    const tampered = receiptResult("get_batch_context", "b", { value: 42 });
    (tampered.details.evidenceReceipt as { inputDigest: string }).inputDigest = "0".repeat(64);
    const invalid = createAgentGraphRuntime({
      model: fakeModel([new AIMessage("42")]) as never,
      tools: [tool("get_batch_context", async () => tampered)],
    });
    await expect(invalid.run(input("今天怎么喂"))).resolves.toMatchObject({
      status: "safe_block",
      text: expect.stringContaining("NBJ_AGENT_EVIDENCE_RECEIPT_INVALID"),
    });
  });

  it("marks a deterministic subgraph receipt with another frozen binding as safe-block", async () => {
    const runtime = createAgentGraphRuntime({
      model: fakeModel([new AIMessage("unused")]) as never,
      tools: [
        syncTool(),
        tool("get_batch_context", async () => receiptResult("get_batch_context", "b", { safe: true }, 3)),
        tool("compute_production_plan", async () => receiptResult("compute_production_plan", "b", { value: 42 }, 4)),
      ],
    });
    await expect(runtime.run(input("今天设备怎么设置"))).resolves.toMatchObject({
      intent: "device_plan_or_mode",
      status: "safe_block",
      text: expect.stringContaining("NBJ_AGENT_EVIDENCE_RECEIPT_STALE"),
    });
  });

  it("replays a completed checkpoint by references without re-running tools or the model", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nbj-langgraph-v2-"));
    tempDirs.push(directory);
    const saver = new NodeSqliteCheckpointSaver(join(directory, "checkpoints.db"));
    savers.push(saver);
    let contextCalls = 0;
    const model = fakeModel([new AIMessage("无数值的一般说明")]);
    const runtime = createAgentGraphRuntime({
      model: model as never,
      checkpointer: saver,
      tools: [tool("get_batch_context", async () => {
        contextCalls += 1;
        return receiptResult("get_batch_context", "b", { safe: true });
      })],
    });
    const firstInput = { ...input("你好"), clientMessageId: "checkpoint-v2" };
    const first = await runtime.run(firstInput);
    const replay = await runtime.run({ ...firstInput, resume: true });
    expect(replay).toMatchObject({ text: first.text, resumed: true, status: "completed" });
    expect(contextCalls).toBe(1);
    expect(model.calls).toBe(1);
  });

  it("rejects resuming a checkpoint with a different input digest", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nbj-langgraph-v2-"));
    tempDirs.push(directory);
    const saver = new NodeSqliteCheckpointSaver(join(directory, "checkpoints.db"));
    savers.push(saver);
    const model = fakeModel([new AIMessage("无数值的一般说明")]);
    const runtime = createAgentGraphRuntime({
      model: model as never,
      checkpointer: saver,
      tools: [tool("get_batch_context", async () =>
        receiptResult("get_batch_context", "b", { safe: true }))],
    });
    const firstInput = { ...input("你好"), clientMessageId: "resume-mismatch" };
    await runtime.run(firstInput);
    await expect(runtime.run({ ...firstInput, message: "换一个问题", resume: true }))
      .rejects.toThrow("NBJ_AGENT_RESUME_INPUT_MISMATCH");
  });

  it("shares one long-lived checkpoint saver per database path", () => {
    const directory = mkdtempSync(join(tmpdir(), "nbj-langgraph-shared-"));
    tempDirs.push(directory);
    const path = join(directory, "shared.db");
    const first = getSharedCheckpointSaver(path);
    const second = getSharedCheckpointSaver(resolve(path));
    expect(second).toBe(first);
    closeSharedCheckpointSavers();
  });

  it("rejects number-swap attacks for protected device facts", async () => {
    const contextData = {
      batch: { current_day_index: 1, config: { name: "批次 A" } },
      canonicalDecision: { selectedMode: "timed_quantity", effectiveMode: "timed_quantity" },
      selectedDecision: {
        setting: {
          dayAge: 4,
          singlePowderGrams: 50,
          dailyPowderGrams: 500,
          mealCount: 10,
          timedMeals: [
            { timeLocal: "09:00", powderGrams: 50 },
            { timeLocal: "10:00", powderGrams: 50 },
          ],
          freeWindows: [],
        },
      },
    };
    const runtime = createAgentGraphRuntime({
      model: fakeModel([new AIMessage("把 500g 与 10餐 互换，再把克说成公斤")]) as never,
      tools: [
        tool("get_batch_context", async () => receiptResult(
          "get_batch_context",
          "b",
          contextData,
          3,
          [0, 1, 4, 9, 10, 50, 500, 2026],
        )),
        tool("compute_production_plan", async () => receiptResult(
          "compute_production_plan",
          "b",
          { safe: true },
          3,
          [0, 1, 4, 9, 10, 50, 500, 2026],
        )),
      ],
    });
    const result = await runtime.run(input("当前批次的设备怎么设置"));
    expect(result).toMatchObject({ intent: "device_plan_or_mode", status: "completed" });
    expect(result.text).toContain("dailyPowderGrams=500 g");
    expect(result.text).toContain("mealCount=10");
    expect(result.text).toContain("mealTime_0=09:00");
    expect(result.text).toContain("mealTime_1=10:00");
    expect(result.text).not.toContain("公斤");
    expect(result.text).not.toContain("把 500g 与 10餐 互换");
  });

  it("rejects percentage, date, and day-age attacks in LLM explanation", async () => {
    const runtime = createAgentGraphRuntime({
      model: fakeModel([new AIMessage("增加 50%，日期 2026-08-06，日龄 5")]) as never,
      tools: [
        tool("get_batch_context", async () => receiptResult(
          "get_batch_context",
          "b",
          {
            batch: { current_day_index: 1, config: { name: "批次 A" } },
            canonicalDecision: { selectedMode: "timed_quantity", effectiveMode: "timed_quantity" },
            selectedDecision: {
              setting: {
                dayAge: 4,
                singlePowderGrams: 50,
                dailyPowderGrams: 500,
                mealCount: 10,
                timedMeals: [{ timeLocal: "09:00", powderGrams: 50 }],
                freeWindows: [],
              },
            },
          },
          3,
          [0, 1, 4, 9, 10, 50, 500, 2026],
        )),
        tool("compute_production_plan", async () => receiptResult(
          "compute_production_plan",
          "b",
          { safe: true },
          3,
          [0, 1, 4, 9, 10, 50, 500, 2026],
        )),
      ],
    });
    const result = await runtime.run(input("当前批次的设备怎么设置"));
    expect(result.text).toContain("dayAge=4");
    expect(result.text).not.toContain("50%");
    expect(result.text).not.toContain("2026-08-06");
    expect(result.text).not.toContain("日龄 5");
  });

  it("returns full deterministic facts when the provider is unavailable", async () => {
    const failingModel = {
      bindTools: () => new RunnableLambda({
        func: async () => {
          throw new Error("provider unavailable");
        },
      }),
    };
    const runtime = createAgentGraphRuntime({
      model: failingModel as never,
      tools: [
        tool("get_batch_context", async () => receiptResult(
          "get_batch_context",
          "b",
          {
            batch: { current_day_index: 1, config: { name: "批次 A" } },
            canonicalDecision: { selectedMode: "timed_quantity", effectiveMode: "timed_quantity" },
            selectedDecision: {
              setting: {
                dayAge: 4,
                singlePowderGrams: 50,
                dailyPowderGrams: 500,
                mealCount: 10,
                timedMeals: [{ timeLocal: "09:00", powderGrams: 50 }],
                freeWindows: [],
              },
            },
          },
          3,
          [0, 1, 4, 9, 10, 50, 500, 2026],
        )),
        tool("compute_production_plan", async () => receiptResult(
          "compute_production_plan",
          "b",
          { safe: true },
          3,
          [0, 1, 4, 9, 10, 50, 500, 2026],
        )),
      ],
    });
    const result = await runtime.run(input("当前批次的设备怎么设置"));
    expect(result).toMatchObject({ intent: "device_plan_or_mode", status: "completed" });
    expect(result.text).toContain("确定性事实");
    expect(result.text).toContain("dailyPowderGrams=500 g");
    expect(result.text).toContain("安全说明");
  });

  it("keeps protected routing deterministic against numeric general phrasing", async () => {
    const runtime = createAgentGraphRuntime({
      model: fakeModel([new AIMessage("五百克分十餐，请解释")]) as never,
      tools: [
        tool("get_batch_context", async () => receiptResult(
          "get_batch_context",
          "b",
          {
            batch: { current_day_index: 1, config: { name: "批次 A" } },
            canonicalDecision: { selectedMode: "timed_quantity", effectiveMode: "timed_quantity" },
            selectedDecision: {
              setting: {
                dayAge: 4,
                singlePowderGrams: 50,
                dailyPowderGrams: 500,
                mealCount: 10,
                timedMeals: [{ timeLocal: "10:00", powderGrams: 50 }],
                freeWindows: [],
              },
            },
          },
          3,
          [0, 1, 4, 10, 50, 500, 2026],
        )),
        tool("compute_production_plan", async () => receiptResult(
          "compute_production_plan",
          "b",
          { safe: true },
          3,
          [0, 1, 4, 10, 50, 500, 2026],
        )),
      ],
    });
    const result = await runtime.run(input("当前批次设备五百克分十餐，怎么设置"));
    expect(result.intent).toBe("device_plan_or_mode");
    expect(result.text).toContain("dailyPowderGrams=500 g");
    expect(result.text).toContain("mealCount=10");
    expect(result.text).not.toContain("五百克分十餐");
  });
});
