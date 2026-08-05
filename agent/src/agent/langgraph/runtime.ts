import { createHash, randomUUID } from "node:crypto";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  Annotation,
  END,
  START,
  StateGraph,
} from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { FeedingTool } from "../../container/tools.js";
import { classifyDeterministicIntent, staticEvidencePlan, staticToolArguments } from "./router.js";
import { selectSopSubgraph } from "./subgraphs/handlers.js";
import { deterministicResponse } from "./subgraphs/responses.js";
import type {
  AgentEvidenceRef,
  AgentGraphStateContract,
  AgentIntentKind,
  CurrentBatchSummary,
  TodayOperationSummary,
} from "./state.js";

export const LANGGRAPH_RUNTIME_VERSION = "nbj-langgraph-v2";

interface EvidenceReceipt {
  receiptId: string;
  batchId: string;
  revision: number;
  sopSourceSha256: string;
  devicePlanSha256: string;
  inputDigest: string;
  numericWhitelist: number[];
}

interface VerifiedReceipt {
  receiptId: string;
  inputDigest: string;
  binding: string;
  revision: number;
  sopSourceSha256: string;
  devicePlanSha256: string;
  numericWhitelist: number[];
}

export interface AgentToolEvidence {
  name: string;
  isError: boolean;
  receiptId?: string;
}

const GraphState = Annotation.Root({
  turnId: Annotation<string>({ reducer: (_left, right) => right, default: () => "" }),
  clientMessageId: Annotation<string>({ reducer: (_left, right) => right, default: () => "" }),
  graphVersion: Annotation<string>({ reducer: (_left, right) => right, default: () => LANGGRAPH_RUNTIME_VERSION }),
  batchId: Annotation<string>({ reducer: (_left, right) => right, default: () => "" }),
  sessionId: Annotation<string>({ reducer: (_left, right) => right, default: () => "" }),
  inputDigest: Annotation<string>({ reducer: (_left, right) => right, default: () => "" }),
  snapshot: Annotation<AgentGraphStateContract["snapshot"]>({ reducer: (_left, right) => right, default: () => ({}) }),
  intent: Annotation<AgentGraphStateContract["intent"]>({
    reducer: (_left, right) => right,
    default: () => ({ kind: "general", asksForExplanation: false, requestsMutation: false, confidence: 0 }),
  }),
  subgraph: Annotation<AgentGraphStateContract["subgraph"]>({ reducer: (_left, right) => right, default: () => "general_subgraph" }),
  evidencePlan: Annotation<AgentGraphStateContract["evidencePlan"]>({
    reducer: (_left, right) => right,
    default: () => ({ requiredTools: [], nextToolIndex: 0, responseKind: "general" }),
  }),
  evidenceRefs: Annotation<AgentEvidenceRef[]>({ reducer: (left, right) => left.concat(right), default: () => [] }),
  batchSummary: Annotation<CurrentBatchSummary | undefined>({ reducer: (_left, right) => right, default: () => undefined }),
  todayOperations: Annotation<TodayOperationSummary | undefined>({ reducer: (_left, right) => right, default: () => undefined }),
  dailyOperations: Annotation<AgentGraphStateContract["dailyOperations"]>({ reducer: (_left, right) => right, default: () => undefined }),
  approval: Annotation<AgentGraphStateContract["approval"]>({ reducer: (_left, right) => right, default: () => null }),
  toolExecutions: Annotation<number>({ reducer: (_left, right) => right, default: () => 0 }),
  numericWhitelist: Annotation<number[]>({ reducer: (left, right) => left.concat(right), default: () => [] }),
  frozenReceiptBinding: Annotation<string>({ reducer: (_left, right) => right, default: () => "" }),
  finalText: Annotation<string>({ reducer: (_left, right) => right, default: () => "" }),
  status: Annotation<AgentGraphStateContract["status"]>({ reducer: (_left, right) => right, default: () => "running" }),
  errorCode: Annotation<string | undefined>({ reducer: (_left, right) => right, default: () => undefined }),
});

