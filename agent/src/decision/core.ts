import { computeProductionPlan } from "../model/production-model.js";
import {
  assertNonOverlappingBusinessDayWindows,
  localMinute,
  remainingBusinessDayTimes,
} from "./business-day.js";
import type {
  CreepGrade,
  DayDecisionInput,
  DeviceSetting,
  DiarrheaAdjustmentInput,
  DiarrheaGrade,
  ExceptionAction,
  FeedingDecision,
  TimedMeal,
} from "../shared/agent-v2-contract.js";

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const GRADE_ORDER: CreepGrade[] = ["none", "low", "medium", "high", "excellent"];
const GRADE_VALUES: Record<CreepGrade, number> = {
  none: 0,
  low: 10,
  medium: 45,
  high: 80,
  excellent: 130,
};
const FIXED_TEACHING_TIMES = [
  "17:00",
  "20:00",
  "23:00",
  "02:00",
  "05:00",
  "08:00",
] as const;
export const FREE_FEEDING_SUGGESTED_MEAL_COUNT = 12;

function fail(code: string): never {
  throw new Error(`NBJ_DECISION_${code}`);
}

function finiteNonNegative(value: number, code: string): number {
  if (!Number.isFinite(value) || value < 0) fail(code);
  return value;
}

function positive(value: number, code: string): number {
  if (!Number.isFinite(value) || value <= 0) fail(code);
  return value;
}

function floorToPrecision(value: number, precision: number): number {
  const units = Math.floor((value + Number.EPSILON) / precision);
  return Number((units * precision).toFixed(10));
}

function minuteOfDay(value: string): number {
  return localMinute(value);
}

function defaultMealTimes(mealCount: number): string[] {
  const allowed = Array.from({ length: 24 }, (_, offset) => (9 + offset) % 24)
    .filter((hour) => hour !== 0 && hour !== 12)
    .map((hour) => `${String(hour).padStart(2, "0")}:00`);
  return Array.from({ length: mealCount }, (_, index) =>
    allowed[Math.floor((index * allowed.length) / mealCount)] ?? "02:00",
  );
}

function teachingTimes(
  firstTeachingLocal: string,
  intervalHours = 3,
  endLocal = "08:00",
): string[] {
  // The field remains in the input for compatibility, but the SOP fixes the
  // first-night device program and no caller may alter its six time points.
  minuteOfDay(firstTeachingLocal);
  minuteOfDay(endLocal);
  positive(intervalHours, "INVALID_TEACHING_INTERVAL");
  return [...FIXED_TEACHING_TIMES];
}

function allocate(total: number, times: string[], precision: number): TimedMeal[] {
  if (times.length === 0 || total === 0) return [];
  times.forEach(minuteOfDay);
  const safeTotal = floorToPrecision(total, precision);
  const base = floorToPrecision(safeTotal / times.length, precision);
  let remainingUnits = Math.round((safeTotal - base * times.length) / precision);
  return times.map((timeLocal) => {
    const powderGrams = Number(
      (base + (remainingUnits-- > 0 ? precision : 0)).toFixed(10),
    );
    return { timeLocal, powderGrams };
  });
}

export function creepGrade(powderGrams: number): CreepGrade {
  finiteNonNegative(powderGrams, "INVALID_CREEP_FEED");
  const exact = (Object.entries(GRADE_VALUES) as Array<[CreepGrade, number]>)
    .find(([, value]) => value === powderGrams);
  if (!exact) fail("INVALID_CREEP_FEED_GRADE_VALUE");
  return exact[0];
}

