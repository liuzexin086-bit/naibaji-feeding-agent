const feeding = require('../models/feedingModel')

class ExportService {
  constructor(repos, services) {
    this.repos = repos
    this.services = services
  }

  trainingData(batchId) {
    const batch = this.repos.batches.findById(batchId)
    if (!batch) return null
    const records = this.repos.dailyRecords
      .filter((row) => row.batchId === batchId)
      .sort((a, b) => (a.dayIndex || 0) - (b.dayIndex || 0))
    const plan = this.services.feedingPlan.generate(batch.config)
    return feeding.exportTrainingData({
      ...batch.config,
      records,
      totalMilkPlanG: plan.totalMilkPlanG,
      standardWeight: plan.standardWeight,
    })
  }
}

module.exports = { ExportService }
