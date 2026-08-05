import type { AgentIntentKind } from "./state.js";

export interface IntentClassification {
  kind: AgentIntentKind;
  asksForExplanation: boolean;
  requestsMutation: boolean;
  confidence: number;
}

export interface StaticEvidencePlan {
  requiredTools: string[];
  responseKind: "deterministic" | "knowledge" | "general";
}

const EXCEPTION = /腹泻|拉稀|拒食|空腹|堵料|堵塞|探头|污染|死亡|异常|diarrhea|refus|block|probe|death/u;
const LAGGARD = /弱仔|掉队|补喂|去留|laggard|weak pig/u;
const DEVICE = /设备|模式|奶粉|下粉|餐次|配奶|自由采食|定时定量|device|feed(?:ing)? plan|mode/u;
const TIMELINE = /今日操作|今日任务|巡栏|维护|流程|时间线|timeline|today operations/u;
const KNOWLEDGE = /sop|规程|知识|为什么|依据|解释|说明|knowledge/u;
const BATCH_CONTEXT = /当前批次|批次数据|批次情况|当前数据|今日情况|今天情况|批次概览|批次状态/u;
const MUTATION = /切换|修改|调整|执行|确认|启动|关闭|switch|change|adjust|confirm|start|stop/u;

/** Fixed safety precedence; an LLM never supplies this route. */
export function classifyDeterministicIntent(message: string): IntentClassification {
  const normalized = message.toLowerCase();
  let kind: AgentIntentKind = "general";
  if (EXCEPTION.test(normalized)) kind = "exception";
  else if (LAGGARD.test(normalized)) kind = "laggard";
  else if (DEVICE.test(normalized)) kind = "device_plan_or_mode";
  else if (TIMELINE.test(normalized)) kind = "timeline_or_today_operations";
  else if (KNOWLEDGE.test(normalized)) kind = "knowledge";
  else if (BATCH_CONTEXT.test(normalized)) kind = "batch_overview";
  return {
    kind,
    asksForExplanation: KNOWLEDGE.test(normalized),
    requestsMutation: MUTATION.test(normalized),
    confidence: kind === "general" ? 0.5 : 1,
  };
}

/** The graph may only invoke this static evidence plan. */
export function staticEvidencePlan(intent: AgentIntentKind): StaticEvidencePlan {
  switch (intent) {
    case "batch_overview":
      return { requiredTools: [], responseKind: "deterministic" };
    case "exception":
      return { requiredTools: ["check_data_quality"], responseKind: "deterministic" };
    case "device_plan_or_mode":
      return { requiredTools: ["compute_production_plan"], responseKind: "deterministic" };
    case "timeline_or_today_operations":
      return { requiredTools: ["get_today_timeline"], responseKind: "deterministic" };
    case "knowledge":
      return { requiredTools: ["search_feeding_knowledge"], responseKind: "knowledge" };
    case "laggard":
      return { requiredTools: [], responseKind: "deterministic" };
    default:
      return { requiredTools: [], responseKind: "general" };
  }
}

export function staticToolArguments(toolName: string, message: string): Record<string, unknown> {
  if (toolName === "search_feeding_knowledge") return { query: message.slice(0, 500) };
  // Quality checks deliberately start with no fabricated observations. Other
  // registered tools used by this graph accept no caller-controlled inputs.
  return {};
}
