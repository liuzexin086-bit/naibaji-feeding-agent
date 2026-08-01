const { badRequest } = require('../utils/errors')

function validateBatchConfig(config) {
  const errors = []
  const startAge = Number(config.startAge)
  const endAge = Number(config.endAge)
  const headCount = Number(config.headCount)

  if (!Number.isFinite(startAge) || startAge < 1 || startAge > 30) errors.push('startAge must be 1-30')
  if (!Number.isFinite(endAge) || endAge < 2 || endAge > 30) errors.push('endAge must be 2-30')
  if (Number.isFinite(startAge) && Number.isFinite(endAge) && startAge >= endAge) errors.push('startAge must be less than endAge')
  if (!Number.isFinite(headCount) || headCount < 1) errors.push('headCount must be positive')

  if (errors.length) throw badRequest('Invalid batch config', errors)
}

module.exports = { validateBatchConfig }
