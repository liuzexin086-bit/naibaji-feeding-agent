import { createHash } from "node:crypto";
import {
  computeProductionPlan,
  modelStandardWeight,
  type ProductionPlanInput,
} from "../model/production-model.js";
import type {
  CreepGrade,
  DayDecisionInput,
  DiarrheaGrade,
  FeedingDecision,
  FeedingMode,
} from "../shared/agent-v2-contract.js";
import type { DevicePlanSnapshot } from "../shared/local-store-contract.js";
import { computeDayDecision } from "./core.js";
import { enabledFreeFeedingWindows, normalizeFreeFeedingSlots } from "./free-feeding-slots.js";

type JsonObject = Record<string, unknown>;

const FIRST_DAY_MEAL_TIMES = ["17:00", "20:00", "23:00", "02:00", "05:00", "08:00"];
const GRADE_ORDER: CreepGrade[] = ["none", "low", "medium", "high", "excellent"];
const FREE_FEEDING_BLOCKERS = new Set([
  "milk_control",
  "diarrhea",
  "refusal",
  "blockage",
  "probe_contamination",
  "curve_cap",
]);

export interface BatchDecisionSource {
  batchId: string;
  revision: number;
  currentDayIndex: number;
  config: JsonObject;
  records?: JsonObject[];
}

export interface FrozenSopRef {
  templateId: string;
  version: string;
  sourceSha256: string;
  snapshotSha256: string;
  collectionRevision: string;
  parserVersion: string;
  embeddingModel: string;
  config: JsonObject;
}

export interface FrozenBatchDecisionContext {
  batchId: string;
  revision: number;
  currentDayIndex: number;
  selectedMode: FeedingMode;
  sop: FrozenSopRef;
  devicePlan: DevicePlanSnapshot;
  modelInput: ProductionPlanInput;
  planStartDate: string;
  records: JsonObject[];
}

export interface CanonicalBatchDecision {
  selectedMode: FeedingMode;
  effectiveMode: FeedingMode;
  sopRef: Omit<FrozenSopRef, "config">;
  devicePlanRef: Pick<DevicePlanSnapshot, "version" | "sha256">;
  freeFeedingBlockers: string[];
  decision: FeedingDecision;
}

function fail(code: string): never {
  throw new Error(`NBJ_FROZEN_${code}`);
}

function object(value: unknown, code: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value as JsonObject;
}

function text(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) fail(code);
  return value.trim();
}

function finite(value: unknown, code: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) fail(code);
  return value;
}

function integer(value: unknown, code: string, minimum: number, maximum: number): number {
  const numeric = finite(value, code, minimum);
  if (!Number.isSafeInteger(numeric) || numeric > maximum) fail(code);
  return numeric;
}

function localDate(value: unknown, code: string): string {
  const date = text(value, code);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(code);
  return date;
}

