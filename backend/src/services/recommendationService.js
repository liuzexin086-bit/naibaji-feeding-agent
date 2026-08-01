const { nowIso } = require('../utils/ids')

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n))
}

class RecommendationService {
  constructor(repos, services) {
    this.repos = repos
    this.services = services
  }

  recomputeBatch(batchId) {
    const batch = this.repos.batches.findById(batchId)
    if (!batch) return []
    const records = this.repos.dailyRecords
      .filter((row) => row.batchId === batchId)
      .sort((a, b) => (a.dayIndex || 0) - (b.dayIndex || 0))
    this.repos.recommendations.removeWhere((row) => row.batchId === batchId)

    const plan = this.services.feedingPlan.generate(batch.config)
    const sceneState = this.services.sceneState.getOrCreate(batch.config)
    const result = []

    for (const record of records) {
      const dayIndex = plan.days.findIndex((day) => day.dayAge === record.dayAge)
      const planDay = dayIndex >= 0 ? plan.days[dayIndex] : plan.days[record.dayIndex || 0]
      if (!planDay) continue

      const basePerPig = record.planPerPigAtCommit || planDay.perPigMilkPlan
      const baseTotal = record.planTotalAtCommit || Math.round(basePerPig * (record.headCount || batch.config.headCount || 1))
      const servicePlanDay = { ...planDay, perPigMilkPlan: basePerPig, totalMilkPlan: baseTotal }
      const shadow = this.services.shadowRisk.compute(servicePlanDay, record, batch.config)
      const weight = this.services.weightEstimation.estimate(servicePlanDay, record, batch.config, shadow.riskScore)
      const growthUp = shadow.allowGrowthUp || { allowed: false, reasons: ['缺少上调判定'] }
      const sceneWeight = sceneState.weightCorrection || {}
      const rawWeightFactor = clamp((sceneWeight.weightBias || 1) * (sceneWeight.growthBias || 1), 0.85, 1.15)
      const weightCorrectionFactor = rawWeightFactor > 1 && !growthUp.allowed ? 1 : rawWeightFactor
      const riskAdjustFactor = shadow.adjustFactor == null ? 1 : shadow.adjustFactor
      let finalTotal = Math.round(baseTotal * weightCorrectionFactor * riskAdjustFactor)
      const allowAutoIncrease = false
      if (!allowAutoIncrease && finalTotal > baseTotal) finalTotal = baseTotal

      const blockedReasons = []
      if (rawWeightFactor > 1 && !growthUp.allowed) blockedReasons.push(...growthUp.reasons)
      if (finalTotal > baseTotal && !allowAutoIncrease) blockedReasons.push('早期生产限制：上调必须人工确认')

      const rec = this.repos.recommendations.insert({
        recommendationId: `${batchId}_${record.dayAge}`,
        batchId,
        dailyRecordId: record.id,
        dayAge: record.dayAge,
        dayIndex: record.dayIndex,
        modelVersion: batch.modelVersion || 'v5lite-v0.6',
        baseMilkG: baseTotal,
        weightCorrectionFactor,
        riskAdjustFactor,
        finalRecommendedMilkG: finalTotal,
        riskHealth: shadow.riskHealth,
        riskMachine: shadow.riskMachine,
        riskEnv: shadow.riskEnv,
        riskScore: shadow.riskScore,
        growthProxyScore: shadow.growthProxyScore,
        weightEstimateMean: weight.meanKg,
        weightEstimateLow: weight.lowKg,
        weightEstimateHigh: weight.highKg,
        weightEstimateConfidence: weight.confidence,
        weightEstimateSource: weight.source,
        allowGrowthUp: growthUp.allowed,
        growthUpBlockedReasons: blockedReasons.length ? blockedReasons : growthUp.reasons,
        pauseProbe: shadow.pauseProbe,
        createdAt: nowIso(),
      })
      result.push(rec)
    }

    return result
  }

  listForBatch(batchId) {
    return this.repos.recommendations
      .filter((row) => row.batchId === batchId)
      .sort((a, b) => (a.dayIndex || 0) - (b.dayIndex || 0))
  }
}

module.exports = { RecommendationService }
