const { badRequest } = require('../utils/errors')

function asNonNegativeInt(value, label, required) {
  if ((value == null || value === '') && !required) return 0
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) throw badRequest(`${label} must be a non-negative integer`)
  return n
}

function validateDailyRecord(record) {
  if (!record) throw badRequest('Missing daily record')
  const headCount = asNonNegativeInt(record.headCount, 'headCount', true)
  if (headCount < 1) throw badRequest('headCount must be positive')

  const mild = asNonNegativeInt(record.diarrheaMild, 'diarrheaMild')
  const moderate = asNonNegativeInt(record.diarrheaModerate, 'diarrheaModerate')
  const severe = asNonNegativeInt(record.diarrheaSevere, 'diarrheaSevere')
  const death = asNonNegativeInt(record.death, 'death')
  const cull = asNonNegativeInt(record.cull, 'cull')

  if (mild + moderate + severe > headCount) throw badRequest('diarrhea total cannot exceed headCount')
  if (death + cull > headCount) throw badRequest('death + cull cannot exceed headCount')
}

module.exports = { validateDailyRecord }
