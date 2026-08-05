import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIMessage } from "@langchain/core/messages";
import { RunnableLambda } from "@langchain/core/runnables";
import { afterEach, describe, expect, it } from "vitest";
import { NodeSqliteCheckpointSaver } from "../src/agent/langgraph/checkpoint.js";
import {
  createAgentGraphRuntime,
  graphThreadId,
} from "../src/agent/langgraph/runtime.js";
import { classifyDeterministicIntent, staticEvidencePlan } from "../src/agent/langgraph/router.js";
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
    expect(staticEvidencePlan("timeline_or_today_operations")).toEqual({
      requiredTools: ["get_today_timeline"], responseKind: "deterministic",
    });
  });

  it("uses the static timeline evidence plan instead of model-selected tool calls", async () => {
    const execution: string[] = [];
    const model = fakeModel([new AIMessage({ content: "", tool_calls: [
      { id: "must-not-run", name: "shell", args: {}, type: "tool_call" },
    ] })]);
    const runtime = createAgentGraphRuntime({
      model: model as never,
      tools: [
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
      toolExecutions: 1,
      text: expect.stringContaining("今日常规操作已按冻结 SOP 汇总"),
    });
    expect(result.toolEvidence.map((event) => event.name)).toEqual(["get_batch_context", "get_today_timeline"]);
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
      model: fakeModel([new AIMessage("unused")]) as never,
      tools: [
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
      model: fakeModel([new AIMessage("unused")]) as never,
      tools: [
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

  it("blocks a narration model that tries to choose a tool", async () => {
    const runtime = createAgentGraphRuntime({
      model: fakeModel([new AIMessage({ content: "", tool_calls: [
        { id: "bad", name: "shell", args: {}, type: "tool_call" },
      ] })]) as never,
      tools: [tool("get_batch_context", async () => receiptResult("get_batch_context", "b", { safe: true }))],
    });
    await expect(runtime.run(input("你好"))).rejects.toThrow("NBJ_AGENT_MODEL_TOOL_CALL_FORBIDDEN");
  });

  it("validates every numeric narration token against a verified receipt", async () => {
    const tools = [tool("get_batch_context", async () =>
      receiptResult("get_batch_context", "b", { dailyPowderGrams: 42 }))];
    const accepted = createAgentGraphRuntime({
      model: fakeModel([new AIMessage("今日总下粉 42 克")]) as never,
      tools,
    });
    await expect(accepted.run(input("你好"))).resolves.toMatchObject({ text: "今日总下粉 42 克" });
    const rejected = createAgentGraphRuntime({
      model: fakeModel([new AIMessage("今日总下粉 43 克")]) as never,
      tools,
    });
    // General chat refuses unverified numbers gracefully instead of failing
    // the whole turn; the numeric gate still blocks them from being delivered.
    await expect(rejected.run({ ...input("你好"), clientMessageId: "numeric-reject" }))
      .resolves.toMatchObject({
        status: "completed",
        text: expect.stringContaining("未经核实"),
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
});
