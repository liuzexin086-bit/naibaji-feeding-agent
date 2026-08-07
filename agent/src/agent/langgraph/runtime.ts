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
import {
  deterministicDiarrheaEndedResponse,
  deterministicDiarrheaResponse,
  deterministicResponse,
  knowledgeResponseText,
} from "./subgraphs/responses.js";
import type {
  AgentEvidenceRef,
  AgentGraphStateContract,
  AgentIntentKind,
  CurrentBatchSummary,
  DeterministicFact,
  DiarrheaPreviewSummary,
  KnowledgeResultRef,
  TodayOperationSummary,
  TodayFeedbackSummary,
} from "./state.js";
import {
  normalizeIsoTimestamp,
  timestampOrderValue,
} from "../../shared/iso-time.js";

export const LANGGRAPH_RUNTIME_VERSION = "nbj-langgraph-v2";

const NARRATION_SYSTEM_PROMPT = `你是奶爸机现场执行助手。请用自然、简洁的中文回答现场问题。
规则：
1. 只能使用“已核实现场上下文”中的信息，不得使用上下文之外的数据。
2. 不得生成任何数字表达：不得出现阿拉伯数字、时间、百分号或中文数词。
3. 只写不含数字的解释段；安全关键数值全部由确定性事实块提供。
4. 若上下文缺少答案所需信息，明确说明“当前未提供该信息”，不要猜测。
5. 不得提及内部工具名、证据摘要、版本或元数据。`;

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
  knowledgeResults: Annotation<KnowledgeResultRef[] | undefined>({ reducer: (_left, right) => right, default: () => undefined }),
  diarrheaPreview: Annotation<DiarrheaPreviewSummary | undefined>({ reducer: (_left, right) => right, default: () => undefined }),
  diarrheaEnded: Annotation<boolean | undefined>({ reducer: (_left, right) => right, default: () => undefined }),
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
  // Telemetry compatibility only. P1-5 no longer treats this as a security
  // boundary; protected numeric facts are generated by deterministic code.
  const allowed = new Set(numericWhitelist);
  if (responseNumbers(text).some((value) => !allowed.has(value))) {
    throw new Error("NBJ_AGENT_NUMERIC_EVIDENCE_REQUIRED");
  }
}

function safeBlockText(errorCode?: string): string {
  return `当前批次的冻结 SOP、设备方案或确定性证据不可用（${errorCode ?? "NBJ_AGENT_SAFE_BLOCK"}）。系统不会提供设备数值或执行变更。`;
}

function narrationModeLabel(mode?: CurrentBatchSummary["effectiveMode"]): string {
  return mode === "free_feeding" ? "自由采食" : mode === "timed_quantity" ? "定时定量" : "未返回";
}

