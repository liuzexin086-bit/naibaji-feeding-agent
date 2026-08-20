"use strict";
/**
 * 奶爸机 — 饲喂模型
 * =================
 *
 * P2-6 single-source feeding model authority.
 * Faithful TypeScript port of the baseline parity oracle `feeding-model.js`.
 * Behavior MUST be byte-identical to the baseline; do not improve or refactor.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CREEP_MEAL_FLOORS = exports.CREEP_GRADE_ORDER = exports.CREEP_GRADE_VALUES = exports.INTERNAL = exports.WEIGHT_STANDARD = void 0;
exports.validateBatchConfig = validateBatchConfig;
exports.getDailyCapacity = getDailyCapacity;
exports.getRampFactor = getRampFactor;
exports.milkToGain = milkToGain;
exports.generatePlan = generatePlan;
exports.computeControlPlan = computeControlPlan;
exports.computeDailyStats = computeDailyStats;
exports.exportTrainingData = exportTrainingData;
/** 体重标准（对应日龄的最低合格体重） */
exports.WEIGHT_STANDARD = {
    3: 2.3, 4: 2.4, 5: 2.6, 6: 2.8, 7: 3.0,
    8: 3.2, 9: 3.4, 10: 3.6, 11: 3.8, 12: 4.0, 13: 4.2, 14: 4.4,
    15: 4.6, 16: 4.8, 17: 5.0, 18: 5.2, 19: 5.4, 20: 5.6, 21: 5.8,
};
/** 内部固定参数 */
exports.INTERNAL = {
    fcr: 0.9,
    dilution: 6,
    stomachMlPerKg: 30,
    safetyFactor: 0.85,
    creepEq: 0.7, // 教槽营养当量
    ramp: { d1: 0.30, d2: 0.60, d3: 0.78, d4Plus: 0.85 },
};
// Operator-facing教槽档位 are deliberately discrete.  Keep these values in
// the protected model so every caller (UI, Worker and local Agent) uses the
// same deterministic mapping.
exports.CREEP_GRADE_VALUES = Object.freeze({
    none: 0,
    low: 10,
    medium: 45,
    high: 80,
    excellent: 130,
});
exports.CREEP_GRADE_ORDER = Object.freeze(['none', 'low', 'medium', 'high', 'excellent']);
exports.CREEP_MEAL_FLOORS = Object.freeze({
    none: 10,
    low: 9,
    medium: 8,
    high: 6,
    excellent: 4,
});
function creepValueFromRecord(record) {
    const label = record && (record.creepGrade ?? record.creep_grade);
    if (typeof label === 'string' && Object.prototype.hasOwnProperty.call(exports.CREEP_GRADE_VALUES, label)) {
        return exports.CREEP_GRADE_VALUES[label];
    }
    if (record && record.creepValue != null && Number.isFinite(Number(record.creepValue))) {
        const value = Number(record.creepValue);
        if (Object.values(exports.CREEP_GRADE_VALUES).includes(value))
            return value;
    }
    if (record && record.totalCreepG != null && Number(record.headCount) > 0) {
        const value = Number(record.totalCreepG) / Number(record.headCount);
        if (Number.isFinite(value))
            return value;
    }
    return null;
}
function creepGradeFromRecord(record) {
    const label = record && (record.creepGrade ?? record.creep_grade);
    if (typeof label === 'string' && exports.CREEP_GRADE_ORDER.includes(label))
        return label;
    const value = creepValueFromRecord(record);
    const exact = Object.entries(exports.CREEP_GRADE_VALUES).find(([, gradeValue]) => gradeValue === value);
    return exact ? exact[0] : 'none';
}
// “持续教槽”定义：最近三次现场观察中至少两次达到同一档或更高。
// 例如 low + medium 可持续触发 low；单次 high 不触发控奶。
function sustainedCreepGrade(grades) {
    const recent = grades.slice(-3);
    if (recent.length < 2)
        return 'none';
    for (let index = exports.CREEP_GRADE_ORDER.length - 1; index >= 1; index--) {
        const count = recent.filter((grade) => exports.CREEP_GRADE_ORDER.indexOf(grade) >= index).length;
        if (count >= 2)
            return exports.CREEP_GRADE_ORDER[index];
    }
    return 'none';
}
// ──────────────────────────────────────────────
// 输入验证
// ──────────────────────────────────────────────
/** 验证批次参数，不通过则抛错 */
function validateBatchConfig(opts) {
    const errors = [];
    if (opts.startAge == null || opts.startAge < 1 || opts.startAge > 30)
        errors.push('超早期断奶日龄须在 1-30 之间');
    if (opts.endAge == null || opts.endAge < 2 || opts.endAge > 30)
        errors.push('最终断奶日龄须在 2-30 之间');
    if (opts.startAge >= opts.endAge)
        errors.push('超早期断奶日龄必须小于最终断奶日龄');
    if (opts.startWeight == null || opts.startWeight <= 0)
        opts.startWeight = exports.WEIGHT_STANDARD[opts.startAge] || 2.3;
    if (opts.headCount == null || opts.headCount < 1)
        errors.push('断奶头数须大于 0');
    if (errors.length > 0)
        throw new Error('参数验证失败:\n' + errors.join('\n'));
}
// ──────────────────────────────────────────────
// 1. 胃容量 → 头均奶粉量
// ──────────────────────────────────────────────
function getDailyCapacity(weightKg) {
    return weightKg * exports.INTERNAL.stomachMlPerKg * exports.INTERNAL.safetyFactor * 12 / exports.INTERNAL.dilution;
}
function getRampFactor(dayIndex) {
    if (dayIndex === 0)
        return exports.INTERNAL.ramp.d1;
    if (dayIndex === 1)
        return exports.INTERNAL.ramp.d2;
    if (dayIndex === 2)
        return exports.INTERNAL.ramp.d3;
    return exports.INTERNAL.ramp.d4Plus;
}
/** 奶粉 → 增重 (kg) */
function milkToGain(milkG) {
    return milkG / (exports.INTERNAL.fcr * 1000);
}
/** 从抽样数组推算全群加权平均重 */
function computeWeightedAvg(weighSample) {
    if (!weighSample || weighSample.length === 0)
        return null;
    const total = weighSample.reduce((s, w) => s + w.avgKg * w.headCount, 0);
    const count = weighSample.reduce((s, w) => s + w.headCount, 0);
    return count > 0 ? Math.round(total / count * 1000) / 1000 : null;
}
// ──────────────────────────────────────────────
// 2. 基线计划生成
// ──────────────────────────────────────────────
function generatePlan(opts) {
    // 输入验证
    validateBatchConfig(opts);
    const startAge = opts.startAge;
    const endAge = opts.endAge;
    const startWeight = opts.startWeight;
    let weight = startWeight;
    const headCount = opts.headCount;
    const feedingDays = endAge - startAge; // 天数差
    // 所有天都有喂奶，包括最后一天
    const totalDays = feedingDays + 1; // 包含首尾
    const days = [];
    let totalMilkPlan = 0;
    for (let d = 0; d < totalDays; d++) {
        const dayAge = startAge + d;
        const cap = getDailyCapacity(weight);
        const ramp = getRampFactor(d);
        const perPigMilk = Math.round(cap * ramp);
        const totalMilk = perPigMilk * headCount;
        const gain = milkToGain(perPigMilk);
        totalMilkPlan += totalMilk;
        days.push({
            dayAge, dayIndex: d,
            weightStart: Math.round(weight * 1000) / 1000,
            perPigMilkPlan: perPigMilk,
            totalMilkPlan: totalMilk,
            dailyCapacity: Math.round(cap),
            rampFactor: ramp,
            weightEnd: Math.round((weight + gain) * 1000) / 1000,
        });
        weight += gain;
    }
    const finalWeight = days[days.length - 1].weightEnd;
    const standardWeight = exports.WEIGHT_STANDARD[endAge] || 4.4;
    // 缓存计划图表数据（避免前端每次重绘重新计算）
    const planMilkPP = days.map(d => d.perPigMilkPlan);
    const planMilkTotal = days.map(d => d.totalMilkPlan);
    return {
        days, headCount, planMilkPP, planMilkTotal,
        totalMilkPlanG: Math.round(totalMilkPlan),
        finalWeightPlan: finalWeight,
        feedingDays: totalDays,
        startAge, endAge, startWeight,
        standardWeight,
        perFeedingMilkPlan: days.map(d => Math.round(d.totalMilkPlan / 10)),
    };
}
// ──────────────────────────────────────────────
// 2b. 控奶计划计算（渐进递减）
// ──────────────────────────────────────────────
function computeControlPlan(plan, records, controlStartDay) {
    const nDays = plan.days.length;
    const headCount = plan.headCount;
    const planPPControl = plan.planMilkPP.slice();
    const planTotalControl = plan.planMilkTotal.slice();
    const feedTimes = new Array(nDays).fill(10);
    const perFeed = new Array(nDays).fill(null);
    // 构建教槽映射 & 已录天计划值。新合同只允许五个固定教槽档位；
    // totalCreepG 仍可被旧记录读取，但不能改变档位映射。
    const creepMap = {};
    const creepGradeMap = {};
    const committed = new Set();
    const committedPlans = {};
    for (let i = 0; i < records.length; i++) {
        const r = records[i];
        committed.add(r.dayAge);
        if (r.planPerPigAtCommit != null) {
            committedPlans[r.dayAge] = {
                perPig: r.planPerPigAtCommit,
                total: r.planTotalAtCommit,
                feedTimes: Math.max(1, Math.min(10, Number(r.feedTimesAtCommit) || 10)),
            };
        }
        const creepValue = creepValueFromRecord(r);
        if (creepValue != null) {
            creepMap[r.dayAge] = creepValue; // 转头均（固定档位值）
            creepGradeMap[r.dayAge] = creepGradeFromRecord(r);
        }
    }
    // 控奶只能由持续教槽触发，并从持续状态成立后的下一个计划日开始。
    const automaticGrades = [];
    let automaticStart = nDays;
    for (let i = 0; i < nDays; i++) {
        const dayAge = plan.days[i].dayAge;
        if (creepGradeMap[dayAge] !== undefined) {
            automaticGrades.push(creepGradeMap[dayAge]);
            if (automaticGrades.length > 3)
                automaticGrades.shift();
        }
        if (sustainedCreepGrade(automaticGrades) !== 'none') {
            automaticStart = Math.min(nDays, i + 1);
            break;
        }
    }
    const requestedControlStart = Number.isFinite(Number(controlStartDay)) && Number(controlStartDay) >= 0
        ? Math.max(0, Math.min(nDays, Number(controlStartDay)))
        : automaticStart;
    // Persisted server-owned startDay is the replay authority. The protected
    // model may discover the first automatic trigger, but it must not silently
    // move a persisted latch later when historical observations are revised.
    const resolvedControlStartDay = requestedControlStart;
    // Committed history itself must not violate INV-007. If old or hand-edited
    // data jumps upward after control has started, fail closed instead of hiding
    // the contradiction and generating a new executable future program.
    let previousCommittedCount = null;
    for (let i = resolvedControlStartDay; i < nDays; i++) {
        const dayAge = plan.days[i].dayAge;
        const committedCount = committedPlans[dayAge]?.feedTimes;
        if (committedCount == null)
            continue;
        if (previousCommittedCount !== null && committedCount > previousCommittedCount) {
            throw new Error('NBJ_CONTROL_HISTORY_NON_MONOTONIC');
        }
        previousCommittedCount = committedCount;
    }
    const creepGradeRolling = [];
    let currentCount = 10;
    let latestCreep = 0; // 最新录入的教槽值，用于补充日增重
    for (let i = 0; i < nDays; i++) {
        const d = plan.days[i];
        // 更新教槽滚动
        const hasCreep = creepGradeMap[d.dayAge] !== undefined;
        if (hasCreep) {
            creepGradeRolling.push(creepGradeMap[d.dayAge]);
            if (creepGradeRolling.length > 3)
                creepGradeRolling.shift();
            latestCreep = creepMap[d.dayAge]; // 保存最新教槽值
        }
        // 控奶前：10次，单次 = 原计划/10
        if (i < resolvedControlStartDay) {
            perFeed[i] = Math.round(d.perPigMilkPlan / 10 * 10) / 10;
            continue;
        }
        // 已录天用提交时的计划值（保持当时看到的版本）
        if (committed.has(d.dayAge)) {
            const cp = committedPlans[d.dayAge];
            if (cp) {
                planPPControl[i] = cp.perPig;
                planTotalControl[i] = cp.total;
                feedTimes[i] = Math.max(1, Math.min(10, cp.feedTimes));
                perFeed[i] = Math.round(cp.perPig / feedTimes[i] * 100) / 100;
                currentCount = Math.max(1, Math.min(10, cp.feedTimes));
            }
            else {
                // 旧记录没有提交值时的 fallback
                perFeed[i] = Math.round(d.perPigMilkPlan / 10 * 10) / 10;
            }
            continue;
        }
        const stableGrade = sustainedCreepGrade(creepGradeRolling);
        const mealFloor = exports.CREEP_MEAL_FLOORS[stableGrade];
        // 循环按日执行，因此每个未提交计划日最多只会减少一次。
        if (stableGrade !== 'none' && currentCount > mealFloor) {
            currentCount -= 1;
        }
        currentCount = Math.min(10, currentCount);
        feedTimes[i] = currentCount;
        // 计划头均 = min(原计划, 单次上限 × 配奶次数)
        const perFeedCap = d.dailyCapacity / 10;
        const adjustedPerPig = Math.round(perFeedCap * currentCount * 10) / 10;
        const finalPerPig = Math.min(d.perPigMilkPlan, adjustedPerPig);
        planPPControl[i] = finalPerPig;
        planTotalControl[i] = Math.round(finalPerPig * headCount);
        // 单次量 = 计划头均 / 配奶次数（不额外取整，保证乘回去一致）
        perFeed[i] = Math.round(finalPerPig / currentCount * 100) / 100;
    }
    // Final INV-007 validation over the complete visible plan.
    for (let i = resolvedControlStartDay + 1; i < feedTimes.length; i++) {
        const previous = feedTimes[i - 1];
        const current = feedTimes[i];
        if (current > previous) {
            throw new Error('NBJ_CONTROL_HISTORY_NON_MONOTONIC');
        }
        if (previous - current > 1) {
            throw new Error('NBJ_CONTROL_HISTORY_STEP_INVALID');
        }
    }
    // 构建控奶后的完整 days（含体重 cascade，含教槽营养）
    const ctrlDays = [];
    let ctrlW = plan.startWeight;
    for (let i = 0; i < nDays; i++) {
        const orig = plan.days[i];
        const milk = planPPControl[i];
        const totalMilk = planTotalControl[i];
        // 教槽营养：已录天用实际值，未录天用最近值
        const creepPP = creepMap[orig.dayAge] !== undefined ? creepMap[orig.dayAge] : latestCreep;
        const totalNutrition = milk + creepPP * exports.INTERNAL.creepEq;
        const gain = totalNutrition / (exports.INTERNAL.fcr * 1000);
        const ws = Math.round(ctrlW * 1000) / 1000;
        const we = Math.round((ctrlW + gain) * 1000) / 1000;
        ctrlDays.push({
            dayAge: orig.dayAge, dayIndex: i,
            weightStart: ws,
            perPigMilkPlan: milk,
            totalMilkPlan: totalMilk,
            dailyCapacity: orig.dailyCapacity,
            rampFactor: orig.rampFactor,
            weightEnd: we,
        });
        ctrlW += gain;
    }
    return {
        planMilkPPControl: planPPControl,
        planMilkTotalControl: planTotalControl,
        feedTimes,
        perFeed,
        days: ctrlDays,
        controlStartDay: resolvedControlStartDay,
    };
}
// ──────────────────────────────────────────────
// 3. 每日实际录入数据模型
// ──────────────────────────────────────────────
/** 从每日记录计算衍生字段 */
function computeDailyStats(record) {
    const hc = record.headCount != null ? record.headCount : 1;
    if (hc <= 0) {
        return { perPigMilkActual: 0, perPigCreepActual: 0, diarrheaRate: 0, diarrheaTotal: 0 };
    }
    const diarTotal = (record.diarrheaMild || 0) + (record.diarrheaModerate || 0) + (record.diarrheaSevere || 0);
    return {
        perPigMilkActual: record.totalMilkG / hc,
        perPigCreepActual: record.totalCreepG / hc,
        diarrheaRate: diarTotal / hc,
        diarrheaTotal: diarTotal,
    };
}
/** 批次结束时输出训练数据 */
function exportTrainingData(batchInfo) {
    const records = batchInfo.records || [];
    // 单次遍历计算所有汇总
    let totalDiarCases = 0, totalPigDays = 0, actualTotalMilk = 0, actualTotalCreep = 0;
    for (const r of records) {
        const hc = r.headCount != null ? r.headCount : 1;
        if (hc > 0)
            totalPigDays += hc;
        totalDiarCases += (r.diarrheaMild || 0) + (r.diarrheaModerate || 0) + (r.diarrheaSevere || 0);
        actualTotalMilk += r.totalMilkG || 0;
        actualTotalCreep += r.totalCreepG || 0;
    }
    const finalDiarrheaRate = totalPigDays > 0
        ? Math.round((totalDiarCases / totalPigDays) * 10000) / 100
        : 0;
    const headCount = batchInfo.headCount || 1;
    const avgPerPigMilk = actualTotalMilk / headCount;
    const avgPerPigCreep = actualTotalCreep / headCount;
    return {
        batch: {
            startAge: batchInfo.startAge,
            endAge: batchInfo.endAge,
            feedingDays: batchInfo.endAge - batchInfo.startAge + 1,
            startWeight: batchInfo.startWeight,
            headCount,
            sowParity: batchInfo.sowParity || null,
            litterSize: batchInfo.litterSize || null,
            healthStatus: batchInfo.healthStatus || null,
            farmRoom: batchInfo.farmRoom || null,
            plannedTotalMilkG: batchInfo.totalMilkPlanG,
            standardWeaningWeight: batchInfo.standardWeight || exports.WEIGHT_STANDARD[batchInfo.endAge] || 4.4,
        },
        dailyRecords: records.map(r => {
            const stats = computeDailyStats(r);
            const daily = {
                dayAge: r.dayAge,
                totalMilkG: r.totalMilkG,
                totalCreepG: r.totalCreepG,
                perPigMilkG: Math.round(stats.perPigMilkActual * 100) / 100,
                perPigCreepG: Math.round(stats.perPigCreepActual * 100) / 100,
                headCount: r.headCount,
                diarrheaMild: r.diarrheaMild || 0,
                diarrheaModerate: r.diarrheaModerate || 0,
                diarrheaSevere: r.diarrheaSevere || 0,
                dailyDiarrheaRate: Math.round(stats.diarrheaRate * 10000) / 100,
                death: r.death || 0,
                cull: r.cull || 0,
                minTemp: r.minTemp ?? null,
                maxTemp: r.maxTemp ?? null,
                avgTemp: r.avgTemp ?? null,
                minHum: r.minHum ?? null,
                maxHum: r.maxHum ?? null,
                avgHum: r.avgHum ?? null,
                dilution: r.dilution ?? null,
                waterType: r.waterType || null,
                medication: r.medication || null,
                actualMilkRecorded: r.actualMilkRecorded === true,
                executionStatus: r.executionStatus || 'normal',
                creepLevel: r.creepLevel ?? null,
                uniformityLevel: r.uniformityLevel ?? null,
                growthLevel: r.growthLevel ?? null,
                planPerPigAtCommit: r.planPerPigAtCommit ?? null,
                planTotalAtCommit: r.planTotalAtCommit ?? null,
                feedTimesAtCommit: r.feedTimesAtCommit ?? null,
            };
            if (r.weighSample && r.weighSample.length > 0) {
                daily.weighSamples = r.weighSample.map(w => ({
                    category: w.category,
                    avgKg: w.avgKg,
                    headCount: w.headCount,
                }));
                daily.weightedAvgKg = computeWeightedAvg(r.weighSample);
            }
            return daily;
        }),
        labels: {
            finalDiarrheaRate,
            totalMilkG: actualTotalMilk,
            totalCreepG: actualTotalCreep,
            avgPerPigMilkG: Math.round(avgPerPigMilk * 100) / 100,
            avgPerPigCreepG: Math.round(avgPerPigCreep * 100) / 100,
            pigDays: totalPigDays,
            totalDiarrheaCases: totalDiarCases,
        },
        exportedAt: new Date().toISOString(),
        version: 'naibaji-v2',
    };
}
