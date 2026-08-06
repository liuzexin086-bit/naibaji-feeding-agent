import type {
  AgentIntentKind,
  CurrentBatchSummary,
  DiarrheaPreviewSummary,
  KnowledgeResultRef,
  TodayOperationSummary,
} from "../state.js";

export type { CurrentBatchSummary, TodayOperationSummary } from "../state.js";

function modeLabel(mode?: CurrentBatchSummary["effectiveMode"]): string {
  return mode === "free_feeding" ? "自由采食" : mode === "timed_quantity" ? "定时定量" : "未返回";
}

function batchPrefix(summary?: CurrentBatchSummary): string {
  if (!summary) return "";
  const parts: string[] = [];
  if (summary.name) parts.push(`批次“${summary.name}”`);
  if (summary.dayNumber !== undefined) parts.push(`第${summary.dayNumber}天`);
  if (summary.dayAge !== undefined) parts.push(`日龄${summary.dayAge}`);
  return parts.length ? `${parts.join(" · ")}。` : "";
}

function scheduleText(summary?: CurrentBatchSummary): string {
  if (!summary) return "";
  const mode = summary.effectiveMode ?? summary.selectedMode;
  if (mode === "free_feeding") {
    const windows = summary.freeWindows.map((window) => `${window.startLocal}–${window.endLocal}`);
    return windows.length ? `自由采食时间段：${windows.join("、")}。` : "自由采食时间段未返回。";
  }
  return summary.mealTimes.length ? `配奶时间点：${summary.mealTimes.join("、")}。` : "配奶时间点未返回。";
}

function deviceSummary(summary?: CurrentBatchSummary): string {
  if (!summary) return "";
  const mode = summary.effectiveMode ?? summary.selectedMode;
  if (mode === "free_feeding") {
    const suggested = summary.suggestedDailyPowderGrams ?? summary.dailyPowderGrams;
    const count = summary.suggestedDailyMealCount;
    const display = suggested === undefined
      ? "建议单日下粉总量未返回"
      : `建议单日下粉总量 ${suggested}g${count === undefined ? "" : `（模型按${count}次计算）`}`;
    return `${display}。${scheduleText(summary)}`;
  }
  const values: string[] = [];
  if (summary.singlePowderGrams !== undefined) values.push(`单次下粉 ${summary.singlePowderGrams}g`);
  if (summary.dailyPowderGrams !== undefined) values.push(`程序总量 ${summary.dailyPowderGrams}g`);
  if (summary.mealCount !== undefined) values.push(`实际餐次 ${summary.mealCount}`);
  return values.length ? `${values.join("；")}。${scheduleText(summary)}` : scheduleText(summary);
}

/** Deterministic, non-device-controlling responses for protected routes. */
export function deterministicResponse(
  intent: AgentIntentKind,
  requestsMutation: boolean,
  summary?: CurrentBatchSummary,
  timeline?: TodayOperationSummary,
): string {
  if (intent === "batch_overview") {
    const selected = summary?.selectedMode;
    const effective = summary?.effectiveMode;
    const mode = effective ? `当前生效模式：${modeLabel(effective)}。` : "";
    const selectedText = selected && selected !== effective ? `已选择模板：${modeLabel(selected)}。` : "";
    return summary
      ? `${batchPrefix(summary)}${mode}${selectedText}${deviceSummary(summary)}`
      : "当前批次的已验证摘要未返回，系统不会推测设备设定。";
  }
  if (intent === "exception") {
    return `${batchPrefix(summary)}该情况已进入异常人工处置路径。请补充现场观察；系统不会直接更改设备程序。`;
  }
  if (intent === "laggard") {
    return "弱仔处置需独立留痕和人工确认；第三日去留不会并入今日常规操作确认。";
  }
  if (intent === "device_plan_or_mode") {
    const current = summary
      ? `${batchPrefix(summary)}当前生效模式：${modeLabel(summary.effectiveMode ?? summary.selectedMode)}。${deviceSummary(summary)}`
      : "已按冻结 SOP、批次版本和设备方案读取确定性饲喂计划；";
    return requestsMutation
      ? `${current}设备或模式变更必须走独立已认证接口，系统不会直接执行。`
      : `${current}请以现场执行台显示的程序为准。`;
  }
  if (intent === "timeline_or_today_operations") {
    if (timeline) {
      const status = timeline.status === "confirmed" ? "已确认" : "待确认";
      const items = timeline.operations.map((operation) => {
        const window = operation.startLocal && operation.endLocal
          ? `${operation.startLocal}–${operation.endLocal} ` : "";
        return `${window}${operation.title}`;
      });
      const amendments = timeline.amendments ?? [];
      const pendingAmendments = amendments.filter((amendment) => amendment.status === "pending").length;
      const confirmedAmendments = amendments.filter((amendment) => amendment.status === "confirmed").length;
      const amendmentText = amendments.length
        ? `；确认后修订 ${amendments.length} 项（待确认 ${pendingAmendments}，已确认待应用 ${confirmedAmendments}）`
        : "";
      return `${batchPrefix(summary)}今日操作（${status}${timeline.businessDate ? `，${timeline.businessDate}` : ""}）：${items.length ? items.join("；") : "未返回操作项"}${amendmentText}。仅支持当天一次完整确认，不逐项确认；确认后修订走独立审批。`;
    }
    return "今日常规操作已按冻结 SOP 汇总到“今日操作”栏。该栏仅支持当天一次完整确认，不逐项确认。";
  }
  if (intent === "knowledge") {
    return "已限定在批次冻结 SOP 知识范围内检索；若无同一摘要的知识证据，将返回不可用而不会读取最新模板。";
  }
  return "我会基于当前批次的冻结 SOP 和确定性证据协助说明；设备数值与变更不会由对话直接生成或执行。";
}