function narrationContextText(state: AgentGraphState): string {
  const parts: string[] = [];
  const summary = state.batchSummary;
  if (summary) {
    const fields: string[] = [];
    if (summary.name) fields.push(`批次名称：${summary.name}`);
    if (summary.dayNumber !== undefined) fields.push(`第${summary.dayNumber}天`);
    if (summary.dayAge !== undefined) fields.push(`日龄${summary.dayAge}`);
    fields.push(`生效模式：${narrationModeLabel(summary.effectiveMode ?? summary.selectedMode)}`);
    if (summary.singlePowderGrams !== undefined) fields.push(`单次下粉：${summary.singlePowderGrams}g`);
    if (summary.dailyPowderGrams !== undefined) fields.push(`程序总量：${summary.dailyPowderGrams}g`);
    if (summary.mealCount !== undefined) fields.push(`餐次：${summary.mealCount}`);
    if (summary.mealTimes.length) fields.push(`配奶时间点：${summary.mealTimes.join("、")}`);
    if (summary.freeWindows.length) {
      fields.push(`自由采食时段：${summary.freeWindows.map((window) => `${window.startLocal}–${window.endLocal}`).join("、")}`);
    }
    parts.push(`批次：${fields.join("；")}`);
  }
  if (summary?.latestDiarrhea) {
    const latest = summary.latestDiarrhea;
    const gradeLabel = { mild: "轻度", moderate: "中度", severe: "重度" }[latest.grade];
    const actual = latest.actualPowderGrams;
    parts.push(`最新腹泻记录：${gradeLabel}；累计实际下粉${actual == null ? "未录入" : `${actual}g`}；记录时间${latest.recordedAt}。`);
  }
  if (state.todayOperations) {
    const today = state.todayOperations;
    const status = today.status === "confirmed" ? "已确认" : today.status === "pending" ? "待确认" : "未返回";
    const items = today.operations.map((operation) => {
      const window = operation.startLocal && operation.endLocal
        ? `${operation.startLocal}–${operation.endLocal} `
        : "";
      return `${window}${operation.title}`;
    });
    parts.push(`今日操作：日期${today.businessDate ?? "未返回"}；状态${status}；条目：${items.join("；")}`);
    if (today.feedback && today.feedback.length > 0) {
      const feedbackLines = today.feedback.map((feedback) => {
        const label = feedback.kind === "diarrhea" ? "腹泻" : "教槽控奶";
        const feedbackStatus = feedback.status === "applied"
          ? "已应用"
          : feedback.status === "manual"
            ? "人工处置"
            : "待确认";
        const proposalText = feedback.proposal
          ? `；方案：${feedback.proposal.mode === "free_feeding" ? "自由采食" : "定时定量"}，程序总量${feedback.proposal.dailyPowderGrams}g，单次下粉${feedback.proposal.singlePowderGrams}g，餐次${feedback.proposal.mealCount}，配奶时间点${feedback.proposal.timedMeals.map((meal) => `${meal.timeLocal} ${meal.powderGrams}g`).join("、")}`
          : "；无自动设备方案，需人工处置";
        return `${label}反馈（${feedbackStatus}）：${feedback.reason}${proposalText}`;
      });
      parts.push(`现场反馈：${feedbackLines.join("\n")}`);
    }
    if (today.amendments && today.amendments.length > 0) {
      parts.push(`确认后修订：${today.amendments.map((amendment) =>
        `${amendment.originKind === "diarrhea" ? "腹泻" : "教槽控奶"}:${amendment.status}`).join("、")}`);
    }
  }
  if (state.knowledgeResults && state.knowledgeResults.length > 0) {
    const rows = state.knowledgeResults.map((row) => `- ${row.title}：${row.text}`).join("\n");
    parts.push(`冻结SOP检索：\n${rows}`);
  }
  if (state.diarrheaPreview) {
    const preview = state.diarrheaPreview;
    const gradeLabel = { mild: "轻度", moderate: "中度", severe: "重度" }[preview.worstGrade];
    const kindLabel = preview.resultKind === "proposal"
      ? "待确认提案"
      : preview.resultKind === "preview_only"
        ? "仅预览"
        : "人工处置";
    const remaining = preview.mode === "free_feeding"
      ? `剩余窗口：${preview.freeWindows.map((window) => `${window.startLocal}–${window.endLocal}`).join("、") || "无"}`
      : `当前${preview.mealCount ?? 0}餐：${preview.timedMeals.map((meal) => `${meal.timeLocal} ${meal.powderGrams}g`).join("、") || "无"}`;
    const sourceLabel = preview.cumulativeSource === "observation"
      ? "本次观察"
      : preview.cumulativeSource === "request"
        ? "请求参数"
        : preview.cumulativeSource === "latest_record"
          ? "最近记录"
          : "未录入按0估算";
    parts.push(`腹泻调整（${kindLabel}）：${gradeLabel}；目标槽位${preview.targetSlot ?? "未指定"}；${remaining}；调整后整日程序总量${preview.remainingDailyPowderGrams}g；累计实际下粉${preview.cumulativePowderGrams}g（${sourceLabel}）；剩余可交付${preview.remainingDeliverable}g。`);
  }
  parts.push("以上数字均已通过确定性证据校验。");
  return parts.join("\n");
}

