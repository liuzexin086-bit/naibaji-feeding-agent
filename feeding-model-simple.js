/**
 * 奶爸机 — 极简日调控模型
 * ========================
 *
 * 批次开始只输入一次仔猪日龄；之后每天只输入：
 *   1. 教槽料采食等级：无 / 低 / 中 / 高
 *      - 无：0g
 *      - 低：0～<30g（模型代表值 15g）
 *      - 中：30～<70g（模型代表值 50g）
 *      - 高：≥70g（模型代表值 70g，按阈值下限保守估算）
 *   2. 腹泻情况：无 / 轻度 / 严重
 *
 * 输出头均奶粉量、配奶次数、单次头均奶粉量和风险提示。
 * 日龄、估算体重和上一日调控状态均由模型自动滚动，可导出并恢复。
 *
 * 注意：
 * - 本脚本输出的是群体饲喂建议，不是诊断或治疗方案。
 * - 轻度腹泻当天取消 1 餐，严重腹泻当天均匀取消 3 餐；
 *   每餐头均量及其他控制参数保持不变。
 * - 模型有效日龄为 3～30 日龄。
 * - 输出全部为“头均”数值，因此不需要输入头数。
 */

const MODEL_VERSION = 'naibaji-simple-v2'
const MIN_AGE = 3
const MAX_AGE = 30

/** 原模型体重标准；21 日龄后按 0.2kg/天外推。 */
const WEIGHT_STANDARD = {
  3: 2.3, 4: 2.4, 5: 2.6, 6: 2.8, 7: 3.0,
  8: 3.2, 9: 3.4, 10: 3.6, 11: 3.8, 12: 4.0, 13: 4.2, 14: 4.4,
  15: 4.6, 16: 4.8, 17: 5.0, 18: 5.2, 19: 5.4, 20: 5.6, 21: 5.8,
}

/** 沿用原脚本的内部固定参数。 */
const INTERNAL = {
  fcr: 0.9,
  dilution: 6,
  stomachMlPerKg: 30,
  safetyFactor: 0.85,
  creepEq: 0.7,
  baselineFeedTimes: 12,
  minFeedTimes: 2,
  minPredictedGainG: 180,
  ramp: { d1: 0.30, d2: 0.60, d3: 0.78, d4Plus: 0.85 },
}

/**
 * 等级代表值仅用于日增重保护和体重滚算。
 * startFeedTimes/intervalDays 延续原模型的 30g、70g 控奶节点；
 * “无”单独设为不减次，“低”采用原 <30g 的三天递减规则。
 */
const CREEP_LEVELS = {
  none:   { label: '无', estimatedG: 0,  startFeedTimes: 12, intervalDays: Infinity, rank: 0 },
  low:    { label: '低', estimatedG: 15, startFeedTimes: 11, intervalDays: 3, rank: 1 },
  medium: { label: '中', estimatedG: 50, startFeedTimes: 10, intervalDays: 2, rank: 2 },
  high:   { label: '高', estimatedG: 70, startFeedTimes: 8,  intervalDays: 1, rank: 3 },
}

const DIARRHEA_LEVELS = {
  none:   { label: '无', removedMeals: 0, freezeReduction: false },
  mild:   { label: '轻度', removedMeals: 1, freezeReduction: true },
  severe: { label: '严重', removedMeals: 3, freezeReduction: true },
}

const CREEP_ALIASES = {
  无: 'none', none: 'none', '0': 'none',
  低: 'low', low: 'low',
  中: 'medium', medium: 'medium', mid: 'medium',
  高: 'high', high: 'high',
}

const DIARRHEA_ALIASES = {
  无: 'none', none: 'none', '0': 'none',
  轻: 'mild', 轻度: 'mild', mild: 'mild',
  重: 'severe', 重度: 'severe', 严重: 'severe', severe: 'severe',
}

function round(value, digits = 1) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function floorTo(value, digits = 2) {
  const factor = 10 ** digits
  return Math.floor((value + Number.EPSILON) * factor) / factor
}

function normalizeLevel(value, aliases, fieldName) {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : String(value)
  const normalized = aliases[key]
  if (!normalized) {
    throw new Error(`${fieldName}无效：${value}`)
  }
  return normalized
}