/** Deterministic rendering of a verified diarrhea adjustment preview. */
export function deterministicDiarrheaResponse(
  summary: CurrentBatchSummary | undefined,
  preview: DiarrheaPreviewSummary,
): string {
  const gradeLabel = { mild: "轻度", moderate: "中度", severe: "重度" }[preview.worstGrade];
  const prefix = batchPrefix(summary);
  if (preview.resultKind === "manual_only") {
    return `${prefix}已生成${gradeLabel}腹泻人工处置要求：目标槽位 ${preview.targetSlot ?? "未指定"}；调整后整日程序总量 ${preview.remainingDailyPowderGrams}g，累计实际 ${preview.cumulativePowderGrams}g，剩余可交付 ${preview.remainingDeliverable}g。不生成可执行设备提案，需人工处置。`;
  }
  if (preview.resultKind === "preview_only") {
    const windows = preview.freeWindows
      .map((window) => `${window.startLocal}–${window.endLocal}`)
      .join("、") || "无";
    const times = preview.timedMeals
      .map((meal) => `${meal.timeLocal} ${meal.powderGrams}g`)
      .join("、") || "无";
    return `${prefix}已生成${gradeLabel}腹泻调整预览：目标槽位 ${preview.targetSlot ?? "未指定"}；剩余窗口 ${preview.freeWindows.length ? windows : "无"}；剩余餐次 ${preview.mealCount ?? 0}：${times}；调整后整日程序总量 ${preview.remainingDailyPowderGrams}g，累计实际 ${preview.cumulativePowderGrams}g，剩余可交付 ${preview.remainingDeliverable}g。该预览不会自动应用，需人工处置。`;
  }
  if (preview.mode === "free_feeding") {
    const windows = preview.freeWindows
      .map((window) => `${window.startLocal}–${window.endLocal}`)
      .join("、") || "无";
    return `${prefix}已生成${gradeLabel}腹泻调整待确认提案：目标窗口 ${preview.targetSlot ?? "未指定"}；剩余 ${preview.freeWindows.length} 个窗口：${windows}；调整后整日程序总量 ${preview.remainingDailyPowderGrams}g，剩余可交付 ${preview.remainingDeliverable}g。该提案需人工确认后写入设备。`;
  }
  const times = preview.timedMeals
    .map((meal) => `${meal.timeLocal} ${meal.powderGrams}g`)
    .join("、") || "无";
  return `${prefix}已生成${gradeLabel}腹泻调整待确认提案：目标餐次 ${preview.targetSlot ?? "未指定"}；当前 ${preview.mealCount ?? 0} 餐：${times}；调整后整日程序总量 ${preview.remainingDailyPowderGrams}g，剩余可交付 ${preview.remainingDeliverable}g。该提案需人工确认后写入设备。`;
}

/** Deterministic response after the latest recorded diarrhea grade returns to none. */
export function deterministicDiarrheaEndedResponse(
  summary: CurrentBatchSummary | undefined,
): string {
  return `${batchPrefix(summary)}最近腹泻记录已恢复为“无”，今日操作不再保留待确认的腹泻处置项，设备无需按腹泻减餐调整；已确认的历史方案不会自动回退。`;
}

/** Deterministic rendering of verified knowledge retrieved from the frozen SOP. */
export function knowledgeResponseText(results: KnowledgeResultRef[]): string {
  const body = results
    .map((row) => `## ${row.title}\n${row.text}`)
    .join("\n\n");
  return [
    "以下内容来自本批次冻结 SOP 的检索结果：",
    body,
    "设备具体数值与变更以现场执行台显示为准。",
  ].join("\n\n");
}
