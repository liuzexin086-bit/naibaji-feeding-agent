/**
 * 奶爸机 — V5-Lite 影子模式模型
 * =============================
 *
 * 与 feeding-model.js 完全独立，并行运行。
 * 所有计算均为仿真，不影响机器实际奶量。
 *
 * Layer 2: 日级风险评分 → adjustFactor
 * Layer 3: 离线批次自适应学习
 */

// ──────────────────────────────────────────────
// 常量
// ──────────────────────────────────────────────

const V5 = {
  creepThresholds: { low: 30, high: 70 },
  riskWeights: { mild: 15, moderate: 40, severe: 100 },
  riskNorm: 10,
  executionDeficitThreshold: 0.10,
  tempThresholds: { mild: 31, moderate: 33, strong: 34 },
  tempScores: { mild: 10, moderate: 20, strong: 30 },
  fuseLine: 40,
  adjustSlopeHigh: 0.004,
  adjustSlopeLow: 0.002,
  adjustFloor: 0.75,
  creepBonus: 0.05,
  probeMatureDR: 0.045,
  probeCooldown: 3,
  targetDR: 0.04,      // 等效综合腹泻率目标底线（对应100头中允许4头轻/2头中/1头重；原0.03经验证于加权DR偏保守，上调至0.04后需后续模拟验证收敛稳定性）
  stagnationThreshold: 8,  // 连续未探顶批次数告警阈值
  probeDeltaThreshold: 0.020,  // 对数空间下被动路径稳定性阈值
  dqConflictPenalty: 0.1,
  dqThreshold: 0.70,
  betaAlpha: 0.3,
  betaBeta: 10,
  bayesianNu: 3,
  priorMature: 0.751,
  historyLimit: 8,
  // 拓扑优化边界
  bounds: {
    sf_d0: [0.15, 0.40],
    sf_d1: [0.35, 0.70],
    sf_d2: [0.50, 0.85],
    sf_mature: [0.60, 0.95],
  },
}

const CREEP_LEVEL_PROXY = {
  1: { meanG: 20, lowG: 5, highG: 30, confidence: 0.35 },
  2: { meanG: 50, lowG: 30, highG: 70, confidence: 0.55 },
  3: { meanG: 85, lowG: 70, highG: 110, confidence: 0.60 },
}
const GROWTH_PROXY_WEIGHTS = { creep: 0.4, growth: 0.3, uniformity: 0.3 }
const GROWTH_TREND_DELTA = { high: 0.01, zero: 0, low: -0.02 }
const WEIGHT_STANDARD_FALLBACK = {
  3: 2.3, 4: 2.4, 5: 2.6, 6: 2.8, 7: 3.0,
  8: 3.2, 9: 3.4, 10: 3.6, 11: 3.8, 12: 4.0,
  13: 4.2, 14: 4.4, 15: 4.6, 16: 4.8, 17: 5.0,
  18: 5.2, 19: 5.4, 20: 5.6, 21: 5.8,
}

// ──────────────────────────────────────────────
// Layer 2 — 日级风险计算
// ──────────────────────────────────────────────

/** 教槽克数 → 等级 1/2/3 */
function creepGramsToLevel(avgGrams) {
  if (avgGrams >= V5.creepThresholds.high) return 3
  if (avgGrams >= V5.creepThresholds.low) return 2
  return 1
}

/** 健康风险分 0-100 */
function computeRiskHealth(nL, nM, nH, N) {
  if (!N || N <= 0) return 0
  return Math.min(100, ((V5.riskWeights.mild * nL + V5.riskWeights.moderate * nM + V5.riskWeights.severe * nH) / N) * V5.riskNorm)
}

/** 执行异常风险：按正常执行时的执行缺口分级 */
function computeRiskExecution(executionDeficitRate) {
  if (executionDeficitRate == null) return 0
  if (executionDeficitRate >= 0.30) return 30
  if (executionDeficitRate >= 0.20) return 20
  if (executionDeficitRate >= V5.executionDeficitThreshold) return 10
  return 0
}

