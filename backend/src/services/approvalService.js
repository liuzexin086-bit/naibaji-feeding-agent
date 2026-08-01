class ApprovalService {
  constructor(repos) {
    this.repos = repos
  }

  approve(recommendationId, payload) {
    const rec = this.repos.recommendations.findById(recommendationId)
    if (!rec) return null
    return this.repos.approvals.insert({
      recommendationId,
      batchId: rec.batchId,
      approved: payload.approved !== false,
      override: payload.override === true,
      overrideMilkG: payload.overrideMilkG == null ? null : Number(payload.overrideMilkG),
      overrideReason: payload.overrideReason || '',
      approverId: payload.approverId || 'local-user',
      approvedAt: new Date().toISOString(),
    })
  }
}

module.exports = { ApprovalService }
