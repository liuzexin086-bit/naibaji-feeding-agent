/**
 * 奶爸机 — 饲喂模型
 * =================
 *
 * 核心逻辑：
 *   初重 → 胃容量 → 渐进比例 → 计划头均奶粉量 → ×头数 → 计划总配奶量
 *   每日录入真实数据（总配奶、总教槽、腹泻细化、头数）
 *   → 计算头均实际采食 → 批次结束输出训练数据文件
 *
 * FCR 固定为内部参数（0.9），用户不可调
 * 后期用收集的真实数据训练深度学习模型
 */

/** 体重标准（对应日龄的最低合格体重） */
const WEIGHT_STANDARD = {
  3: 2.3, 4: 2.4, 5: 2.6, 6: 2.8, 7: 3.0,
  8: 3.2, 9: 3.4, 10: 3.6, 11: 3.8, 12: 4.0, 13: 4.2, 14: 4.4,
  15: 4.6, 16: 4.8, 17: 5.0, 18: 5.2, 19: 5.4, 20: 5.6, 21: 5.8,
}

/** 内部固定参数 */
const INTERNAL = {
  fcr: 0.9,
  dilution: 6,
  stomachMlPerKg: 30,
  safetyFactor: 0.85,
  creepEq: 0.7,      // 教槽营养当量
  ramp: { d1: 0.30, d2: 0.60, d3: 0.78, d4Plus: 0.85 },
}

// Operator-facing教槽档位 are deliberately discrete.  Keep these values in
// the protected model so every caller (UI, Worker and local Agent) uses the
// same deterministic mapping.
const CREEP_GRADE_VALUES = Object.freeze({
  none: 0,
  low: 10,
  medium: 45,
  high: 80,
  excellent: 130,
})

function creepValueFromRecord(record) {
  const label = record && (record.creepGrade ?? record.creep_grade)
  if (typeof label === 'string' && Object.prototype.hasOwnProperty.call(CREEP_GRADE_VALUES, label)) {
    return CREEP_GRADE_VALUES[label]
  }
  if (record && record.creepValue != null && Number.isFinite(Number(record.creepValue))) {
    const value = Number(record.creepValue)
    if (Object.values(CREEP_GRADE_VALUES).includes(value)) return value
  }
  if (record && record.totalCreepG != null && Number(record.headCount) > 0) {
    const value = Number(record.totalCreepG) / Number(record.headCount)
    if (Number.isFinite(value)) return value
  }
  return null
}

// ──────────────────────────────────────────────
// 输入验证
// ──────────────────────────────────────────────

/** 验证批次参数，不通过则抛错 */
function validateBatchConfig(opts) {
  const errors = []
  if (opts.startAge == null || opts.startAge < 1 || opts.startAge > 30)
    errors.push('超早期断奶日龄须在 1-30 之间')
  if (opts.endAge == null || opts.endAge < 2 || opts.endAge > 30)
    errors.push('最终断奶日龄须在 2-30 之间')
  if (opts.startAge >= opts.endAge)
    errors.push('超早期断奶日龄必须小于最终断奶日龄')
  if (opts.startWeight == null || opts.startWeight <= 0)
    opts.startWeight = WEIGHT_STANDARD[opts.startAge] || 2.3
  if (opts.headCount == null || opts.headCount < 1)
    errors.push('断奶头数须大于 0')
  if (errors.length > 0) throw new Error('参数验证失败:\n' + errors.join('\n'))
}

// ──────────────────────────────────────────────
// 1. 胃容量 → 头均奶粉量
// ──────────────────────────────────────────────

function getDailyCapacity(weightKg) {
  return weightKg * INTERNAL.stomachMlPerKg * INTERNAL.safetyFactor * 12 / INTERNAL.dilution
}

function getRampFactor(dayIndex) {
  if (dayIndex === 0) return INTERNAL.ramp.d1
  if (dayIndex === 1) return INTERNAL.ramp.d2
  if (dayIndex === 2) return INTERNAL.ramp.d3
  return INTERNAL.ramp.d4Plus
}

