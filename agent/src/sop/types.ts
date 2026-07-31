export const SOP_PHASES = [
  "preparation",
  "admission",
  "adaptation",
  "first_teaching",
  "teaching_loop",
  "production_feeding",
  "creep_feed",
  "milk_soaked_feed",
  "transition",
  "completed",
  "exception",
] as const;

export type SopPhase = (typeof SOP_PHASES)[number];

export type PlanSource = "sop_teaching" | "production_model" | "sop_transition";

export type TaskKind =
  | "preparation_check"
  | "admission"
  | "teaching_meal"
  | "gentle_movement"
  | "inspection"
  | "water_close"
  | "water_check"
  | "water_restore"
  | "creep_feed"
  | "milk_soaked_feed"
  | "transition_feed"
  | "clean_water_cycle"
  | "deep_clean"
  | "batch_end_clean"
  | "laggard_supplement"
  | "laggard_day3_evaluation"
  | "custom";

export interface SopCustomTaskDefinition {
  title: string;
  ageDay: number;
  localTime: string;
  planSource?: PlanSource;
  requiresConfirmation?: boolean;
  plannedValues?: Record<string, unknown>;
}

export interface SopTemplateSnapshot {
  templateId: string;
  version: string;
  timezone: string;
  utcOffsetMinutes: number;
  defaultAdmissionDeadlineLocal: string;
  preferredFirstTeachingLocal: string;
  adaptationMinHours: number;
  adaptationMaxHours: number;
  teachingIntervalHours: number;
  teachingLiquidMlPerHead: number;
  teachingPowderGramsPerTwenty: number;
  devicePowderPrecisionGrams: number;
  teachingProgramEndDayOffset?: number;
  teachingProgramEndLocal?: string;
  teachingDirectTotalPowderGrams?: number;
  quantityAuthorityOrder?: ReadonlyArray<
    "sop_direct" | "sop_indirect" | "production_model"
  >;
  modelQuantityFallbackEnabled?: boolean;
  teachingQuantitySource?: "sop" | "production_model";
  deviceConfigurationFields?: ReadonlyArray<"powderGrams" | "timeLocal">;
  teachingLatestDay: number;
  waterClosedBeforeAgeDays: number;
  waterPolicyEnabled: boolean;
  teachingProgramEnabled?: boolean;
  gentleMovementEnabled?: boolean;
  laggardEvaluationEnabled?: boolean;
  creepFeedEnabled?: boolean;
  soakedFeedEnabled?: boolean;
  transitionEnabled?: boolean;
  maintenanceEnabled?: boolean;
  productionProgramStartLocal?: string;
  customTasks?: SopCustomTaskDefinition[];
  standardCleanEveryDays: number;
  deepCleanEveryDays: number;
  creepAgeStart: number;
  creepAgeEnd: number;
  soakedFeedAgeStart: number;
  soakedFeedAgeEnd: number;
  soakedFeedRatio: string;
  transitionAgeStart: number;
  transitionMealsMin: number;
  transitionMealsMax: number;
}

export interface ProductionMealAmount {
  powderGrams: number;
  dailyPowderGrams: number;
  mealCount: number;
  dayAge: number;
  calculationDate: string;
  modelVersion: string;
}

export interface SopRun {
  id: string;
  batchId: string;
  userId: string;
  template: SopTemplateSnapshot;
  modelVersion: string;
  modelHash: string;
  dilutionRatio: string;
  phase: SopPhase;
  revision: number;
  startedAt: string;
  admittedAt: string;
  firstTeachingAt: string;
  activeHeadCount: number;
  status: "active" | "completed" | "paused";
  majorityFeedsConfirmedAt?: string;
  exceptionReason?: string;
}

export interface SopTask {
  id: string;
  runId: string;
  batchId: string;
  kind: TaskKind;
  title: string;
  scheduledAt: string;
  status: "pending" | "scheduled" | "completed" | "overdue" | "exception" | "cancelled";
  planSource: PlanSource;
  sequence: number;
  requiresConfirmation: boolean;
  numericPlan?: {
    headCount?: number;
    powderGrams?: number;
    feedRatio?: string;
    mealCount?: number;
    dailyPowderGrams?: number;
    dayAge?: number;
  };
  metadata?: Record<string, unknown>;
}

export interface SopDeviation {
  code: string;
  message: string;
  requiresConfirmation: boolean;
  observedAt: string;
}

export interface LaggardCase {
  id: string;
  runId: string;
  pigTag: string;
  observedAt: string;
  notApproachingTrough: boolean;
  hollowAbdomen: boolean;
  supplementCount: number;
  status: "open" | "keep" | "return_to_sow" | "closed";
  day3Outcome?: "keep" | "return_to_sow";
}

export interface DataQualityInput {
  headCount?: number;
  averageWeightKg?: number;
  feedingResponse?: "active" | "mixed" | "refusing";
  abdomenState?: "full" | "mixed" | "hollow";
  diarrhea?: "none" | "mild" | "moderate" | "severe";
  deaths?: number;
  deviceStatus?: "ok" | "blocked" | "probe_contaminated" | "offline";
  waterStatusConfirmed?: boolean;
  operatorConfirmed?: boolean;
}
