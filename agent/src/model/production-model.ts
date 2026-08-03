// The protected CommonJS models are copied into the Agent build context.
// Static imports let Wrangler bundle the same source for Workers while Node
// loads the same files from the Container image.
// @ts-expect-error The protected JavaScript model intentionally has no TS declarations.
import feedingModel from "../../container-models/feeding-model.cjs";
// @ts-expect-error The protected JavaScript model intentionally has no TS declarations.
import v5LiteModel from "../../container-models/v5lite-model.cjs";

export interface ProductionPlanInput {
  startAge: number;
  endAge: number;
  startWeight: number;
  headCount: number;
  records?: Array<Record<string, unknown>>;
  controlStartDay?: number;
  dayAge?: number;
  dilutionRatio?: string;
  devicePowderPrecisionGrams?: number;
  programStartLocal?: string;
}

export interface DeviceMealSetting {
  timeLocal: string;
  powderGrams: number;
}

export interface DeviceDayProgram {
  dayAge: number;
  dayIndex: number;
  dailyPowderGrams: number;
  mealCount: number;
  intervalMinutes: number;
  perHeadPerMealGrams: number | null;
  meals: DeviceMealSetting[];
}

export interface ProductionPlanOutput {
  modelVersion: string;
  calculationDate: string;
  basis: Record<string, unknown>;
  plan: ReturnType<FeedingModel["generatePlan"]>;
  control: ReturnType<FeedingModel["computeControlPlan"]>;
  deviceOperation: {
    mode: "equal_interval_program";
    powderPrecisionGrams: number;
    programStartLocal: string;
    configurationFields: Array<"powderGrams" | "timeLocal">;
    curve: DeviceDayProgram[];
    basis: string;
  };
  selectedDay: {
    dayIndex: number;
    planDay: (Record<string, unknown> & { dayAge: number; totalMilkPlan: number }) | undefined;
    totalMilkGrams: number | undefined;
    mealCount: number | undefined;
    perHeadPerMealGrams: number | undefined;
    v5Lite: Record<string, unknown> | null;
    deviceProgram: DeviceDayProgram | undefined;
  };
  /** Index of the first day on which model control is active. */
  controlStartDay: number;
}

export interface ModelDerivedMealAmount {
  powderGrams: number;
  dailyPowderGrams: number;
  mealCount: number;
  dayAge: number;
  calculationDate: string;
  modelVersion: string;
}

export function getModelDerivedMealAmount(
  output: ProductionPlanOutput,
  mealIndex = 0,
): ModelDerivedMealAmount {
  const program = output.selectedDay.deviceProgram;
  const meal = program?.meals[mealIndex] ?? program?.meals[0];
  if (!program || !meal || meal.powderGrams <= 0) {
    throw new Error("NBJ_PRODUCTION_MEAL_UNAVAILABLE");
  }
  return {
    powderGrams: meal.powderGrams,
    dailyPowderGrams: program.dailyPowderGrams,
    mealCount: program.mealCount,
    dayAge: program.dayAge,
    calculationDate: output.calculationDate,
    modelVersion: output.modelVersion,
  };
}

interface FeedingModel {
  generatePlan(input: ProductionPlanInput): {
    days: Array<Record<string, unknown> & { dayAge: number; totalMilkPlan: number }>;
    totalMilkPlanG: number;
    [key: string]: unknown;
  };
  computeControlPlan(
    plan: Record<string, unknown>,
    records: Array<Record<string, unknown>>,
    controlStartDay?: number,
  ): {
    planMilkPPControl: number[];
    planMilkTotalControl: number[];
    feedTimes: number[];
    perFeed: number[];
    controlStartDay?: number;
  };
}

interface V5Model {
  computeShadowAdjustment(
    planDay: Record<string, unknown>,
    record: Record<string, unknown>,
    batchInfo: Record<string, unknown>,
  ): Record<string, unknown>;
}

function floorToPrecision(value: number, precision: number): number {
  return Math.floor((value + Number.EPSILON) / precision) * precision;
}

const INITIAL_DEVICE_TIMES = [
  "10:00",
  "14:00",
  "16:00",
  "18:00",
  "20:00",
  "22:00",
  "02:00",
  "04:00",
  "06:00",
  "08:00",
] as const;

