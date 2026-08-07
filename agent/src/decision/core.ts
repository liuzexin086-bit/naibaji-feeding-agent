import { computeProductionPlan } from "../model/production-model.js";
import {
  assertNonOverlappingBusinessDayWindows,
  hasActiveOrFutureBusinessDayWindow,
  localMinute,
  remainingBusinessDayTimes,
} from "./business-day.js";
import type {
  CreepGrade,
  DayDecisionInput,
  DeviceSetting,
  DeviceWindow,
  DiarrheaAdjustmentInput,
  DiarrheaAdjustmentResult,
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
  const mode = input.requestedMode ?? "timed_quantity";
  if (mode === "free_feeding" && !input.freeWindows?.length) {
    fail("FREE_WINDOWS_REQUIRED");
  }

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
  const modelMealCount = Math.floor(positive(program.mealCount, "INVALID_MODEL_MEAL_COUNT"));
  const freeDispenseLimit = mode === "free_feeding"
    ? Math.max(1, Math.min(modelMealCount, selected.mealCount ?? modelMealCount))
    : modelMealCount;
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
  const singlePowderGrams = mode === "free_feeding"
    ? selected.source === "sop_direct" && sopSingle == null
      ? floorToPrecision(safeDailyTotal / freeDispenseLimit, precision)
      : resolvedSinglePowderGrams
    : timedMeals[0]?.powderGrams ?? resolvedSinglePowderGrams;
  const programTotal = floorToPrecision(
    mode === "free_feeding"
      ? singlePowderGrams * freeDispenseLimit
      : timedMeals.reduce((sum, meal) => sum + meal.powderGrams, 0),
    precision,
  );
  if (
    mode === "free_feeding" &&
    (selected.source === "sop_direct" || selected.source === "sop_indirect") &&
    programTotal > safeDailyTotal
  ) {
    fail("SOP_QUANTITY_CONFLICT");
  }
  const suggestedFreeFeedingDailyPowderGrams = mode === "free_feeding"
    ? programTotal
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
      dailyPowderGrams: mode === "free_feeding" || input.teachingProgram?.enabled || selected.source === "production_model"
        ? programTotal
        : safeDailyTotal,
      singlePowderGrams: floorToPrecision(singlePowderGrams, precision),
      mealCount: mode === "timed_quantity" ? timedMeals.length : freeDispenseLimit,
      ...(mode === "free_feeding" ? { freeDispenseLimit } : {}),
      ...(suggestedFreeFeedingDailyPowderGrams !== undefined ? {
        suggestedDailyPowderGrams: suggestedFreeFeedingDailyPowderGrams,
        suggestedDailyMealCount: freeDispenseLimit,
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
            freeDispenseLimit: mode === "free_feeding" ? freeDispenseLimit : undefined,
            modelSinglePowder,
            timedMeals,
            freeWindows: mode === "free_feeding" ? input.freeWindows ?? [] : [],
          },
          explanation: "自由采食最多八时段；freeDispenseLimit 是当天最多标准配奶次数，程序总量严格等于单次下粉 × 配额；不按窗口数量推断餐次。",
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

function selectDiarrheaTarget(
  candidates: string[],
  priority: string[] | undefined,
): string {
  if (!priority || priority.length === 0) {
    fail("DIARRHEA_REDUCTION_SLOT_REQUIRED");
  }
  for (const slot of priority) {
    if (candidates.includes(slot)) return slot;
  }
  fail("DIARRHEA_REDUCTION_SLOT_REQUIRED");
}

function diarrheaTargetAlreadyHappened(target: string, observedAt: string): boolean {
  const observedLocal = observedLocalHourMinute(observedAt);
  return remainingBusinessDayTimes([target], observedLocal).length === 0;
}

function diarrheaAdjustedSetting(
  source: DeviceSetting,
  targetSlot: string,
): { setting: DeviceSetting; adjustedProgramTotal: number } {
  const precision = source.precisionGrams;
  if (source.mode === "free_feeding") {
    const freeDispenseLimit = source.freeDispenseLimit ?? source.mealCount;
    if (freeDispenseLimit <= 1) {
      fail("DIARRHEA_FREE_DISPENSE_LIMIT_MIN");
    }
    const adjustedLimit = freeDispenseLimit - 1;
    const adjustedProgramTotal = floorToPrecision(
      source.singlePowderGrams * adjustedLimit,
      precision,
    );
    return {
      setting: {
        ...source,
        dailyPowderGrams: adjustedProgramTotal,
        mealCount: adjustedLimit,
        freeDispenseLimit: adjustedLimit,
        freeWindows: [...source.freeWindows],
        ...(source.suggestedDailyPowderGrams !== undefined
          ? {
              suggestedDailyPowderGrams: adjustedProgramTotal,
            }
          : {}),
        ...(source.suggestedDailyMealCount !== undefined
          ? { suggestedDailyMealCount: adjustedLimit }
          : {}),
      },
      adjustedProgramTotal,
    };
  }

  const timedMeals = source.timedMeals.filter((meal) => meal.timeLocal !== targetSlot);
  if (timedMeals.length === source.timedMeals.length) {
    fail("DIARRHEA_REDUCTION_SLOT_REQUIRED");
  }
  const adjustedProgramTotal = timedMeals.reduce((sum, meal) => sum + meal.powderGrams, 0);
  const singlePowderGrams = timedMeals.length
    ? Math.max(...timedMeals.map((meal) => meal.powderGrams))
    : 0;
  return {
    setting: {
      ...source,
      dailyPowderGrams: adjustedProgramTotal,
      singlePowderGrams,
      mealCount: timedMeals.length,
      timedMeals,
    },
    adjustedProgramTotal,
  };
}

function futureDeliverableFor(
  setting: DeviceSetting,
  observedAt: string,
  remainingDeliverable: number,
): number {
  const observedLocal = observedLocalHourMinute(observedAt);
  if (setting.mode === "free_feeding") {
    if (!hasActiveOrFutureBusinessDayWindow(setting.freeWindows, observedLocal)) return 0;
    const units = Math.floor(remainingDeliverable / setting.singlePowderGrams);
    return floorToPrecision(units * setting.singlePowderGrams, setting.precisionGrams);
  }
  return setting.timedMeals
    .filter((meal) => remainingBusinessDayTimes([meal.timeLocal], observedLocal).length > 0)
    .reduce((sum, meal) => sum + meal.powderGrams, 0);
}

function diarrheaEvidenceDecision(
  decision: FeedingDecision,
  setting: DeviceSetting,
  input: DiarrheaAdjustmentInput,
  worstGrade: Exclude<DiarrheaGrade, "none">,
  targetSlot: string | null,
  targetAlreadyHappened: boolean,
  adjustedProgramTotal: number,
  remainingDeliverable: number,
  kind: Exclude<DiarrheaAdjustmentResult["kind"], "none">,
): FeedingDecision {
  const mode = setting.mode;
  const reason = kind === "manual_only"
    ? `腹泻${worstGrade}已转人工处置；不生成可执行设备方案。`
    : kind === "individual_intervention"
      ? `腹泻${worstGrade}按个体处置；隔离腹泻仔猪并对病猪控奶一次，整栏设备不变。`
      : mode === "free_feeding"
        ? `腹泻${worstGrade}按自由采食配额减一生成待确认整栏减量提案；窗口保持不变。`
        : `腹泻${worstGrade}按冻结 SOP 目标槽位生成待确认整栏减餐提案。`;
  const actionText = kind === "manual_only"
    ? "现场检查并按兽医/场区 SOP 处置；不自动生成设备方案。"
    : kind === "individual_intervention"
      ? "标记并隔离腹泻仔猪，病猪控奶一次；其他仔猪继续执行原饲喂程序。"
      : mode === "free_feeding"
        ? "自由采食最大配奶次数减一，需人工确认；不改变窗口和单次下粉，不自动应用。"
        : "按冻结 SOP 目标槽位整栏减少一次采食，需人工确认；不自动应用设备方案。";
  return {
    ...decision,
    revision: decision.revision + 1,
    setting,
    exceptionActions: [
      ...decision.exceptionActions.filter((action) => action.type !== "diarrhea"),
      {
        type: "diarrhea",
        severity: "urgent",
        title: `腹泻调整：${worstGrade}（${kind}）`,
        actions: [actionText, "现场检查并按兽医/场区 SOP 处置。"],
        requiresHumanConfirmation: true,
      },
    ],
    evidence: {
      ...decision.evidence,
      reasons: [...decision.evidence.reasons, reason],
      inputs: {
        ...decision.evidence.inputs,
        diarrheaAdjustment: {
          grades: [...input.grades],
          worstGrade,
          mode,
          targetSlot,
          targetAlreadyHappened,
          cumulativePowderGrams: input.cumulativePowderGrams,
          adjustedProgramTotal,
          remainingDeliverable,
        },
      },
      steps: [
        ...decision.evidence.steps,
        {
          name: "diarrhea_target_slot",
          value: {
            mode,
            targetSlot,
            targetAlreadyHappened,
            prioritySource: mode === "free_feeding" ? "free_quota" : "frozen_sop",
          },
          explanation: mode === "free_feeding"
            ? "自由采食中度腹泻只减少一次配奶配额，窗口不删除；不读取 freeReductionPriority。"
            : "目标槽位必须来自冻结 SOP reductionPriority，不自行选择替代餐次。",
        },
        {
          name: "diarrhea_cumulative_facts",
          value: {
            cumulativeActual: input.cumulativePowderGrams,
            adjustedProgramTotal,
            remainingDeliverable,
          },
          explanation: "累计量仅表示已发生事实；超过调整后总量时禁止生成可执行提案。",
        },
      ],
    },
    status: "draft",
  };
}

export function previewDiarrheaAdjustment(
  input: DiarrheaAdjustmentInput,
): DiarrheaAdjustmentResult {
  const worstGrade = worstDiarrheaGrade(input.grades);
  const cumulativeActual = input.cumulativePowderGrams === null
    ? null
    : finiteNonNegative(
        input.cumulativePowderGrams,
        "INVALID_DIARRHEA_CUMULATIVE",
      );
  const source = input.decision.setting;
  const sourceMode = source.mode;
  const originalDailyPowderGrams = source.dailyPowderGrams;
  if (worstGrade === "none") {
    return {
      kind: "none",
      worstGrade: null,
      decision: null,
      proposal: null,
      manualDispositionRequired: false,
      targetSlot: null,
      targetAlreadyHappened: false,
      adjustedProgramTotal: originalDailyPowderGrams,
      cumulativeActual,
      remainingDeliverable: Math.max(
        0,
        originalDailyPowderGrams - (cumulativeActual ?? 0),
      ),
      futureDeliverable: futureDeliverableFor(
        source,
        input.observedAt,
        Math.max(0, originalDailyPowderGrams - (cumulativeActual ?? 0)),
      ),
      affectsWholePen: false,
      isolateAffectedPiglets: false,
      affectedPigletMilkControlCount: 0,
      deviceAdjustmentRequired: false,
      requiresHumanConfirmation: false,
      requiresManualDisposition: false,
      reason: "最近腹泻档位为无，不生成腹泻调整。",
      evidence: { grades: [...input.grades], worstGrade: "none" },
    };
  }

  if (worstGrade === "mild") {
    return {
      kind: "individual_intervention",
      worstGrade,
      decision: null,
      proposal: null,
      manualDispositionRequired: true,
      targetSlot: null,
      targetAlreadyHappened: false,
      adjustedProgramTotal: originalDailyPowderGrams,
      cumulativeActual,
      remainingDeliverable: Math.max(
        0,
        originalDailyPowderGrams - (cumulativeActual ?? 0),
      ),
      futureDeliverable: futureDeliverableFor(
        source,
        input.observedAt,
        Math.max(0, originalDailyPowderGrams - (cumulativeActual ?? 0)),
      ),
      affectsWholePen: false,
      isolateAffectedPiglets: true,
      affectedPigletMilkControlCount: 1,
      deviceAdjustmentRequired: false,
      requiresHumanConfirmation: false,
      requiresManualDisposition: true,
      reason: "轻度腹泻按个体处置：标记并隔离腹泻仔猪，病猪控奶一次；整栏设备程序保持不变。",
      evidence: {
        grades: [...input.grades],
        worstGrade,
        mode: sourceMode,
        affectsWholePen: false,
        isolateAffectedPiglets: true,
        affectedPigletMilkControlCount: 1,
        deviceAdjustmentRequired: false,
      },
    };
  }

  if (worstGrade === "severe") {
    return {
      kind: "manual_only",
      worstGrade,
      decision: null,
      proposal: null,
      manualDispositionRequired: true,
      targetSlot: null,
      targetAlreadyHappened: false,
      adjustedProgramTotal: originalDailyPowderGrams,
      cumulativeActual,
      remainingDeliverable: Math.max(
        0,
        originalDailyPowderGrams - (cumulativeActual ?? 0),
      ),
      futureDeliverable: futureDeliverableFor(
        source,
        input.observedAt,
        Math.max(0, originalDailyPowderGrams - (cumulativeActual ?? 0)),
      ),
      affectsWholePen: false,
      isolateAffectedPiglets: true,
      affectedPigletMilkControlCount: 0,
      deviceAdjustmentRequired: false,
      requiresHumanConfirmation: false,
      requiresManualDisposition: true,
      reason: "重度腹泻已转紧急人工处置：立即隔离明显腹泻仔猪，检查脱水/全身症状、环境和生物安全，并由现场负责人/兽医进行病因判断；不自动修改设备。",
      evidence: {
        grades: [...input.grades],
        worstGrade,
        mode: sourceMode,
        deviceAdjustmentRequired: false,
        isolateAffectedPiglets: true,
        manualDispositionRequired: true,
      },
    };
  }

  if (cumulativeActual === null) {
    return {
      kind: "manual_only",
      worstGrade,
      decision: null,
      proposal: null,
      manualDispositionRequired: true,
      targetSlot: null,
      targetAlreadyHappened: false,
      adjustedProgramTotal: originalDailyPowderGrams,
      cumulativeActual: null,
      remainingDeliverable: Math.max(0, originalDailyPowderGrams),
      futureDeliverable: futureDeliverableFor(
        source,
        input.observedAt,
        Math.max(0, originalDailyPowderGrams),
      ),
      affectsWholePen: true,
      isolateAffectedPiglets: false,
      affectedPigletMilkControlCount: 0,
      deviceAdjustmentRequired: false,
      requiresHumanConfirmation: false,
      requiresManualDisposition: true,
      reason: "中度腹泻已记录，但当前累计实际下粉量未知；请补录后重新评估，不生成可执行减餐提案。",
      evidence: {
        grades: [...input.grades],
        worstGrade,
        mode: sourceMode,
        cumulativePowderGrams: null,
        cumulativeMissing: true,
      },
    };
  }

  const mode = sourceMode;
  let targetSlot: string | null = null;
  let targetAlreadyHappened = false;
  let adjusted: ReturnType<typeof diarrheaAdjustedSetting>;
  if (mode === "free_feeding") {
    const baseLimit = source.freeDispenseLimit ?? source.mealCount;
    if (baseLimit <= 1) {
      return {
        kind: "manual_only",
        worstGrade,
        decision: null,
        proposal: null,
        manualDispositionRequired: true,
        targetSlot: null,
        targetAlreadyHappened: false,
        adjustedProgramTotal: originalDailyPowderGrams,
        cumulativeActual,
        remainingDeliverable: Math.max(0, originalDailyPowderGrams - cumulativeActual),
        futureDeliverable: 0,
        affectsWholePen: true,
        isolateAffectedPiglets: false,
        affectedPigletMilkControlCount: 0,
        deviceAdjustmentRequired: false,
        requiresHumanConfirmation: false,
        requiresManualDisposition: true,
        reason: `中度腹泻无法生成可执行减餐提案：自由采食基础配额 ${baseLimit} 已达下限，继续减量会产生 0 次配奶；转人工处置。`,
        evidence: {
          grades: [...input.grades],
          worstGrade,
          mode,
          code: "NBJ_DIARRHEA_FREE_DISPENSE_LIMIT_MIN",
          baseFreeDispenseLimit: baseLimit,
        },
      };
    }
    adjusted = diarrheaAdjustedSetting(source, "");
  } else {
    const candidates = source.timedMeals.map((meal) => meal.timeLocal);
    targetSlot = selectDiarrheaTarget(candidates, input.reductionPriority);
    targetAlreadyHappened = diarrheaTargetAlreadyHappened(targetSlot, input.observedAt);
    adjusted = diarrheaAdjustedSetting(source, targetSlot);
  }
  const remainingDeliverable = Math.max(
    0,
    adjusted.adjustedProgramTotal - cumulativeActual,
  );
  const futureDeliverable = futureDeliverableFor(
    adjusted.setting,
    input.observedAt,
    remainingDeliverable,
  );
  const manualFree = mode === "free_feeding" && futureDeliverable < source.singlePowderGrams;
  const manualTimed = mode === "timed_quantity" && (
    targetAlreadyHappened ||
    cumulativeActual >= adjusted.adjustedProgramTotal ||
    futureDeliverable > remainingDeliverable
  );

  if (manualFree || manualTimed) {
    return {
      kind: "manual_only",
      worstGrade,
      decision: null,
      proposal: null,
      manualDispositionRequired: true,
      targetSlot,
      targetAlreadyHappened,
      adjustedProgramTotal: adjusted.adjustedProgramTotal,
      cumulativeActual,
      remainingDeliverable,
      futureDeliverable,
      affectsWholePen: true,
      isolateAffectedPiglets: false,
      affectedPigletMilkControlCount: 0,
      deviceAdjustmentRequired: false,
      requiresHumanConfirmation: false,
      requiresManualDisposition: true,
      reason: mode === "free_feeding"
        ? `中度腹泻无法生成可执行减餐提案：调整后总量 ${adjusted.adjustedProgramTotal}g，累计实际 ${cumulativeActual}g，剩余可交付 ${remainingDeliverable}g，当前业务日已无可用自由采食窗口或可交付量；转人工处置。`
        : `中度腹泻无法生成可执行减餐提案：目标槽位 ${targetSlot}${targetAlreadyHappened ? "已发生" : ""}、累计量或剩余可交付不满足安全条件；转人工处置。`,
      evidence: {
        grades: [...input.grades],
        worstGrade,
        mode,
        targetSlot,
        targetAlreadyHappened,
        cumulativePowderGrams: cumulativeActual,
        adjustedProgramTotal: adjusted.adjustedProgramTotal,
        remainingDeliverable,
        futureDeliverable,
      },
    };
  }

  const decision = diarrheaEvidenceDecision(
      input.decision,
      adjusted.setting,
      input,
      worstGrade,
      targetSlot,
      targetAlreadyHappened,
      adjusted.adjustedProgramTotal,
      remainingDeliverable,
      "feeding_reduction_proposal",
    );
  const evidenceAdjustedTotal = adjusted.adjustedProgramTotal;
  const evidenceRemaining = remainingDeliverable;
  return {
    kind: "feeding_reduction_proposal",
    worstGrade,
    decision,
    proposal: decision.setting,
    manualDispositionRequired: false,
    targetSlot,
    targetAlreadyHappened,
    adjustedProgramTotal: evidenceAdjustedTotal,
    cumulativeActual,
    remainingDeliverable: evidenceRemaining,
    futureDeliverable,
    affectsWholePen: true,
    isolateAffectedPiglets: false,
    affectedPigletMilkControlCount: 0,
    deviceAdjustmentRequired: true,
    requiresHumanConfirmation: true,
    requiresManualDisposition: false,
    reason: mode === "free_feeding"
      ? `中度腹泻按自由采食配奶额度 ${source.freeDispenseLimit ?? source.mealCount} → ${adjusted.setting.freeDispenseLimit} 生成待确认减量提案；窗口保持不变，调整后整日程序总量 ${evidenceAdjustedTotal}g，累计实际 ${cumulativeActual}g，未来可交付 ${futureDeliverable}g。`
      : `中度腹泻按整栏减餐处理：目标槽位 ${targetSlot}，调整后整日程序总量 ${evidenceAdjustedTotal}g，累计实际 ${cumulativeActual}g，剩余可交付 ${evidenceRemaining}g，未来餐次计划 ${futureDeliverable}g；需独立人工确认后应用。`,
    evidence: {
      grades: [...input.grades],
      worstGrade,
      mode,
      targetSlot,
      targetAlreadyHappened,
      cumulativePowderGrams: cumulativeActual,
      adjustedProgramTotal: evidenceAdjustedTotal,
      remainingDeliverable: evidenceRemaining,
      futureDeliverable,
      affectsWholePen: true,
      deviceAdjustmentRequired: true,
      requiresHumanConfirmation: true,
    },
  };
}