/** 环境热应激风险 */
function computeRiskEnv(avgTemp) {
  if (avgTemp == null) return 0
  if (avgTemp > V5.tempThresholds.strong) return V5.tempScores.strong
  if (avgTemp > V5.tempThresholds.moderate) return V5.tempScores.moderate
  if (avgTemp > V5.tempThresholds.mild) return V5.tempScores.mild
  return 0
}

/** 综合风险分 = max(health, execution) + env */
function computeRiskScore(health, execution, env) {
  return Math.max(health, execution) + env
}

/** 控奶系数 adjustFactor + 是否暂停主动探测 */
function computeAdjustFactor(riskScore, nH, creepLevel) {
  let adjustFactor = 1.0
  let pauseProbe = false
  const hardFuse = nH > 0

  // 重度腹泻熔断：直接降奶，不执行任何后续补偿逻辑
  if (hardFuse) {
    pauseProbe = true
    const effectiveRisk = Math.max(riskScore, V5.fuseLine)
    adjustFactor = Math.max(V5.adjustFloor, 1.0 - V5.adjustSlopeHigh * effectiveRisk)
    return { adjustFactor: Math.round(adjustFactor * 1000) / 1000, pauseProbe }
  }

  if (riskScore >= V5.fuseLine) {
    pauseProbe = true
    adjustFactor = Math.max(V5.adjustFloor, 1.0 - V5.adjustSlopeHigh * riskScore)
  } else if (riskScore > 15) {
    adjustFactor = 1.0 - V5.adjustSlopeLow * riskScore
  }

  // 教槽吃得极好时适当放宽限饲（非熔断场景）
  if (creepLevel === 3 && adjustFactor < 1.0) {
    adjustFactor = Math.min(1.0, adjustFactor + V5.creepBonus)
  }

  return { adjustFactor: Math.round(adjustFactor * 1000) / 1000, pauseProbe }
}

/** 等级字段钳制到 1-3 */
function clampLevel(v, fallback) {
  const n = Number(v)
  if (n === 1 || n === 2 || n === 3) return n
  return fallback
}

