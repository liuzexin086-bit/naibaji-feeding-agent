import type { AgentIntentKind } from "../state.js";

export type SopSubgraphName =
  | "first_day_subgraph"
  | "timed_quantity_subgraph"
  | "free_feeding_subgraph"
  | "exception_subgraph"
  | "laggard_subgraph"
  | "timeline_today_operations_subgraph"
  | "knowledge_subgraph"
  | "approval_subgraph"
  | "batch_overview_subgraph"
  | "general_subgraph";

/** Named deterministic subgraphs; none owns feeding arithmetic or device I/O. */
export function selectSopSubgraph(
  intent: AgentIntentKind,
  selectedMode?: string,
  currentDayIndex?: number,
): SopSubgraphName {
  if (intent === "exception") return "exception_subgraph";
  if (intent === "laggard") return "laggard_subgraph";
  if (intent === "timeline_or_today_operations") return "timeline_today_operations_subgraph";
  if (intent === "knowledge") return "knowledge_subgraph";
  if (intent === "batch_overview") return "batch_overview_subgraph";
  if (intent === "device_plan_or_mode" && currentDayIndex === 0) return "first_day_subgraph";
  if (intent === "device_plan_or_mode" && selectedMode === "free_feeding") return "free_feeding_subgraph";
  if (intent === "device_plan_or_mode") return "timed_quantity_subgraph";
  return "general_subgraph";
}