function narrationWhitelist(state: AgentGraphState): number[] {
  // Kept for telemetry and older checkpoint compatibility, not as an LLM gate.
  const values = new Set(state.numericWhitelist);
  const summary = state.batchSummary;
  if (summary) {
    for (const value of [
      summary.dayNumber,
      summary.dayAge,
      summary.singlePowderGrams,
      summary.dailyPowderGrams,
      summary.mealCount,
      summary.suggestedDailyPowderGrams,
      summary.suggestedDailyMealCount,
    ]) {
      if (value !== undefined) values.add(value);
    }
    for (const time of summary.mealTimes) {
      for (const value of responseNumbers(time)) values.add(value);
    }
    for (const window of summary.freeWindows) {
      for (const value of responseNumbers(window.startLocal)) values.add(value);
      for (const value of responseNumbers(window.endLocal)) values.add(value);
    }
  }
  const today = state.todayOperations;
  if (today) {
    if (today.businessDate) {
      for (const value of responseNumbers(today.businessDate)) values.add(value);
    }
    for (const operation of today.operations) {
      for (const value of responseNumbers(operation.title)) values.add(value);
      if (operation.startLocal) {
        for (const value of responseNumbers(operation.startLocal)) values.add(value);
      }
      if (operation.endLocal) {
        for (const value of responseNumbers(operation.endLocal)) values.add(value);
      }
    }
    for (const feedback of today.feedback ?? []) {
      for (const value of responseNumbers(feedback.reason)) values.add(value);
      if (feedback.proposal) {
        for (const value of [
          feedback.proposal.dailyPowderGrams,
          feedback.proposal.singlePowderGrams,
          feedback.proposal.mealCount,
          feedback.proposal.controlStartDay,
        ]) {
          if (value !== undefined) values.add(value);
        }
        for (const meal of feedback.proposal.timedMeals) {
          for (const value of responseNumbers(meal.timeLocal)) values.add(value);
          values.add(meal.powderGrams);
        }
      }
    }
  }
  for (const row of state.knowledgeResults ?? []) {
    for (const value of responseNumbers(row.title)) values.add(value);
    for (const value of responseNumbers(row.text)) values.add(value);
  }
  const preview = state.diarrheaPreview;
  if (preview) {
    for (const value of [
      preview.remainingDailyPowderGrams,
      preview.singlePowderGrams,
      preview.mealCount,
      preview.cumulativePowderGrams,
      preview.remainingDeliverable,
    ]) {
      if (value !== undefined) values.add(value);
    }
    if (preview.targetSlot) {
      for (const value of responseNumbers(preview.targetSlot)) values.add(value);
    }
    for (const meal of preview.timedMeals) {
      for (const value of responseNumbers(meal.timeLocal)) values.add(value);
      values.add(meal.powderGrams);
    }
  }
  return [...values];
}

function deterministicFallbackText(state: AgentGraphState): string {
  if (state.intent.kind === "knowledge" && state.knowledgeResults && state.knowledgeResults.length > 0) {
    return knowledgeResponseText(state.knowledgeResults);
  }
  return deterministicResponse(
    state.intent.kind,
    state.intent.requestsMutation,
    state.batchSummary,
    state.todayOperations,
  );
}

