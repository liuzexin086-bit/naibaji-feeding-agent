const v5 = require('../models/v5liteModel')

class DataQualityService {
  compute(records) {
    const base = v5.computeDataQuality(records || [])
    let score = base.dqScore
    const conflicts = [...(base.conflicts || [])]
    const warnings = []

    for (const record of records || []) {
      const headCount = record.headCount || 1
      const diarTotal = (record.diarrheaMild || 0) + (record.diarrheaModerate || 0) + (record.diarrheaSevere || 0)
      if (diarTotal > headCount) {
        score -= 0.2
        conflicts.push({ dayAge: record.dayAge, reason: '腹泻总数超过头数' })
      }
      if ((record.death || 0) + (record.cull || 0) > 0 && Number(record.growthLevel) === 3 && Number(record.uniformityLevel) === 3) {
        score -= 0.1
        warnings.push({ dayAge: record.dayAge, reason: '死亡淘汰存在但长势/均匀度填好' })
      }
      if (record.actualMilkRecorded !== true && record.actualExecutedMilkG == null && record.totalMilkG == null) {
        score -= 0.1
        warnings.push({ dayAge: record.dayAge, reason: '实际下发奶量缺失' })
      }
      if (record.machineErrorCode && record.leftoverRate === 0) {
        warnings.push({ dayAge: record.dayAge, reason: '设备故障与剩奶记录可能冲突' })
      }
    }

    const dqScore = Math.max(0, Math.round(score * 100) / 100)
    return {
      dqScore,
      conflicts,
      warnings,
      isLearnable: dqScore >= 0.7 && conflicts.length === 0,
    }
  }
}

module.exports = { DataQualityService }