export type AgentGraphState = typeof GraphState.State;

function messageText(message: BaseMessage | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((block) => {
    if (typeof block === "string") return [block];
    return block && typeof block === "object" && "text" in block ? [String(block.text ?? "")] : [];
  }).join("");
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function envelopeFromToolResult(result: unknown): Record<string, unknown> | null {
  const topLevel = object(result);
  return object(topLevel?.details) ?? topLevel;
}

function verifyReceipt(toolName: string, expectedBatchId: string, result: unknown): VerifiedReceipt | null {
  const envelope = envelopeFromToolResult(result);
  const receiptRow = object(envelope?.evidenceReceipt);
  if (!receiptRow) return null;
  const data = envelope?.data;
  const receipt: EvidenceReceipt = {
    receiptId: String(receiptRow.receiptId ?? ""),
    batchId: String(receiptRow.batchId ?? ""),
    revision: Number(receiptRow.revision),
    sopSourceSha256: String(receiptRow.sopSourceSha256 ?? ""),
    devicePlanSha256: String(receiptRow.devicePlanSha256 ?? ""),
    inputDigest: String(receiptRow.inputDigest ?? ""),
    numericWhitelist: Array.isArray(receiptRow.numericWhitelist) ? receiptRow.numericWhitelist.map(Number) : [],
  };
  if (!/^nbj-receipt-[0-9a-f]{24}$/u.test(receipt.receiptId) || receipt.batchId !== expectedBatchId ||
      !Number.isSafeInteger(receipt.revision) || receipt.revision < 0 ||
      !/^[0-9a-f]{64}$/iu.test(receipt.sopSourceSha256) ||
      !/^[0-9a-f]{64}$/iu.test(receipt.devicePlanSha256) ||
      !/^[0-9a-f]{64}$/iu.test(receipt.inputDigest) ||
      receipt.numericWhitelist.some((value) => !Number.isFinite(value))) {
    throw new Error("NBJ_AGENT_EVIDENCE_RECEIPT_INVALID");
  }
  const payload = {
    toolName,
    batchId: receipt.batchId,
    revision: receipt.revision,
    sopSourceSha256: receipt.sopSourceSha256,
    devicePlanSha256: receipt.devicePlanSha256,
    data,
  };
  const expectedDigest = createHash("sha256")
    .update(JSON.stringify(payload).normalize("NFC"), "utf8")
    .digest("hex")
    .toUpperCase();
  if (expectedDigest !== receipt.inputDigest ||
      receipt.receiptId !== `nbj-receipt-${expectedDigest.slice(0, 24).toLowerCase()}`) {
    throw new Error("NBJ_AGENT_EVIDENCE_RECEIPT_INVALID");
  }
  return {
    receiptId: receipt.receiptId,
    inputDigest: receipt.inputDigest,
    binding: [receipt.revision, receipt.sopSourceSha256.toUpperCase(), receipt.devicePlanSha256.toUpperCase()].join(":"),
    revision: receipt.revision,
    sopSourceSha256: receipt.sopSourceSha256.toUpperCase(),
    devicePlanSha256: receipt.devicePlanSha256.toUpperCase(),
    numericWhitelist: receipt.numericWhitelist,
  };
}

function responseNumbers(text: string): number[] {
  const values: number[] = [];
  for (const match of text.matchAll(/[+-]?(?:\d+(?:\.\d+)?|\.\d+)/g)) {
    const numeric = Number(match[0]);
    if (Number.isFinite(numeric)) values.push(numeric);
  }
  return values;
}

function validateNumericResponse(text: string, numericWhitelist: number[]): void {
  const allowed = new Set(numericWhitelist);
  if (responseNumbers(text).some((value) => !allowed.has(value))) {
    throw new Error("NBJ_AGENT_NUMERIC_EVIDENCE_REQUIRED");
  }
}

function safeBlockText(errorCode?: string): string {
  return `当前批次的冻结 SOP、设备方案或确定性证据不可用（${errorCode ?? "NBJ_AGENT_SAFE_BLOCK"}）。系统不会提供设备数值或执行变更。`;
}

function dailyOperationRef(result: unknown): AgentGraphStateContract["dailyOperations"] {
  const envelope = envelopeFromToolResult(result);
  const data = object(envelope?.data);
  const plan = object(data?.dailyOperationPlan);
  if (!plan) return undefined;
  const planId = String(plan.id ?? "");
  const businessDate = String(plan.businessDate ?? "");
  const operationsSha256 = String(plan.operationsSha256 ?? "").toUpperCase();
  const status = String(plan.status ?? "");
  if (!planId || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate) || !/^[A-F0-9]{64}$/.test(operationsSha256) ||
      (status !== "pending" && status !== "confirmed")) return undefined;
  return { planId, businessDate, operationsSha256, status };
}