/** 奶粉 → 增重 (kg) */
function milkToGain(milkG) {
  return milkG / (INTERNAL.fcr * 1000)
}

/** 从抽样数组推算全群加权平均重 */
function computeWeightedAvg(weighSample) {
  if (!weighSample || weighSample.length === 0) return null
  const total = weighSample.reduce((s, w) => s + w.avgKg * w.headCount, 0)
  const count = weighSample.reduce((s, w) => s + w.headCount, 0)
  return count > 0 ? Math.round(total / count * 1000) / 1000 : null
}

// ──────────────────────────────────────────────
// 2. 基线计划生成
// ──────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {number} opts.startAge - 超早期断奶日龄
 * @param {number} opts.endAge - 最终断奶日龄
 * @param {number} opts.startWeight - 初重 (kg)
 * @param {number} opts.headCount - 断奶头数
 * @returns {{
 *   days: Array<{
 *     dayAge, dayIndex, weightStart,
 *     perPigMilkPlan: number,     // 头均计划奶粉(g)
 *     totalMilkPlan: number,      // 总计划奶粉(g) = perPig × headCount
 *     dailyCapacity, rampFactor,
 *     weightEnd, isFeedingDay,
 *   }>,
 *   totalMilkPlanG: number,       // 全期计划奶粉总量
 *   finalWeightPlan: number,      // 预计断奶体重(kg)
 *   feedingDays: number,
 *   startAge, endAge, startWeight, headCount,
 * }}
 */
function generatePlan(opts) {
  // 输入验证
  validateBatchConfig(opts)

  const startAge = opts.startAge
  const endAge = opts.endAge
  const startWeight = opts.startWeight
  let weight = startWeight
  const headCount = opts.headCount
  const feedingDays = endAge - startAge  // 天数差
  // 所有天都有喂奶，包括最后一天
  const totalDays = feedingDays + 1  // 包含首尾
  const days = []
  let totalMilkPlan = 0

  for (let d = 0; d < totalDays; d++) {
    const dayAge = startAge + d
    const cap = getDailyCapacity(weight)
    const ramp = getRampFactor(d)
    const perPigMilk = Math.round(cap * ramp)
    const totalMilk = perPigMilk * headCount
    const gain = milkToGain(perPigMilk)
    totalMilkPlan += totalMilk

    days.push({
      dayAge, dayIndex: d,
      weightStart: Math.round(weight * 1000) / 1000,
      perPigMilkPlan: perPigMilk,
      totalMilkPlan: totalMilk,
      dailyCapacity: Math.round(cap),
      rampFactor: ramp,
      weightEnd: Math.round((weight + gain) * 1000) / 1000,
    })
    weight += gain
  }

  const finalWeight = days[days.length - 1].weightEnd
  const standardWeight = WEIGHT_STANDARD[endAge] || 4.4

  // 缓存计划图表数据（避免前端每次重绘重新计算）
  const planMilkPP = days.map(d => d.perPigMilkPlan)
  const planMilkTotal = days.map(d => d.totalMilkPlan)

  return {
    days, headCount, planMilkPP, planMilkTotal,
    totalMilkPlanG: Math.round(totalMilkPlan),
    finalWeightPlan: finalWeight,
    feedingDays: totalDays,
    startAge, endAge, startWeight,
    standardWeight,
    perFeedingMilkPlan: days.map(d => Math.round(d.totalMilkPlan / 10)),
  }
}


// ──────────────────────────────────────────────
// 2b. 控奶计划计算（渐进递减）
// ──────────────────────────────────────────────

