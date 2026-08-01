class DeviceSyncService {
  constructor(repos) {
    this.repos = repos
  }

  recordExecution(recommendationId, payload) {
    const rec = this.repos.recommendations.findById(recommendationId)
    if (!rec) return null
    return this.repos.executions.insert({
      recommendationId,
      batchId: rec.batchId,
      deviceId: payload.deviceId || null,
      executedMilkG: payload.executedMilkG == null ? rec.finalRecommendedMilkG : Number(payload.executedMilkG),
      executedFeedTimes: payload.executedFeedTimes == null ? null : Number(payload.executedFeedTimes),
      leftoverRate: payload.leftoverRate == null ? null : Number(payload.leftoverRate),
      machineErrorCode: payload.machineErrorCode || '',
      executionStatus: payload.executionStatus || 'recorded',
      executedAt: payload.executedAt || new Date().toISOString(),
    })
  }
}

module.exports = { DeviceSyncService }