function snapshotFromContext(
  result: unknown,
  receipt: VerifiedReceipt,
): AgentGraphStateContract["snapshot"] {
  const envelope = envelopeFromToolResult(result);
  const data = object(envelope?.data);
  const canonical = object(data?.canonicalDecision);
  const decision = object(canonical?.decision);
  const setting = object(decision?.setting);
  const batch = object(data?.batch);
  const currentDayIndex = Number(batch?.current_day_index);
  const currentDayAge = Number(setting?.dayAge);
  const selectedMode = canonical?.selectedMode;
  const effectiveMode = canonical?.effectiveMode;
  return {
    batchRevision: receipt.revision,
    ...(Number.isSafeInteger(currentDayIndex) && currentDayIndex >= 0 ? { currentDayIndex } : {}),
    ...(Number.isSafeInteger(currentDayAge) && currentDayAge >= 1 ? { currentDayAge } : {}),
    ...(selectedMode === "timed_quantity" || selectedMode === "free_feeding" ? { selectedMode } : {}),
    ...(effectiveMode === "timed_quantity" || effectiveMode === "free_feeding" ? { effectiveMode } : {}),
    sopSourceSha256: receipt.sopSourceSha256,
    devicePlanSha256: receipt.devicePlanSha256,
  };
}

function finite(value: unknown): number | undefined {
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function localTime(value: unknown): string | undefined {
  const result = typeof value === "string" ? value : "";
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(result) ? result : undefined;
}

function batchSummaryFromContext(result: unknown): CurrentBatchSummary | undefined {
  const envelope = envelopeFromToolResult(result);
  const data = object(envelope?.data);
  const canonical = object(data?.canonicalDecision);
  const decision = object(data?.selectedDecision) ?? object(canonical?.decision);
  const setting = object(decision?.setting);
  const batch = object(data?.batch);
  if (!setting || !batch) return undefined;
  const config = object(batch.config);
  const mealTimes = Array.isArray(setting.timedMeals)
    ? setting.timedMeals.map((meal) => localTime(object(meal)?.timeLocal)).filter((time): time is string => Boolean(time))
    : [];
  const freeWindows = Array.isArray(setting.freeWindows)
    ? setting.freeWindows.map((window) => {
      const row = object(window);
      const startLocal = localTime(row?.startLocal);
      const endLocal = localTime(row?.endLocal);
      return startLocal && endLocal ? { startLocal, endLocal } : null;
    }).filter((window): window is { startLocal: string; endLocal: string } => Boolean(window))
    : [];
  const currentDayIndex = finite(batch.current_day_index);
  const selectedMode = canonical?.selectedMode;
  const effectiveMode = canonical?.effectiveMode;
  return {
    ...(typeof config?.name === "string" && config.name.trim() ? { name: config.name.trim() } : {}),
    ...(currentDayIndex !== undefined && Number.isSafeInteger(currentDayIndex) && currentDayIndex >= 0 ? { dayNumber: currentDayIndex + 1 } : {}),
    ...(finite(setting.dayAge) !== undefined ? { dayAge: finite(setting.dayAge) } : {}),
    ...(selectedMode === "timed_quantity" || selectedMode === "free_feeding" ? { selectedMode } : {}),
    ...(effectiveMode === "timed_quantity" || effectiveMode === "free_feeding" ? { effectiveMode } : {}),
    ...(finite(setting.singlePowderGrams) !== undefined ? { singlePowderGrams: finite(setting.singlePowderGrams) } : {}),
    ...(finite(setting.dailyPowderGrams) !== undefined ? { dailyPowderGrams: finite(setting.dailyPowderGrams) } : {}),
    ...(finite(setting.mealCount) !== undefined ? { mealCount: finite(setting.mealCount) } : {}),
    ...(finite(setting.suggestedDailyPowderGrams) !== undefined ? { suggestedDailyPowderGrams: finite(setting.suggestedDailyPowderGrams) } : {}),
    ...(finite(setting.suggestedDailyMealCount) !== undefined ? { suggestedDailyMealCount: finite(setting.suggestedDailyMealCount) } : {}),
    mealTimes,
    freeWindows,
  };
}

function todayOperationSummaryFromToolResult(result: unknown): TodayOperationSummary | undefined {
  const envelope = envelopeFromToolResult(result);
  const data = object(envelope?.data);
  const plan = object(data?.dailyOperationPlan);
  if (!plan) return undefined;
  const operations: TodayOperationSummary["operations"] = [];
  if (Array.isArray(plan.operations)) {
    for (const operation of plan.operations) {
      const row = object(operation);
      const dueWindow = object(row?.dueWindow);
      const title = typeof row?.title === "string" ? row.title.trim() : "";
      if (!title) continue;
      const startLocal = localTime(dueWindow?.startLocal);
      const endLocal = localTime(dueWindow?.endLocal);
      operations.push({ title, ...(startLocal ? { startLocal } : {}), ...(endLocal ? { endLocal } : {}) });
    }
  }
  if (!operations.length) return undefined;
  const status = plan.status === "pending" || plan.status === "confirmed" ? plan.status : undefined;
  return {
    ...(typeof plan.businessDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(plan.businessDate) ? { businessDate: plan.businessDate } : {}),
    ...(status ? { status } : {}),
    operations,
  };
}

function stableTurnId(input: Pick<AgentGraphRunInput, "userId" | "batchId" | "sessionId" | "clientMessageId">): string {
  return createHash("sha256").update([
    "nbj-langgraph-v2", input.userId, input.batchId, input.sessionId, input.clientMessageId,
  ].join("\u001f"), "utf8").digest("hex").slice(0, 32);
}

function actionDigest(turnId: string, subgraph: string): string {
  return createHash("sha256").update(["nbj-action-v2", turnId, subgraph].join("\u001f"), "utf8").digest("hex").toUpperCase();
}

export function graphThreadId(userId: string, batchId: string, sessionId: string): string {
  return `nbj:${userId}:${batchId}:${sessionId}`;
}

export interface AgentGraphRunInput {
  userId: string;
  batchId: string;
  sessionId: string;
  clientMessageId: string;
  message: string;
  history: BaseMessage[];
  systemPrompt: string;
  signal: AbortSignal;
  resume: boolean;
}

export interface AgentGraphRuntimeOptions {
  model: BaseChatModel;
  tools: FeedingTool[];
  checkpointer?: BaseCheckpointSaver;
  onToolEvidence?: (event: AgentToolEvidence) => void;
  /** Receives a raw result only during the active request; checkpoints retain refs/digests only. */
  onToolResult?: (name: string, result: unknown) => void;
}

export interface AgentGraphRunResult {
  text: string;
  resumed: boolean;
  toolExecutions: number;
  toolEvidence: AgentToolEvidence[];
  intent: AgentIntentKind;
  status: AgentGraphStateContract["status"];
}

function publicToolEvidence(refs: AgentEvidenceRef[]): AgentToolEvidence[] {
  return refs.map((ref) => ({ name: ref.toolName, isError: ref.isError, ...(ref.receiptId ? { receiptId: ref.receiptId } : {}) }));
}

interface NarrationModel {
  invoke(input: BaseMessage[], options?: Record<string, unknown>): Promise<BaseMessage>;
}

interface RunContext {
  userId: string;
  batchId: string;
  sessionId: string;
  clientMessageId: string;
  message: string;
  history: BaseMessage[];
  systemPrompt: string;
  signal: AbortSignal;
  tools: Map<string, FeedingTool>;
  narrationModel: NarrationModel;
  onToolResult?: (name: string, result: unknown) => void;
  onToolEvidence?: (event: AgentToolEvidence) => void;
}

function runContextFromConfig(config: RunnableConfig): RunContext {
  const context = config.configurable?.nbj_run as RunContext | undefined;
  if (!context) throw new Error("NBJ_AGENT_RUN_CONTEXT_REQUIRED");
  return context;
}

function computeInputDigest(input: AgentGraphRunInput): string {
  const historyText = input.history
    .map((message) => `${message.getType()}:${messageText(message)}`)
    .join("\u001f");
  return createHash("sha256").update([
    "nbj-langgraph-v2-input",
    input.userId,
    input.batchId,
    input.sessionId,
    input.clientMessageId,
    input.message,
    historyText,
    input.systemPrompt,
  ].join("\u001f"), "utf8").digest("hex");
}

const loadTurnScopeNode = async (_state: AgentGraphState, config: RunnableConfig) => {
  const run = runContextFromConfig(config);
  const tool = run.tools.get("get_batch_context");
  if (!tool) throw new Error("NBJ_AGENT_CONTEXT_TOOL_REQUIRED");
  try {
    const result = await tool.execute(randomUUID(), {}, run.signal);
    const receipt = verifyReceipt(tool.name, run.batchId, result);
    if (!receipt) throw new Error("NBJ_AGENT_FROZEN_SNAPSHOT_REQUIRED");
    run.onToolResult?.(tool.name, result);
    run.onToolEvidence?.({ name: tool.name, isError: false, receiptId: receipt.receiptId });
    return {
      snapshot: snapshotFromContext(result, receipt),
      batchSummary: batchSummaryFromContext(result),
      frozenReceiptBinding: receipt.binding,
      numericWhitelist: receipt.numericWhitelist,
      evidenceRefs: [{
        toolName: tool.name,
        receiptId: receipt.receiptId,
        inputDigest: receipt.inputDigest,
        frozenBinding: receipt.binding,
        isError: false,
      }],
    };
  } catch (error) {
    const code = error instanceof Error && error.message.startsWith("NBJ_")
      ? error.message : "NBJ_AGENT_FROZEN_SNAPSHOT_REQUIRED";
    run.onToolEvidence?.({ name: tool.name, isError: true });
    return {
      evidenceRefs: [{ toolName: tool.name, isError: true }],
      status: "safe_block" as const,
      errorCode: code,
    };
  }
};

const planTurnNode = async (state: AgentGraphState, config: RunnableConfig) => {
  const run = runContextFromConfig(config);
  const intent = classifyDeterministicIntent(run.message);
  return {
    intent,
    evidencePlan: { ...staticEvidencePlan(intent.kind), nextToolIndex: 0 },
    subgraph: selectSopSubgraph(intent.kind, state.snapshot.selectedMode, state.snapshot.currentDayIndex),
  };
};

const executeEvidenceNode = async (state: AgentGraphState, config: RunnableConfig) => {
  const run = runContextFromConfig(config);
  const name = state.evidencePlan.requiredTools[state.evidencePlan.nextToolIndex];
  if (!name) return {};
  const tool = run.tools.get(name);
  if (!tool) throw new Error("NBJ_AGENT_TOOL_NOT_ALLOWED");
  try {
    const result = await tool.execute(
      `nbj-${state.turnId}-${name}-${state.evidencePlan.nextToolIndex}`,
      staticToolArguments(name, run.message),
      run.signal,
    );
    const receipt = verifyReceipt(name, run.batchId, result);
    if ((name === "compute_production_plan" || name === "get_today_timeline") && !receipt) {
      throw new Error("NBJ_AGENT_EVIDENCE_RECEIPT_REQUIRED");
    }
    if (receipt && receipt.binding !== state.frozenReceiptBinding) {
      throw new Error("NBJ_AGENT_EVIDENCE_RECEIPT_STALE");
    }
    run.onToolResult?.(name, result);
    run.onToolEvidence?.({ name, isError: false, ...(receipt ? { receiptId: receipt.receiptId } : {}) });
    return {
      evidencePlan: { ...state.evidencePlan, nextToolIndex: state.evidencePlan.nextToolIndex + 1 },
      toolExecutions: state.toolExecutions + 1,
      numericWhitelist: receipt?.numericWhitelist ?? [],
      evidenceRefs: [{
        toolName: name,
        ...(receipt ? {
          receiptId: receipt.receiptId,
          inputDigest: receipt.inputDigest,
          frozenBinding: receipt.binding,
        } : {}),
        isError: false,
      }],
      ...(dailyOperationRef(result) ? { dailyOperations: dailyOperationRef(result) } : {}),
      ...(name === "get_today_timeline" ? { todayOperations: todayOperationSummaryFromToolResult(result) } : {}),
    };
  } catch (error) {
    const code = error instanceof Error && error.message.startsWith("NBJ_") ? error.message : "NBJ_AGENT_TOOL_FAILED";
    run.onToolEvidence?.({ name, isError: true });
    return {
      evidencePlan: { ...state.evidencePlan, nextToolIndex: state.evidencePlan.nextToolIndex + 1 },
      toolExecutions: state.toolExecutions + 1,
      evidenceRefs: [{ toolName: name, isError: true }],
      status: "safe_block" as const,
      errorCode: code,
    };
  }
};

const validateEvidenceNode = async (state: AgentGraphState) => {
  const required = state.evidencePlan.requiredTools;
  const successful = new Set(state.evidenceRefs.filter((ref) => !ref.isError).map((ref) => ref.toolName));
  if (state.status === "safe_block" || required.some((name) => !successful.has(name))) {
    return { status: "safe_block" as const, errorCode: state.errorCode ?? "NBJ_AGENT_EVIDENCE_REQUIRED" };
  }
  if (state.evidenceRefs.some((ref) => ref.frozenBinding && ref.frozenBinding !== state.frozenReceiptBinding)) {
    return { status: "stale" as const, errorCode: "NBJ_AGENT_EVIDENCE_RECEIPT_STALE" };
  }
  return {};
};

const actionGateNode = async (state: AgentGraphState) => {
  if (state.status === "safe_block" || state.status === "stale") return {};
  // Daily confirmation is intentionally graph-out: only the dedicated
  // authenticated API may perform it. Mutation requests stay advisory.
  const digest = actionDigest(state.turnId, state.subgraph);
  if (state.intent.requestsMutation && state.intent.kind !== "timeline_or_today_operations") {
    return {
      approval: {
        approvalId: `nbj-approval-${digest.slice(0, 24).toLowerCase()}`,
        status: "draft_required" as const,
        basedOnRevision: state.snapshot.batchRevision,
        actionDigest: digest,
      },
    };
  }
  return { approval: { status: "not_required" as const, actionDigest: digest } };
};

const dailyOperationGateNode = async (state: AgentGraphState) => {
  if (state.intent.kind === "timeline_or_today_operations" && !state.dailyOperations) {
    return { status: "safe_block" as const, errorCode: "NBJ_AGENT_DAILY_OPERATION_PLAN_REQUIRED" };
  }
  // This node is read-only by construction. Confirmation remains the
  // dedicated authenticated API, never a graph interrupt or tool loop.
  return {};
};

const renderResponseNode = async (state: AgentGraphState, config: RunnableConfig) => {
  if (state.status === "safe_block" || state.status === "stale") {
    return { finalText: safeBlockText(state.errorCode), status: state.status };
  }
  if (state.intent.kind !== "general") {
    return { finalText: deterministicResponse(
      state.intent.kind,
      state.intent.requestsMutation,
      state.batchSummary,
      state.todayOperations,
    ) };
  }
  const run = runContextFromConfig(config);
  const response = await run.narrationModel.invoke([
    new SystemMessage(run.systemPrompt),
    ...run.history,
    new HumanMessage(run.message),
    new SystemMessage("仅回答一般说明；不得调用工具、生成设备数值、审批或设备控制命令。"),
  ], { signal: run.signal, callbacks: [] });
  const ai = response instanceof AIMessage ? response : new AIMessage(response.content);
  if ((ai.tool_calls ?? []).length > 0) throw new Error("NBJ_AGENT_MODEL_TOOL_CALL_FORBIDDEN");
  return { finalText: messageText(ai) || deterministicResponse("general", false) };
};

const validateResponseNode = async (state: AgentGraphState) => {
  try {
    validateNumericResponse(state.finalText, state.numericWhitelist);
  } catch (error) {
    if (state.intent.kind !== "general") throw error;
    // General chat must not hard-fail the whole turn over an
    // unverified number: refuse gracefully while keeping the numeric
    // safety gate intact for every other response path.
    return {
      finalText: "抱歉，我无法提供未经核实的具体数值。设备设定、餐次和粉量请以现场执行台显示的批次方案为准。",
      status: "completed" as const,
      errorCode: "NBJ_AGENT_NUMERIC_EVIDENCE_REQUIRED",
    };
  }
  return {};
};

const persistResponseNode = async (state: AgentGraphState) => ({
  status: state.status === "running" ? "completed" as const : state.status,
});

function compileAgentGraphImpl(checkpointer?: BaseCheckpointSaver) {
  return new StateGraph(GraphState)
    .addNode("load_turn_scope", loadTurnScopeNode)
    .addNode("plan_turn", planTurnNode)
    .addNode("execute_evidence", executeEvidenceNode)
    .addNode("validate_evidence", validateEvidenceNode)
    .addNode("action_gate", actionGateNode)
    .addNode("daily_operation_gate", dailyOperationGateNode)
    .addNode("render_response", renderResponseNode)
    .addNode("validate_response", validateResponseNode)
    .addNode("persist_response", persistResponseNode)
    .addEdge(START, "load_turn_scope")
    .addConditionalEdges("load_turn_scope", (state) => state.status === "safe_block" ? "render_response" : "plan_turn")
    .addConditionalEdges("plan_turn", (state) =>
      state.evidencePlan.requiredTools.length ? "execute_evidence" : "validate_evidence")
    .addConditionalEdges("execute_evidence", (state) =>
      state.status === "safe_block" ? "validate_evidence" :
        state.evidencePlan.nextToolIndex < state.evidencePlan.requiredTools.length ? "execute_evidence" : "validate_evidence")
    .addEdge("validate_evidence", "action_gate")
    .addEdge("action_gate", "daily_operation_gate")
    .addEdge("daily_operation_gate", "render_response")
    .addEdge("render_response", "validate_response")
    .addEdge("validate_response", "persist_response")
    .addEdge("persist_response", END)
    .compile({ checkpointer });
}

type CompiledAgentGraph = ReturnType<typeof compileAgentGraphImpl>;

const compiledGraphs = new WeakMap<object, CompiledAgentGraph>();
const noCheckpointerGraphKey = {};

function compileAgentGraph(checkpointer?: BaseCheckpointSaver): CompiledAgentGraph {
  const key: object = checkpointer ?? noCheckpointerGraphKey;
  const cached = compiledGraphs.get(key);
  if (cached) return cached;
  const graph = compileAgentGraphImpl(checkpointer);
  compiledGraphs.set(key, graph);
  return graph;
}

/**
 * Creates a closed-loop v2 graph. Tool selection and parameters come only from
 * `router.ts`; the language model is never bound to tools and cannot select a
 * device action or enter a ReAct loop. The compiled graph is cached per
 * checkpointer, and per-request inputs flow through `config.configurable`
 * so they never enter checkpointed state.
 */
export function createAgentGraphRuntime(options: AgentGraphRuntimeOptions) {
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  const narrationModel = options.model.bindTools
    ? options.model.bindTools([], { tool_choice: "none" } as never)
    : options.model;
  const graph = compileAgentGraph(options.checkpointer);

  return {
    async run(input: AgentGraphRunInput): Promise<AgentGraphRunResult> {
      const inputDigest = computeInputDigest(input);
      const config: RunnableConfig = {
        configurable: {
          thread_id: graphThreadId(input.userId, input.batchId, input.sessionId),
          // NodeSqliteCheckpointSaver resolves this to `turn:<clientMessageId>`
          // as its namespace. Do not set LangGraph's internal checkpoint_ns:
          // it is reserved for nested graph tasks and would prevent replay.
          nbj_request_id: `turn:${input.clientMessageId}`,
          nbj_run: {
            userId: input.userId,
            batchId: input.batchId,
            sessionId: input.sessionId,
            clientMessageId: input.clientMessageId,
            message: input.message,
            history: input.history,
            systemPrompt: input.systemPrompt,
            signal: input.signal,
            tools,
            narrationModel,
            onToolResult: options.onToolResult,
            onToolEvidence: options.onToolEvidence,
          },
        },
        callbacks: [],
        recursionLimit: 40,
      };
      let resumed = false;
      if (input.resume && options.checkpointer) {
        const checkpoint = await graph.getState(config);
        if (checkpoint.values && Object.keys(checkpoint.values).length > 0) {
          resumed = true;
          const state = checkpoint.values as AgentGraphState;
          if (state.inputDigest && state.inputDigest !== inputDigest) {
            throw new Error("NBJ_AGENT_RESUME_INPUT_MISMATCH");
          }
          if (state.finalText) {
            validateNumericResponse(state.finalText, state.numericWhitelist ?? []);
            return {
              text: state.finalText,
              resumed,
              toolExecutions: state.toolExecutions,
              toolEvidence: publicToolEvidence(state.evidenceRefs ?? []),
              intent: state.intent.kind,
              status: state.status,
            };
          }
          const continued = await graph.invoke(null, config) as AgentGraphState;
          return {
            text: continued.finalText,
            resumed,
            toolExecutions: continued.toolExecutions,
            toolEvidence: publicToolEvidence(continued.evidenceRefs ?? []),
            intent: continued.intent.kind,
            status: continued.status,
          };
        }
      }
      const state = await graph.invoke({
        turnId: stableTurnId(input),
        clientMessageId: input.clientMessageId,
        graphVersion: LANGGRAPH_RUNTIME_VERSION,
        batchId: input.batchId,
        sessionId: input.sessionId,
        inputDigest,
        snapshot: {},
        intent: { kind: "general", asksForExplanation: false, requestsMutation: false, confidence: 0 },
        subgraph: "general_subgraph",
        evidencePlan: { requiredTools: [], nextToolIndex: 0, responseKind: "general" },
        evidenceRefs: [],
        batchSummary: undefined,
        todayOperations: undefined,
        dailyOperations: undefined,
        approval: null,
        toolExecutions: 0,
        numericWhitelist: [],
        frozenReceiptBinding: "",
        finalText: "",
        status: "running",
      }, config) as AgentGraphState;
      return {
        text: state.finalText,
        resumed,
        toolExecutions: state.toolExecutions,
        toolEvidence: publicToolEvidence(state.evidenceRefs ?? []),
        intent: state.intent.kind,
        status: state.status,
      };
    },
  };
}
