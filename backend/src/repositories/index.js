const { createId, nowIso } = require('../utils/ids')

class Repository {
  constructor(db, collectionName, prefix) {
    this.db = db
    this.collectionName = collectionName
    this.prefix = prefix
  }

  all() {
    return this.db.collection(this.collectionName)
  }

  findById(id) {
    return this.all().find((item) => item.id === id) || null
  }

  filter(predicate) {
    return this.all().filter(predicate)
  }

  insert(item) {
    const now = nowIso()
    const row = {
      ...item,
      id: item.id || createId(this.prefix),
      createdAt: item.createdAt || now,
      updatedAt: now,
    }
    this.all().push(row)
    this.db.save()
    return row
  }

  upsert(id, patch) {
    const rows = this.all()
    const idx = rows.findIndex((item) => item.id === id)
    if (idx >= 0) {
      rows[idx] = { ...rows[idx], ...patch, id, updatedAt: nowIso() }
      this.db.save()
      return rows[idx]
    }
    return this.insert({ ...patch, id })
  }

  removeWhere(predicate) {
    const rows = this.all()
    const kept = rows.filter((item) => !predicate(item))
    const removed = rows.length - kept.length
    this.db.load()[this.collectionName] = kept
    if (removed > 0) this.db.save()
    return removed
  }
}

function createRepositories(db) {
  return {
    batches: new Repository(db, 'batches', 'batch'),
    dailyRecords: new Repository(db, 'dailyRecords', 'rec'),
    weighSamples: new Repository(db, 'weighSamples', 'weigh'),
    recommendations: new Repository(db, 'recommendations', 'recmd'),
    approvals: new Repository(db, 'approvals', 'approval'),
    executions: new Repository(db, 'executions', 'exec'),
    sceneStates: new Repository(db, 'sceneStates', 'scene'),
    modelRegistry: new Repository(db, 'modelRegistry', 'model'),
    auditLogs: new Repository(db, 'auditLogs', 'audit'),
  }
}

module.exports = { Repository, createRepositories }