export function majorityCreepGrade(
  lastThreeDays: CreepGrade[] | number[] = [],
): CreepGrade {
  if (lastThreeDays.length === 0) return "none";
  const values = lastThreeDays.slice(-3);
  const areGrades = values.every(
    (value): value is CreepGrade =>
      typeof value === "string" && GRADE_ORDER.includes(value as CreepGrade),
  );
  const areGrams = values.every((value): value is number =>
    typeof value === "number" && Object.values(GRADE_VALUES).includes(value),
  );
  if (!areGrades && !areGrams) fail("INVALID_CREEP_GRADE_HISTORY");
  const grades: CreepGrade[] = areGrades ? values : values.map(creepGrade);
  if (grades.length < 2) return "none";
  // 持续状态：最近三次中至少两次达到候选档或更高。
  for (let index = GRADE_ORDER.length - 1; index >= 1; index -= 1) {
    const count = grades.filter((grade) => GRADE_ORDER.indexOf(grade) >= index).length;
    if (count >= 2) return GRADE_ORDER[index];
  }
  return "none";
}

function resolveSopTarget(input: DayDecisionInput, modelTotal: number): {
  target: number;
  source: DeviceSetting["source"];
  explanation: string;
  perMeal?: number;
  mealCount?: number;
} {
  const sop = input.sop;
  if (sop?.directTotalPowderGrams != null) {
    positive(sop.directTotalPowderGrams, "INVALID_SOP_DIRECT_TOTAL");
    return {
      target: sop.directTotalPowderGrams,
      source: "sop_direct",
      explanation: "采用最高优先级的 SOP 直接程序/日总粉量。",
      perMeal: sop.powderGramsPerMeal,
      mealCount: sop.mealCount,
    };
  }

  if (sop) {
    const mealCount = sop.mealCount;
    if (mealCount != null) positive(mealCount, "INVALID_SOP_MEAL_COUNT");
    let perMeal: number | undefined;
    if (sop.powderGramsPerMeal != null) {
      perMeal = positive(sop.powderGramsPerMeal, "INVALID_SOP_MEAL_AMOUNT");
    } else if (sop.powderGramsPerHeadPerMeal != null) {
      perMeal =
        positive(sop.powderGramsPerHeadPerMeal, "INVALID_SOP_HEAD_PARAMETER") *
        positive(input.modelInput.headCount, "INVALID_HEAD_COUNT");
    } else if (sop.powderGramsPerTwentyHeadsPerMeal != null) {
      perMeal =
        (positive(
          sop.powderGramsPerTwentyHeadsPerMeal,
          "INVALID_SOP_TWENTY_HEAD_PARAMETER",
        ) *
          positive(input.modelInput.headCount, "INVALID_HEAD_COUNT")) /
        20;
    }
    if (perMeal != null && mealCount != null) {
      return {
        target: perMeal * mealCount,
        source: "sop_indirect",
        explanation: "SOP 未给直接总量，按完整的单餐参数、有效头数和餐次推导总量。",
        perMeal,
        mealCount,
      };
    }
  }

  return {
    target: positive(modelTotal, "MODEL_TOTAL_UNAVAILABLE"),
    source: "production_model",
    explanation: "SOP 数量信息不足，回退到 feeding-model + V5-Lite。",
  };
}

function hasDiarrhea(grades: DiarrheaGrade[] = []): boolean {
  return grades.some((grade) => grade !== "none");
}

function exceptionActionsFor(
  input: DayDecisionInput,
  target: number,
  curveLimit: number,
): ExceptionAction[] {
  const actions: ExceptionAction[] = [];
  if (target > curveLimit) {
    actions.push({
      type: "curve_cap",
      severity: "urgent",
      title: "SOP 数量超过模型曲线",
      actions: [
        "暂停自动套用该数量。",
        "核对当前 SOP、头数和单餐量。",
        "由现场负责人确认是否覆盖模型曲线上限。",
      ],
      requiresHumanConfirmation: true,
    });
  }
  if (hasDiarrhea(input.diarrheaGrades)) {
    actions.push({
      type: "diarrhea",
      severity: "urgent",
      title: "记录到腹泻",
      actions: [
        "切换为定时定量。",
        "暂停常规增量，按腹泻调整预览重排剩余餐次。",
        "现场检查并按兽医/场区 SOP 处置。",
      ],
      requiresHumanConfirmation: true,
    });
  }
  if (input.exceptionSignals?.refusal) {
    actions.push({
      type: "refusal",
      severity: "urgent",
      title: "持续拒奶",
      actions: ["暂停常规加量。", "检查仔猪精神、腹部和奶槽，转人工处置。"],
      requiresHumanConfirmation: true,
    });
  }
  if (input.exceptionSignals?.blockage) {
    actions.push({
      type: "blockage",
      severity: "urgent",
      title: "设备堵塞",
      actions: ["停止继续下粉。", "清理出粉口/奶槽并确认设备恢复后再启用。"],
      requiresHumanConfirmation: true,
    });
  }
  if (input.exceptionSignals?.probeContaminated) {
    actions.push({
      type: "probe_contamination",
      severity: "urgent",
      title: "探头污染",
      actions: ["停止依据探头的自动调整。", "清洁探头并完成功能检查后人工确认。"],
      requiresHumanConfirmation: true,
    });
  }
  return actions;
}

