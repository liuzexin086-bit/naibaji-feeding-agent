const v5 = require('../models/v5liteModel')

class ShadowRiskService {
  compute(planDay, record, batchConfig) {
    return v5.computeShadowAdjustment(planDay, record, batchConfig)
  }
}

module.exports = { ShadowRiskService }
