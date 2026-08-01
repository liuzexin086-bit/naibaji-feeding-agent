const v5 = require('../models/v5liteModel')

class BatchLearningService {
  constructor(repos, services) {
    this.repos = repos
    this.services = services
  }

  complete(batchId) {
    const batch = this.repos.batches.findById(batchId)
    if (!batch) return null
    const records = this.repos.dailyRecords
      .filter((row) => row.batchId === batchId)
      .sort((a, b) => (a.dayIndex || 0) - (b.dayIndex || 0))
    const sceneState = this.services.sceneState.getOrCreate(batch.config)
    const dq = this.services.dataQuality.compute(records)
    let shadowResult = null

    if (records.length > 0) {
      shadowResult = v5.computeBatchShadow(records, batch.config, sceneState)
      if (shadowResult && shadowResult.nextState && !shadowResult.rejected) {
        this.services.sceneState.save(batch.config, shadowResult.nextState)
      }
    }

    const completed = this.repos.batches.upsert(batchId, {
      ...batch,
      status: 'completed',
      completedAt: new Date().toISOString(),
      learningResult: {
        dataQuality: dq,
        shadowResult,
        batchGrowthSummary: v5.computeBatchGrowthSummary(records),
      },
    })
    return completed.learningResult
  }
}

module.exports = { BatchLearningService }