export function computeDayDecision(input: DayDecisionInput): FeedingDecision {
  if (!input.batchId?.trim()) fail("BATCH_ID_REQUIRED");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dateLocal)) fail("INVALID_DATE_LOCAL");
  finiteNonNegative(input.revision, "INVALID_REVISION");
  const precision = positive(
    input.precisionGrams ?? input.modelInput.devicePowderPrecisionGrams ?? 1,
    "INVALID_PRECISION",
  );
  if ((input.freeWindows?.length ?? 0) > 8) fail("FREE_WINDOWS_LIMIT");
  if (input.freeWindows?.length) assertNonOverlappingBusinessDayWindows(input.freeWindows);

  const currentDayAge = input.modelInput.dayAge ?? input.modelInput.startAge;
  const recordedGrades = input.creepFeedGradesLast3Days;
  const modelRecords = [...(input.modelInput.records ?? [])];
  // A direct decision caller may provide only the compact last-three-grade
  // field.  Materialise those grades as model records so the protected model
  // still owns the control start and meal-count decision.
  if (recordedGrades?.length) {
    const existingAges = new Set(modelRecords.map((record) => Number(record.dayAge)));
    const firstAge = currentDayAge - recordedGrades.length;
    recordedGrades.forEach((grade, index) => {
      const dayAge = firstAge + index;
      if (existingAges.has(dayAge)) return;
      modelRecords.push({
        dayAge,
        creepGrade: grade,
        creepValue: GRADE_VALUES[grade],
        headCount: input.modelInput.headCount,
      });
    });
  }
  const model = computeProductionPlan({
    ...input.modelInput,
    dayAge: currentDayAge,
    records: modelRecords,
    devicePowderPrecisionGrams: precision,
  });
  const program = model.selectedDay.deviceProgram;
  if (!program) fail("MODEL_DAY_UNAVAILABLE");
  const curveLimit = positive(program.dailyPowderGrams, "MODEL_CURVE_UNAVAILABLE");
  const selected = resolveSopTarget(input, curveLimit);
  const safeDailyTotal = floorToPrecision(selected.target, precision);
  const exceptionActions = exceptionActionsFor(input, selected.target, curveLimit);
  const forcedTimed = exceptionActions.length > 0 || input.milkControlActive === true;
  const mode = forcedTimed ? "timed_quantity" : (input.requestedMode ?? "timed_quantity");

  let times: string[];
  if (input.teachingProgram?.enabled) {
    times = teachingTimes(
      input.teachingProgram.firstTeachingLocal,
      input.teachingProgram.intervalHours,
      input.teachingProgram.endLocal ?? "08:00",
    );
  } else if (input.timedMealTimes) {
    times = input.timedMealTimes;
  } else if (selected.source !== "production_model" && input.sop?.mealCount) {
    times = defaultMealTimes(Math.floor(input.sop.mealCount));
  } else {
    times = program.meals.map((meal) => meal.timeLocal);
  }
  const modelSinglePowder = floorToPrecision(
    positive(program.meals[0]?.powderGrams ?? 0, "MODEL_SINGLE_MEAL_UNAVAILABLE"),
    precision,
  );
  const referenceMealCount = Math.floor(
    selected.mealCount != null
      ? positive(selected.mealCount, "INVALID_SOP_MEAL_COUNT")
      : positive(program.mealCount, "INVALID_MODEL_MEAL_COUNT"),
  );
  const sopSingle = selected.perMeal != null
    ? floorToPrecision(positive(selected.perMeal, "INVALID_SOP_MEAL_AMOUNT"), precision)
    : undefined;
  const resolvedSinglePowderGrams = sopSingle ?? modelSinglePowder;
  let timedMeals: TimedMeal[] = [];
  if (mode === "timed_quantity") {
    if (selected.source === "production_model" || sopSingle != null) {
      // Model/SOP per-meal quantities are never reconstructed from a daily
      // total.  Every device event receives the same deterministic amount.
      timedMeals = times.map((timeLocal) => ({
        timeLocal,
        powderGrams: resolvedSinglePowderGrams,
      }));
    } else {
      // A direct SOP daily total without a per-meal quantity is the sole case
      // where the SOP itself requests allocation across its schedule.
      timedMeals = allocate(safeDailyTotal, times, precision);
    }
  }
  const singlePowderGrams = timedMeals[0]?.powderGrams ?? resolvedSinglePowderGrams;
  const programTotal = floorToPrecision(
    mode === "timed_quantity"
      ? timedMeals.reduce((sum, meal) => sum + meal.powderGrams, 0)
      : singlePowderGrams * referenceMealCount,
    precision,
  );
  const suggestedFreeFeedingDailyPowderGrams = mode === "free_feeding"
    ? floorToPrecision(
      floorToPrecision(curveLimit / FREE_FEEDING_SUGGESTED_MEAL_COUNT, precision) *
        FREE_FEEDING_SUGGESTED_MEAL_COUNT,
      precision,
    )
    : undefined;
  const status = input.requestedStatus === "active" ? "active" : "draft";
  const creepGradeInput = input.creepFeedGradesLast3Days !== undefined
    ? input.creepFeedGradesLast3Days
    : input.creepFeedGramsLast3Days;
  const sustainedGrade = majorityCreepGrade(creepGradeInput);
  const creepGradeInputSource = input.creepFeedGradesLast3Days !== undefined
    ? "recorded_grades"
    : input.creepFeedGramsLast3Days !== undefined
      ? "legacy_grams"
      : "not_recorded";
  const reasons = [selected.explanation];
  if (selected.target > curveLimit) reasons.push("SOP 目标量超过模型曲线，已生成现场人工确认处置。 ");
  if (forcedTimed) reasons.push("异常或控奶条件触发定时定量模式。 ");
  if (input.teachingProgram?.enabled) reasons.push("教奶程序持续至次日 08:00（含 08:00 餐）。");
  if (input.teachingProgram?.enabled && selected.source !== "production_model") {
    reasons.push("首日教奶量采用冻结 SOP，按实际 6 个教奶时间点形成设备程序。");
  } else if (input.teachingProgram?.enabled) {
    reasons.push("SOP 未提供可计算数量，回退到生产模型单次量。");
  }

  return {
    revision: input.revision,
    batchId: input.batchId,
    dateLocal: input.dateLocal,
    setting: {
      mode,
      dayAge: program.dayAge,
      dailyPowderGrams: input.teachingProgram?.enabled || selected.source === "production_model"
        ? programTotal
        : safeDailyTotal,
      singlePowderGrams: floorToPrecision(singlePowderGrams, precision),
      mealCount: mode === "timed_quantity" ? timedMeals.length : referenceMealCount,
      ...(suggestedFreeFeedingDailyPowderGrams !== undefined ? {
        suggestedDailyPowderGrams: suggestedFreeFeedingDailyPowderGrams,
        suggestedDailyMealCount: FREE_FEEDING_SUGGESTED_MEAL_COUNT,
      } : {}),
      timedMeals,
      freeWindows: mode === "free_feeding" ? [...(input.freeWindows ?? [])] : [],
      precisionGrams: precision,
      source: selected.source,
      estimatedAverageWeightKg: model.selectedDay.estimatedAverageWeightKg,
      estimatedEndWeightKg: model.selectedDay.estimatedEndWeightKg,
    },
    exceptionActions,
    evidence: {
      sopVersion: input.sopVersion,
      modelVersion: model.modelVersion,
      calculationDate: input.calculationDate ?? input.dateLocal,
      reasons: reasons.map((reason) => reason.trim()),
      inputs: {
        requestedMode: input.requestedMode ?? "timed_quantity",
        requestedStatus: input.requestedStatus ?? "draft",
        modelInput: structuredClone(input.modelInput),
        sop: structuredClone(input.sop ?? {}),
        creepFeedGradesLast3Days: [...(input.creepFeedGradesLast3Days ?? [])],
        creepFeedGramsLast3Days: [...(input.creepFeedGramsLast3Days ?? [])],
        diarrheaGrades: [...(input.diarrheaGrades ?? [])],
        exceptionSignals: structuredClone(input.exceptionSignals ?? {}),
        milkControlActive: input.milkControlActive ?? false,
      },
      steps: [
        {
          name: "quantity_authority",
          value: { source: selected.source, targetPowderGrams: selected.target },
          explanation: selected.explanation,
        },
        {
          name: "production_curve_limit",
          value: curveLimit,
          explanation: "同日 feeding-model + V5-Lite 标准曲线，仅作为现场异常核对基准。",
        },
        {
          name: "safe_rounding",
          value: safeDailyTotal,
          explanation: "向下按设备精度取整；SOP 数量优先，不静默截断超曲线目标。",
        },
        {
          name: "exception_actions",
          value: exceptionActions,
          explanation: "仅生成确定性现场处置，不输出风险分数、等级或预测。",
        },
        {
          name: "creep_sustained_grade",
          value: { grade: sustainedGrade, inputSource: creepGradeInputSource },
          explanation: "最近三次观察中至少两次达到同一档或更高才形成持续教槽状态。",
        },
        {
          name: "device_program",
          value: {
            mode,
            singlePowderGrams,
            referenceMealCount,
            modelSinglePowder,
            timedMeals,
            freeWindows: mode === "free_feeding" ? input.freeWindows ?? [] : [],
          },
          explanation: "自由采食最多八时段；模型单餐量直接来自 per-head-per-meal × 有效头数并按精度取整，程序总量再乘实际餐次。",
        },
        {
          name: "estimated_average_weight",
          value: {
            startKg: model.selectedDay.estimatedAverageWeightKg,
            endKg: model.selectedDay.estimatedEndWeightKg,
          },
          explanation: "按批次初重与生产模型增重曲线估算的当日群体均重。",
        },
        {
          name: "control_start",
          value: model.controlStartDay,
          explanation: "持续教槽成立的次日开始控奶；餐次只减不增、每天最多减一次，最高 10 餐。",
        },
      ],
    },
    status,
  };
}

