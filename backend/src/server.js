const http = require('http')
const path = require('path')
const { JsonDatabase } = require('./storage/jsonDatabase')
const { createRepositories } = require('./repositories')
const { createServices } = require('./services')
const { HttpError, notFound, toErrorResponse } = require('./utils/errors')

function send(res, status, payload) {
  const body = JSON.stringify(payload == null ? {} : payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(body)
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 5 * 1024 * 1024) {
        reject(new HttpError(413, 'Request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!raw.trim()) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new HttpError(400, 'Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function routeKey(method, parts) {
  return `${method} ${parts.join('/')}`
}

function createBackend(options = {}) {
  const dataDir = options.dataDir || path.join(process.cwd(), '.data')
  const db = new JsonDatabase(path.join(dataDir, 'naibaji-db.json'))
  const repos = createRepositories(db)
  const services = createServices(repos)

  function seedModelRegistry() {
    if (repos.modelRegistry.all().length > 0) return
    repos.modelRegistry.insert({
      modelName: 'feeding-model',
      modelVersion: 'v1',
      status: 'active',
      paramsJson: {},
      notes: '基础胃容量和控奶模型',
      activatedAt: new Date().toISOString(),
    })
    repos.modelRegistry.insert({
      modelName: 'v5lite',
      modelVersion: 'v0.6',
      status: 'active',
      paramsJson: {},
      notes: '后端化生产版：风险修正、估重、推荐日志、审批与执行反馈',
      activatedAt: new Date().toISOString(),
    })
  }
  seedModelRegistry()

  async function handle(req, res) {
    if (req.method === 'OPTIONS') return send(res, 204, {})
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      const parts = url.pathname.split('/').filter(Boolean)
      if (parts[0] !== 'api') throw notFound('Route not found')
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await parseBody(req) : {}
      const p = parts.slice(1)

      if (routeKey(req.method, p) === 'GET health') {
        return send(res, 200, { ok: true, dataFile: db.filePath })
      }

      if (req.method === 'GET' && p[0] === 'batches' && p.length === 1) {
        return send(res, 200, { batches: services.batch.list(url.searchParams.get('includeRecords') === '1') })
      }
      if (req.method === 'POST' && p[0] === 'batches' && p.length === 1) {
        return send(res, 201, services.batch.create(body.config || body))
      }
      if (req.method === 'GET' && p[0] === 'batches' && p.length === 2) {
        const batch = services.batch.get(p[1])
        if (!batch) throw notFound('Batch not found')
        return send(res, 200, batch)
      }
      if (req.method === 'PUT' && p[0] === 'batches' && p[2] === 'snapshot') {
        return send(res, 200, services.batch.upsertSnapshot(p[1], body))
      }
      if (req.method === 'POST' && p[0] === 'batches' && p[2] === 'records') {
        return send(res, 201, services.batch.saveRecord(p[1], body))
      }
      if (req.method === 'GET' && p[0] === 'batches' && p[2] === 'recommendations') {
        return send(res, 200, { recommendations: services.recommendation.listForBatch(p[1]) })
      }
      if (req.method === 'POST' && p[0] === 'batches' && p[2] === 'complete') {
        const result = services.batchLearning.complete(p[1])
        if (!result) throw notFound('Batch not found')
        return send(res, 200, { learningResult: result, batch: services.batch.get(p[1]) })
      }
      if (req.method === 'GET' && p[0] === 'batches' && p[2] === 'export') {
        const data = services.export.trainingData(p[1])
        if (!data) throw notFound('Batch not found')
        return send(res, 200, data)
      }
      if (req.method === 'POST' && p[0] === 'recommendations' && p[2] === 'approve') {
        const approval = services.approval.approve(p[1], body)
        if (!approval) throw notFound('Recommendation not found')
        return send(res, 201, approval)
      }
      if (req.method === 'POST' && p[0] === 'recommendations' && p[2] === 'execute') {
        const execution = services.deviceSync.recordExecution(p[1], body)
        if (!execution) throw notFound('Recommendation not found')
        return send(res, 201, execution)
      }
      if (req.method === 'GET' && p[0] === 'model' && p[1] === 'registry') {
        return send(res, 200, { models: repos.modelRegistry.all() })
      }
      if (req.method === 'GET' && p[0] === 'scene-states') {
        const row = repos.sceneStates.filter((item) => item.sceneId === p[1])[0]
        if (!row) throw notFound('Scene state not found')
        return send(res, 200, row)
      }

      throw notFound('Route not found')
    } catch (error) {
      const status = error.status || 500
      send(res, status, toErrorResponse(error))
    }
  }

  const server = http.createServer(handle)
  return { server, db, repos, services }
}

function startBackend(options = {}) {
  const backend = createBackend(options)
  const port = options.port == null ? 0 : options.port
  const host = options.host || '127.0.0.1'
  return new Promise((resolve, reject) => {
    backend.server.once('error', reject)
    backend.server.listen(port, host, () => {
      const address = backend.server.address()
      resolve({
        ...backend,
        port: address.port,
        url: `http://${host}:${address.port}/api`,
        close: () => new Promise((done) => backend.server.close(done)),
      })
    })
  })
}

module.exports = { createBackend, startBackend }