function toPositiveNumber(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

function hasActualMilkInput(record) {
  if (!record) return false
  if (record.actualMilkRecorded === false) return false
  if (record.actualMilkRecorded === true || record.submitted === true || record.recordSubmitted === true) return true
  if (record.deviceMilkRecorded === true || record.deviceTotalMilkG != null || record.actualDispensedMilkG != null) return true
  if (record.totalMilkG == null || record.totalMilkG === '') return false
  const n = Number(record.totalMilkG)
  return Number.isFinite(n) && n >= 0
}

function resolveBaseWeight(planDay, record, batchInfo) {
  var fromPlan = toPositiveNumber(planDay && planDay.weightStart)
  if (fromPlan) return fromPlan

  var fromRecord = toPositiveNumber(record && record.startWeight)
  if (fromRecord) return fromRecord

  var fromBatch = toPositiveNumber(batchInfo && batchInfo.startWeight)
  if (fromBatch) return fromBatch

  var fromBatchRecord = toPositiveNumber(record && record.batchStartWeight)
  if (fromBatchRecord) return fromBatchRecord

  var startAge =
    record && record.startAge != null
      ? Number(record.startAge)
      : batchInfo && batchInfo.startAge != null
        ? Number(batchInfo.startAge)
        : planDay && planDay.dayAge != null
          ? Number(planDay.dayAge)
          : null

  if (startAge != null) {
    if (batchInfo && batchInfo.standardWeightMap && batchInfo.standardWeightMap[startAge]) {
      return Number(batchInfo.standardWeightMap[startAge])
    }
    if (WEIGHT_STANDARD_FALLBACK[startAge]) return WEIGHT_STANDARD_FALLBACK[startAge]
  }

  return 2.3
}

/**
 * 主入口：计算当天影子调整结果
 * planDay: plan.days[dayIndex]（含 perPigMilkPlan, totalMilkPlan）
 * record: 当前正在录入的记录对象（构建中）
 */
function computeShadowAdjustment(planDay, record, batchInfo) {
  planDay = planDay || {}
  record = record || {}
  batchInfo = batchInfo || record.batchInfo || {}
  const N = record.headCount || 1
  const nL = record.diarrheaMild || 0
  const nM = record.diarrheaModerate || 0
  const nH = record.diarrheaSevere || 0
  const totalCreep = record.totalCreepG || 0
  const avgCreep = totalCreep / N

  const creepLevelFromGrams = creepGramsToLevel(avgCreep)
  // 三等级生长信号（优先用显式填写的等级）
  const hasCreepG = record.totalCreepG != null && record.totalCreepG !== ''
  const observedCreepLevel = clampLevel(
    record.creepLevel,
    hasCreepG ? creepLevelFromGrams : 2,
  )
  const uniformityLevel = clampLevel(record.uniformityLevel, 2)
  const growthLevel = clampLevel(record.growthLevel, 2)

  var growthProxyScore = computeGrowthProxyScore(observedCreepLevel, uniformityLevel, growthLevel)
  var trendDelta = computeGrowthTrendDelta(growthProxyScore)

  const riskHealth = computeRiskHealth(nL, nM, nH, N)

  // 只有真实执行数据存在时才计算执行缺口；自动填入的计划值不能触发执行异常风险。
  const planTotal = planDay.totalMilkPlan || 0
  const hasActualMilk = hasActualMilkInput(record)
  const executionStatus = record.executionStatus || 'normal'
  const executionRiskExcluded = executionStatus !== 'normal'
  let executionDeficitRate = null
  let executionRate = null
  let riskExecution = 0
  if (hasActualMilk && planTotal > 0) {
    const actualTotal = Number(
      record.deviceTotalMilkG != null ? record.deviceTotalMilkG
        : record.actualDispensedMilkG != null ? record.actualDispensedMilkG
          : record.totalMilkG,
    )
    if (Number.isFinite(actualTotal)) {
      executionDeficitRate = Math.max(0, Math.min(1, (planTotal - actualTotal) / planTotal))
      executionRate = Math.max(0, Math.min(1, 1 - executionDeficitRate))
      if (!executionRiskExcluded) riskExecution = computeRiskExecution(executionDeficitRate)
    }
  }

  const riskEnv = computeRiskEnv(record.avgTemp)
  const riskScore = computeRiskScore(riskHealth, riskExecution, riskEnv)

  // 控奶补偿用 observedCreepLevel（显式等级 > 教槽克数推算）
  const { adjustFactor, pauseProbe } = computeAdjustFactor(riskScore, nH, observedCreepLevel)

  const basePerPig = planDay.perPigMilkPlan || 0
  const shadowPerPig = Math.round(basePerPig * adjustFactor)
  const shadowTotal = Math.round(shadowPerPig * N)

  // 估重：有称重样本时用样本，否则用三等级推算
  var hasWeightAnchor = record.weighSample && record.weighSample.length > 0
  var weightEst
  if (hasWeightAnchor && typeof computeWeightedAvg === 'function') {
    var measured = computeWeightedAvg(record.weighSample)
    weightEst = {
      meanKg: measured,
      lowKg: Math.round(measured * 0.97 * 1000) / 1000,
      highKg: Math.round(measured * 1.03 * 1000) / 1000,
      confidence: 0.80,
      source: 'WEIGH_SAMPLE',
    }
  } else {
    var baseWeightForEstimate = resolveBaseWeight(planDay, record, batchInfo)
    weightEst = estimateWeightFromLevels(
      baseWeightForEstimate,
      basePerPig,
      observedCreepLevel,
      null,
      {
        dayIndex: planDay.dayIndex,
        uniformityLevel: uniformityLevel,
        hasInitialWeightAnchor: record.hasInitialWeightAnchor === true || batchInfo.hasInitialWeightAnchor === true,
      },
    )
  }

  var growthUp = allowGrowthUp({
    ...record,
    _hasWeightAnchor: hasWeightAnchor,
    executionDeficitRate: executionDeficitRate,
    executionRiskExcluded: executionRiskExcluded,
  }, riskScore)

  return {
    creepLevel: observedCreepLevel,
    uniformityLevel,
    growthLevel,
    growthProxyScore,
    growthTrendDelta: trendDelta,
    weightEstimate: weightEst,
    allowGrowthUp: growthUp,
    riskHealth,
    riskExecution,
    riskEnv,
    riskScore,
    adjustFactor,
    pauseProbe,
    shadowPerPig,
    shadowTotal,
    executionDeficitRate,
    executionRate,
    executionStatus,
    executionRiskExcluded,
    hasActualMilk,
  }
}

// ──────────────────────────────────────────────
// Layer 3 — 批次级离线学习
// ──────────────────────────────────────────────

/** 数据质量门控：检测人工填报与推算数据的冲突 */
function computeDataQuality(records) {
  let score = 1.0
  const conflicts = []
  let consecutiveReviewDays = 0
  for (const r of records) {
    const N = r.headCount || 1
    const diarTotal = (r.diarrheaMild || 0) + (r.diarrheaModerate || 0) + (r.diarrheaSevere || 0)
    // 优先用显式填写的 creepLevel
    const creepFromGrams = creepGramsToLevel((r.totalCreepG || 0) / N)
    const observedLevel = r.creepLevel || creepFromGrams
    const executionDeficit = r.shadowExecutionDeficitRate != null
      ? r.shadowExecutionDeficitRate
      : r.shadowLeftoverRate
    const normalExecution = !r.executionStatus || r.executionStatus === 'normal'
    const needsReview = normalExecution && executionDeficit != null && executionDeficit > 0.20 && diarTotal === 0 && observedLevel === 3
    consecutiveReviewDays = needsReview ? consecutiveReviewDays + 1 : 0

    // 仅在连续多日的高执行缺口与全部人工观测优异同时出现时，保守地提示复核一次。
    if (consecutiveReviewDays === 2) {
      score -= V5.dqConflictPenalty
      conflicts.push({ dayAge: r.dayAge, reason: '执行缺口连续偏高，但健康和教槽表现未见明显异常，建议复核' })
    }
  }
  return { dqScore: Math.max(0, score), conflicts }
}

// ──────────────────────────────────────────────
// Layer 2b — 三等级生长观测
// ──────────────────────────────────────────────

function computeGrowthProxyScore(creepLevel, uniformityLevel, growthLevel) {
  return GROWTH_PROXY_WEIGHTS.creep * creepLevel
    + GROWTH_PROXY_WEIGHTS.growth * growthLevel
    + GROWTH_PROXY_WEIGHTS.uniformity * uniformityLevel
}

function computeGrowthTrendDelta(proxyScore) {
  if (proxyScore >= 2.6) return GROWTH_TREND_DELTA.high
  if (proxyScore >= 1.8) return GROWTH_TREND_DELTA.zero
  return GROWTH_TREND_DELTA.low
}

function allowGrowthUp(record, riskScore) {
  var reasons = []
  if (record.diarrheaSevere > 0) reasons.push('重度腹泻')
  if (riskScore >= 40) reasons.push('风险分过高(' + riskScore + ')')
  if (!record.executionRiskExcluded && record.executionDeficitRate > 0.20) reasons.push('执行缺口过高')
  if ((record.death || 0) + (record.cull || 0) > 0) reasons.push('存在死亡淘汰')
  if (record.uniformityLevel === 1) reasons.push('均匀度差')
  if (!record._hasWeightAnchor) reasons.push('缺少称重锚点')
  return { allowed: reasons.length === 0, reasons: reasons }
}

function estimateWeightFromLevels(baseWeight, milkPP, creepLevel, confidenceOverride, options) {
  if (confidenceOverride && typeof confidenceOverride === 'object') {
    options = confidenceOverride
    confidenceOverride = null
  }
  options = options || {}
  var proxy = CREEP_LEVEL_PROXY[creepLevel] || CREEP_LEVEL_PROXY[2]
  var safeBaseWeight = toPositiveNumber(baseWeight) || 2.3
  var safeMilkPP = Number.isFinite(Number(milkPP)) ? Number(milkPP) : 0
  var milkGain = safeMilkPP / (0.9 * 1000)
  var creepGain = proxy.meanG * 0.7 / (0.9 * 1000)
  var effectiveGain = creepGain * proxy.confidence
  var mean = safeBaseWeight + milkGain + effectiveGain
  var uniformityLevel = clampLevel(options.uniformityLevel, 2)
  var uniformityRangePct = { 3: 0.04, 2: 0.07, 1: 0.12 }
  var pctRange = mean * (uniformityRangePct[uniformityLevel] || 0.07)
  var dayIndex = options.dayIndex != null ? Math.max(0, Number(options.dayIndex) || 0) : 0
  var ageDrift = Math.min(0.12, dayIndex * 0.008)
  var minHalfRange = 0.12
  if (options.hasInitialWeightAnchor !== true) minHalfRange = Math.max(minHalfRange, 0.18)
  if (uniformityLevel === 1) minHalfRange = Math.max(minHalfRange, 0.25)
  var halfRange = Math.max(minHalfRange, pctRange, ageDrift)
  var confidence = confidenceOverride != null ? confidenceOverride : proxy.confidence
  if (options.hasInitialWeightAnchor !== true) confidence = Math.min(confidence, 0.50)
  return {
    meanKg: Math.round(mean * 1000) / 1000,
    lowKg: Math.round(Math.max(0, mean - halfRange) * 1000) / 1000,
    highKg: Math.round((mean + halfRange) * 1000) / 1000,
    confidence: Math.min(confidence, 0.60),
    source: 'THREE_LEVEL_PROXY',
  }
}

function computeBatchGrowthSummary(records) {
  if (!records || records.length === 0) {
    return { avgGrowthProxyScore: 2.0, weakGrowthTrendDelta: 0, hasWeightAnchor: false, confidenceCap: 0.60 }
  }
  var sumScore = 0, count = 0, hasWeight = false
  for (var i = 0; i < records.length; i++) {
    var r = records[i]
    if (r.growthProxyScore != null) { sumScore += r.growthProxyScore; count++ }
    if (r.weighSample && r.weighSample.length > 0) hasWeight = true
  }
  var avgScore = count > 0 ? sumScore / count : 2.0
  var trendDelta = computeGrowthTrendDelta(avgScore)
  return {
    avgGrowthProxyScore: Math.round(avgScore * 10) / 10,
    weakGrowthTrendDelta: trendDelta,
    hasWeightAnchor: hasWeight,
    confidenceCap: hasWeight ? 0.90 : 0.60,
  }
}

/** 贝塔平滑处理 */
function betaSmoothing(records, alpha, beta) {
  let num = alpha
  let den = beta
  for (const r of records) {
    const N = r.headCount || 1
    const nL = r.diarrheaMild || 0
    const nM = r.diarrheaModerate || 0
    const nH = r.diarrheaSevere || 0
    num += 1 * nL + 2 * nM + 4 * nH
    den += N
  }
  return den > 0 ? num / den : 0
}

/** 被动贝叶斯收缩点估计 */
function passiveBayesianEstimate(drSmooth, n_s, thetaPrior, history, thetaCurrent, avgAdjustFactor) {
  const thetaExecuted = thetaCurrent * (avgAdjustFactor != null ? avgAdjustFactor : 1.0)
  const localB = 0.5 * (-Math.log(Math.max(drSmooth, 0.0001) / V5.targetDR))
  const x_b = Math.log(thetaExecuted) + localB

  const newHistory = [...(history || []), x_b].slice(-V5.historyLimit)

  const xHat = median(newHistory)
  const w = n_s / (n_s + V5.bayesianNu)
  const thetaPassive = Math.exp(w * xHat + (1 - w) * Math.log(thetaPrior))

  return { thetaPassive, newHistory, x_b }
}

/** 中位数 */
function median(arr) {
  if (!arr || arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** 主动探测审判（柔性挂起与恢复） */
function activeProbeJudgment(probedFloor, drMature, completedBatchCount, recentDR, sceneState) {
  const result = {
    status: probedFloor.status,
    value: probedFloor.value,
    confidence: probedFloor.confidence,
    triggered: false,
  }

  // 三条防线：被动收敛 + 冷却期 + 前5批不探
  const shouldProbe = probedFloor.status === 'ACTIVE'
    && completedBatchCount >= 5
    && (sceneState ? sceneState.lastStepSize < V5.probeDeltaThreshold : true)
    && (sceneState ? sceneState.cooldownBatches === 0 : true)

  if (shouldProbe) {
    result.triggered = true
    if (drMature > V5.probeMatureDR) {
      // 探顶失败：只剥夺信任，不销毁数值
      result.status = 'SUSPENDED'
      result.confidence = 0
      result.value = probedFloor.value  // 保持不动
    } else {
      // 探顶成功
      result.value = Math.max(probedFloor.value, V5.priorMature)
      result.confidence = Math.min(0.99, probedFloor.confidence + 0.02)
      result.status = 'ACTIVE'
    }
    return result
  }

  // 冷却期结束后检查恢复（用 cooldownBatches 而非累计批次数）
  if (probedFloor.status === 'SUSPENDED' && sceneState && sceneState.cooldownBatches === 0) {
    const recent = (recentDR || []).slice(-2)
    if (recent.length >= 2 && recent.every(function(d) { return d < V5.targetDR * 0.5 })) {
      result.status = 'ACTIVE'
      result.confidence = 0.50
      result.triggered = true
    }
  }

  return result
}

/** 防通缩告警：连续多批未探顶且腹泻率极低，可能过度限饲 */
function stagnationWatchdog(sceneState, recentBatchesDR) {
  const lastProbeIndex = sceneState.lastProbeBatchIndex != null ? sceneState.lastProbeBatchIndex : 0
  const batchesSinceProbe = sceneState.completedBatchCount - lastProbeIndex
  if (batchesSinceProbe >= V5.stagnationThreshold && recentBatchesDR.length >= 3) {
    const allLow = recentBatchesDR.slice(-3).every(function(d) { return d < 0.5 * V5.targetDR })
    if (allLow) {
      return { alert: true, message: '栏位已连续 ' + batchesSinceProbe + ' 批次未成功上探，且近期腹泻率极低，可能陷入过度限饲通缩，请人工复核' }
    }
  }
  return { alert: false }
}

/** 单调性投影拓扑优化与硬裁剪 */
function topologyOptimization(nextValues) {
  const keys = ['sf_d0', 'sf_d1', 'sf_d2', 'sf_mature']
  const result = {}

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const [lo, hi] = V5.bounds[key]
    result[key] = Math.max(lo, Math.min(hi, nextValues[key] != null ? nextValues[key] : 0))
  }

  // 前向 Max 推顶保证单调递增
  result.sf_d1 = Math.max(result.sf_d0, result.sf_d1)
  result.sf_d2 = Math.max(result.sf_d1, result.sf_d2)
  result.sf_mature = Math.max(result.sf_d2, result.sf_mature)

  // 取整到3位小数
  for (const k of keys) result[k] = Math.round(result[k] * 1000) / 1000

  return result
}

/** 全期影子计算结果 + 场景状态更新 */
function computeBatchShadow(batchRecords, batchInfo, sceneState) {
  const records = batchRecords || []
  const curParams = sceneState.currentParameters

  // 数据质量门控：不达标则拒绝更新场景参数
  const dq = computeDataQuality(records)
  if (dq.dqScore < V5.dqThreshold) {
    return {
      rejected: true,
      reason: 'DATA_QUALITY_FAILED',
      dataQuality: dq,
      drSmooth: 0,
      drMature: 0,
      thetaPassive: 0,
      probeResult: { triggered: false },
      optimizedParams: curParams,
      nextState: sceneState,
      watchdog: { alert: false },
    }
  }

  // Beta smoothing（全期数据）
  const drSmooth = betaSmoothing(records, V5.betaAlpha, V5.betaBeta)

  // 成熟期 DR（后1/3天数）
  const matureDays = records.slice(-Math.max(3, Math.floor(records.length / 3)))
  const drMature = betaSmoothing(matureDays, V5.betaAlpha, V5.betaBeta)

  // 计算窗口期日均 adjustFactor（等效执行参数，Fix 1）
  var sumAdj = 0, adjCount = 0
  for (var i = 0; i < matureDays.length; i++) {
    if (matureDays[i].shadowAdjustFactor != null) {
      sumAdj += matureDays[i].shadowAdjustFactor
      adjCount++
    }
  }
  const avgAdjustFactor = adjCount > 0 ? sumAdj / adjCount : 1.0

  // 各阶段划分：早期/中期/晚期（用于各节点独立估计）
  const totalDays = records.length
  const third = Math.max(2, Math.floor(totalDays / 3))
  const earlyDays = records.slice(0, third)
  const midDays = records.slice(third, Math.min(Math.floor(totalDays * 2 / 3), totalDays))

  const drEarly = earlyDays.length > 0 ? betaSmoothing(earlyDays, V5.betaAlpha, V5.betaBeta) : drSmooth
  const drMid = midDays.length > 0 ? betaSmoothing(midDays, V5.betaAlpha, V5.betaBeta) : drSmooth

  // 各节点独立贝叶斯估计
  const n_s = sceneState.completedBatchCount
  const epMature = passiveBayesianEstimate(drSmooth, n_s, V5.priorMature,
    sceneState.historyAbsoluteEstimates.sf_mature, curParams.sf_mature, avgAdjustFactor)
  const epEarly = passiveBayesianEstimate(drEarly, n_s, V5.priorMature,
    sceneState.historyAbsoluteEstimates.sf_d0, curParams.sf_d0, avgAdjustFactor)
  const epMid = passiveBayesianEstimate(drMid, n_s, V5.priorMature,
    sceneState.historyAbsoluteEstimates.sf_d1, curParams.sf_d1, avgAdjustFactor)
  const thetaPassive = epMature.thetaPassive

  // 主动探测（传入近期DR用于恢复判定）
  const recentDR = (sceneState._recentDRHistory || []).concat(drMature).slice(-5)
  const probeResult = activeProbeJudgment(sceneState.probedFloor, drMature, n_s, recentDR, sceneState)

  // 合并
  let sfMature
  let newProbedFloor = { ...sceneState.probedFloor }
  let newCompleted = n_s + 1
  let newCooldown = Math.max(0, sceneState.cooldownBatches - 1)
  let lastProbeIdx = sceneState.lastProbeBatchIndex != null ? sceneState.lastProbeBatchIndex : 0

  if (probeResult.triggered && probeResult.status === 'SUSPENDED') {
    sfMature = thetaPassive
    // 柔性挂起：值不动，只改状态和信任度
    newProbedFloor = { value: probeResult.value, confidence: 0, status: 'SUSPENDED', updatedAtBatch: null }
    newCooldown = V5.probeCooldown
    lastProbeIdx = n_s + 1
  } else if (probeResult.triggered && probeResult.status === 'ACTIVE') {
    sfMature = Math.max(thetaPassive, probeResult.value)
    newProbedFloor = { value: probeResult.value, confidence: probeResult.confidence, status: 'ACTIVE', updatedAtBatch: null }
    lastProbeIdx = n_s + 1
  } else {
    sfMature = thetaPassive
    // 恢复检测：如果 SUSPENDED 状态下恢复为 ACTIVE
    if (probeResult.status === 'ACTIVE' && sceneState.probedFloor.status === 'SUSPENDED') {
      newProbedFloor = { value: probeResult.value, confidence: probeResult.confidence, status: 'ACTIVE', updatedAtBatch: null }
    }
  }

  // 其他节点按 sf_mature 比例缩放
  const ratio = sfMature / curParams.sf_mature
  // 各节点独立估计值（sf_d2 从 sf_d1 和 sf_mature 插值）
  const nextValues = {
    sf_d0: epEarly.thetaPassive,
    sf_d1: epMid.thetaPassive,
    sf_d2: curParams.sf_d2 * (Math.sqrt(epMid.thetaPassive * sfMature) / Math.sqrt(curParams.sf_d1 * curParams.sf_mature)),
    sf_mature: sfMature,
  }

  const optimized = topologyOptimization(nextValues)

  // 构建新历史（各节点独立 x_b）
  const newHistoryMap = {}
  const nodeKeys = ['sf_d0', 'sf_d1', 'sf_d2', 'sf_mature']
  const nodeEp = { sf_d0: epEarly, sf_d1: epMid, sf_mature: epMature }
  for (const key of nodeKeys) {
    const h = sceneState.historyAbsoluteEstimates[key] || []
    const ep = nodeEp[key]
    const newVal = ep ? ep.x_b : (epMature.x_b * (optimized[key] / optimized.sf_mature))
    newHistoryMap[key] = [...h, newVal].slice(-V5.historyLimit)
  }

  // 防通缩告警
  const watchdog = stagnationWatchdog(
    { ...sceneState, completedBatchCount: n_s + 1, lastProbeBatchIndex: lastProbeIdx },
    recentDR,
  )

  // 批次生长总结
  const growthSummary = computeBatchGrowthSummary(records)

  // 更新 growthTrendBias（带范围钳制）
  const oldGrowthProxy = sceneState.growthProxyState || { growthTrendBias: 1.0, confidence: 0, history: [] }
  const nextGrowthTrendBias = Math.max(0.90, Math.min(1.10,
    oldGrowthProxy.growthTrendBias + growthSummary.weakGrowthTrendDelta,
  ))

  // 构建新场景状态（含生长趋势 + 体重校正）
  const newState = {
    sceneId: sceneState.sceneId || 'default',
    completedBatchCount: newCompleted,
    lastStepSize: Math.abs(Math.log(optimized.sf_mature) - Math.log(curParams.sf_mature)),
    cooldownBatches: newCooldown,
    probedFloor: newProbedFloor,
    currentParameters: optimized,
    historyAbsoluteEstimates: newHistoryMap,
    lastProbeBatchIndex: lastProbeIdx,
    _recentDRHistory: recentDR,
    growthProxyState: {
      growthTrendBias: Math.round(nextGrowthTrendBias * 1000) / 1000,
      confidence: Math.min(growthSummary.confidenceCap, (oldGrowthProxy.confidence || 0) + 0.05),
      history: [...(oldGrowthProxy.history || []), growthSummary].slice(-V5.historyLimit),
    },
    weightCorrection: sceneState.weightCorrection || {
      weightBias: 1.0, growthBias: 1.0, confidence: 0, history: [],
    },
  }

  return {
    drSmooth,
    drMature,
    thetaPassive,
    probeResult,
    optimizedParams: optimized,
    nextState: newState,
    watchdog: watchdog,
    batchGrowthSummary: growthSummary,
  }
}

/** 影子场景默认初始状态 */
function defaultSceneState() {
  return {
    sceneId: 'default',
    completedBatchCount: 0,
    lastStepSize: 0,
    cooldownBatches: 0,
    lastProbeBatchIndex: 0,
    _recentDRHistory: [],
    probedFloor: {
      value: V5.priorMature,
      confidence: 0.95,
      status: 'ACTIVE',
      updatedAtBatch: null,
    },
    currentParameters: {
      sf_d0: 0.245,
      sf_d1: 0.495,
      sf_d2: 0.650,
      sf_mature: 0.751,
    },
    historyAbsoluteEstimates: {
      sf_d0: [],
      sf_d1: [],
      sf_d2: [],
      sf_mature: [],
    },
    growthProxyState: {
      growthTrendBias: 1.0,
      confidence: 0,
      history: [],
    },
    weightCorrection: {
      weightBias: 1.0,
      growthBias: 1.0,
      confidence: 0,
      history: [],
    },
  }
}

// ──────────────────────────────────────────────
// 导出
// ──────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    V5,
    creepGramsToLevel,
    computeRiskHealth,
    computeRiskExecution,
    computeRiskEnv,
    computeRiskScore,
    computeAdjustFactor,
    computeShadowAdjustment,
    clampLevel,
    hasActualMilkInput,
    resolveBaseWeight,
    computeDataQuality,
    computeGrowthProxyScore,
    computeGrowthTrendDelta,
    allowGrowthUp,
    estimateWeightFromLevels,
    WEIGHT_STANDARD_FALLBACK,
    computeBatchGrowthSummary,
    betaSmoothing,
    passiveBayesianEstimate,
    activeProbeJudgment,
    topologyOptimization,
    computeBatchShadow,
    stagnationWatchdog,
    defaultSceneState,
    median,
  }
}