function worstDiarrheaGrade(grades: DiarrheaGrade[]): DiarrheaGrade {
  if (grades.length === 0) fail("DIARRHEA_GRADES_REQUIRED");
  const order: DiarrheaGrade[] = ["none", "mild", "moderate", "severe"];
  return grades.reduce((worst, grade) =>
    order.indexOf(grade) > order.indexOf(worst) ? grade : worst,
  "none");
}

function observedLocalHourMinute(value: string): string {
  const match = value.match(/T(\d{2}):(\d{2})/u);
  if (!match) fail("INVALID_OBSERVED_AT");
  const zoneSuffix = /(?:Z|[+-]\d{2}:\d{2})$/u.test(value);
  if (!zoneSuffix) return `${match[1]!}:${match[2]!}`;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail("INVALID_OBSERVED_AT");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value ?? "";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "";
  return `${hour}:${minute}`;
}

function gradeTargetRatio(grade: DiarrheaGrade): number {
  return { none: 1, mild: 0.9, moderate: 0.75, severe: 0.5 }[grade];
}

export function previewDiarrheaAdjustment(
  input: DiarrheaAdjustmentInput,
): FeedingDecision {
  const observed = new Date(input.observedAt);
  if (!Number.isFinite(observed.getTime())) fail("INVALID_OBSERVED_AT");
  const actual = finiteNonNegative(
    input.cumulativePowderGrams,
    "INVALID_CUMULATIVE_POWDER",
  );
  const worstGrade = worstDiarrheaGrade(input.grades);
  const targetRatio = input.targetRatio ?? gradeTargetRatio(worstGrade);
  if (!Number.isFinite(targetRatio) || targetRatio < 0 || targetRatio > 1) {
    fail("INVALID_DIARRHEA_TARGET_RATIO");
  }
  const precision = input.decision.setting.precisionGrams;
  const adjustedDayCap = floorToPrecision(
    input.decision.setting.dailyPowderGrams * targetRatio,
    precision,
  );
  const remainingAllowance = floorToPrecision(
    Math.max(0, adjustedDayCap - actual),
    precision,
  );
  const observedTime = observedLocalHourMinute(input.observedAt);
  const remainingTimes = input.remainingMealTimes ??
    remainingBusinessDayTimes(
      input.decision.setting.timedMeals.map((meal) => meal.timeLocal),
      observedTime,
    );
  remainingTimes.forEach(minuteOfDay);
  const timedMeals = allocate(remainingAllowance, remainingTimes, precision);
  const adjustmentSteps = [
    {
      name: "diarrhea_grade",
      value: { grades: [...input.grades], worstGrade, targetRatio },
      explanation: "按最严重腹泻档位或显式 SOP/兽医比例确定当日调整上限。",
    },
    {
      name: "cumulative_actual_powder",
      value: actual,
      explanation: "使用设备累计实际下粉量，而不是计划量或估算量。",
    },
    {
      name: "remaining_allowance",
      value: { adjustedDayCap, cumulativePowderGrams: actual, remainingAllowance },
      explanation: "剩余额度 = 调整后当日上限 - 累计实际粉量，最低为 0，并向下按设备精度取整。",
    },
    {
      name: "remaining_timed_meals",
      value: timedMeals,
      explanation: "只在剩余定时餐中分配剩余额度，合计不超过剩余额度。",
    },
  ];

  return {
    ...input.decision,
    revision: input.decision.revision + 1,
    setting: {
      ...input.decision.setting,
      mode: "timed_quantity",
      dailyPowderGrams: remainingAllowance,
      singlePowderGrams: timedMeals.length
        ? Math.max(...timedMeals.map((meal) => meal.powderGrams))
        : 0,
      mealCount: timedMeals.length,
      timedMeals,
      freeWindows: [],
    },
    exceptionActions: [
      ...input.decision.exceptionActions.filter((action) => action.type !== "diarrhea"),
      {
        type: "diarrhea",
        severity: "urgent",
        title: `腹泻调整预览：${worstGrade}`,
        actions: [
          "暂停常规增量。",
          "按剩余额度设置定时定量餐。",
          "现场检查并按兽医/场区 SOP 处置。",
        ],
        requiresHumanConfirmation: true,
      },
    ],
    evidence: {
      ...input.decision.evidence,
      reasons: [
        ...input.decision.evidence.reasons,
        "腹泻调整仅为草案，必须人工审批后生效。",
      ],
      inputs: {
        ...input.decision.evidence.inputs,
        diarrheaAdjustment: {
          observedAt: input.observedAt,
          grades: [...input.grades],
          cumulativePowderGrams: actual,
          targetRatio,
        },
      },
      steps: [...input.decision.evidence.steps, ...adjustmentSteps],
    },
    status: "draft",
  };
}