/**
 * 控奶逻辑：教槽决定启动值和递减间隔，每日检查日增重保护。
 *
 * 启动次数：
 *   教槽3日均值 ≥70g → 从 8 次/天开始递减
 *   30g ≤ 均值 < 70g → 从 10 次/天
 *   均值 < 30g → 从 11 次/天
 *
 * 递减间隔（教槽决定递减速度）：
 *   ≥70g → 每 1 天减 1 次
 *   30-70g → 每 2 天减 1 次
 *   <30g → 每 3 天减 1 次
 *
 * 日增重保护（每次减前检查）：
 *   预测日增重 = 实际可喝量 / FCR
 *   如果 < 180g 则停止减少
 *   如果单次量 > 胃容量 × 85%，按胃容量上限倒推实际可喝量
 *
 * 下限 2 次/天。
 *
 * @param {object} plan - generatePlan() 输出
 * @param {Array} records - 每日实际记录
 * @param {number|undefined} controlStartDay - 控奶开启的天索引；省略时由首个非 none 教槽记录决定
 * @returns {{ planMilkPPControl, planMilkTotalControl, feedTimes, perFeed, controlStartDay }}
 */
function computeControlPlan(plan, records, controlStartDay) {
  const nDays = plan.days.length
  const headCount = plan.headCount
  const planPPControl = plan.planMilkPP.slice()
  const planTotalControl = plan.planMilkTotal.slice()
  const feedTimes = new Array(nDays).fill(10)
  const perFeed = new Array(nDays).fill(null)

  // 构建教槽映射 & 已录天计划值。新合同只允许五个固定教槽档位；
  // totalCreepG 仍可被旧记录读取，但不能改变档位映射。
  const creepMap = {}
  const committed = new Set()
  const committedPlans = {}
  let firstNonNoneDayAge = null
  for (let i = 0; i < records.length; i++) {
    const r = records[i]
    committed.add(r.dayAge)
    if (r.planPerPigAtCommit != null) {
      committedPlans[r.dayAge] = {
        perPig: r.planPerPigAtCommit,
        total: r.planTotalAtCommit,
        feedTimes: r.feedTimesAtCommit || 10,
      }
    }
    const creepValue = creepValueFromRecord(r)
    if (creepValue != null) {
      creepMap[r.dayAge] = creepValue  // 转头均（固定档位值）
      const label = r.creepGrade ?? r.creep_grade
      const nonNone = label
        ? label !== "none"
        : creepValue > CREEP_GRADE_VALUES.none
      if (nonNone && (firstNonNoneDayAge == null || r.dayAge < firstNonNoneDayAge)) {
        firstNonNoneDayAge = Number(r.dayAge)
      }
    }
  }

  // The first non-none observation fixes the start permanently at the next
  // batch day.  An explicit non-negative value is used only for replay of a
  // previously committed schedule.
  const automaticStart = firstNonNoneDayAge == null
    ? nDays
    : Math.max(0, Math.min(nDays, firstNonNoneDayAge + 1 - plan.startAge))
  const resolvedControlStartDay = Number.isFinite(Number(controlStartDay)) && Number(controlStartDay) >= 0
    ? Math.max(0, Math.min(nDays, Number(controlStartDay)))
    : automaticStart

  const creepRolling = []
  let started = false
  let currentCount = 10
  let interval = 3   // 无教槽时默认每3天减1次（低教槽）
  let lastReductionDay = -1
  let latestCreep = 0  // 最新录入的教槽值，用于补充日增重

  // 根据教槽均值获取启动参数
  function getStartParams(avg) {
    if (avg >= 70) return { start: 8, intv: 1 }
    if (avg >= 30) return { start: 10, intv: 2 }
    return { start: 11, intv: 3 }
  }

  // 更新控奶参数（基于教槽数据或默认值）
  function updateControlParams() {
    if (creepRolling.length > 0) {
      const avg = creepRolling.reduce((a, b) => a + b, 0) / creepRolling.length
      const p = getStartParams(avg)
      currentCount = p.start
      interval = p.intv
    } else {
      // No non-none grade means normal 10-meal feeding.  Automatic control
      // does not start until an observation provides a real signal.
      currentCount = 10
    }
  }

  // 检查是否可以减少到 targetCount
  function canReduceTo(targetCount, dailyCap, originalPlan, dayAge) {
    if (targetCount < 2) return false
    const perFeedCap = dailyCap / 10
    const totalFromFormula = perFeedCap * targetCount
    const effectiveTotal = Math.min(originalPlan, totalFromFormula)
    // 预计日增重 = (奶粉 + 教槽×0.7) / FCR
    const creepForDay = creepMap[dayAge] || latestCreep
    const totalNutrition = effectiveTotal + creepForDay * INTERNAL.creepEq
    const predictedGain = totalNutrition / INTERNAL.fcr  // 预测日增重(g)
    return predictedGain >= 180
  }

  for (let i = 0; i < nDays; i++) {
    const d = plan.days[i]

    // 更新教槽滚动
    const hasCreep = creepMap[d.dayAge] !== undefined
    if (hasCreep) {
      creepRolling.push(creepMap[d.dayAge])
      if (creepRolling.length > 3) creepRolling.shift()
      latestCreep = creepMap[d.dayAge]  // 保存最新教槽值
    }

    // 控奶前：10次，单次 = 原计划/10
    if (i < resolvedControlStartDay) {
      perFeed[i] = Math.round(d.perPigMilkPlan / 10 * 10) / 10
      continue
    }

    // 控奶开启日：确定启动参数
    if (!started) {
      started = true
      updateControlParams()
      lastReductionDay = d.dayAge
    }

    // 逐日检查教槽数据更新，有数据时重新设参数
    if (hasCreep) {
      updateControlParams()
    }

    // 逐日检查是否到减少时机
    if (currentCount > 2) {
      const daysSinceReduction = d.dayAge - lastReductionDay
      if (daysSinceReduction >= interval) {
        const targetCount = currentCount - 1
        if (canReduceTo(targetCount, d.dailyCapacity, d.perPigMilkPlan, d.dayAge)) {
          currentCount = targetCount
          lastReductionDay = d.dayAge
        }
      }
    }

    feedTimes[i] = currentCount

    // 已录天用提交时的计划值（保持当时看到的版本）
    if (committed.has(d.dayAge)) {
      const cp = committedPlans[d.dayAge]
      if (cp) {
        planPPControl[i] = cp.perPig
        planTotalControl[i] = cp.total
        feedTimes[i] = cp.feedTimes
        perFeed[i] = Math.round(cp.perPig / cp.feedTimes * 100) / 100
      } else {
        // 旧记录没有提交值时的 fallback
        perFeed[i] = Math.round(d.perPigMilkPlan / 10 * 10) / 10
      }
      continue
    }

    // 计划头均 = min(原计划, 单次上限 × 配奶次数)
    const perFeedCap = d.dailyCapacity / 10
    const adjustedPerPig = Math.round(perFeedCap * currentCount * 10) / 10
    const finalPerPig = Math.min(d.perPigMilkPlan, adjustedPerPig)
    planPPControl[i] = finalPerPig
    planTotalControl[i] = Math.round(finalPerPig * headCount)
    // 单次量 = 计划头均 / 配奶次数（不额外取整，保证乘回去一致）
    perFeed[i] = Math.round(finalPerPig / currentCount * 100) / 100
  }

  // 构建控奶后的完整 days（含体重 cascade，含教槽营养）
  const ctrlDays = []
  let ctrlW = plan.startWeight
  for (let i = 0; i < nDays; i++) {
    const orig = plan.days[i]
    const milk = planPPControl[i]
    const totalMilk = planTotalControl[i]
    // 教槽营养：已录天用实际值，未录天用最近值
    const creepPP = creepMap[orig.dayAge] !== undefined ? creepMap[orig.dayAge] : latestCreep
    const totalNutrition = milk + creepPP * INTERNAL.creepEq
    const gain = totalNutrition / (INTERNAL.fcr * 1000)
    const ws = Math.round(ctrlW * 1000) / 1000
    const we = Math.round((ctrlW + gain) * 1000) / 1000
    ctrlDays.push({
      dayAge: orig.dayAge, dayIndex: i,
      weightStart: ws,
      perPigMilkPlan: milk,
      totalMilkPlan: totalMilk,
      dailyCapacity: orig.dailyCapacity,
      rampFactor: orig.rampFactor,
      weightEnd: we,
    })
    ctrlW += gain
  }

  return {
    planMilkPPControl: planPPControl,
    planMilkTotalControl: planTotalControl,
    feedTimes,
    perFeed,
    days: ctrlDays,
    controlStartDay: resolvedControlStartDay,
  }
}

