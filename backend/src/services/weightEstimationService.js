const feeding = require('../models/feedingModel')
const v5 = require('../models/v5liteModel')

class WeightEstimationService {
  estimate(planDay, record, batchConfig, riskScore) {
    if (record.weighSample && record.weighSample.length > 0) {
      const measured = feeding.computeWeightedAvg(record.weighSample)
      return {
        meanKg: measured,
        lowKg: Math.round(measured * 0.97 * 1000) / 1000,
        highKg: Math.round(measured * 1.03 * 1000) / 1000,
        confidence: 0.8,
        source: 'WEIGH_SAMPLE',
      }
    }

    const baseWeight = v5.resolveBaseWeight(planDay, record, batchConfig)
    if (record.creepLevel || record.uniformityLevel || record.growthLevel) {
      return v5.estimateWeightFromLevels(baseWeight, planDay.perPigMilkPlan, record.creepLevel || 2, null, {
        dayIndex: planDay.dayIndex,
        uniformityLevel: record.uniformityLevel || 2,
        hasInitialWeightAnchor: batchConfig.hasInitialWeightAnchor === true,
      })
    }

    return {
      meanKg: Math.round((baseWeight || batchConfig.startWeight || 2.3) * 1000) / 1000,
      lowKg: Math.round(Math.max(0, (baseWeight || 2.3) - 0.25) * 1000) / 1000,
      highKg: Math.round(((baseWeight || 2.3) + 0.25) * 1000) / 1000,
      confidence: riskScore >= 40 ? 0.25 : 0.35,
      source: 'MODEL_FALLBACK',
    }
  }
}

module.exports = { WeightEstimationService }
