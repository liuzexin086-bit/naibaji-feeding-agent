const { validateBatchConfig } = require('../validators/batchValidator')
const { validateDailyRecord } = require('../validators/dailyRecordValidator')
const { createId, nowIso } = require('../utils/ids')
const { notFound } = require('../utils/errors')

class BatchService {
  constructor(repos, services) {
    this.repos = repos
    this.services = services
  }

  list(includeRecords) {
    return this.repos.batches.all()
      .slice()
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
      .map((batch) => includeRecords ? this.get(batch.id) : batch)
  }

  get(id) {
    const batch = this.repos.batches.findById(id)
    if (!batch) return null
    const records = this.repos.dailyRecords
      .filter((row) => row.batchId === id)
      .sort((a, b) => (a.dayIndex || 0) - (b.dayIndex || 0))
    const recommendations = this.services.recommendation.listForBatch(id)
    return { ...batch, records, recommendations }
  }

  create(config) {
    validateBatchConfig(config)
    const plan = this.services.feedingPlan.generate(config)
    const batch = this.repos.batches.insert({
      config: { ...config, startWeight: plan.startWeight },
      currentDayIndex: 0,
      status: 'active',
      configLocked: false,
      controlStartDay: -1,
      modelVersion: 'v5lite-v0.6',
    })
    this.services.sceneState.getOrCreate(batch.config)
    return this.get(batch.id)
  }

  upsertSnapshot(id, snapshot) {
    const config = snapshot.config || {}
    validateBatchConfig(config)
    const plan = this.services.feedingPlan.generate(config)
    const batch = this.repos.batches.upsert(id, {
      config: { ...config, startWeight: config.startWeight || plan.startWeight },
      currentDayIndex: snapshot.currentDayIndex || 0,
      status: snapshot.status || 'active',
      configLocked: snapshot.configLocked === true,
      controlStartDay: snapshot.controlStartDay == null ? -1 : snapshot.controlStartDay,
      modelVersion: snapshot.modelVersion || 'v5lite-v0.6',
      createdAt: snapshot.createdAt || nowIso(),
      updatedAt: snapshot.updatedAt || nowIso(),
    })

    this.repos.dailyRecords.removeWhere((row) => row.batchId === id)
    this.repos.weighSamples.removeWhere((row) => row.batchId === id)
    const records = Array.isArray(snapshot.records) ? snapshot.records : []
    records.forEach((record, index) => this.saveRecord(id, record, index, false))
    this.services.recommendation.recomputeBatch(batch.id)
    if (batch.status === 'completed') this.services.batchLearning.complete(batch.id)
    return this.get(batch.id)
  }

  saveRecord(batchId, record, fallbackIndex, recompute = true) {
    const batch = this.repos.batches.findById(batchId)
    if (!batch) throw notFound('Batch not found')
    validateDailyRecord(record)
    const dayIndex = record.dayIndex == null
      ? Math.max(0, Number(record.dayAge || batch.config.startAge) - Number(batch.config.startAge))
      : Number(record.dayIndex)
    const row = this.repos.dailyRecords.insert({
      ...record,
      id: record.id || createId('rec'),
      batchId,
      dayIndex: Number.isFinite(dayIndex) ? dayIndex : fallbackIndex || 0,
      recordDate: record.recordDate || nowIso().slice(0, 10),
    })
    if (Array.isArray(record.weighSample)) {
      for (const sample of record.weighSample) {
        this.repos.weighSamples.insert({
          batchId,
          dailyRecordId: row.id,
          category: sample.category || 'sample',
          avgKg: Number(sample.avgKg),
          headCount: Number(sample.headCount),
          sampleType: sample.sampleType || 'manual',
        })
      }
    }
    if (recompute) this.services.recommendation.recomputeBatch(batchId)
    return row
  }
}

module.exports = { BatchService }
