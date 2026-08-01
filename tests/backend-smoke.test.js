const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { startBackend } = require('../backend/src/server')

function request(baseUrl, method, route, body) {
  const url = new URL(baseUrl + route)
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let raw = ''
      res.on('data', (chunk) => { raw += chunk })
      res.on('end', () => {
        let parsed = {}
        if (raw.trim()) parsed = JSON.parse(raw)
        if (res.statusCode >= 400) {
          const err = new Error(raw)
          err.statusCode = res.statusCode
          reject(err)
          return
        }
        resolve(parsed)
      })
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naibaji-backend-'))
  const backend = await startBackend({ dataDir })
  try {
    const health = await request(backend.url, 'GET', '/health')
    assert.strictEqual(health.ok, true)

    const batchId = 'batch_test'
    const snapshot = {
      id: batchId,
      config: {
        name: 'test',
        startAge: 3,
        endAge: 6,
        startWeight: 2.3,
        headCount: 20,
        farmRoom: 'A-1',
        hasInitialWeightAnchor: true,
      },
      records: [
        {
          dayAge: 3,
          dayIndex: 0,
          headCount: 20,
          totalMilkG: 240,
          totalCreepG: 20,
          diarrheaMild: 0,
          diarrheaModerate: 0,
          diarrheaSevere: 0,
          death: 0,
          cull: 0,
          creepLevel: 2,
          uniformityLevel: 2,
          growthLevel: 2,
          actualMilkRecorded: true,
        },
        {
          dayAge: 4,
          dayIndex: 1,
          headCount: 20,
          totalMilkG: 320,
          totalCreepG: 30,
          diarrheaMild: 1,
          diarrheaModerate: 0,
          diarrheaSevere: 0,
          death: 0,
          cull: 0,
          creepLevel: 2,
          uniformityLevel: 2,
          growthLevel: 2,
          actualMilkRecorded: true,
        },
      ],
      currentDayIndex: 2,
      status: 'active',
      configLocked: true,
      controlStartDay: -1,
    }

    const saved = await request(backend.url, 'PUT', `/batches/${batchId}/snapshot`, snapshot)
    assert.strictEqual(saved.id, batchId)
    assert.strictEqual(saved.records.length, 2)
    assert.ok(saved.recommendations.length >= 2)
    assert.ok(saved.recommendations[0].finalRecommendedMilkG >= 0)

    const recId = saved.recommendations[0].id
    const approval = await request(backend.url, 'POST', `/recommendations/${recId}/approve`, {
      approved: true,
      approverId: 'test',
    })
    assert.strictEqual(approval.recommendationId, recId)

    const execution = await request(backend.url, 'POST', `/recommendations/${recId}/execute`, {
      executedMilkG: 230,
      leftoverRate: 0.01,
    })
    assert.strictEqual(execution.recommendationId, recId)

    const exportData = await request(backend.url, 'GET', `/batches/${batchId}/export`)
    assert.ok(Array.isArray(exportData.dailyRecords))

    const completion = await request(backend.url, 'POST', `/batches/${batchId}/complete`)
    assert.ok(completion.learningResult)
    assert.ok(completion.learningResult.dataQuality)

    console.log('backend smoke test passed')
  } finally {
    await backend.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