// ──────────────────────────────────────────────
// 3. 每日实际录入数据模型
// ──────────────────────────────────────────────

/**
 * @typedef {Object} DailyRecord
 * @property {number} dayAge
 * @property {number} totalMilkG - 总配奶量 (g)
 * @property {number} totalCreepG - 总教槽量 (g)
 * @property {number} headCount - 当前头数
 * @property {number} [diarrheaMild] - 轻度腹泻头数
 * @property {number} [diarrheaModerate] - 中度腹泻头数
 * @property {number} [diarrheaSevere] - 重度腹泻头数
 * @property {number} [sampleWeight] - 样本称重 (kg/头，可选)
 */

/**
 * 从每日记录计算衍生字段
 */
function computeDailyStats(record) {
  const hc = record.headCount != null ? record.headCount : 1
  if (hc <= 0) {
    return { perPigMilkActual: 0, perPigCreepActual: 0, diarrheaRate: 0, diarrheaTotal: 0 }
  }
  const diarTotal = (record.diarrheaMild || 0) + (record.diarrheaModerate || 0) + (record.diarrheaSevere || 0)
  return {
    perPigMilkActual: record.totalMilkG / hc,
    perPigCreepActual: record.totalCreepG / hc,
    diarrheaRate: diarTotal / hc,
    diarrheaTotal: diarTotal,
  }
}

