const fs = require('fs')
const path = require('path')

const COLLECTIONS = [
  'batches',
  'dailyRecords',
  'weighSamples',
  'recommendations',
  'approvals',
  'executions',
  'sceneStates',
  'modelRegistry',
  'auditLogs',
]

function defaultData() {
  const data = { meta: { schemaVersion: 1, createdAt: new Date().toISOString() } }
  for (const name of COLLECTIONS) data[name] = []
  return data
}

class JsonDatabase {
  constructor(filePath) {
    this.filePath = filePath
    this.data = null
  }

  load() {
    if (this.data) return this.data
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    if (!fs.existsSync(this.filePath)) {
      this.data = defaultData()
      this.save()
      return this.data
    }
    const raw = fs.readFileSync(this.filePath, 'utf8')
    this.data = raw.trim() ? JSON.parse(raw) : defaultData()
    for (const name of COLLECTIONS) {
      if (!Array.isArray(this.data[name])) this.data[name] = []
    }
    if (!this.data.meta) this.data.meta = { schemaVersion: 1 }
    return this.data
  }

  save() {
    if (!this.data) this.data = defaultData()
    this.data.meta.updatedAt = new Date().toISOString()
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2))
  }

  collection(name) {
    const data = this.load()
    if (!Array.isArray(data[name])) data[name] = []
    return data[name]
  }
}

module.exports = { JsonDatabase, COLLECTIONS }
