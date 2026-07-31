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
    controlStartDay: number,
  ): {
    planMilkPPControl: number[];
    planMilkTotalControl: number[];
    feedTimes: number[];
    perFeed: number[];
  };
}

interface V5Model {
  computeShadowAdjustment(
    planDay: Record<string, unknown>,
    record: Record<string, unknown>,
    batchInfo: Record<string, unknown>,
  ): Record<string, unknown>;
}

function roundToPrecision(value: number, precision: number): number {
  return Math.round((value + Number.EPSILON) / precision) * precision;
}

function localMinuteLabel(totalMinutes: number): string {
  const normalized = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(
    normalized % 60,
  ).padStart(2, "0")}`;
}

function programStartMinutes(value?: string): number {
  const match = String(value || "00:00").match(/^(\d{2}):(\d{2})$/);
  if (!match) return 0;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : 0;
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
  const effectiveControlStartDay =
    requestedControlStartDay >= 0 ? requestedControlStartDay : plan.days.length;
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
  const startMinutes = programStartMinutes(input.programStartLocal);
  const deviceCurve = plan.days.map((day, index) => {
    const mealCount = Math.max(1, Number(control.feedTimes[index] ?? 1));
    const dailyPowderGrams = Number(control.planMilkTotalControl[index] ?? 0);
    const regularPowderGrams = roundToPrecision(
      dailyPowderGrams / mealCount,
      precision,
    );
    const meals = Array.from({ length: mealCount }, (_, mealIndex) => {
      const powderGrams = mealIndex === mealCount - 1
        ? roundToPrecision(
            dailyPowderGrams - regularPowderGrams * (mealCount - 1),
            precision,
          )
        : regularPowderGrams;
      return {
        timeLocal: localMinuteLabel(startMinutes + (mealIndex * 1440) / mealCount),
        powderGrams,
      };
    });
    return {
      dayAge: day.dayAge,
      dayIndex: index,
      dailyPowderGrams,
      mealCount,
      intervalMinutes: Math.round(1440 / mealCount),
      perHeadPerMealGrams: control.perFeed[index],
      meals,
    };
  });

  return {
    modelVersion: "feeding-model+V5-Lite@2026-07-11",
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
      programStartLocal: input.programStartLocal || "00:00",
      configurationFields: ["powderGrams", "timeLocal"],
      curve: deviceCurve,
      basis:
        "feeding-model + V5-Lite 日总粉量和餐次；按设备精度分配到定时下奶点，末餐补齐取整差额。设备只需设置下粉量和下奶时间。",
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
  };
}