function protectedFacts(state: AgentGraphState): DeterministicFact[] {
  const facts: DeterministicFact[] = [];
  const summary = state.batchSummary;
  const evidenceRef = state.evidenceRefs.find((ref) => !ref.isError)?.receiptId;
  const revision = state.snapshot.batchRevision;
  const sopDigest = state.snapshot.sopSourceSha256;
  const deviceDigest = state.snapshot.devicePlanSha256;
  const refs = {
    ...(evidenceRef ? { evidenceRef } : {}),
    ...(revision !== undefined ? { revision } : {}),
    ...(sopDigest ? { sopDigest } : {}),
    ...(deviceDigest ? { deviceDigest } : {}),
  };
  if (summary) {
    if (summary.dayNumber !== undefined) facts.push({ field: "dayNumber", value: summary.dayNumber, unit: "day", ...refs });
    if (summary.dayAge !== undefined) facts.push({ field: "dayAge", value: summary.dayAge, unit: "day", ...refs });
    if (summary.effectiveMode ?? summary.selectedMode) {
      facts.push({
        field: "effectiveMode",
        value: summary.effectiveMode ?? summary.selectedMode ?? "timed_quantity",
        ...refs,
      });
    }
    if (summary.singlePowderGrams !== undefined) {
      facts.push({ field: "singlePowderGrams", value: summary.singlePowderGrams, unit: "g", ...refs });
    }
    if (summary.dailyPowderGrams !== undefined) {
      facts.push({ field: "dailyPowderGrams", value: summary.dailyPowderGrams, unit: "g", ...refs });
    }
    if (summary.mealCount !== undefined) {
      facts.push({ field: "mealCount", value: summary.mealCount, unit: "count", ...refs });
    }
    summary.mealTimes.forEach((time, index) => {
      facts.push({ field: `mealTime_${index}`, value: time, unit: "HH:mm", ...refs });
    });
    summary.freeWindows.forEach((window, index) => {
      facts.push({ field: `freeWindowStart_${index}`, value: window.startLocal, unit: "HH:mm", ...refs });
      facts.push({ field: `freeWindowEnd_${index}`, value: window.endLocal, unit: "HH:mm", ...refs });
    });
  }
  const today = state.todayOperations;
  if (today?.businessDate) {
    facts.push({ field: "businessDate", value: today.businessDate, unit: "YYYY-MM-DD", ...refs });
  }
  for (const feedback of today?.feedback ?? []) {
    facts.push({ field: `feedback_${feedback.kind}`, value: feedback.status, ...refs });
    if (feedback.proposal) {
      facts.push({ field: "feedbackDailyPowderGrams", value: feedback.proposal.dailyPowderGrams, unit: "g", ...refs });
      facts.push({ field: "feedbackSinglePowderGrams", value: feedback.proposal.singlePowderGrams, unit: "g", ...refs });
      facts.push({ field: "feedbackMealCount", value: feedback.proposal.mealCount, unit: "count", ...refs });
    }
  }
  for (const amendment of today?.amendments ?? []) {
    facts.push({
      field: `amendment_${amendment.id}`,
      value: amendment.status,
      ...refs,
    });
    if (amendment.decisionId) {
      facts.push({
        field: `amendment_decision_${amendment.id}`,
        value: amendment.decisionId,
        ...refs,
      });
    }
  }
  if (today?.amendments?.length) {
    const pending = today.amendments.filter((amendment) => amendment.status === "pending").length;
    const confirmed = today.amendments.filter((amendment) => amendment.status === "confirmed").length;
    const applied = today.amendments.filter((amendment) => amendment.status === "applied").length;
    facts.push({ field: "pendingAmendmentCount", value: pending, unit: "count", ...refs });
    facts.push({ field: "confirmedAmendmentCount", value: confirmed, unit: "count", ...refs });
    facts.push({ field: "appliedAmendmentCount", value: applied, unit: "count", ...refs });
  }
  const preview = state.diarrheaPreview;
  if (preview) {
    facts.push({ field: "diarrheaWorstGrade", value: preview.worstGrade, ...refs });
    facts.push({ field: "diarrheaResultKind", value: preview.resultKind, ...refs });
    if (preview.targetSlot) facts.push({ field: "diarrheaTargetSlot", value: preview.targetSlot, unit: "HH:mm", ...refs });
    facts.push({ field: "adjustedProgramTotal", value: preview.remainingDailyPowderGrams, unit: "g", ...refs });
    facts.push({ field: "cumulativeActual", value: preview.cumulativePowderGrams, unit: "g", ...refs });
    facts.push({ field: "remainingDeliverable", value: preview.remainingDeliverable, unit: "g", ...refs });
  }
  return facts;
}

function deterministicFactBlockText(state: AgentGraphState): string {
  const facts = protectedFacts(state);
  if (!facts.length) return "确定性事实：暂无可用受保护数值。";
  return [
    "确定性事实：",
    ...facts.map((fact) => {
      const unit = fact.unit ? ` ${fact.unit}` : "";
      const ref = fact.evidenceRef ? ` [${fact.evidenceRef}]` : "";
      return `- ${fact.field}=${String(fact.value)}${unit}${ref}`;
    }),
  ].join("\n");
}