function validateStartAge(startAge) {
  if (!Number.isInteger(startAge) || startAge < MIN_AGE || startAge > MAX_AGE) {
    throw new Error(`仔猪日龄须为 ${MIN_AGE}～${MAX_AGE} 之间的整数`)
  }
}

function getStandardWeight(age) {
  validateStartAge(age)
  if (WEIGHT_STANDARD[age] != null) return WEIGHT_STANDARD[age]
  return round(5.8 + (age - 21) * 0.2, 1)
}

/** 头均日安全奶粉容量（g/头/天），公式与原脚本一致。 */
function getDailyCapacity(weightKg) {
  return weightKg
    * INTERNAL.stomachMlPerKg
    * INTERNAL.safetyFactor
    * INTERNAL.baselineFeedTimes
    / INTERNAL.dilution
}

function getRampFactor(dayIndex) {
  if (dayIndex === 0) return INTERNAL.ramp.d1
  if (dayIndex === 1) return INTERNAL.ramp.d2
  if (dayIndex === 2) return INTERNAL.ramp.d3
  return INTERNAL.ramp.d4Plus
}

/** 在原计划餐次中尽量均匀地选出需要取消的餐序号（从 1 开始）。 */
function getEvenlySkippedMeals(plannedFeedTimes, removedMeals) {
  const count = Math.min(
    Math.max(removedMeals, 0),
    Math.max(plannedFeedTimes - INTERNAL.minFeedTimes, 0),
  )
  const skipped = []
  for (let i = 1; i <= count; i++) {
    skipped.push(Math.round(i * plannedFeedTimes / (count + 1)))
  }
  return skipped
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function createInitialState(startAge) {
  validateStartAge(startAge)
  return {
    version: MODEL_VERSION,
    startAge,
    dayIndex: 0,
    estimatedWeightKg: getStandardWeight(startAge),
    controlFeedTimes: INTERNAL.baselineFeedTimes,
    previousCreepKey: null,
    lastControlReductionDayIndex: -1,
    initialized: false,
    history: [],
  }
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('批次快照须为对象')
  }
  if (snapshot.version !== MODEL_VERSION) {
    throw new Error(`批次快照版本无效，须为 ${MODEL_VERSION}`)
  }

  validateStartAge(snapshot.startAge)
  const maxDays = MAX_AGE - snapshot.startAge + 1
  if (!Number.isInteger(snapshot.dayIndex) || snapshot.dayIndex < 0 || snapshot.dayIndex > maxDays) {
    throw new Error('批次快照 dayIndex 超出有效范围')
  }
  if (!Number.isFinite(snapshot.estimatedWeightKg) || snapshot.estimatedWeightKg <= 0) {
    throw new Error('批次快照估算体重无效')
  }

  const controlFeedTimes = snapshot.controlFeedTimes ?? snapshot.feedTimes
  if (
    !Number.isInteger(controlFeedTimes)
    || controlFeedTimes < INTERNAL.minFeedTimes
    || controlFeedTimes > INTERNAL.baselineFeedTimes
  ) {
    throw new Error('批次快照正常餐次无效')
  }

  const previousCreepKey = snapshot.previousCreepKey
  if (previousCreepKey !== null && !CREEP_LEVELS[previousCreepKey]) {
    throw new Error('批次快照上一日教槽等级无效')
  }
  if (typeof snapshot.initialized !== 'boolean' || snapshot.initialized !== (snapshot.dayIndex > 0)) {
    throw new Error('批次快照初始化状态无效')
  }
  if (
    (snapshot.dayIndex === 0 && previousCreepKey !== null)
    || (snapshot.dayIndex > 0 && previousCreepKey === null)
  ) {
    throw new Error('批次快照上一日教槽等级与 dayIndex 不一致')
  }
  if (!Number.isInteger(snapshot.lastControlReductionDayIndex)) {
    throw new Error('批次快照减餐日索引无效')
  }
  const maxReductionIndex = snapshot.dayIndex > 0 ? snapshot.dayIndex - 1 : -1
  if (
    snapshot.lastControlReductionDayIndex < -1
    || snapshot.lastControlReductionDayIndex > maxReductionIndex
  ) {
    throw new Error('批次快照减餐日索引超出范围')
  }
  if (!Array.isArray(snapshot.history) || snapshot.history.length !== snapshot.dayIndex) {
    throw new Error('批次快照历史长度与 dayIndex 不一致')
  }
  for (let i = 0; i < snapshot.history.length; i++) {
    if (snapshot.history[i]?.dayAge !== snapshot.startAge + i) {
      throw new Error('批次快照历史日龄不连续')
    }
  }

  return {
    version: MODEL_VERSION,
    startAge: snapshot.startAge,
    dayIndex: snapshot.dayIndex,
    estimatedWeightKg: snapshot.estimatedWeightKg,
    controlFeedTimes,
    previousCreepKey,
    lastControlReductionDayIndex: snapshot.lastControlReductionDayIndex,
    initialized: snapshot.initialized,
    history: cloneJson(snapshot.history),
  }
}

