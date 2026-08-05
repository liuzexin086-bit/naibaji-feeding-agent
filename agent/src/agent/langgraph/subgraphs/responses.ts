import type { AgentIntentKind, CurrentBatchSummary, TodayOperationSummary } from "../state.js";

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
    return "该情况已进入异常人工处置路径。请补充现场观察；系统不会直接更改设备程序。";
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
      return `${batchPrefix(summary)}今日操作（${status}${timeline.businessDate ? `，${timeline.businessDate}` : ""}）：${items.length ? items.join("；") : "未返回操作项"}。仅支持当天一次完整确认，不逐项确认。`;
    }
    return "今日常规操作已按冻结 SOP 汇总到“今日操作”栏。该栏仅支持当天一次完整确认，不逐项确认。";
  }
  if (intent === "knowledge") {
    return "已限定在批次冻结 SOP 知识范围内检索；若无同一摘要的知识证据，将返回不可用而不会读取最新模板。";
  }
  return "我会基于当前批次的冻结 SOP 和确定性证据协助说明；设备数值与变更不会由对话直接生成或执行。";
}
