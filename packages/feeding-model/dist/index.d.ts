/**
 * 奶爸机 — 饲喂模型
 * =================
 *
 * P2-6 single-source feeding model authority.
 * Faithful TypeScript port of the baseline parity oracle `feeding-model.js`.
 * Behavior MUST be byte-identical to the baseline; do not improve or refactor.
 */
import type { PlanOptions, FeedingPlan, DailyRecord, ControlPlan, DailyStats, BatchInfo, TrainingExport } from './schema';
/** 体重标准（对应日龄的最低合格体重） */
export declare const WEIGHT_STANDARD: Record<number, number>;
/** 内部固定参数 */
export declare const INTERNAL: {
    fcr: number;
    dilution: number;
    stomachMlPerKg: number;
    safetyFactor: number;
    creepEq: number;
    ramp: {
        d1: number;
        d2: number;
        d3: number;
        d4Plus: number;
    };
};
export declare const CREEP_GRADE_VALUES: Readonly<Record<string, number>>;
export declare const CREEP_GRADE_ORDER: readonly string[];
export declare const CREEP_MEAL_FLOORS: Readonly<Record<string, number>>;
/** 验证批次参数，不通过则抛错 */
export declare function validateBatchConfig(opts: PlanOptions): void;
export declare function getDailyCapacity(weightKg: number): number;
export declare function getRampFactor(dayIndex: number): number;
/** 奶粉 → 增重 (kg) */
export declare function milkToGain(milkG: number): number;
export declare function generatePlan(opts: PlanOptions): FeedingPlan;
export declare function computeControlPlan(plan: FeedingPlan, records: DailyRecord[], controlStartDay?: number | undefined): ControlPlan;
/** 从每日记录计算衍生字段 */
export declare function computeDailyStats(record: DailyRecord): DailyStats;
/** 批次结束时输出训练数据 */
export declare function exportTrainingData(batchInfo: BatchInfo): TrainingExport;
