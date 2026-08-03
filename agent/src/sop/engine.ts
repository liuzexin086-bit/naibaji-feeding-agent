import type {
  DataQualityInput,
  LaggardCase,
  PlanSource,
  ProductionMealAmount,
  SopDeviation,
  SopRun,
  SopTask,
  SopTemplateSnapshot,
} from "./types.js";

export const PRODUCTION_MODEL_VERSION = "feeding-model+V5-Lite@2026-08-03-control-v2";
export const PRODUCTION_MODEL_HASH =
  "feeding-model:5378C5AAB45E1A4EFCEDEE8A258A6AC044824B69AD024553BA0FACFA72B8B94F;" +
  "v5lite:124385A11FD247013C7C4DD14FE95642DDEBF0B9621A797E72EB91794EC16EAE";

export const DEFAULT_SOP_TEMPLATE: Readonly<SopTemplateSnapshot> = Object.freeze({
  templateId: "naibaji-early-weaning",
  version: "2026.08.03-v6-first-day-sop",
  timezone: "Asia/Shanghai",
  utcOffsetMinutes: 480,
  defaultAdmissionDeadlineLocal: "09:00",
  preferredFirstTeachingLocal: "17:00",
  adaptationMinHours: 8,
  adaptationMaxHours: 10,
  teachingIntervalHours: 3,
  teachingLiquidMlPerHead: 10,
  teachingPowderGramsPerTwenty: 35,
  devicePowderPrecisionGrams: 1,
  teachingProgramEndDayOffset: 1,
  teachingProgramEndLocal: "08:00",
  teachingDirectTotalPowderGrams: 0,
  quantityAuthorityOrder: ["sop_direct", "sop_indirect", "production_model"] as const,
  modelQuantityFallbackEnabled: true,
  teachingQuantitySource: "sop",
  deviceConfigurationFields: ["powderGrams", "timeLocal"] as const,
  teachingLatestDay: 3,
  waterClosedBeforeAgeDays: 12,
  waterPolicyEnabled: true,
  teachingProgramEnabled: true,
  gentleMovementEnabled: true,
  laggardEvaluationEnabled: true,
  creepFeedEnabled: true,
  soakedFeedEnabled: true,
  transitionEnabled: true,
  maintenanceEnabled: true,
  productionProgramStartLocal: "09:00",
  initialMealCount: 10,
  excludedMealTimes: ["00:00", "12:00"] as const,
  customTasks: [],
  standardCleanEveryDays: 2,
  deepCleanEveryDays: 7,
  creepAgeStart: 8,
  creepAgeEnd: 11,
  soakedFeedAgeStart: 12,
  soakedFeedAgeEnd: 14,
  soakedFeedRatio: "4:1",
  transitionAgeStart: 20,
  transitionMealsMin: 2,
  transitionMealsMax: 3,
});

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function assertFinitePositive(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`NBJ_SOP_INVALID_${field.toUpperCase()}`);
  }
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function localDateKey(instant: Date, offsetMinutes: number): string {
  return new Date(instant.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

function localTimeToUtc(
  localDate: string,
  localTime: string,
  offsetMinutes: number,
): Date {
  const parsed = Date.parse(`${localDate}T${localTime}:00.000Z`);
  if (!Number.isFinite(parsed)) throw new Error("NBJ_SOP_INVALID_LOCAL_TIME");
  return new Date(parsed - offsetMinutes * 60_000);
}

export function computeFirstTeachingTime(
  admittedAt: string,
  template: SopTemplateSnapshot = DEFAULT_SOP_TEMPLATE,
): { firstTeachingAt: string; deviation?: SopDeviation } {
  const admission = new Date(admittedAt);
  if (!Number.isFinite(admission.getTime())) throw new Error("NBJ_SOP_INVALID_ADMISSION_TIME");

  const preferred = localTimeToUtc(
    localDateKey(admission, template.utcOffsetMinutes),
    "17:00",
    template.utcOffsetMinutes,
  );
  if (preferred.getTime() < admission.getTime()) {
    preferred.setUTCDate(preferred.getUTCDate() + 1);
  }
  return { firstTeachingAt: preferred.toISOString() };
}

export function roundToDevicePrecision(value: number, precision: number): number {
  assertFinitePositive(precision, "device_precision");
  return Math.round((value + Number.EPSILON) / precision) * precision;
}

export function computeSopMeal(
  activeHeadCount: number,
  modelMeal: ProductionMealAmount,
  template: SopTemplateSnapshot = DEFAULT_SOP_TEMPLATE,
  scheduledMealCount = 1,
  mealIndex = 0,
): {
  planSource: "sop_teaching";
  amountSource: "sop_direct_total" | "sop_indirect_total" | "production_model_fallback";
  quantityAuthority: "sop_direct" | "sop_indirect" | "production_model";
  powderGrams: number;
  dailyPowderGrams: number;
  mealCount: number;
  dayAge: number;
  activeHeadCount: number;
  sopVersion: string;
  modelVersion: string;
  calculationDate: string;
  quantityBasis: string;
  modelFallback: boolean;
} {
  assertFinitePositive(activeHeadCount, "head_count");
  assertFinitePositive(scheduledMealCount, "scheduled_meal_count");
  if (!Number.isInteger(mealIndex) || mealIndex < 0 || mealIndex >= scheduledMealCount) {
    throw new Error("NBJ_SOP_INVALID_MEAL_INDEX");
  }
  const precision = template.devicePowderPrecisionGrams;
  assertFinitePositive(precision, "device_precision");

  let amountSource: "sop_direct_total" | "sop_indirect_total" | "production_model_fallback";
  let quantityAuthority: "sop_direct" | "sop_indirect" | "production_model";
  let powderGrams: number;
  let dailyPowderGrams: number;
  let quantityBasis: string;

  if (template.teachingQuantitySource === "production_model") {
    assertFinitePositive(modelMeal.powderGrams, "model_meal_powder");
    powderGrams = roundToDevicePrecision(modelMeal.powderGrams, precision);
    dailyPowderGrams = powderGrams * scheduledMealCount;
    amountSource = "production_model_fallback";
    quantityAuthority = "production_model";
    quantityBasis = `教奶单次下粉量采用模型 ${powderGrams}g/次，共 ${scheduledMealCount} 次`;
  } else if (Number(template.teachingDirectTotalPowderGrams) > 0) {
    const resolvedTotal = roundToDevicePrecision(
      Number(template.teachingDirectTotalPowderGrams),
      precision,
    );
    const regularMeal = roundToDevicePrecision(resolvedTotal / scheduledMealCount, precision);
    powderGrams = mealIndex === scheduledMealCount - 1
      ? resolvedTotal - regularMeal * (scheduledMealCount - 1)
      : regularMeal;
    if (powderGrams <= 0) throw new Error("NBJ_SOP_DIRECT_TOTAL_TOO_SMALL");
    dailyPowderGrams = resolvedTotal;
    amountSource = "sop_direct_total";
    quantityAuthority = "sop_direct";
    quantityBasis = `SOP 直接给出教奶程序总粉量 ${resolvedTotal}g，按 ${scheduledMealCount} 餐和设备 ${precision}g 精度分配`;
  } else if (Number(template.teachingPowderGramsPerTwenty) > 0) {
    powderGrams = roundToDevicePrecision(
      activeHeadCount / 20 * Number(template.teachingPowderGramsPerTwenty),
      precision,
    );
    if (powderGrams <= 0) throw new Error("NBJ_SOP_INDIRECT_AMOUNT_TOO_SMALL");
    dailyPowderGrams = powderGrams * scheduledMealCount;
    amountSource = "sop_indirect_total";
    quantityAuthority = "sop_indirect";
    quantityBasis = `SOP ${template.teachingPowderGramsPerTwenty}g/20头/次 × ${activeHeadCount}头 × ${scheduledMealCount}餐，并按设备 ${precision}g 精度取整`;
  } else {
    if (template.modelQuantityFallbackEnabled === false) {
      throw new Error("NBJ_SOP_QUANTITY_UNRESOLVED");
    }
    assertFinitePositive(modelMeal.powderGrams, "model_meal_powder");
    assertFinitePositive(modelMeal.dailyPowderGrams, "model_daily_powder");
    assertFinitePositive(modelMeal.mealCount, "model_meal_count");
    powderGrams = roundToDevicePrecision(modelMeal.powderGrams, precision);
    dailyPowderGrams = powderGrams * scheduledMealCount;
    amountSource = "production_model_fallback";
    quantityAuthority = "production_model";
    quantityBasis = `SOP 无法直接或间接确定总量，使用 ${modelMeal.modelVersion} 单餐量并按 ${scheduledMealCount} 个实际排定餐次汇总`;
  }
  return {
    planSource: "sop_teaching",
    amountSource,
    quantityAuthority,
    powderGrams,
    dailyPowderGrams,
    mealCount: scheduledMealCount,
    dayAge: modelMeal.dayAge,
    activeHeadCount,
    sopVersion: template.version,
    modelVersion: modelMeal.modelVersion,
    calculationDate: modelMeal.calculationDate,
    quantityBasis,
    modelFallback: quantityAuthority === "production_model",
  };
}

export function teachingProgramEndAt(
  run: Pick<SopRun, "firstTeachingAt" | "admittedAt" | "template">,
): string {
  const firstTeachingAt = new Date(run.firstTeachingAt);
  if (!Number.isFinite(firstTeachingAt.getTime())) {
    throw new Error("NBJ_SOP_INVALID_FIRST_TEACHING_TIME");
  }
  const localDate = localDateKey(firstTeachingAt, run.template.utcOffsetMinutes);
  const localStartPseudoUtc = Date.parse(`${localDate}T00:00:00.000Z`);
  const endDayOffset = Math.max(
    0,
    Math.max(1, Math.floor(run.template.teachingProgramEndDayOffset ?? 1)),
  );
  const endTime = "08:00";
  const endTimeMatch = endTime.match(/^(\d{2}):(\d{2})$/);
  if (!endTimeMatch) throw new Error("NBJ_SOP_INVALID_TEACHING_END_TIME");
  const endMinutes = Number(endTimeMatch[1]) * 60 + Number(endTimeMatch[2]);
  if (endMinutes >= 1440) throw new Error("NBJ_SOP_INVALID_TEACHING_END_TIME");
  return toIso(
    localStartPseudoUtc +
      endDayOffset * DAY_MS +
      endMinutes * 60_000 -
      run.template.utcOffsetMinutes * 60_000,
  );
}

export function teachingProgramTimes(
  run: Pick<SopRun, "firstTeachingAt" | "admittedAt" | "template">,
): string[] {
  const firstMs = new Date(run.firstTeachingAt).getTime();
  const programEndMs = new Date(teachingProgramEndAt(run)).getTime();
  const intervalMs = run.template.teachingIntervalHours * HOUR_MS;
  if (!Number.isFinite(firstMs) || !Number.isFinite(programEndMs)) {
    throw new Error("NBJ_SOP_INVALID_TEACHING_PROGRAM_TIME");
  }
  assertFinitePositive(intervalMs, "teaching_interval");
  const times: string[] = [];
  for (let due = firstMs; due <= programEndMs; due += intervalMs) {
    times.push(toIso(due));
  }
  return times;
}

function taskId(runId: string, kind: string, scheduledAt: string, sequence: number): string {
  return `${runId}:${kind}:${scheduledAt}:${sequence}`;
}

function makeTask(
  run: Pick<SopRun, "id" | "batchId">,
  kind: SopTask["kind"],
  title: string,
  scheduledAt: string,
  sequence: number,
  planSource: PlanSource,
  extra: Partial<SopTask> = {},
): SopTask {
  const requiresConfirmation = extra.requiresConfirmation ?? true;
  return {
    id: taskId(run.id, kind, scheduledAt, sequence),
    runId: run.id,
    batchId: run.batchId,
    kind,
    title,
    scheduledAt,
    status: requiresConfirmation ? "pending" : "scheduled",
    planSource,
    sequence,
    requiresConfirmation,
    ...extra,
  };
}

export function startSopRun(input: {
  id: string;
  batchId: string;
  userId: string;
  admittedAt: string;
  activeHeadCount: number;
  dilutionRatio: string;
  modelMeal: ProductionMealAmount;
  template?: SopTemplateSnapshot;
  now?: string;
}): { run: SopRun; initialTasks: SopTask[]; deviations: SopDeviation[] } {
  const template = {
    ...structuredClone(input.template ?? DEFAULT_SOP_TEMPLATE),
    preferredFirstTeachingLocal: "17:00",
    teachingProgramEndDayOffset: 1,
    teachingProgramEndLocal: "08:00",
    teachingQuantitySource: "sop" as const,
    productionProgramStartLocal: "09:00",
  };
  const first = computeFirstTeachingTime(input.admittedAt, template);
  const now = input.now ?? new Date().toISOString();
  const run: SopRun = {
    id: input.id,
    batchId: input.batchId,
    userId: input.userId,
    template,
    modelVersion: PRODUCTION_MODEL_VERSION,
    modelHash: PRODUCTION_MODEL_HASH,
    dilutionRatio: input.dilutionRatio,
    phase: "adaptation",
    revision: 0,
    startedAt: now,
    admittedAt: new Date(input.admittedAt).toISOString(),
    firstTeachingAt: first.firstTeachingAt,
    activeHeadCount: input.activeHeadCount,
    status: "active",
  };
  const programTimes = teachingProgramTimes(run);
  const meal = computeSopMeal(
    input.activeHeadCount,
    input.modelMeal,
    template,
    programTimes.length,
    0,
  );
  const movementAt = toIso(new Date(first.firstTeachingAt).getTime());
  const initialTasks: SopTask[] = [];
  if (template.teachingProgramEnabled !== false) {
    initialTasks.push(
      makeTask(run, "teaching_meal", "首次教奶（设备程序）", first.firstTeachingAt, 1, "sop_teaching", {
        requiresConfirmation: false,
        numericPlan: {
          headCount: meal.activeHeadCount,
          powderGrams: meal.powderGrams,
          dailyPowderGrams: meal.dailyPowderGrams,
          mealCount: meal.mealCount,
          dayAge: meal.dayAge,
        },
        metadata: {
          executionMode: "device_program",
          amountSource: meal.amountSource,
          quantityAuthority: meal.quantityAuthority,
          quantityBasis: meal.quantityBasis,
          resolvedProgramTotalPowderGrams: meal.dailyPowderGrams,
          modelFallback: meal.modelFallback,
          modelVersion: meal.modelVersion,
          calculationDate: meal.calculationDate,
          deviceConfigurationFields: ["powderGrams", "timeLocal"],
          deviceAction: "设置下粉量和定时下奶时间，设备自动配奶",
        },
      }),
    );
  }
  if (template.gentleMovementEnabled !== false) {
    initialTasks.push(
      makeTask(
        run,
        "gentle_movement",
        "轻柔驱赶 10 分钟",
        movementAt,
        2,
        "sop_teaching",
        { metadata: { durationMinutes: 10, startsAfterTaskSequence: 1 } },
      ),
    );
  }
  return { run, initialTasks, deviations: first.deviation ? [first.deviation] : [] };
}

export function generateTeachingTasks(
  run: SopRun,
  through: string,
  modelMeal: ProductionMealAmount,
  startingSequence = 3,
): SopTask[] {
  if (run.template.teachingProgramEnabled === false) return [];
  const throughMs = new Date(through).getTime();
  const firstMs = new Date(run.firstTeachingAt).getTime();
  if (!Number.isFinite(throughMs) || throughMs < firstMs) return [];

  const forcedEvaluationAt =
    new Date(run.admittedAt).getTime() + run.template.teachingLatestDay * DAY_MS;
  const programEndMs = new Date(teachingProgramEndAt(run)).getTime();
  const endMs = Math.min(throughMs, programEndMs);
  const programTimes = teachingProgramTimes(run);
  const tasks: SopTask[] = [];
  let sequence = startingSequence;

  for (let mealIndex = 1; mealIndex < programTimes.length; mealIndex += 1) {
    const scheduledAt = programTimes[mealIndex];
    if (new Date(scheduledAt).getTime() > endMs) break;
    const meal = computeSopMeal(
      run.activeHeadCount,
      modelMeal,
      run.template,
      programTimes.length,
      mealIndex,
    );
    tasks.push(
      makeTask(run, "teaching_meal", "教奶循环（设备程序）", scheduledAt, sequence++, "sop_teaching", {
        requiresConfirmation: false,
        numericPlan: {
          headCount: meal.activeHeadCount,
          powderGrams: meal.powderGrams,
          dailyPowderGrams: meal.dailyPowderGrams,
          mealCount: meal.mealCount,
          dayAge: meal.dayAge,
        },
        metadata: {
          executionMode: "device_program",
          amountSource: meal.amountSource,
          quantityAuthority: meal.quantityAuthority,
          quantityBasis: meal.quantityBasis,
          resolvedProgramTotalPowderGrams: meal.dailyPowderGrams,
          modelFallback: meal.modelFallback,
          modelVersion: meal.modelVersion,
          calculationDate: meal.calculationDate,
          deviceConfigurationFields: ["powderGrams", "timeLocal"],
          deviceAction: "设置下粉量和定时下奶时间，设备自动配奶",
        },
      }),
    );
  }

  if (throughMs >= programEndMs) {
    const scheduledAt = toIso(programEndMs);
    tasks.push(
      makeTask(
        run,
        "inspection",
        "次日 08:00 早间巡栏并结束教奶",
        scheduledAt,
        sequence++,
        "sop_teaching",
        {
          metadata: {
            endsTeachingProgram: true,
            checks: ["精神状态", "主动到槽", "腹部饱满", "粪便", "掉队猪", "设备状态"],
          },
        },
      ),
    );
  }

  if (
    throughMs >= forcedEvaluationAt &&
    !run.majorityFeedsConfirmedAt &&
    run.template.laggardEvaluationEnabled !== false
  ) {
    const scheduledAt = toIso(forcedEvaluationAt);
    tasks.push(
      makeTask(
        run,
        "laggard_day3_evaluation",
        "第三天人工去留与教奶阶段评估",
        scheduledAt,
        sequence,
        "sop_teaching",
        { metadata: { blocksAutomaticExtension: true } },
      ),
    );
  }
  return tasks;
}

export function generateAgeTasks(
  run: SopRun,
  ageDays: number,
  localDayStart: string,
): SopTask[] {
  const due = new Date(localDayStart);
  if (!Number.isFinite(due.getTime())) throw new Error("NBJ_SOP_INVALID_DAY_START");
  const tasks: SopTask[] = [];
  let sequence = 1;
  if (
    run.template.creepFeedEnabled !== false &&
    ageDays >= run.template.creepAgeStart &&
    ageDays <= run.template.creepAgeEnd
  ) {
    tasks.push(makeTask(run, "creep_feed", "奶粉拌干教槽料", due.toISOString(), sequence++, "sop_transition"));
  }
  if (
    run.template.soakedFeedEnabled !== false &&
    ageDays >= run.template.soakedFeedAgeStart &&
    ageDays <= run.template.soakedFeedAgeEnd
  ) {
    tasks.push(
      makeTask(run, "milk_soaked_feed", "奶泡料", due.toISOString(), sequence++, "sop_transition", {
        numericPlan: { feedRatio: run.template.soakedFeedRatio },
      }),
    );
  }
  if (run.template.transitionEnabled !== false && ageDays >= run.template.transitionAgeStart) {
    tasks.push(
      makeTask(run, "transition_feed", "断奶过渡建议", due.toISOString(), sequence++, "sop_transition", {
        numericPlan: { mealCount: run.template.transitionMealsMax },
        metadata: {
          requiresConfirmedIntakeBodyAndStool: true,
          mealCountRange: [
            run.template.transitionMealsMin,
            run.template.transitionMealsMax,
          ],
        },
      }),
    );
  }
  return tasks;
}

export function generateMaintenanceTasks(
  run: SopRun,
  dayNumber: number,
  localDayStart: string,
  batchEnded = false,
): SopTask[] {
  if (run.template.maintenanceEnabled === false) return [];
  const due = new Date(localDayStart).toISOString();
  const tasks: SopTask[] = [];
  let sequence = 1;
  if (dayNumber > 0 && dayNumber % run.template.standardCleanEveryDays === 0) {
    tasks.push(makeTask(run, "clean_water_cycle", "清水循环与奶槽清洗", due, sequence++, "sop_transition"));
  }
  if (dayNumber > 0 && dayNumber % run.template.deepCleanEveryDays === 0) {
    tasks.push(makeTask(run, "deep_clean", "深度循环清洗", due, sequence++, "sop_transition"));
  }
  if (batchEnded) {
    tasks.push(
      makeTask(run, "batch_end_clean", "批次结束清洁与干燥防尘检查", due, sequence, "sop_transition", {
        metadata: {
          checklist: ["粉仓", "出粉口", "主机", "奶槽", "干燥", "防尘"],
        },
      }),
    );
  }
  return tasks;
}

export function generateWaterTasks(
  run: SopRun,
  startAgeDays: number,
  admittedAt: string,
  quality: DataQualityInput,
): { blocked: boolean; reasons: string[]; tasks: SopTask[] } {
  const reopenAgeDays = run.template.waterClosedBeforeAgeDays;
  if (!run.template.waterPolicyEnabled || startAgeDays >= reopenAgeDays) {
    return { blocked: false, reasons: [], tasks: [] };
  }
  const severeReasons = detectExceptionReasons(quality);
  const dehydrationRisk =
    quality.feedingResponse === "refusing" || quality.abdomenState === "hollow";
  const reasons = [
    ...severeReasons,
    ...(dehydrationRisk ? ["疑似脱水风险或持续拒奶，需人工重新确认给水策略"] : []),
  ];
  if (reasons.length > 0) return { blocked: true, reasons, tasks: [] };

  const admittedMs = new Date(admittedAt).getTime();
  if (!Number.isFinite(admittedMs)) throw new Error("NBJ_SOP_INVALID_ADMISSION_TIME");
  const closeAt = toIso(admittedMs);
  const restoreAt = toIso(admittedMs + (reopenAgeDays - startAgeDays) * DAY_MS);
  return {
    blocked: false,
    reasons: [],
    tasks: [
      makeTask(run, "water_close", "断奶入栏后关闭水嘴并记录操作人", closeAt, 1, "sop_teaching", {
        metadata: {
          keepClosedUntilAgeDays: reopenAgeDays,
          fieldPolicy: true,
        },
      }),
      makeTask(run, "water_restore", `${reopenAgeDays} 日龄恢复水嘴并记录操作人`, restoreAt, 2, "sop_teaching", {
        metadata: {
          reopenAgeDays,
          fieldPolicy: true,
        },
      }),
    ],
  };
}

export function generateCustomTasks(
  run: SopRun,
  startAgeDays: number,
): SopTask[] {
  const definitions = Array.isArray(run.template.customTasks)
    ? run.template.customTasks
    : [];
  return definitions.map((definition, index) => {
    if (
      !definition ||
      !Number.isFinite(definition.ageDay) ||
      !/^\d{2}:\d{2}$/.test(definition.localTime) ||
      !definition.title?.trim()
    ) {
      throw new Error("NBJ_SOP_INVALID_CUSTOM_TASK");
    }
    const localDate = localDateKey(
      new Date(
        new Date(run.admittedAt).getTime() +
          (definition.ageDay - startAgeDays) * DAY_MS,
      ),
      run.template.utcOffsetMinutes,
    );
    const scheduledAt = localTimeToUtc(
      localDate,
      definition.localTime,
      run.template.utcOffsetMinutes,
    ).toISOString();
    return makeTask(
      run,
      "custom",
      definition.title.trim(),
      scheduledAt,
      10_000 + index,
      definition.planSource ?? "sop_transition",
      {
        requiresConfirmation: definition.requiresConfirmation !== false,
        metadata: {
          customTask: true,
          ageDay: definition.ageDay,
          ...(definition.plannedValues ?? {}),
        },
      },
    );
  });
}

export function teachingCommittedPlan(tasks: SopTask[]): {
  planSource: "sop_teaching";
  mealCount: number;
  plannedPowderGrams: number;
} {
  const meals = tasks.filter(
    (task) => task.kind === "teaching_meal" && task.status !== "cancelled",
  );
  return {
    planSource: "sop_teaching",
    mealCount: meals.length,
    plannedPowderGrams: meals.reduce(
      (sum, task) => sum + (task.numericPlan?.powderGrams ?? 0),
      0,
    ),
  };
}

export function checkExecutionGap(input: {
  planSource: PlanSource;
  committedPlan: number;
  actual: number;
  submittedRevision: number;
  currentRevision: number;
}): {
  gap: number;
  gapRate: number | null;
  stale: boolean;
  code?: "NBJ_AGENT_STALE";
  semantics: string;
} {
  if (input.submittedRevision !== input.currentRevision) {
    return {
      gap: 0,
      gapRate: null,
      stale: true,
      code: "NBJ_AGENT_STALE",
      semantics: "提交所依据的批次 revision 已过期，必须重新计算后审批",
    };
  }
  const gap = Math.max(0, input.committedPlan - input.actual);
  return {
    gap,
    gapRate: input.committedPlan > 0 ? gap / input.committedPlan : null,
    stale: false,
    semantics:
      input.planSource === "sop_teaching"
        ? "仅与当前已排定教奶餐次合计对账，不与生产模型完整日计划比较"
        : "与提交时冻结的生产计划对账",
  };
}

export function detectExceptionReasons(input: DataQualityInput): string[] {
  const reasons: string[] = [];
  if (input.diarrhea === "severe") reasons.push("严重腹泻");
  if ((input.deaths ?? 0) > 0) reasons.push("死亡异常");
  if (input.feedingResponse === "refusing") reasons.push("持续拒奶");
  if (input.abdomenState === "hollow") reasons.push("明显腹部空瘪");
  if (input.deviceStatus === "blocked") reasons.push("设备堵塞");
  if (input.deviceStatus === "probe_contaminated") reasons.push("探头污染");
  if (input.deviceStatus === "offline") reasons.push("设备离线");
  return reasons;
}

export function checkDataQuality(input: DataQualityInput): {
  complete: boolean;
  missing: string[];
  exceptionMode: boolean;
  exceptionReasons: string[];
  mayDraftStandardDecision: boolean;
} {
  const missing: string[] = [];
  if (!Number.isFinite(input.headCount) || (input.headCount ?? 0) <= 0) missing.push("headCount");
  if (!Number.isFinite(input.averageWeightKg) || (input.averageWeightKg ?? 0) <= 0) {
    missing.push("averageWeightKg");
  }
  if (!input.feedingResponse) missing.push("feedingResponse");
  if (!input.abdomenState) missing.push("abdomenState");
  if (!input.diarrhea) missing.push("diarrhea");
  if (!input.deviceStatus) missing.push("deviceStatus");
  if (input.operatorConfirmed !== true) missing.push("operatorConfirmed");
  const exceptionReasons = detectExceptionReasons(input);
  return {
    complete: missing.length === 0,
    missing,
    exceptionMode: exceptionReasons.length > 0,
    exceptionReasons,
    mayDraftStandardDecision: missing.length === 0 && exceptionReasons.length === 0,
  };
}

export function createLaggardCase(input: {
  id: string;
  runId: string;
  pigTag: string;
  observedAt: string;
  notApproachingTrough: boolean;
  hollowAbdomen: boolean;
}): LaggardCase {
  if (!input.pigTag.trim()) throw new Error("NBJ_LAGGARD_TAG_REQUIRED");
  if (!input.notApproachingTrough && !input.hollowAbdomen) {
    throw new Error("NBJ_LAGGARD_OBSERVATION_REQUIRED");
  }
  return { ...input, supplementCount: 0, status: "open" };
}

export function recordLaggardSupplement(caseItem: LaggardCase): LaggardCase {
  if (caseItem.status !== "open") throw new Error("NBJ_LAGGARD_CASE_CLOSED");
  if (caseItem.supplementCount >= 3) throw new Error("NBJ_LAGGARD_SUPPLEMENT_REVIEW_REQUIRED");
  return { ...caseItem, supplementCount: caseItem.supplementCount + 1 };
}

export function evaluateLaggardDay3(
  caseItem: LaggardCase,
  outcome: "keep" | "return_to_sow",
): LaggardCase {
  return { ...caseItem, day3Outcome: outcome, status: outcome };
}
