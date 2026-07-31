import type { ProductionPlanInput } from "../model/production-model.js";

export type FeedingMode = "timed_quantity" | "free_feeding";
export type CreepGrade = "none" | "low" | "medium" | "high";
export type RiskLevel = "normal" | "elevated" | "high" | "exception";
export type DiarrheaGrade = "none" | "mild" | "moderate" | "severe";

export interface DeviceWindow {
  startLocal: string;
  endLocal: string;
}

export interface TimedMeal {
  timeLocal: string;
  powderGrams: number;
}

export interface DeviceSetting {
  mode: FeedingMode;
  dayAge: number;
  dailyPowderGrams: number;
  singlePowderGrams: number;
  mealCount: number;
  timedMeals: TimedMeal[];
  freeWindows: DeviceWindow[];
  precisionGrams: number;
  source: "sop_direct" | "sop_indirect" | "production_model";
}

export interface DecisionEvidence {
  sopVersion: string;
  modelVersion: string;
  calculationDate: string;
  reasons: string[];
  inputs: Record<string, unknown>;
  steps: Array<{ name: string; value: unknown; explanation: string }>;
}

export interface FeedingDecision {
  revision: number;
  batchId: string;
  dateLocal: string;
  setting: DeviceSetting;
  risk: {
    level: RiskLevel;
    score: number;
    overCurveRatio: number;
    reasons: string[];
  };
  evidence: DecisionEvidence;
  status: "draft" | "active" | "superseded";
}

export interface SopQuantityInput {
  /** Highest-authority complete program/day total. */
  directTotalPowderGrams?: number;
  /** Complete per-meal amount, before multiplying by mealCount. */
  powderGramsPerMeal?: number;
  /** Per-head per-meal parameter, before multiplying by head count and mealCount. */
  powderGramsPerHeadPerMeal?: number;
  /** SOP's common "grams per 20 heads per meal" parameter. */
  powderGramsPerTwentyHeadsPerMeal?: number;
  mealCount?: number;
}

export interface TeachingProgramInput {
  enabled: boolean;
  firstTeachingLocal: string;
  intervalHours?: number;
  /** Fixed by the contract to 08:00 when omitted. */
  endLocal?: string;
}

export interface DayDecisionInput {
  revision: number;
  batchId: string;
  dateLocal: string;
  sopVersion: string;
  calculationDate?: string;
  modelInput: ProductionPlanInput;
  sop?: SopQuantityInput;
  requestedMode?: FeedingMode;
  requestedStatus?: "draft" | "active";
  precisionGrams?: number;
  freeWindows?: DeviceWindow[];
  timedMealTimes?: string[];
  teachingProgram?: TeachingProgramInput;
  /** Preferred field: operators record only none/low/medium/high. */
  creepFeedGradesLast3Days?: CreepGrade[];
  /** @deprecated Compatibility for callers that previously recorded grams. */
  creepFeedGramsLast3Days?: number[];
  diarrheaGrades?: DiarrheaGrade[];
  milkControlActive?: boolean;
}

export interface DiarrheaAdjustmentInput {
  decision: FeedingDecision;
  observedAt: string;
  grades: DiarrheaGrade[];
  /** Actual powder already dispensed today; never an estimated or planned amount. */
  cumulativePowderGrams: number;
  /** Optional explicit medical/SOP ratio; otherwise the deterministic grade table is used. */
  targetRatio?: number;
  /** Explicit remaining times avoid ambiguity for overnight programs. */
  remainingMealTimes?: string[];
}
