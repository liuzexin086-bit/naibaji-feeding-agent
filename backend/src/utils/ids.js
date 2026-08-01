function createId(prefix) {
  const stamp = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${stamp}_${rand}`
}

function nowIso() {
  return new Date().toISOString()
}

module.exports = { createId, nowIso }