function containsNumericExpression(text: string): boolean {
  return /[\d０-９]|[%％]|百分之|[零一二三四五六七八九十百千万两半]/u.test(text);
}

function protectedDeterministicText(state: AgentGraphState, body: string): string {
  return `${deterministicFactBlockText(state)}\n\n${body}\n\n安全说明：设备数值与变更不会由对话直接生成或执行。`;
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

function latestDiarrheaFromRecords(records: unknown): CurrentBatchSummary["latestDiarrhea"] {
  if (!Array.isArray(records)) return undefined;
  const validRecords = records.filter((row) =>
    normalizeIsoTimestamp(
      object(row)?.recordedAt ?? object(row)?.created_at,
    ) !== null);
  if (validRecords.length === 0) return undefined;
  const sorted = [...validRecords].sort((left, right) => {
    const leftRow = object(left);
    const rightRow = object(right);
    const leftAt = String(leftRow?.recordedAt ?? leftRow?.created_at ?? "");
    const rightAt = String(rightRow?.recordedAt ?? rightRow?.created_at ?? "");
    const leftMs = timestampOrderValue(leftAt);
    const rightMs = timestampOrderValue(rightAt);
    if (leftMs !== rightMs) return leftMs - rightMs;
    return leftAt.localeCompare(rightAt);
  });
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const row = object(sorted[index]);
    const grade = String(row?.diarrheaGrade ?? "");
    if (grade === "none") return undefined;
    if (grade === "mild" || grade === "moderate" || grade === "severe") {
      const rawActual = row?.actualPowderGrams;
      const actual = rawActual == null || rawActual === "" ? null : finite(rawActual);
      const recordedAt = String(row?.recordedAt ?? row?.created_at ?? "");
      return { grade, actualPowderGrams: actual ?? null, recordedAt };
    }
  }
  return undefined;
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
  const latestDiarrhea = latestDiarrheaFromRecords(batch.records);
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
    ...(latestDiarrhea ? { latestDiarrhea } : {}),
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
  const feedback = feedbackSummaryFromToolResult(result);
  const amendments = amendmentSummaryFromToolResult(data?.amendments);
  return {
    ...(typeof plan.businessDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(plan.businessDate) ? { businessDate: plan.businessDate } : {}),
    ...(status ? { status } : {}),
    operations,
    ...(feedback ? { feedback } : {}),
    ...(amendments && amendments.length ? { amendments } : {}),
  };
}

function amendmentSummaryFromToolResult(
  value: unknown,
): NonNullable<TodayOperationSummary["amendments"]> {
  if (!Array.isArray(value)) return [];
  const amendments: NonNullable<TodayOperationSummary["amendments"]> = [];
  for (const raw of value) {
    const row = object(raw);
    if (!row) continue;
    const id = typeof row.id === "string" && row.id ? row.id : "";
    const originKind = String(row.originKind ?? "");
    const priority = String(row.priority ?? "");
    const status = String(row.status ?? "");
    const severity = row.severity == null
      ? null
      : String(row.severity);
    const decisionId = row.decisionId == null
      ? null
      : String(row.decisionId);
    if (!id ||
        (originKind !== "diarrhea" && originKind !== "creep_control") ||
        (priority !== "routine" && priority !== "warning" && priority !== "critical") ||
        (status !== "pending" && status !== "confirmed" && status !== "rejected" &&
         status !== "applied" && status !== "superseded" && status !== "cancelled") ||
        (severity !== null && severity !== "mild" && severity !== "moderate" && severity !== "severe")) {
      continue;
    }
    amendments.push({
      id,
      originKind,
      severity,
      priority,
      status,
      decisionId,
      ...(typeof row.proposalDigest === "string" && row.proposalDigest
        ? { proposalDigest: row.proposalDigest }
        : {}),
    });
  }
  return amendments;
}

