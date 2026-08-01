const { SceneStateService } = require('./sceneStateService')
const { FeedingPlanService } = require('./feedingPlanService')
const { ShadowRiskService } = require('./shadowRiskService')
const { WeightEstimationService } = require('./weightEstimationService')
const { DataQualityService } = require('./dataQualityService')
const { RecommendationService } = require('./recommendationService')
const { ApprovalService } = require('./approvalService')
const { DeviceSyncService } = require('./deviceSyncService')
const { BatchLearningService } = require('./batchLearningService')
const { ExportService } = require('./exportService')
const { BatchService } = require('./batchService')

function createServices(repos) {
  const services = {}
  services.sceneState = new SceneStateService(repos)
  services.feedingPlan = new FeedingPlanService()
  services.shadowRisk = new ShadowRiskService()
  services.weightEstimation = new WeightEstimationService()
  services.dataQuality = new DataQualityService()
  services.recommendation = new RecommendationService(repos, services)
  services.approval = new ApprovalService(repos)
  services.deviceSync = new DeviceSyncService(repos)
  services.batchLearning = new BatchLearningService(repos, services)
  services.export = new ExportService(repos, services)
  services.batch = new BatchService(repos, services)
  return services
}

module.exports = { createServices }
