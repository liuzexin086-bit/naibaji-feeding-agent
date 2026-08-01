const v5 = require('../models/v5liteModel')
const { nowIso } = require('../utils/ids')

class SceneStateService {
  constructor(repos) {
    this.repos = repos
  }

  getSceneId(batchConfig) {
    return (batchConfig && (batchConfig.farmRoom || batchConfig.roomId || batchConfig.deviceId)) || 'default'
  }

  getOrCreate(batchConfig) {
    const sceneId = this.getSceneId(batchConfig)
    const existing = this.repos.sceneStates.filter((row) => row.sceneId === sceneId)[0]
    if (existing) return existing.state

    const state = v5.defaultSceneState()
    state.sceneId = sceneId
    this.repos.sceneStates.insert({
      sceneId,
      roomId: batchConfig && batchConfig.farmRoom,
      deviceId: batchConfig && batchConfig.deviceId,
      modelVersion: 'v5lite-v0.6',
      state,
      updatedAt: nowIso(),
    })
    return state
  }

  save(batchConfig, state) {
    const sceneId = this.getSceneId(batchConfig)
    const existing = this.repos.sceneStates.filter((row) => row.sceneId === sceneId)[0]
    const payload = {
      sceneId,
      roomId: batchConfig && batchConfig.farmRoom,
      deviceId: batchConfig && batchConfig.deviceId,
      modelVersion: 'v5lite-v0.6',
      state,
      updatedAt: nowIso(),
    }
    if (existing) return this.repos.sceneStates.upsert(existing.id, payload)
    return this.repos.sceneStates.insert(payload)
  }
}

module.exports = { SceneStateService }
