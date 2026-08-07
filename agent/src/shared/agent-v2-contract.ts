import type { ProductionPlanInput } from "../model/production-model.js";

export type FeedingMode = "timed_quantity" | "free_feeding";
export type CreepGrade = "none" | "low" | "medium" | "high" | "excellent";
export type DiarrheaGrade = "none" | "mild" | "moderate" | "severe";

/** Fixed internal values for the five operator-facing creep grades. */
export const CREEP_GRADE_VALUES: Readonly<Record<CreepGrade, number>> = {
  none: 0,
  low: 10,
  medium: 45,
  high: 80,
  excellent: 130,
};

export type ExceptionActionType =
  | "diarrhea"
  | "refusal"
  | "blockage"
  | "probe_contamination"
  | "curve_cap";

export interface ExceptionAction {
  type: ExceptionActionType;
  severity: "notice" | "urgent";
  title: string;
  actions: string[];
  requiresHumanConfirmation: boolean;
}

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
  /** Canonical free-feeding dispense quota; mealCount is compatibility only. */
  freeDispenseLimit?: number;
  /** Free-feeding display-only recommendation; it never changes a device program. */
  suggestedDailyPowderGrams?: number;
  suggestedDailyMealCount?: number;
  timedMeals: TimedMeal[];
  freeWindows: DeviceWindow[];
  precisionGrams: number;
  source: "sop_direct" | "sop_indirect" | "production_model";
  estimatedAverageWeightKg?: number;
  estimatedEndWeightKg?: number;
}

export interface FreeFeedingSetting {
  windows: DeviceWindow[];
  singlePowderGrams: number;
  freeDispenseLimit: number;
  dailyPowderGrams: number;
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
  /** Deterministic现场处置 only; this is not a predictive risk score. */
  exceptionActions: ExceptionAction[];
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
  /** Preferred field: operators record none/low/medium/high/excellent. */
  creepFeedGradesLast3Days?: CreepGrade[];
  /** @deprecated Compatibility only for callers carrying fixed internal values. */
  creepFeedGramsLast3Days?: number[];
  diarrheaGrades?: DiarrheaGrade[];
  exceptionSignals?: {
    refusal?: boolean;
    blockage?: boolean;
    probeContaminated?: boolean;
  };
  milkControlActive?: boolean;
}

export interface DiarrheaAdjustmentInput {
  decision: FeedingDecision;
  observedAt: string;
  grades: DiarrheaGrade[];
  /** Actual powder already dispensed today; never an estimated or planned amount. */
  cumulativePowderGrams: number | null;
  /** Frozen SOP timed-meal reductionPriority. Required for timed_quantity. */
  reductionPriority?: string[];
  /** @deprecated Legacy snapshot compatibility only; not read by the free-feeding decision path. */
  freeReductionPriority?: string[];
}

export type DiarrheaAdjustmentKind =
  | "none"
  | "individual_intervention"
  | "feeding_reduction_proposal"
  | "manual_only";

export interface DiarrheaAdjustmentResult {
  kind: DiarrheaAdjustmentKind;
  worstGrade: Exclude<DiarrheaGrade, "none"> | null;
  decision: FeedingDecision | null;
  proposal: DeviceSetting | null;
  manualDispositionRequired: boolean;
  targetSlot: string | null;
  targetAlreadyHappened: boolean;
  adjustedProgramTotal: number;
  cumulativeActual: number | null;
  remainingDeliverable: number;
  futureDeliverable: number;
  affectsWholePen: boolean;
  isolateAffectedPiglets: boolean;
  affectedPigletMilkControlCount: number;
  deviceAdjustmentRequired: boolean;
  requiresHumanConfirmation: boolean;
  requiresManualDisposition: boolean;
  reason: string;
  evidence: Record<string, unknown>;
}