function feedbackSummaryFromToolResult(result: unknown): TodayFeedbackSummary[] | undefined {
  const envelope = envelopeFromToolResult(result);
  const data = object(envelope?.data);
  const plan = object(data?.dailyOperationPlan);
  const originRow = object(data?.feedbackOrigin) ?? object(plan?.feedbackOrigin);
  if (!originRow) return undefined;
  const kind = String(originRow.kind ?? "");
  if (kind !== "diarrhea" && kind !== "creep_control") return undefined;
  const proposalRow = object(data?.proposedSetting) ?? object(plan?.proposedSetting);
  let proposal: TodayFeedbackSummary["proposal"] | undefined;
  if (proposalRow) {
    const mode = proposalRow.mode;
    const timedMeals: NonNullable<TodayFeedbackSummary["proposal"]>["timedMeals"] = [];
    if (Array.isArray(proposalRow.timedMeals)) {
      for (const meal of proposalRow.timedMeals) {
        const row = object(meal);
        const timeLocal = localTime(row?.timeLocal);
        const powderGrams = finite(row?.powderGrams);
        if (timeLocal && powderGrams !== undefined) timedMeals.push({ timeLocal, powderGrams });
      }
    }
    const dailyPowderGrams = finite(proposalRow.dailyPowderGrams);
    const singlePowderGrams = finite(proposalRow.singlePowderGrams);
    const mealCount = finite(proposalRow.mealCount);
    if ((mode === "timed_quantity" || mode === "free_feeding") &&
        dailyPowderGrams !== undefined && singlePowderGrams !== undefined &&
        mealCount !== undefined) {
      proposal = {
        mode,
        dailyPowderGrams,
        singlePowderGrams,
        mealCount,
        timedMeals,
        manualDispositionRequired: proposalRow.manualDispositionRequired === true,
        ...(finite(proposalRow.controlStartDay) !== undefined
          ? { controlStartDay: finite(proposalRow.controlStartDay) }
          : {}),
      };
    }
  }
  const planStatus = plan?.status === "confirmed" ? "confirmed" : undefined;
  const originStatus = originRow.status === "applied"
    ? "applied"
    : originRow.status === "manual"
      ? "manual"
      : "proposed";
  return [{
    kind,
    status: planStatus === "confirmed" ? "applied" : originStatus,
    reason: String(originRow.reason ?? ""),
    ...(proposal ? { proposal } : {}),
  }];
}

function knowledgeResultsFromToolResult(result: unknown): KnowledgeResultRef[] | undefined {
  const envelope = envelopeFromToolResult(result);
  const data = object(envelope?.data);
  if (data?.status !== "ok" || !Array.isArray(data.results)) return undefined;
  const rows = data.results.slice(0, 3).map((row) => {
    const item = object(row);
    if (!item) return null;
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const text = typeof item.text === "string" ? item.text.trim() : "";
    const score = Number(item.score);
    if (!title || !text || !Number.isFinite(score)) return null;
    return {
      sectionId: String(item.sectionId ?? ""),
      title: title.slice(0, 200),
      text: text.slice(0, 1_200),
      score,
    };
  }).filter((row): row is KnowledgeResultRef => row !== null);
  return rows.length ? rows : undefined;
}

