const feeding = require('../models/feedingModel')

class FeedingPlanService {
  generate(config) {
    return feeding.generatePlan({
      startAge: config.startAge,
      endAge: config.endAge,
      startWeight: config.startWeight,
      headCount: config.headCount,
    })
  }

  controlPlan(plan, records, controlStartDay) {
    return feeding.computeControlPlan(plan, records || [], controlStartDay == null ? -1 : controlStartDay)
  }
}

module.exports = { FeedingPlanService }