/**
 * 批次结束时输出训练数据
 *
 * @param {object} batchInfo
 * @param {DailyRecord[]} batchInfo.records - 所有日记录
 * @param {number} batchInfo.startAge
 * @param {number} batchInfo.endAge
 * @param {number} batchInfo.startWeight
 * @param {number} batchInfo.headCount
 * @param {number} batchInfo.totalMilkPlanG - 计划全期奶粉
 * @returns {object} 训练数据对象
 */
function exportTrainingData(batchInfo) {
  const records = batchInfo.records || []

  // 单次遍历计算所有汇总
  let totalDiarCases = 0, totalPigDays = 0, actualTotalMilk = 0, actualTotalCreep = 0
  for (const r of records) {
    const hc = r.headCount != null ? r.headCount : 1
    if (hc > 0) totalPigDays += hc
    totalDiarCases += (r.diarrheaMild || 0) + (r.diarrheaModerate || 0) + (r.diarrheaSevere || 0)
    actualTotalMilk += r.totalMilkG || 0
    actualTotalCreep += r.totalCreepG || 0
  }
  const finalDiarrheaRate = totalPigDays > 0
    ? Math.round((totalDiarCases / totalPigDays) * 10000) / 100
    : 0

  const headCount = batchInfo.headCount || 1
  const avgPerPigMilk = actualTotalMilk / headCount
  const avgPerPigCreep = actualTotalCreep / headCount

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
      standardWeaningWeight: batchInfo.standardWeight || WEIGHT_STANDARD[batchInfo.endAge] || 4.4,
    },
    dailyRecords: records.map(r => {
      const stats = computeDailyStats(r)
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
      }
      if (r.weighSample && r.weighSample.length > 0) {
        daily.weighSamples = r.weighSample.map(w => ({
          category: w.category,
          avgKg: w.avgKg,
          headCount: w.headCount,
        }))
        daily.weightedAvgKg = computeWeightedAvg(r.weighSample)
      }
      return daily
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
  }
}

// ──────────────────────────────────────────────
// 导出
// ──────────────────────────────────────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    WEIGHT_STANDARD, INTERNAL, CREEP_GRADE_VALUES,
    validateBatchConfig,
    getDailyCapacity, getRampFactor, milkToGain,
    generatePlan, computeControlPlan, computeDailyStats, exportTrainingData,
  }
}