function diarrheaPreviewFromToolResult(result: unknown): DiarrheaPreviewSummary | undefined {
  const envelope = envelopeFromToolResult(result);
  const data = object(envelope?.data);
  const deviceOperation = object(data?.deviceOperation);
  const decision = object(data?.decision);
  const setting = object(decision?.setting);
  const worstGrade = String(data?.worstGrade ?? "");
  const resultKind = String(data?.status ?? "");
  if (!["mild", "moderate", "severe"].includes(worstGrade) ||
      !["proposal", "preview_only", "manual_only"].includes(resultKind)) {
    return undefined;
  }
  const mode = deviceOperation?.mode === "free_feeding" || setting?.mode === "free_feeding"
    ? "free_feeding"
    : "timed_quantity";
  const timedMeals: DiarrheaPreviewSummary["timedMeals"] = [];
  if (Array.isArray(setting?.timedMeals)) {
    for (const meal of setting.timedMeals) {
      const row = object(meal);
      const timeLocal = localTime(row?.timeLocal);
      const powderGrams = finite(row?.powderGrams);
      if (timeLocal && powderGrams !== undefined) {
        timedMeals.push({ timeLocal, powderGrams });
      }
    }
  }
  const freeWindows: DiarrheaPreviewSummary["freeWindows"] = [];
  if (Array.isArray(setting?.freeWindows)) {
    for (const window of setting.freeWindows) {
      const row = object(window);
      const startLocal = localTime(row?.startLocal);
      const endLocal = localTime(row?.endLocal);
      if (startLocal && endLocal) freeWindows.push({ startLocal, endLocal });
    }
  }
  const remainingDailyPowderGrams =
    finite(deviceOperation?.remainingDailyPowderGrams) ??
    finite(data?.adjustedProgramTotal) ??
    finite(setting?.dailyPowderGrams);
  const singlePowderGrams =
    finite(deviceOperation?.singlePowderGrams) ??
    finite(setting?.singlePowderGrams);
  const mealCount = finite(deviceOperation?.mealCount) ?? finite(setting?.mealCount);
  const cumulativePowderGrams = finite(data?.cumulativePowderGrams) ?? 0;
  const remainingDeliverable = finite(data?.remainingDeliverable) ?? 0;
  const targetSlot = typeof data?.targetSlot === "string" && data.targetSlot
    ? data.targetSlot
    : undefined;
  const cumulativeSource = String(data?.cumulativeSource ?? "");
  if (remainingDailyPowderGrams === undefined) return undefined;
  return {
    worstGrade: worstGrade as DiarrheaPreviewSummary["worstGrade"],
    resultKind: resultKind as DiarrheaPreviewSummary["resultKind"],
    ...(resultKind === "proposal" ? { mode } : {}),
    remainingDailyPowderGrams,
    ...(singlePowderGrams !== undefined ? { singlePowderGrams } : {}),
    ...(mealCount !== undefined ? { mealCount } : {}),
    timedMeals,
    freeWindows,
    manualDispositionRequired:
      deviceOperation?.manualDispositionRequired === true ||
      data?.manualDispositionRequired === true,
    cumulativePowderGrams,
    cumulativeSource: (["observation", "request", "latest_record", "assumed_zero"] as const)
      .includes(cumulativeSource as DiarrheaPreviewSummary["cumulativeSource"])
      ? cumulativeSource as DiarrheaPreviewSummary["cumulativeSource"]
      : "observation",
    remainingDeliverable,
    ...(targetSlot ? { targetSlot } : {}),
    ...(data?.targetAlreadyHappened === true ? { targetAlreadyHappened: true } : {}),
  };
}