function createBatchController(initialState) {
  const state = initialState

  function isComplete() {
    return state.startAge + state.dayIndex > MAX_AGE
  }

  function canReduceTo(targetFeedTimes, baselineMilkG, dailyCapacityG, creepG) {
    if (targetFeedTimes < INTERNAL.minFeedTimes) return false
    const milkG = Math.min(
      baselineMilkG,
      dailyCapacityG / INTERNAL.baselineFeedTimes * targetFeedTimes,
    )
    const predictedGainG = (milkG + creepG * INTERNAL.creepEq) / INTERNAL.fcr
    return predictedGainG >= INTERNAL.minPredictedGainG
  }

  /**
   * 录入一天的两个等级并立即返回当天建议。
   * 每调用一次，模型自动进入下一日。
   */
  function recordDay(creepLevel, diarrheaLevel) {
    if (isComplete()) {
      throw new Error(`批次已结束：模型仅支持到 ${MAX_AGE} 日龄`)
    }

    const creepKey = normalizeLevel(creepLevel, CREEP_ALIASES, '教槽料采食等级')
    const diarrheaKey = normalizeLevel(diarrheaLevel, DIARRHEA_ALIASES, '腹泻情况')
    const creep = CREEP_LEVELS[creepKey]
    const diarrhea = DIARRHEA_LEVELS[diarrheaKey]

    const dayAge = state.startAge + state.dayIndex
    const weightStartKg = state.estimatedWeightKg
    const dailyCapacityG = getDailyCapacity(weightStartKg)
    const rampFactor = getRampFactor(state.dayIndex)
    const baselineMilkG = Math.round(dailyCapacityG * rampFactor)
    const actions = []

    if (!state.initialized) {
      state.controlFeedTimes = creep.startFeedTimes
      state.initialized = true
      state.lastControlReductionDayIndex = state.dayIndex
      actions.push(
        state.controlFeedTimes < INTERNAL.baselineFeedTimes
          ? '按采食等级启动控奶'
          : '维持基线',
      )
    } else {
      const previousCreep = CREEP_LEVELS[state.previousCreepKey]
      const creepWorsened = creep.rank < previousCreep.rank
      if (creepWorsened) {
        const before = state.controlFeedTimes
        state.controlFeedTimes = Math.max(state.controlFeedTimes, creep.startFeedTimes)
        state.lastControlReductionDayIndex = state.dayIndex
        actions.push(
          state.controlFeedTimes > before
            ? '采食等级下降，恢复正常餐次'
            : '采食等级下降，维持正常餐次',
        )
      }
    }

    if (diarrhea.freezeReduction) {
      // 腹泻日跳过正常减餐；实际取消数在应用最少 2 餐保护后再写入 action。
    } else if (creep.intervalDays !== Infinity) {
      const daysSinceReduction = state.dayIndex - state.lastControlReductionDayIndex
      if (
        daysSinceReduction >= creep.intervalDays
        && state.controlFeedTimes > INTERNAL.minFeedTimes
      ) {
        const target = state.controlFeedTimes - 1
        if (canReduceTo(target, baselineMilkG, dailyCapacityG, creep.estimatedG)) {
          state.controlFeedTimes = target
          state.lastControlReductionDayIndex = state.dayIndex
          actions.push('满足间隔和增重保护，正常餐次减少 1 次')
        } else {
          actions.push('预计增重不足，维持正常餐次')
        }
      }
    }

    const plannedFeedTimes = state.controlFeedTimes
    const requestedRemovedMeals = diarrhea.removedMeals
    const skippedMealNumbers = getEvenlySkippedMeals(plannedFeedTimes, requestedRemovedMeals)
    const removedMeals = skippedMealNumbers.length
    const feedTimes = plannedFeedTimes - removedMeals
    if (diarrheaKey === 'mild') {
      actions.push(`轻度腹泻，当天取消 ${removedMeals} 餐`)
    }
    if (diarrheaKey === 'severe') {
      actions.push(`严重腹泻，当天均匀取消 ${removedMeals} 餐`)
    }
    const perFeedCapacityG = dailyCapacityG / INTERNAL.baselineFeedTimes
    const milkBeforeDiarrheaG = Math.min(
      baselineMilkG,
      perFeedCapacityG * plannedFeedTimes,
    )
    // 以厘克为最小操作单位向下取整，确保单餐量不会突破安全上限。
    const perFeedMilkG = floorTo(milkBeforeDiarrheaG / plannedFeedTimes, 2)
    const milkPlanG = round(perFeedMilkG * feedTimes, 2)
    const milkWithoutDiarrheaG = round(perFeedMilkG * plannedFeedTimes, 2)
    const milkReductionG = round(perFeedMilkG * removedMeals, 2)
    const predictedGainG = (milkPlanG + creep.estimatedG * INTERNAL.creepEq) / INTERNAL.fcr
    const weightEndKg = weightStartKg + predictedGainG / 1000

    const warnings = []
    if (diarrheaKey === 'mild') {
      warnings.push(`轻度腹泻：当天取消 ${removedMeals} 餐，其余各餐喂量不变。`)
    }
    if (diarrheaKey === 'severe') {
      warnings.push(`严重腹泻：当天均匀取消 ${removedMeals} 餐，其余各餐喂量不变；请立即联系兽医。`)
    }
    if (removedMeals < requestedRemovedMeals) {
      warnings.push(
        `受每天至少 ${INTERNAL.minFeedTimes} 餐限制，计划取消 ${requestedRemovedMeals} 餐，实际取消 ${removedMeals} 餐。`,
      )
    }
    if (creepKey === 'none') {
      warnings.push('未采食教槽料：不启动减次，请检查教槽料新鲜度和可及性。')
    }

    const result = {
      dayAge,
      batchDay: state.dayIndex + 1,
      input: {
        creepLevel: creep.label,
        diarrheaLevel: diarrhea.label,
      },
      estimate: {
        weightStartKg: round(weightStartKg, 3),
        creepIntakeG: creep.estimatedG,
        predictedGainG: round(predictedGainG, 1),
        weightEndKg: round(weightEndKg, 3),
      },
      recommendation: {
        perPigMilkG: milkPlanG,
        feedTimes,
        perFeedPerPigMilkG: perFeedMilkG,
        baselinePerPigMilkG: baselineMilkG,
        perPigMilkWithoutDiarrheaG: milkWithoutDiarrheaG,
        plannedFeedTimesWithoutDiarrhea: plannedFeedTimes,
        requestedRemovedMeals,
        removedMeals,
        skippedMealNumbers,
        milkReductionG,
        action: actions.length > 0 ? actions.join('；') : '维持',
      },
      warnings,
    }

    state.history.push(cloneJson(result))
    state.estimatedWeightKg = weightEndKg
    state.previousCreepKey = creepKey
    state.dayIndex += 1
    return result
  }

  function getState() {
    return cloneJson({
      ...state,
      // 保留旧 getState().feedTimes 读取兼容。
      feedTimes: state.controlFeedTimes,
    })
  }

  return { recordDay, getState, isComplete }
}

/**
 * 创建一个新批次。
 *
 * @example
 * const batch = createFeedingBatch(7)
 * console.log(batch.recordDay('无', '无'))
 * console.log(batch.recordDay('中', '轻度'))
 * console.log(batch.recordDay('高', '无'))
 */
function createFeedingBatch(startAge) {
  return createBatchController(createInitialState(startAge))
}

/** 从 getState() 返回的快照恢复批次。 */
function restoreFeedingBatch(snapshot) {
  return createBatchController(validateSnapshot(snapshot))
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MODEL_VERSION, MIN_AGE, MAX_AGE,
    WEIGHT_STANDARD,
    INTERNAL,
    CREEP_LEVELS,
    DIARRHEA_LEVELS,
    getStandardWeight,
    getDailyCapacity,
    getRampFactor,
    getEvenlySkippedMeals,
    createFeedingBatch, restoreFeedingBatch,
  }
}
