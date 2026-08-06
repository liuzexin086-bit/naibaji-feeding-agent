import type { FeedingMode } from "../../shared/agent-v2-contract.js";

export type AgentIntentKind =
  | "batch_overview"
  | "exception"
  | "laggard"
  | "device_plan_or_mode"
  | "timeline_or_today_operations"
  | "knowledge"
  | "general";

export type AgentTurnStatus = "running" | "safe_block" | "completed" | "interrupted" | "stale";

export interface AgentEvidenceRef {
  toolName: string;
  receiptId?: string;
  inputDigest?: string;
  frozenBinding?: string;
  isError: boolean;
}

export interface CurrentBatchSummary {
  name?: string;
  dayNumber?: number;
  dayAge?: number;
  selectedMode?: "timed_quantity" | "free_feeding";
  effectiveMode?: "timed_quantity" | "free_feeding";
  singlePowderGrams?: number;
  dailyPowderGrams?: number;
  mealCount?: number;
  suggestedDailyPowderGrams?: number;
  suggestedDailyMealCount?: number;
  mealTimes: string[];
  freeWindows: Array<{ startLocal: string; endLocal: string }>;
  latestDiarrhea?: {
    grade: "mild" | "moderate" | "severe";
    actualPowderGrams: number | null;
    recordedAt: string;
  };
}

export interface TodayOperationSummary {
  businessDate?: string;
  status?: "pending" | "confirmed";
  operations: Array<{ title: string; startLocal?: string; endLocal?: string }>;
  feedback?: TodayFeedbackSummary[];
  amendments?: Array<{
    id: string;
    originKind: "diarrhea" | "creep_control";
    severity: "mild" | "moderate" | "severe" | null;
    priority: "routine" | "warning" | "critical";
    status: "pending" | "confirmed" | "rejected" | "applied" | "superseded" | "cancelled";
    decisionId: string | null;
    proposalDigest?: string;
  }>;
}

export interface TodayFeedbackSummary {
  kind: "diarrhea" | "creep_control";
  status: "proposed" | "manual" | "applied";
  reason: string;
  proposal?: {
    mode: "timed_quantity" | "free_feeding";
    dailyPowderGrams: number;
    singlePowderGrams: number;
    mealCount: number;
    timedMeals: Array<{ timeLocal: string; powderGrams: number }>;
    manualDispositionRequired: boolean;
    controlStartDay?: number;
  };
}

export interface KnowledgeResultRef {
  sectionId: string;
  title: string;
  text: string;
  score: number;
}

export interface DiarrheaPreviewSummary {
  worstGrade: "mild" | "moderate" | "severe";
  resultKind: "proposal" | "preview_only" | "manual_only";
  mode?: FeedingMode;
  remainingDailyPowderGrams: number;
  singlePowderGrams?: number;
  mealCount?: number;
  timedMeals: Array<{ timeLocal: string; powderGrams: number }>;
  freeWindows: Array<{ startLocal: string; endLocal: string }>;
  manualDispositionRequired: boolean;
  cumulativePowderGrams: number;
  cumulativeSource: "observation" | "request" | "latest_record" | "assumed_zero";
  remainingDeliverable: number;
  targetSlot?: string;
  targetAlreadyHappened?: boolean;
}

export interface DeterministicFact {
  field: string;
  value: string | number;
  unit?: string;
  evidenceRef?: string;
  revision?: number;
  sopDigest?: string;
  deviceDigest?: string;
}

/**
 * Checkpoint-safe graph state. It deliberately holds references and digests,
 * never raw tool inputs/results, credentials, or the full message body.
 */
export interface AgentGraphStateContract {
  turnId: string;
  clientMessageId: string;
  graphVersion: string;
  batchId: string;
  sessionId: string;
  inputDigest: string;
  snapshot: {
    batchRevision?: number;
    currentDayIndex?: number;
    currentDayAge?: number;
    selectedMode?: FeedingMode;
    effectiveMode?: FeedingMode;
    sopSourceSha256?: string;
    devicePlanSha256?: string;
  };
  intent: {
    kind: AgentIntentKind;
    asksForExplanation: boolean;
    requestsMutation: boolean;
    confidence: number;
  };
  subgraph: "first_day_subgraph" | "timed_quantity_subgraph" | "free_feeding_subgraph"
    | "exception_subgraph" | "laggard_subgraph" | "timeline_today_operations_subgraph"
    | "knowledge_subgraph" | "approval_subgraph" | "batch_overview_subgraph" | "general_subgraph";
  evidencePlan: {
    requiredTools: string[];
    nextToolIndex: number;
    responseKind: "deterministic" | "knowledge" | "general";
  };
  evidenceRefs: AgentEvidenceRef[];
  batchSummary?: CurrentBatchSummary;
  todayOperations?: TodayOperationSummary;
  knowledgeResults?: KnowledgeResultRef[];
  diarrheaPreview?: DiarrheaPreviewSummary;
  diarrheaEnded?: boolean;
  deterministicFacts?: DeterministicFact[];
  dailyOperations?: {
    planId: string;
    businessDate: string;
    operationsSha256: string;
    status: "pending" | "confirmed";
  };
  approval: null | {
    approvalId: string;
    status: "not_required" | "draft_required";
    basedOnRevision?: number;
    actionDigest: string;
  };
  numericWhitelist: number[];
  frozenReceiptBinding: string;
  finalText: string;
  status: AgentTurnStatus;
  errorCode?: string;
}
