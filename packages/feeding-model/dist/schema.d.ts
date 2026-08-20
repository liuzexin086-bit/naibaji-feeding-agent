/**
 * Feeding Model runtime schema (type-only).
 *
 * Faithful type mirror of the shapes produced/consumed by the baseline
 * `feeding-model.js` parity oracle. Type-only; no behavior lives here.
 */
/** Plan generation options (also mutated by validateBatchConfig for startWeight fallback). */
export interface PlanOptions {
    /** 超早期断奶日龄 (1-30). */
    startAge: number;
    /** 最终断奶日龄 (2-30, > startAge). */
    endAge: number;
    /** 初重 (kg). Defaulted from WEIGHT_STANDARD when null/<=0. */
    startWeight?: number | null;
    /** 断奶头数 (>0). */
    headCount: number;
}
/** One planned/day row produced by generatePlan / computeControlPlan days. */
export interface PlanDay {
    dayAge: number;
    dayIndex: number;
    weightStart: number;
    /** 头均计划奶粉 (g). */
    perPigMilkPlan: number;
    /** 总计划奶粉 (g) = perPig × headCount. */
    totalMilkPlan: number;
    dailyCapacity: number;
    rampFactor: number;
    weightEnd: number;
    isFeedingDay?: boolean;
}
/** Output of generatePlan. */
export interface FeedingPlan {
    days: PlanDay[];
    headCount: number;
    planMilkPP: number[];
    planMilkTotal: number[];
    /** 全期计划奶粉总量 (g). */
    totalMilkPlanG: number;
    /** 预计断奶体重 (kg). */
    finalWeightPlan: number;
    feedingDays: number;
    startAge: number;
    endAge: number;
    startWeight: number;
    standardWeight: number;
    perFeedingMilkPlan: number[];
}
/** A single daily actual record (DailyRecord). */
export interface DailyRecord {
    dayAge: number;
    /** 总配奶量 (g). */
    totalMilkG: number;
    /** 总教槽量 (g). */
    totalCreepG: number;
    /** 当前头数. */
    headCount?: number;
    diarrheaMild?: number;
    diarrheaModerate?: number;
    diarrheaSevere?: number;
    /** 样本称重 (kg/头, 可选). */
    sampleWeight?: number;
    /** Committed-plan fields consumed by computeControlPlan. */
    planPerPigAtCommit?: number | null;
    planTotalAtCommit?: number | null;
    feedTimesAtCommit?: number | null;
    /** Creep observation fields. */
    creepGrade?: string | null;
    creep_grade?: string | null;
    creepValue?: number | null;
    /** Miscellaneous pass-through fields for exportTrainingData. */
    death?: number;
    cull?: number;
    minTemp?: number | null;
    maxTemp?: number | null;
    avgTemp?: number | null;
    minHum?: number | null;
    maxHum?: number | null;
    avgHum?: number | null;
    dilution?: number | null;
    waterType?: string | null;
    medication?: string | null;
    actualMilkRecorded?: boolean;
    executionStatus?: string;
    creepLevel?: string | null;
    uniformityLevel?: string | null;
    growthLevel?: string | null;
    /** Weigh samples (optional). */
    weighSample?: WeighSample[];
}
/** A single weigh sample. */
export interface WeighSample {
    category?: string;
    avgKg: number;
    headCount: number;
}
/** Output of computeControlPlan. */
export interface ControlPlan {
    planMilkPPControl: number[];
    planMilkTotalControl: number[];
    feedTimes: number[];
    perFeed: (number | null)[];
    days: PlanDay[];
    controlStartDay: number;
}
/** Output of computeDailyStats. */
export interface DailyStats {
    perPigMilkActual: number;
    perPigCreepActual: number;
    diarrheaRate: number;
    diarrheaTotal: number;
}
/** Batch info consumed by exportTrainingData. */
export interface BatchInfo {
    records?: DailyRecord[];
    startAge: number;
    endAge: number;
    startWeight: number;
    headCount: number;
    totalMilkPlanG: number;
    standardWeight?: number;
    sowParity?: number | null;
    litterSize?: number | null;
    healthStatus?: string | null;
    farmRoom?: string | null;
}
/** Derived daily export row from exportTrainingData. */
export interface TrainingDailyRecord {
    dayAge: number;
    totalMilkG?: number;
    totalCreepG?: number;
    perPigMilkG: number;
    perPigCreepG: number;
    headCount?: number;
    diarrheaMild: number;
    diarrheaModerate: number;
    diarrheaSevere: number;
    dailyDiarrheaRate: number;
    death: number;
    cull: number;
    minTemp?: number | null;
    maxTemp?: number | null;
    avgTemp?: number | null;
    minHum?: number | null;
    maxHum?: number | null;
    avgHum?: number | null;
    dilution?: number | null;
    waterType?: string | null;
    medication?: string | null;
    actualMilkRecorded: boolean;
    executionStatus: string;
    creepLevel?: string | null;
    uniformityLevel?: string | null;
    growthLevel?: string | null;
    planPerPigAtCommit?: number | null;
    planTotalAtCommit?: number | null;
    feedTimesAtCommit?: number | null;
    weighSamples?: {
        category?: string;
        avgKg: number;
        headCount: number;
    }[];
    weightedAvgKg?: number | null;
}
/** Output of exportTrainingData. */
export interface TrainingExport {
    batch: {
        startAge: number;
        endAge: number;
        feedingDays: number;
        startWeight: number;
        headCount: number;
        sowParity: number | null;
        litterSize: number | null;
        healthStatus: string | null;
        farmRoom: string | null;
        plannedTotalMilkG: number;
        standardWeaningWeight: number;
    };
    dailyRecords: TrainingDailyRecord[];
    labels: {
        finalDiarrheaRate: number;
        totalMilkG: number;
        totalCreepG: number;
        avgPerPigMilkG: number;
        avgPerPigCreepG: number;
        pigDays: number;
        totalDiarrheaCases: number;
    };
    exportedAt: string;
    version: string;
}