function addDays(dateLocal: string, days: number): string {
  const date = new Date(`${dateLocal}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function feedingMode(value: unknown): FeedingMode {
  if (value === "timed_quantity" || value === "free_feeding") return value;
  fail("SELECTED_MODE_INVALID");
}

function digestDevicePlan(snapshot: DevicePlanSnapshot): string {
  const immutable = {
    version: snapshot.version,
    firstDay: snapshot.firstDay,
    templates: snapshot.templates,
  };
  return createHash("sha256").update(JSON.stringify(immutable).normalize("NFC"), "utf8").digest("hex").toUpperCase();
}

export function digestFrozenSopSnapshot(snapshot: Omit<FrozenSopRef, "snapshotSha256">): string {
  const immutable = {
    templateId: snapshot.templateId,
    version: snapshot.version,
    sourceSha256: snapshot.sourceSha256.toUpperCase(),
    collectionRevision: snapshot.collectionRevision,
    parserVersion: snapshot.parserVersion,
    embeddingModel: snapshot.embeddingModel,
    config: snapshot.config,
  };
  return createHash("sha256").update(JSON.stringify(immutable).normalize("NFC"), "utf8").digest("hex").toUpperCase();
}

function digest(value: unknown, code: string): string {
  const result = text(value, code);
  if (!/^[0-9a-f]{64}$/iu.test(result)) fail(code);
  return result.toUpperCase();
}

function frozenSop(config: JsonObject): FrozenSopRef {
  const row = object(config.sopTemplate, "SOP_MISSING");
  const sopConfig = object(row.config, "SOP_CONFIG_MISSING");
  const snapshot: Omit<FrozenSopRef, "snapshotSha256"> = {
    templateId: text(row.templateId, "SOP_TEMPLATE_ID_MISSING"),
    version: text(row.version, "SOP_VERSION_MISSING"),
    sourceSha256: digest(row.sourceSha256, "SOP_DIGEST_MISSING"),
    collectionRevision: text(row.collectionRevision, "SOP_COLLECTION_REVISION_MISSING"),
    parserVersion: text(row.parserVersion, "SOP_PARSER_VERSION_MISSING"),
    embeddingModel: text(row.embeddingModel, "SOP_EMBEDDING_MODEL_MISSING"),
    config: structuredClone(sopConfig),
  };
  const snapshotSha256 = digest(row.snapshotSha256, "SOP_SNAPSHOT_DIGEST_MISSING");
  if (digestFrozenSopSnapshot(snapshot) !== snapshotSha256) fail("SOP_SNAPSHOT_DIGEST_MISMATCH");
  return { ...snapshot, snapshotSha256 };
}

function frozenDevicePlan(config: JsonObject): DevicePlanSnapshot {
  const snapshot = object(config.devicePlanSnapshot, "DEVICE_PLAN_MISSING") as unknown as DevicePlanSnapshot;
  if (!snapshot.version || !snapshot.sha256 || !snapshot.firstDay || !snapshot.templates) {
    fail("DEVICE_PLAN_MISSING");
  }
  if (snapshot.firstDay.mode !== "timed_quantity" ||
      JSON.stringify(snapshot.firstDay.mealTimes) !== JSON.stringify(FIRST_DAY_MEAL_TIMES)) {
    fail("FIRST_DAY_PROGRAM_INVALID");
  }
  if (!snapshot.templates.timed_quantity || !snapshot.templates.free_feeding) {
    fail("DEVICE_PLAN_MISSING");
  }
  if (digestDevicePlan(snapshot) !== snapshot.sha256) fail("DEVICE_PLAN_DIGEST_MISMATCH");
  try {
    const slots = normalizeFreeFeedingSlots(snapshot.templates.free_feeding.slots);
    const enabled = enabledFreeFeedingWindows(slots);
    if (JSON.stringify(enabled) !== JSON.stringify(snapshot.templates.free_feeding.windows)) {
      fail("DEVICE_PLAN_WINDOWS_MISMATCH");
    }
    return {
      ...structuredClone(snapshot),
      templates: {
        ...structuredClone(snapshot.templates),
        free_feeding: {
          ...structuredClone(snapshot.templates.free_feeding),
          slots,
          windows: enabled,
        },
      },
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("NBJ_FROZEN_")) throw error;
    const code = error instanceof Error ? error.message.replace(/^NBJ_/, "") : "FREE_FEEDING_SLOTS_INVALID";
    fail(code);
  }
}

function latestGrades(records: JsonObject[]): CreepGrade[] {
  return records.slice(-3).flatMap((record) => {
    const grade = record.creepGrade;
    return typeof grade === "string" && GRADE_ORDER.includes(grade as CreepGrade)
      ? [grade as CreepGrade]
      : [];
  });
}

function selectedTimedMealTimes(
  template: DevicePlanSnapshot["templates"]["timed_quantity"],
  mealCount: number,
): string[] {
  const target = Math.max(1, Math.min(template.mealTimes.length, Math.floor(mealCount)));
  const disabled = new Set(template.reductionPriority.slice(0, template.mealTimes.length - target));
  return template.mealTimes.filter((time) => !disabled.has(time)).slice(0, target);
}

function freeFeedingBlockers(
  context: FrozenBatchDecisionContext,
  dayIndex: number,
  latest: JsonObject | undefined,
): string[] {
  if (context.selectedMode !== "free_feeding" || dayIndex === 0) return [];
  const stage = context.devicePlan.templates.free_feeding.stageConditions;
  const blockers = new Set<string>();
  for (const key of Object.keys(stage)) {
    if (key !== "earliestBatchDay" && key !== "requiresOperatorSelection") {
      blockers.add("stage_conditions_invalid");
    }
  }
  if (stage.earliestBatchDay !== undefined) {
    const earliest = stage.earliestBatchDay;
    if (typeof earliest !== "number" || !Number.isSafeInteger(earliest) || earliest < 1) {
      blockers.add("stage_earliest_batch_day_invalid");
    } else if (dayIndex < earliest) {
      blockers.add("stage_earliest_batch_day");
    }
  }
  if (stage.requiresOperatorSelection !== undefined &&
      typeof stage.requiresOperatorSelection !== "boolean") {
    blockers.add("stage_operator_selection_invalid");
  }
  for (const blocker of context.devicePlan.templates.free_feeding.exceptionBlockers) {
    if (!FREE_FEEDING_BLOCKERS.has(blocker)) blockers.add("exception_blocker_invalid");
  }
  const configured = new Set(context.devicePlan.templates.free_feeding.exceptionBlockers);
  const signalBlockers: Array<[string, boolean]> = [
    ["milk_control", (context.modelInput.controlStartDay ?? -1) >= 0 && dayIndex >= (context.modelInput.controlStartDay ?? -1)],
    ["diarrhea", typeof latest?.diarrheaGrade === "string" && latest.diarrheaGrade !== "none"],
    ["refusal", latest?.feedingResponse === "refusal" || latest?.refusal === true],
    ["blockage", latest?.deviceStatus === "blocked" || latest?.blockage === true],
    ["probe_contamination", latest?.deviceStatus === "probe_contaminated" || latest?.probeContaminated === true],
  ];
  for (const [name, active] of signalBlockers) {
    if (active && configured.has(name)) blockers.add(name);
  }
  return [...blockers].sort();
}

export function loadFrozenBatchDecisionContext(source: BatchDecisionSource): FrozenBatchDecisionContext {
  if (!source.batchId.trim()) fail("BATCH_ID_MISSING");
  const config = object(source.config, "BATCH_CONFIG_MISSING");
  const sop = frozenSop(config);
  const devicePlan = frozenDevicePlan(config);
  const startAge = integer(config.startAge, "START_AGE_INVALID", 1, 60);
  const endAge = integer(config.endAge, "END_AGE_INVALID", startAge, 60);
  const headCount = integer(config.effectiveHeads ?? config.headCount, "HEAD_COUNT_INVALID", 1, 100_000);
  const startWeight = finite(config.startWeight ?? modelStandardWeight(startAge), "START_WEIGHT_INVALID", 0.1);
  const controlStartDay = typeof config.controlStartDay === "number"
    ? integer(config.controlStartDay, "CONTROL_START_DAY_INVALID", -1, 60)
    : -1;
  const records = Array.isArray(source.records) ? structuredClone(source.records) : [];
  return {
    batchId: source.batchId,
    revision: integer(source.revision, "REVISION_INVALID", 0, Number.MAX_SAFE_INTEGER),
    currentDayIndex: integer(source.currentDayIndex, "CURRENT_DAY_INVALID", 0, endAge - startAge),
    selectedMode: feedingMode(config.selectedMode),
    sop,
    devicePlan,
    modelInput: {
      startAge,
      endAge,
      startWeight,
      headCount,
      records: records as ProductionPlanInput["records"],
      controlStartDay,
      dayAge: startAge + source.currentDayIndex,
      dilutionRatio: typeof config.dilutionRatio === "string" ? config.dilutionRatio : "水:粉=6:1",
      devicePowderPrecisionGrams: devicePlan.templates.timed_quantity.precisionGrams,
      programStartLocal: "09:00",
    },
    planStartDate: localDate(config.planStartDate, "PLAN_START_DATE_INVALID"),
    records,
  };
}

export function computeFrozenBatchDecision(
  context: FrozenBatchDecisionContext,
  dayIndex = context.currentDayIndex,
  revision = context.revision,
): CanonicalBatchDecision {
  const dayAge = context.modelInput.startAge + dayIndex;
  const firstDay = dayIndex === 0;
  if (!Number.isSafeInteger(dayIndex) || dayIndex < 0 || dayAge > context.modelInput.endAge) {
    fail("DAY_INDEX_INVALID");
  }
  const timedTemplate = context.devicePlan.templates.timed_quantity;
  const latest = context.records.at(-1);
  const controlStartDay = context.modelInput.controlStartDay ?? -1;
  const initialFreeFeedingBlockers = freeFeedingBlockers(context, dayIndex, latest);
  const requestedMode = firstDay
    ? "timed_quantity"
    : initialFreeFeedingBlockers.length > 0
      ? "timed_quantity"
      : context.selectedMode;
  const input: DayDecisionInput = {
    revision,
    batchId: context.batchId,
    dateLocal: addDays(context.planStartDate, dayIndex),
    calculationDate: addDays(context.planStartDate, dayIndex),
    sopVersion: context.sop.version,
    modelInput: { ...context.modelInput, dayAge },
    requestedMode,
    requestedStatus: "active",
    precisionGrams: timedTemplate.precisionGrams,
    creepFeedGradesLast3Days: latestGrades(context.records),
    milkControlActive: controlStartDay >= 0 && dayIndex >= controlStartDay,
    diarrheaGrades: typeof latest?.diarrheaGrade === "string" ? [latest.diarrheaGrade as DiarrheaGrade] : undefined,
    exceptionSignals: {
      refusal: latest?.feedingResponse === "refusal" || latest?.refusal === true,
      blockage: latest?.deviceStatus === "blocked" || latest?.blockage === true,
      probeContaminated: latest?.deviceStatus === "probe_contaminated" || latest?.probeContaminated === true,
    },
  };
  if (firstDay) {
    const sopConfig = context.sop.config;
    if (sopConfig.teachingProgramEnabled !== true || sopConfig.teachingFirstLocal !== "17:00" ||
        sopConfig.teachingIntervalHours !== 3 || sopConfig.teachingEndLocal !== "08:00") {
      fail("FIRST_DAY_PROGRAM_INVALID");
    }
    input.sop = {
      ...(typeof sopConfig.teachingDirectTotalPowderGrams === "number" && sopConfig.teachingDirectTotalPowderGrams > 0
        ? { directTotalPowderGrams: sopConfig.teachingDirectTotalPowderGrams } : {}),
      ...(typeof sopConfig.teachingPowderGramsPerTwenty === "number" && sopConfig.teachingPowderGramsPerTwenty > 0
        ? { powderGramsPerTwentyHeadsPerMeal: sopConfig.teachingPowderGramsPerTwenty } : {}),
      mealCount: 6,
    };
    input.teachingProgram = { enabled: true, firstTeachingLocal: "17:00", intervalHours: 3, endLocal: "08:00" };
  } else {
    const model = computeProductionPlan(input.modelInput);
    input.timedMealTimes = selectedTimedMealTimes(
      timedTemplate,
      Number(model.selectedDay.deviceProgram?.mealCount ?? timedTemplate.mealTimes.length),
    );
    input.freeWindows = structuredClone(context.devicePlan.templates.free_feeding.windows);
  }
  const decision = computeDayDecision(input);
  const outputBlockers = new Set(initialFreeFeedingBlockers);
  if (context.selectedMode === "free_feeding" && dayIndex > 0) {
    for (const action of decision.exceptionActions) {
      if (FREE_FEEDING_BLOCKERS.has(action.type)) outputBlockers.add(action.type);
    }
  }
  return {
    selectedMode: firstDay ? "timed_quantity" : context.selectedMode,
    effectiveMode: decision.setting.mode,
    sopRef: {
      templateId: context.sop.templateId,
      version: context.sop.version,
      sourceSha256: context.sop.sourceSha256,
      snapshotSha256: context.sop.snapshotSha256,
      collectionRevision: context.sop.collectionRevision,
      parserVersion: context.sop.parserVersion,
      embeddingModel: context.sop.embeddingModel,
    },
    devicePlanRef: { version: context.devicePlan.version, sha256: context.devicePlan.sha256 },
    freeFeedingBlockers: [...outputBlockers].sort(),
    decision,
  };
}

export function computeFrozenBatchCurve(
  context: FrozenBatchDecisionContext,
): {
  selected: CanonicalBatchDecision;
  selectedCurve: CanonicalBatchDecision[];
  timedQuantity: CanonicalBatchDecision[];
  freeFeeding: CanonicalBatchDecision[];
} {
  const days = Array.from(
    { length: context.modelInput.endAge - context.modelInput.startAge + 1 },
    (_, index) => index,
  );
  const originalMode = context.selectedMode;
  const timedQuantity = days.map((dayIndex) => computeFrozenBatchDecision(
    { ...context, selectedMode: "timed_quantity" }, dayIndex,
  ));
  const freeFeeding = days.map((dayIndex) => computeFrozenBatchDecision(
    { ...context, selectedMode: "free_feeding" }, dayIndex,
  ));
  const selectedList = originalMode === "free_feeding" ? freeFeeding : timedQuantity;
  return {
    selected: selectedList[context.currentDayIndex]!,
    selectedCurve: selectedList,
    timedQuantity,
    freeFeeding,
  };
}