function diarrheaEndedFromToolResult(result: unknown): boolean {
  const envelope = envelopeFromToolResult(result);
  const data = object(envelope?.data);
  return data?.status === "ended" || data?.ended === true;
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
  const activeDiarrhea = state.batchSummary?.latestDiarrhea;
  const effectiveIntent = intent.kind === "general" && activeDiarrhea
    ? { ...intent, kind: "exception" as const }
    : intent;
  const evidencePlan = effectiveIntent.kind === "exception" && activeDiarrhea &&
      !/腹泻|拉稀|diarrhea|loose stool|soft stool/u.test(run.message)
    ? { requiredTools: ["preview_diarrhea_adjustment"] as const, responseKind: "deterministic" as const, nextToolIndex: 0 }
    : { ...staticEvidencePlan(effectiveIntent.kind, run.message), nextToolIndex: 0 };
  return {
    intent: effectiveIntent,
    evidencePlan,
    subgraph: selectSopSubgraph(effectiveIntent.kind, state.snapshot.selectedMode, state.snapshot.currentDayIndex),
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
    if ((name === "compute_production_plan" || name === "get_today_timeline" ||
         name === "sync_observation_feedback") && !receipt) {
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
      ...(name === "get_today_timeline" || name === "sync_observation_feedback"
        ? { todayOperations: todayOperationSummaryFromToolResult(result) }
        : {}),
      ...(name === "search_feeding_knowledge"
        ? { knowledgeResults: knowledgeResultsFromToolResult(result) }
        : {}),
      ...(name === "preview_diarrhea_adjustment"
        ? {
            diarrheaPreview: diarrheaPreviewFromToolResult(result),
            diarrheaEnded: diarrheaEndedFromToolResult(result),
          }
        : {}),
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

const NARRATION_INTENTS = new Set<AgentIntentKind>([
  "knowledge",
  "general",
]);
const PROTECTED_DETERMINISTIC_INTENTS = new Set<AgentIntentKind>([
  "batch_overview",
  "device_plan_or_mode",
  "timeline_or_today_operations",
]);

const renderResponseNode = async (state: AgentGraphState, config: RunnableConfig) => {
  if (state.status === "safe_block" && state.errorCode === "NBJ_DIARRHEA_GRADE_REQUIRED") {
    return {
      finalText: "请补充腹泻档位（轻/中/重）；累计下粉量请在页面“今日数据”录入并保存，或直接在消息里说明已下粉量（如 120g）。",
      status: "safe_block" as const,
    };
  }
  if (state.status === "safe_block" || state.status === "stale") {
    return { finalText: safeBlockText(state.errorCode), status: state.status };
  }
  if (state.intent.kind === "exception" || state.intent.kind === "laggard") {
    const body = state.intent.kind === "exception" && state.diarrheaEnded
      ? deterministicDiarrheaEndedResponse(state.batchSummary)
      : state.intent.kind === "exception" && state.diarrheaPreview
        ? deterministicDiarrheaResponse(state.batchSummary, state.diarrheaPreview)
        : deterministicResponse(
      state.intent.kind,
      state.intent.requestsMutation,
      state.batchSummary,
      state.todayOperations,
    );
    return { finalText: protectedDeterministicText(state, body) };
  }
  if (PROTECTED_DETERMINISTIC_INTENTS.has(state.intent.kind)) {
    return {
      finalText: protectedDeterministicText(
        state,
        deterministicResponse(
          state.intent.kind,
          state.intent.requestsMutation,
          state.batchSummary,
          state.todayOperations,
        ),
      ),
    };
  }
  const run = runContextFromConfig(config);
  if (!NARRATION_INTENTS.has(state.intent.kind)) {
    const response = await run.narrationModel.invoke([
      new SystemMessage(run.systemPrompt),
      new SystemMessage(NARRATION_SYSTEM_PROMPT),
      new SystemMessage(`已核实现场上下文：\n${narrationContextText(state)}`),
      ...run.history,
      new HumanMessage(run.message),
      new SystemMessage("仅回答一般说明；不得调用工具、生成设备数值、审批或设备控制命令。"),
    ], { signal: run.signal, callbacks: [] });
    const ai = response instanceof AIMessage ? response : new AIMessage(response.content);
    const text = messageText(ai);
    if ((ai.tool_calls ?? []).length > 0 || !text || containsNumericExpression(text)) {
      return { finalText: deterministicResponse("general", false) };
    }
    return { finalText: text };
  }
  let response: BaseMessage;
  try {
    response = await run.narrationModel.invoke([
      new SystemMessage(NARRATION_SYSTEM_PROMPT),
      new SystemMessage(`已核实现场上下文：\n${narrationContextText(state)}`),
      ...run.history,
      new HumanMessage(run.message),
    ], { signal: run.signal, callbacks: [] });
  } catch {
    return { finalText: deterministicFallbackText(state) };
  }
  const ai = response instanceof AIMessage ? response : new AIMessage(response.content);
  const text = messageText(ai);
  if ((ai.tool_calls ?? []).length > 0 || !text || containsNumericExpression(text)) {
    return { finalText: deterministicFallbackText(state) };
  }
  return { finalText: text };
};

const validateResponseNode = async (state: AgentGraphState) => {
  // numericWhitelist is retained as telemetry/compatibility only and is no
  // longer a security boundary. Protected numbers come from deterministic
  // renderers before this node.
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
        knowledgeResults: undefined,
        diarrheaPreview: undefined,
        diarrheaEnded: undefined,
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