function deviceMealTimes(mealCount: number): string[] {
  if (mealCount === INITIAL_DEVICE_TIMES.length) return [...INITIAL_DEVICE_TIMES];
  if (mealCount <= 1) return [INITIAL_DEVICE_TIMES[0]];
  if (mealCount < INITIAL_DEVICE_TIMES.length) {
    return Array.from({ length: mealCount }, (_, index) => {
      const sourceIndex = Math.round(
        (index * (INITIAL_DEVICE_TIMES.length - 1)) / (mealCount - 1),
      );
      return INITIAL_DEVICE_TIMES[sourceIndex];
    });
  }
  const allowedHours = Array.from({ length: 24 }, (_, offset) => (9 + offset) % 24)
    .filter((hour) => hour !== 0 && hour !== 12)
    .map((hour) => `${String(hour).padStart(2, "0")}:00`);
  return Array.from({ length: mealCount }, (_, index) =>
    allowedHours[Math.floor((index * allowedHours.length) / mealCount)] ?? "02:00",
  );
}

function loadModels(): { feeding: FeedingModel; v5: V5Model } {
  return {
    feeding: feedingModel as FeedingModel,
    v5: v5LiteModel as V5Model,
  };
}

export function computeProductionPlan(input: ProductionPlanInput): ProductionPlanOutput {
  const { feeding, v5 } = loadModels();
  const plan = feeding.generatePlan(input);
  const records = input.records ?? [];
  const requestedControlStartDay = input.controlStartDay ?? -1;
  // A negative/omitted value means automatic control: the protected model
  // finds the first sustained creep state (two of the latest three observations
  // at the same grade or higher) and starts on the next day.
  // A non-negative value remains available for deterministic replay of a
  // previously committed plan.
  const effectiveControlStartDay = requestedControlStartDay >= 0
    ? requestedControlStartDay
    : undefined;
  const control = feeding.computeControlPlan(plan, records, effectiveControlStartDay);
  const dayIndex = input.dayAge == null
    ? 0
    : Math.max(0, plan.days.findIndex((day) => day.dayAge === input.dayAge));
  const planDay = plan.days[dayIndex] ?? plan.days[0];
  const record = records.find((item) => item.dayAge === planDay?.dayAge) ?? {};
  const shadow = planDay
    ? v5.computeShadowAdjustment(planDay, record, {
        startAge: input.startAge,
        startWeight: input.startWeight,
        headCount: input.headCount,
      })
    : null;
  const precision = Math.max(0.1, input.devicePowderPrecisionGrams ?? 1);
  const deviceCurve = plan.days.map((day, index) => {
    const mealCount = Math.max(1, Number(control.feedTimes[index] ?? 1));
    const mealTimes = deviceMealTimes(mealCount);
    const perHeadPerMealGrams = Number(control.perFeed[index] ?? 0);
    const regularPowderGrams = floorToPrecision(
      perHeadPerMealGrams * input.headCount,
      precision,
    );
    const dailyPowderGrams = floorToPrecision(
      regularPowderGrams * mealCount,
      precision,
    );
    const meals = Array.from({ length: mealCount }, (_, mealIndex) => {
      return {
        timeLocal: mealTimes[mealIndex] ?? "02:00",
        powderGrams: regularPowderGrams,
      };
    });
    return {
      dayAge: day.dayAge,
      dayIndex: index,
      dailyPowderGrams,
      mealCount,
      intervalMinutes: Math.round(1440 / mealCount),
      perHeadPerMealGrams,
      meals,
    };
  });

  return {
    modelVersion: "feeding-model+V5-Lite@2026-08-03-control-v2",
    calculationDate: new Date().toISOString().slice(0, 10),
    basis: {
      startAge: input.startAge,
      endAge: input.endAge,
      startWeight: input.startWeight,
      headCount: input.headCount,
      controlStartDay: requestedControlStartDay,
    },
    plan,
    control,
    deviceOperation: {
      mode: "equal_interval_program",
      powderPrecisionGrams: precision,
      programStartLocal: "09:00",
      configurationFields: ["powderGrams", "timeLocal"],
      curve: deviceCurve,
      basis:
        "feeding-model + V5-Lite 先计算单头单餐量；整栏单餐下粉量按单头单餐量乘有效头数并向下取设备精度，程序总量再由整栏单餐量乘实际餐次得到。计划窗口为当日 09:00 至次日 09:00；初始 10 餐，00:00 与 12:00 不下奶。",
    },
    selectedDay: {
      dayIndex,
      planDay,
      totalMilkGrams: control.planMilkTotalControl[dayIndex],
      mealCount: control.feedTimes[dayIndex],
      perHeadPerMealGrams: control.perFeed[dayIndex],
      v5Lite: shadow,
      deviceProgram: deviceCurve[dayIndex] ?? deviceCurve[0],
    },
    controlStartDay: Number(control.controlStartDay ?? (effectiveControlStartDay ?? plan.days.length)),
  };
}
