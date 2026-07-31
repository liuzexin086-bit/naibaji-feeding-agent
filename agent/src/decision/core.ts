import { computeProductionPlan } from "../model/production-model.js";
import type {
  CreepGrade,
  DayDecisionInput,
  DeviceSetting,
  DiarrheaAdjustmentInput,
  DiarrheaGrade,
  FeedingDecision,
  RiskLevel,
  TimedMeal,
} from "../shared/agent-v2-contract.js";

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const GRADE_ORDER: CreepGrade[] = ["none", "low", "medium", "high"];

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
  if (!TIME_PATTERN.test(value)) fail("INVALID_LOCAL_TIME");
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function minuteLabel(minutes: number): string {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(
    normalized % 60,
  ).padStart(2, "0")}`;
}

function defaultMealTimes(mealCount: number): string[] {
  return Array.from({ length: mealCount }, (_, index) =>
    minuteLabel(Math.floor((index * 1440) / mealCount)),
  );
}

function teachingTimes(
  firstTeachingLocal: string,
  intervalHours = 3,
  endLocal = "08:00",
): string[] {
  const start = minuteOfDay(firstTeachingLocal);
  const end = minuteOfDay(endLocal) + 1440;
  const intervalMinutes = positive(intervalHours, "INVALID_TEACHING_INTERVAL") * 60;
  const times: string[] = [];
  for (let cursor = start; cursor <= end; cursor += intervalMinutes) {
    times.push(minuteLabel(cursor));
  }
  if (times.at(-1) !== endLocal) times.push(endLocal);
  return times;
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
  if (powderGrams === 0) return "none";
  if (powderGrams < 30) return "low";
  if (powderGrams < 70) return "medium";
  return "high";
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
  const areGrams = values.every((value): value is number => typeof value === "number");
  if (!areGrades && !areGrams) fail("INVALID_CREEP_GRADE_HISTORY");
  const grades: CreepGrade[] = areGrades ? values : values.map(creepGrade);
  const counts = new Map<CreepGrade, number>();
  grades.forEach((grade) => counts.set(grade, (counts.get(grade) ?? 0) + 1));
  const maximum = Math.max(...counts.values());
  const tied = new Set(
    GRADE_ORDER.filter((grade) => (counts.get(grade) ?? 0) === maximum),
  );
  // A 1-1-1 split has no literal majority; the latest observation is the
  // deterministic and least stale tie-breaker.
  return [...grades].reverse().find((grade) => tied.has(grade)) ?? "none";
}

function resolveSopTarget(input: DayDecisionInput, modelTotal: number): {
  target: number;
  source: DeviceSetting["source"];
  explanation: string;
} {
  const sop = input.sop;
  if (sop?.directTotalPowderGrams != null) {
    positive(sop.directTotalPowderGrams, "INVALID_SOP_DIRECT_TOTAL");
    return {
      target: sop.directTotalPowderGrams,
      source: "sop_direct",
      explanation: "采用最高优先级的 SOP 直接程序/日总粉量。",
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
      };
    }
  }

  return {
    target: positive(modelTotal, "MODEL_TOTAL_UNAVAILABLE"),
    source: "production_model",
    explanation: "SOP 数量信息不足，回退到 feeding-model + V5-Lite。",
  };
}

function riskFor(
  target: number,
  curveLimit: number,
  diarrhea: boolean,
): { level: RiskLevel; score: number; overCurveRatio: number; reasons: string[] } {
  const ratio = target / positive(curveLimit, "MODEL_CURVE_UNAVAILABLE");
  const reasons: string[] = [];
  let level: RiskLevel = "normal";
  let score = 0;
  if (ratio > 1.15) {
    level = "high";
    score = 100;
    reasons.push("权威目标量超过模型标准曲线 115%，禁止自动激活。 ");
  } else if (ratio > 1) {
    level = "elevated";
    score = 60;
    reasons.push("权威目标量超过模型标准曲线 100%，标记腹泻风险。 ");
  }
  if (diarrhea) {
    if (level === "normal") {
      level = "elevated";
      score = 60;
    }
    reasons.push("存在腹泻记录，强制使用定时定量模式。 ");
  }
  return { level, score, overCurveRatio: ratio, reasons: reasons.map((r) => r.trim()) };
}

function hasDiarrhea(grades: DiarrheaGrade[] = []): boolean {
  return grades.some((grade) => grade !== "none");
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
  input.freeWindows?.forEach((window) => {
    minuteOfDay(window.startLocal);
    minuteOfDay(window.endLocal);
  });

  const model = computeProductionPlan({
    ...input.modelInput,
    dayAge: input.modelInput.dayAge ?? input.modelInput.startAge,
    devicePowderPrecisionGrams: precision,
  });
  const program = model.selectedDay.deviceProgram;
  if (!program) fail("MODEL_DAY_UNAVAILABLE");
  const curveLimit = positive(program.dailyPowderGrams, "MODEL_CURVE_UNAVAILABLE");
  const selected = resolveSopTarget(input, curveLimit);
  const safeDailyTotal = floorToPrecision(Math.min(selected.target, curveLimit), precision);
  const diarrhea = hasDiarrhea(input.diarrheaGrades);
  const risk = riskFor(selected.target, curveLimit, diarrhea);
  const forcedTimed = diarrhea || input.milkControlActive === true || risk.level !== "normal";
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
  const timedMeals = mode === "timed_quantity" ? allocate(safeDailyTotal, times, precision) : [];
  const referenceMealCount = Math.floor(
    input.sop?.mealCount != null
      ? positive(input.sop.mealCount, "INVALID_SOP_MEAL_COUNT")
      : positive(program.mealCount, "INVALID_MODEL_MEAL_COUNT"),
  );
  const modelSingleCapacity = program.perHeadPerMealGrams == null
    ? Math.max(...program.meals.map((meal) => meal.powderGrams))
    : program.perHeadPerMealGrams * positive(input.modelInput.headCount, "INVALID_HEAD_COUNT");
  const singlePowderGrams = timedMeals.length > 0
    ? Math.max(...timedMeals.map((meal) => meal.powderGrams))
    : floorToPrecision(
        Math.min(safeDailyTotal / referenceMealCount, modelSingleCapacity),
        precision,
      );
  const status =
    input.requestedStatus === "active" && risk.level !== "high"
      ? "active"
      : "draft";
  const creepGradeInput = input.creepFeedGradesLast3Days !== undefined
    ? input.creepFeedGradesLast3Days
    : input.creepFeedGramsLast3Days;
  const majorityGrade = majorityCreepGrade(creepGradeInput);
  const creepGradeInputSource = input.creepFeedGradesLast3Days !== undefined
    ? "recorded_grades"
    : input.creepFeedGramsLast3Days !== undefined
      ? "legacy_grams"
      : "not_recorded";
  const reasons = [selected.explanation];
  if (selected.target > curveLimit) reasons.push("设置量已截断到模型标准曲线上限。 ");
  if (forcedTimed) reasons.push("风险、腹泻或控奶条件触发定时定量模式。 ");
  if (input.teachingProgram?.enabled) reasons.push("教奶程序持续至次日 08:00（含 08:00 餐）。");

  return {
    revision: input.revision,
    batchId: input.batchId,
    dateLocal: input.dateLocal,
    setting: {
      mode,
      dayAge: program.dayAge,
      dailyPowderGrams: safeDailyTotal,
      singlePowderGrams,
      mealCount: mode === "timed_quantity" ? timedMeals.length : referenceMealCount,
      timedMeals,
      freeWindows: mode === "free_feeding" ? [...(input.freeWindows ?? [])] : [],
      precisionGrams: precision,
      source: selected.source,
    },
    risk,
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
          explanation: "同日 feeding-model + V5-Lite 标准曲线作为设备设置上限。",
        },
        {
          name: "safe_rounding",
          value: safeDailyTotal,
          explanation: "向下按设备精度取整，且不超过权威目标量和模型曲线上限。",
        },
        {
          name: "risk_classification",
          value: risk,
          explanation: "按截断前目标量相对标准曲线的比例保留真实风险。",
        },
        {
          name: "creep_majority_grade",
          value: { grade: majorityGrade, inputSource: creepGradeInputSource },
          explanation: "优先按现场最近三天记录的 none/low/medium/high 档位取多数；平票取最近一天，旧克数记录仅作兼容转换。",
        },
        {
          name: "device_program",
          value: {
            mode,
            singlePowderGrams,
            referenceMealCount,
            modelSingleCapacity,
            timedMeals,
            freeWindows: mode === "free_feeding" ? input.freeWindows ?? [] : [],
          },
          explanation: "自由采食最多八时段，单次量按日总量/参考餐次向下取整且不超过模型单次胃容量；风险、腹泻和控奶均切换为定时定量。",
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
  const observedTime = input.observedAt.slice(11, 16);
  const remainingTimes = input.remainingMealTimes ??
    input.decision.setting.timedMeals
      .map((meal) => meal.timeLocal)
      .filter((time) => TIME_PATTERN.test(observedTime) && time > observedTime);
  remainingTimes.forEach(minuteOfDay);
  const timedMeals = allocate(remainingAllowance, remainingTimes, precision);
  const previousRisk = input.decision.risk;
  const riskLevel: RiskLevel = previousRisk.level === "high" ? "high" : "elevated";
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
    risk: {
      level: riskLevel,
      score: Math.max(60, previousRisk.score),
      overCurveRatio: previousRisk.overCurveRatio,
      reasons: [...previousRisk.reasons, `腹泻调整预览：最严重档位 ${worstGrade}。`],
    },
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
