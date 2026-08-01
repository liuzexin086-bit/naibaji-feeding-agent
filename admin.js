/* 奶爸机独立管理员后台：仅使用 Supabase Auth、RLS 与管理员 RPC；不使用 STORAGE 或 SupabaseSync。 */
(function () {
  'use strict'

  var PAGE_SIZE = 50
  var PROFILE_PAGE_SIZE = 500
  var AdminState = window.AdminState = {
    user: null,
    page: 1,
    total: 0,
    rows: [],
    selected: new Set(),
    filters: null,
    ownerEmails: {},
    initializedUserId: null,
    detail: null,
    activeView: 'batchAdminView',
    apiConfigLoaded: false,
    apiConfig: null,
    sopTemplates: [],
    sopLoaded: false
  }

  var DEFAULT_SOP_CONFIG = {
    templateId: 'naibaji-early-weaning', version: '2026.07.31-v4-sop-priority',
    timezone: 'Asia/Shanghai', utcOffsetMinutes: 480,
    defaultAdmissionDeadlineLocal: '09:00', preferredFirstTeachingLocal: '17:00',
    adaptationMinHours: 8, adaptationMaxHours: 10, teachingIntervalHours: 3,
    teachingLiquidMlPerHead: 10, teachingPowderGramsPerTwenty: 35,
    devicePowderPrecisionGrams: 1,
    teachingProgramEndDayOffset: 1, teachingProgramEndLocal: '08:00',
    teachingDirectTotalPowderGrams: 0,
    quantityAuthorityOrder: ['sop_direct', 'sop_indirect', 'production_model'],
    modelQuantityFallbackEnabled: true,
    teachingQuantitySource: 'sop',
    deviceConfigurationFields: ['powderGrams', 'timeLocal'],
    teachingLatestDay: 3,
    waterClosedBeforeAgeDays: 12, waterPolicyEnabled: true,
    teachingProgramEnabled: true, gentleMovementEnabled: true,
    laggardEvaluationEnabled: true, creepFeedEnabled: true,
    soakedFeedEnabled: true, transitionEnabled: true, maintenanceEnabled: true,
    productionProgramStartLocal: '00:00', customTasks: [],
    standardCleanEveryDays: 2, deepCleanEveryDays: 7,
    creepAgeStart: 8, creepAgeEnd: 11, soakedFeedAgeStart: 12,
    soakedFeedAgeEnd: 14, soakedFeedRatio: '4:1', transitionAgeStart: 20,
    transitionMealsMin: 2, transitionMealsMax: 3
  }
  var SOP_FIELDS = [
    ['timezone', '场区时区', 'text', null],
    ['utcOffsetMinutes', 'UTC 偏移（分钟）', 'number', '1'],
    ['defaultAdmissionDeadlineLocal', '默认入栏截止', 'time', null],
    ['preferredFirstTeachingLocal', '首选首次教奶', 'time', null],
    ['adaptationMinHours', '适应期最短（小时）', 'number', '0.5'],
    ['adaptationMaxHours', '适应期最长（小时）', 'number', '0.5'],
    ['teachingIntervalHours', '教奶间隔（小时）', 'number', '0.5'],
    ['teachingLiquidMlPerHead', 'SOP 奶液参考（mL/头/次）', 'number', '0.1'],
    ['teachingPowderGramsPerTwenty', 'SOP 单餐粉量（g/20头/次，优先执行）', 'number', '0.1'],
    ['teachingDirectTotalPowderGrams', 'SOP 教奶程序直接总粉量（g，0=按单餐参数推导）', 'number', '0.1'],
    ['devicePowderPrecisionGrams', '设备最小精度（g）', 'number', '0.1'],
    ['teachingProgramEndDayOffset', '教奶截止日偏移（入栏日=0）', 'number', '1'],
    ['teachingProgramEndLocal', '教奶截止/早巡栏时间', 'time', null],
    ['teachingLatestDay', '掉队猪最迟评估日', 'number', '1'],
    ['waterClosedBeforeAgeDays', '恢复给水日龄', 'number', '1'],
    ['waterPolicyEnabled', '启用饮水策略', 'checkbox', null],
    ['teachingProgramEnabled', '启用设备教奶程序', 'checkbox', null],
    ['gentleMovementEnabled', '启用轻柔驱赶', 'checkbox', null],
    ['laggardEvaluationEnabled', '启用第三天掉队评估', 'checkbox', null],
    ['creepFeedEnabled', '启用教槽任务', 'checkbox', null],
    ['soakedFeedEnabled', '启用奶泡料任务', 'checkbox', null],
    ['transitionEnabled', '启用转料任务', 'checkbox', null],
    ['maintenanceEnabled', '启用维护清洗任务', 'checkbox', null],
    ['productionProgramStartLocal', '正式饲喂程序起点', 'time', null],
    ['standardCleanEveryDays', '标准清洗周期（天）', 'number', '1'],
    ['deepCleanEveryDays', '深度清洗周期（天）', 'number', '1'],
    ['creepAgeStart', '教槽开始日龄', 'number', '1'],
    ['creepAgeEnd', '教槽结束日龄', 'number', '1'],
    ['soakedFeedAgeStart', '奶泡料开始日龄', 'number', '1'],
    ['soakedFeedAgeEnd', '奶泡料结束日龄', 'number', '1'],
    ['soakedFeedRatio', '奶料比例', 'text', null],
    ['transitionAgeStart', '转料开始日龄', 'number', '1'],
    ['transitionMealsMin', '过渡最少餐次', 'number', '1'],
    ['transitionMealsMax', '过渡最多餐次', 'number', '1']
  ]

  function byId(id) { return document.getElementById(id) }
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }
  function dateText(value) {
    if (!value) return '—'
    var date = new Date(value)
    return isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false })
  }
  function valueText(value) {
    return value == null || value === '' ? '—' : String(value)
  }
  function batchKey(userId, batchId) { return JSON.stringify([userId, batchId]) }
  function encodeKey(userId, batchId) { return encodeURIComponent(batchKey(userId, batchId)) }
  function decodeKey(value) { return JSON.parse(decodeURIComponent(value)) }
  function showOnly(id) {
    ;['loadingScreen', 'loginScreen', 'noPermissionScreen', 'adminRoot'].forEach(function (screenId) {
      byId(screenId).hidden = screenId !== id
    })
  }
  function setLoginMessage(text, isError) {
    var el = byId('loginMessage')
    el.textContent = text || ''
    el.style.color = isError ? '' : 'var(--muted)'
  }
  function setNotice(text, isError) {
    var el = byId('queryNotice')
    el.textContent = text || ''
    el.className = 'notice' + (isError ? '' : ' ok')
  }
  function setExportProgress(text) {
    var el = byId('exportProgress')
    el.textContent = text || ''
    el.hidden = !text
  }
  function errorText(error) {
    if (!error) return '未知错误'
    if (error.message === 'ADMIN_REQUIRED' || error.code === '42501') return '当前账号没有管理员权限。'
    var code = error.code || error.message
    var messages = {
      NBJ_ADMIN_REQUIRED: '当前账号没有管理员权限。',
      NBJ_AGENT_CONFIG_MANAGED_BY_DEPLOYMENT: '当前环境的 API 配置由部署变量管理，不能从页面修改。',
      NBJ_AGENT_API_KEY_REQUIRED: '启用或校验 Agent 前必须配置 API Key。',
      NBJ_AGENT_API_KEY_SAVE_FAILED: 'API Key 没有保存成功，请重新输入。',
      NBJ_AGENT_MODEL_NOT_FOUND: '该供应商下没有找到所填模型 ID。',
      NBJ_AGENT_PROVIDER_INVALID: '请选择支持的模型供应商。',
      NBJ_AGENT_BASE_URL_INVALID: 'API 地址必须是 HTTPS 地址（本机回环地址可使用 HTTP）。',
      NBJ_AGENT_PROVIDER_TIMEOUT: '现场 API 连接超时。',
      NBJ_AGENT_PROVIDER_CONNECTION_FAILED: '无法连接现场 API，请检查地址、代理和网络。',
      NBJ_SOP_TEMPLATE_IMMUTABLE: '已发布模板不可原地修改，请发布新版本。',
      NBJ_SOP_TEMPLATE_NOT_FOUND: '来源 SOP 模板不存在。',
      NBJ_SOP_TEMPLATE_CONFIG_INVALID: 'SOP 配置必须是 JSON 对象。'
    }
    if (messages[code]) return messages[code]
    if (String(code).indexOf('NBJ_AGENT_PROVIDER_HTTP_') === 0) {
      return '现场 API 拒绝了校验请求（HTTP ' + String(code).split('_').pop() + '），请检查 API Key、地址和权限。'
    }
    return error.message || String(error)
  }
  function isAdminConflict(error) {
    return !!error && (error.code === 'P0001' || String(error.message || '').indexOf('ADMIN_BATCH_CONFLICT') >= 0)
  }
  function requireClient() {
    if (!window.supabaseClient) throw new Error('登录服务未加载，请检查网络连接后刷新页面。')
    return window.supabaseClient
  }
  function setElementNotice(id, text, isError) {
    var el = byId(id)
    el.textContent = text || ''
    el.className = 'notice' + (text && !isError ? ' ok' : '')
  }
  async function adminApi(path, options) {
    var sessionResult = await requireClient().auth.getSession()
    if (sessionResult.error) throw sessionResult.error
    var session = sessionResult.data && sessionResult.data.session
    if (!session) throw new Error('登录会话已失效，请重新登录。')
    var requestOptions = Object.assign({}, options || {})
    requestOptions.headers = Object.assign({}, requestOptions.headers || {}, {
      authorization: 'Bearer ' + session.access_token
    })
    if (requestOptions.body) requestOptions.headers['content-type'] = 'application/json'
    var response = await fetch(path, requestOptions)
    var payload = await response.json().catch(function () { return {} })
    if (!response.ok) {
      var error = new Error(payload.code || 'API 请求失败（HTTP ' + response.status + '）')
      error.code = payload.code
      throw error
    }
    return payload
  }

  function readFilters() {
    return {
      email: byId('filterEmail').value.trim(),
      name: byId('filterName').value.trim(),
      farmRoom: byId('filterFarmRoom').value.trim(),
      status: byId('filterStatus').value,
      updatedFrom: byId('filterUpdatedFrom').value,
      updatedTo: byId('filterUpdatedTo').value
    }
  }
  function applyFilterInputs(filters) {
    byId('filterEmail').value = filters.email || ''
    byId('filterName').value = filters.name || ''
    byId('filterFarmRoom').value = filters.farmRoom || ''
    byId('filterStatus').value = filters.status || ''
    byId('filterUpdatedFrom').value = filters.updatedFrom || ''
    byId('filterUpdatedTo').value = filters.updatedTo || ''
  }

  var AdminSync = window.AdminSync = {
    async verifyAdmin() {
      var result = await requireClient().rpc('is_admin')
      if (result.error) throw result.error
      return result.data === true
    },

    async resolveEmailUserIds(email) {
      if (!email) return null
      var ids = []
      var from = 0
      while (true) {
        var result = await requireClient().from('profiles').select('user_id').ilike('email', '%' + email + '%').range(from, from + PROFILE_PAGE_SIZE - 1)
        if (result.error) throw result.error
        var rows = result.data || []
        for (var i = 0; i < rows.length; i++) ids.push(rows[i].user_id)
        if (rows.length < PROFILE_PAGE_SIZE) return ids
        from += PROFILE_PAGE_SIZE
      }
    },

    batchQuery(filters, emailUserIds, includeCount) {
      var query = requireClient().from('batches').select(
        'user_id,id,config,records,current_day_index,status,config_locked,control_start_day,revision,created_at,updated_at',
        includeCount ? { count: 'exact' } : undefined
      )
      if (emailUserIds) {
        if (!emailUserIds.length) return null
        query = query.in('user_id', emailUserIds)
      }
      if (filters.name) query = query.ilike('config->>name', '%' + filters.name + '%')
      if (filters.farmRoom) query = query.ilike('config->>farmRoom', '%' + filters.farmRoom + '%')
      if (filters.status) query = query.eq('status', filters.status)
      if (filters.updatedFrom) query = query.gte('updated_at', filters.updatedFrom + 'T00:00:00')
      if (filters.updatedTo) query = query.lte('updated_at', filters.updatedTo + 'T23:59:59.999')
      return query.order('updated_at', { ascending: false })
    },

    async ownerEmailMap(userIds) {
      var unique = Array.from(new Set((userIds || []).filter(Boolean)))
      var map = {}
      for (var from = 0; from < unique.length; from += 100) {
        var ids = unique.slice(from, from + 100)
        var result = await requireClient().from('profiles').select('user_id,email').in('user_id', ids)
        if (result.error) throw result.error
        ;(result.data || []).forEach(function (profile) { map[profile.user_id] = profile.email || '' })
      }
      return map
    },

    async fetchPage(filters, page) {
      var emailUserIds = await this.resolveEmailUserIds(filters.email)
      var query = this.batchQuery(filters, emailUserIds, true)
      if (!query) return { rows: [], total: 0, emails: {} }
      var start = (page - 1) * PAGE_SIZE
      var result = await query.range(start, start + PAGE_SIZE - 1)
      if (result.error) throw result.error
      var rows = result.data || []
      return { rows: rows, total: result.count || 0, emails: await this.ownerEmailMap(rows.map(function (row) { return row.user_id })) }
    },

    async fetchOne(userId, batchId) {
      var result = await requireClient().from('batches').select('*').eq('user_id', userId).eq('id', batchId).maybeSingle()
      if (result.error) throw result.error
      if (!result.data) throw new Error('批次不存在，或您已失去访问权限。')
      return result.data
    },

    async loadStats() {
      var client = requireClient()
      var results = await Promise.all([
        client.from('profiles').select('*', { count: 'exact', head: true }),
        client.from('batches').select('*', { count: 'exact', head: true }),
        client.from('batches').select('*', { count: 'exact', head: true }).eq('status', 'active'),
        client.from('batches').select('*', { count: 'exact', head: true }).eq('status', 'completed')
      ])
      for (var i = 0; i < results.length; i++) if (results[i].error) throw results[i].error
      return { users: results[0].count || 0, batches: results[1].count || 0, active: results[2].count || 0, completed: results[3].count || 0 }
    },

    async saveSnapshot(payload) {
      var result = await requireClient().rpc('admin_save_batch_snapshot', payload)
      if (result.error) throw result.error
      var row = Array.isArray(result.data) ? result.data[0] : result.data
      if (!row) throw new Error('保存后未收到批次数据。')
      return row
    },

    async loadSopTemplates() {
      var result = await requireClient().from('feeding_sop_templates')
        .select('id,template_key,version,name,config,status,created_by,created_at')
        .order('created_at', { ascending: false })
      if (result.error) throw result.error
      return result.data || []
    },

    async publishSopTemplate(payload) {
      var result = await requireClient().rpc('admin_publish_feeding_sop_template', payload)
      if (result.error) throw result.error
      return Array.isArray(result.data) ? result.data[0] : result.data
    }
  }

  function renderStats(stats) {
    byId('statUsers').textContent = stats.users
    byId('statBatches').textContent = stats.batches
    byId('statActive').textContent = stats.active
    byId('statCompleted').textContent = stats.completed
  }
  function renderRows() {
    var body = byId('batchRows')
    var html = ''
    AdminState.rows.forEach(function (row) {
      var config = row.config || {}
      var key = batchKey(row.user_id, row.id)
      var encoded = encodeKey(row.user_id, row.id)
      var statusClass = row.status === 'completed' ? ' completed' : ''
      html += '<tr>' +
        '<td><input class="row-select" type="checkbox" data-key="' + encoded + '"' + (AdminState.selected.has(key) ? ' checked' : '') + '></td>' +
        '<td>' + escapeHtml(AdminState.ownerEmails[row.user_id] || '—') + '</td>' +
        '<td>' + escapeHtml(valueText(config.name)) + '</td>' +
        '<td>' + escapeHtml(valueText(config.farmRoom)) + '</td>' +
        '<td>' + escapeHtml(valueText(config.startAge)) + '</td>' +
        '<td>' + escapeHtml(valueText(config.endAge)) + '</td>' +
        '<td><span class="status' + statusClass + '">' + (row.status === 'completed' ? '已完成' : '进行中') + '</span></td>' +
        '<td>' + escapeHtml(String((row.records || []).length)) + '</td>' +
        '<td>' + escapeHtml(valueText(row.revision)) + '</td>' +
        '<td>' + escapeHtml(dateText(row.updated_at)) + '</td>' +
        '<td><div class="table-actions"><button class="btn btn-outline" data-action="view" data-key="' + encoded + '" type="button">查看</button><button class="btn btn-outline" data-action="edit" data-key="' + encoded + '" type="button">修改</button><button class="btn btn-outline" data-action="export" data-key="' + encoded + '" type="button">导出</button></div></td>' +
      '</tr>'
    })
    body.innerHTML = html
    byId('emptyState').hidden = AdminState.rows.length !== 0
    byId('selectAll').checked = AdminState.rows.length > 0 && AdminState.rows.every(function (row) { return AdminState.selected.has(batchKey(row.user_id, row.id)) })
    var pageCount = Math.max(1, Math.ceil(AdminState.total / PAGE_SIZE))
    byId('pageInfo').textContent = '第 ' + AdminState.page + ' / ' + pageCount + ' 页，共 ' + AdminState.total + ' 条'
    byId('prevPageButton').disabled = AdminState.page <= 1
    byId('nextPageButton').disabled = AdminState.page >= pageCount
    byId('resultSummary').textContent = AdminState.selected.size ? '已选 ' + AdminState.selected.size + ' 条' : ''
  }
  async function loadPage(page, clearSelection) {
    if (!AdminState.user) return
    if (clearSelection) AdminState.selected.clear()
    setNotice('正在查询……', false)
    var data = await AdminSync.fetchPage(AdminState.filters, page)
    AdminState.page = page
    AdminState.rows = data.rows
    AdminState.total = data.total
    AdminState.ownerEmails = data.emails
    renderRows()
    setNotice('', false)
  }
  async function refreshStats() { renderStats(await AdminSync.loadStats()) }

  function setAdminView(viewId) {
    AdminState.activeView = viewId
    document.querySelectorAll('.admin-view').forEach(function (view) { view.hidden = view.id !== viewId })
    document.querySelectorAll('.admin-tab').forEach(function (tab) {
      var selected = tab.dataset.adminView === viewId
      tab.setAttribute('aria-selected', selected ? 'true' : 'false')
      tab.tabIndex = selected ? 0 : -1
    })
  }

  function renderApiConfig(config) {
    var configured = config && config.configured
    byId('apiProvider').value = (config && config.provider) || 'anthropic'
    byId('apiModel').value = (config && config.model) || ''
    byId('apiMode').value = (config && config.apiMode) || 'responses'
    byId('apiMode').disabled = (config && config.provider) !== 'openai'
    byId('apiBaseUrl').value = (config && config.baseUrl) || ((config && config.provider) === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com/v1')
    byId('apiEnabled').checked = !!(config && config.enabled)
    byId('apiKey').value = ''
    byId('apiClearKey').checked = false
    byId('apiStatusEnabled').textContent = configured ? (config.enabled ? '已启用' : '已停用') : '未配置'
    byId('apiStatusProvider').textContent = configured ? valueText(config.provider) : '—'
    byId('apiStatusModel').textContent = configured ? valueText(config.model) : '—'
    byId('apiStatusMode').textContent = configured ? ((config.apiMode || 'responses') === 'chat_completions' ? 'Chat Completions' : 'Responses API') : '—'
    byId('apiStatusBaseUrl').textContent = configured ? valueText(config.baseUrl) : '—'
    byId('apiStatusKey').textContent = config && config.hasApiKey ? (config.apiKeyHint || '已保存') : '未保存'
    byId('apiStatusUpdated').textContent = dateText(config && config.updatedAt)
    byId('apiStatusUpdatedBy').textContent = valueText(config && config.updatedBy)
    AdminState.apiConfig = config || null
  }

  async function loadApiConfig(force) {
    if (AdminState.apiConfigLoaded && !force) return
    setElementNotice('apiConfigNotice', '正在读取配置……', false)
    try {
      var config = await adminApi('/api/admin/feeding-agent/config')
      renderApiConfig(config)
      AdminState.apiConfigLoaded = true
      setElementNotice('apiConfigNotice', '', false)
    } catch (error) {
      setElementNotice('apiConfigNotice', errorText(error), true)
      throw error
    }
  }

  function renderSopFriendlyFields() {
    byId('sopFriendlyFields').innerHTML = SOP_FIELDS.map(function (field) {
      var key = field[0]
      var label = field[1]
      var type = field[2]
      var step = field[3]
      if (type === 'checkbox') {
        return '<label class="inline-check"><input type="checkbox" data-sop-key="' + escapeHtml(key) + '">' + escapeHtml(label) + '</label>'
      }
      return '<label class="field">' + escapeHtml(label) + '<input type="' + type + '" data-sop-key="' + escapeHtml(key) + '"' +
        (step ? ' step="' + escapeHtml(step) + '"' : '') + ' required></label>'
    }).join('')
  }

  function configFromFriendlyFields() {
    var config = JSON.parse(byId('sopConfigJson').value || '{}')
    SOP_FIELDS.forEach(function (field) {
      var input = document.querySelector('[data-sop-key="' + field[0] + '"]')
      if (field[2] === 'checkbox') config[field[0]] = input.checked
      else if (field[2] === 'number') config[field[0]] = Number(input.value)
      else config[field[0]] = input.value.trim()
    })
    config.templateId = byId('sopTemplateKey').value.trim()
    config.version = byId('sopVersion').value.trim() || config.version
    return config
  }

  function populateFriendlyFields(config) {
    SOP_FIELDS.forEach(function (field) {
      var input = document.querySelector('[data-sop-key="' + field[0] + '"]')
      if (!input) return
      if (field[2] === 'checkbox') input.checked = config[field[0]] === true
      else input.value = config[field[0]] == null ? '' : String(config[field[0]])
    })
  }

  function writeSopConfigJson() {
    try {
      byId('sopConfigJson').value = JSON.stringify(configFromFriendlyFields(), null, 2)
      setElementNotice('sopNotice', '', false)
    } catch (error) {
      setElementNotice('sopNotice', '高级配置 JSON 格式无效。', true)
    }
  }

  function resetSopEditor(template) {
    var config = Object.assign({}, DEFAULT_SOP_CONFIG, template && template.config ? template.config : {})
    byId('sopBaseTemplateId').value = template ? template.id : ''
    byId('sopTemplateKey').value = template ? template.template_key : config.templateId
    byId('sopTemplateKey').readOnly = !!template
    byId('sopVersion').value = ''
    byId('sopName').value = template ? template.name : '奶爸机超早期断奶 SOP'
    byId('sopRetireBase').checked = !!template
    byId('sopEditorTitle').textContent = template ? '基于 ' + template.version + ' 发布新版本' : '发布首个 SOP 版本'
    populateFriendlyFields(config)
    byId('sopConfigJson').value = JSON.stringify(config, null, 2)
    setElementNotice('sopNotice', '', false)
  }

  function renderSopTemplates() {
    var body = byId('sopTemplateRows')
    body.innerHTML = AdminState.sopTemplates.map(function (template) {
      return '<tr><td>' + escapeHtml(template.template_key) + '</td><td>' + escapeHtml(template.version) +
        '</td><td>' + escapeHtml(template.name) + '</td><td><span class="template-status ' +
        escapeHtml(template.status) + '">' + (template.status === 'published' ? '已发布' : '已退役') +
        '</span></td><td>' + escapeHtml(dateText(template.created_at)) +
        '</td><td><button class="btn btn-outline" type="button" data-clone-sop="' +
        escapeHtml(template.id) + '">复制为新版本</button></td></tr>'
    }).join('')
    byId('sopEmptyState').hidden = AdminState.sopTemplates.length !== 0
  }

  async function loadSopTemplates(force) {
    if (AdminState.sopLoaded && !force) return
    setElementNotice('sopNotice', '正在读取 SOP 版本……', false)
    try {
      AdminState.sopTemplates = await AdminSync.loadSopTemplates()
      AdminState.sopLoaded = true
      renderSopTemplates()
      if (!byId('sopBaseTemplateId').value) {
        var published = AdminState.sopTemplates.find(function (item) { return item.status === 'published' })
        resetSopEditor(published || null)
      }
      setElementNotice('sopNotice', '', false)
    } catch (error) {
      setElementNotice('sopNotice', errorText(error), true)
      throw error
    }
  }

  function validateSopConfig(config) {
    SOP_FIELDS.forEach(function (field) {
      var value = config[field[0]]
      if (field[2] === 'number' && !Number.isFinite(value)) throw new Error(field[1] + '必须是有效数字。')
      if (field[2] !== 'checkbox' && (value === '' || value == null)) throw new Error(field[1] + '不能为空。')
    })
    if (config.adaptationMaxHours < config.adaptationMinHours) throw new Error('适应期最长时间不能小于最短时间。')
    if (config.teachingProgramEndDayOffset < 0) throw new Error('教奶截止日偏移不能小于 0。')
    if (config.teachingQuantitySource !== 'sop') throw new Error('数量权威必须设置为 SOP 优先。')
    if (JSON.stringify(config.quantityAuthorityOrder) !== JSON.stringify(['sop_direct', 'sop_indirect', 'production_model'])) {
      throw new Error('数量优先级必须是 SOP 直接总量、SOP 参数推导、生产模型兜底。')
    }
    if (config.modelQuantityFallbackEnabled !== true) throw new Error('必须启用生产模型总量兜底。')
    if (config.teachingDirectTotalPowderGrams < 0 || config.teachingPowderGramsPerTwenty < 0) {
      throw new Error('SOP 粉量不能小于 0。')
    }
    if (JSON.stringify(config.deviceConfigurationFields) !== JSON.stringify(['powderGrams', 'timeLocal'])) {
      throw new Error('设备设置字段只能是 powderGrams 和 timeLocal。')
    }
    if (config.creepAgeEnd < config.creepAgeStart) throw new Error('教槽结束日龄不能小于开始日龄。')
    if (config.soakedFeedAgeEnd < config.soakedFeedAgeStart) throw new Error('奶泡料结束日龄不能小于开始日龄。')
    if (config.transitionMealsMax < config.transitionMealsMin) throw new Error('过渡最多餐次不能小于最少餐次。')
    if (!Array.isArray(config.customTasks)) throw new Error('customTasks 必须是数组。')
    config.customTasks.forEach(function (task, index) {
      if (!task || typeof task !== 'object' || Array.isArray(task)) {
        throw new Error('自定义任务 #' + (index + 1) + ' 必须是对象。')
      }
      if (!String(task.title || '').trim()) throw new Error('自定义任务 #' + (index + 1) + ' 缺少 title。')
      if (!Number.isFinite(Number(task.ageDay))) throw new Error('自定义任务 #' + (index + 1) + ' 的 ageDay 无效。')
      if (!/^\d{2}:\d{2}$/.test(String(task.localTime || ''))) {
        throw new Error('自定义任务 #' + (index + 1) + ' 的 localTime 必须是 HH:mm。')
      }
      if (task.planSource && ['sop_teaching', 'production_model', 'sop_transition'].indexOf(task.planSource) < 0) {
        throw new Error('自定义任务 #' + (index + 1) + ' 的 planSource 无效。')
      }
    })
  }

  function detailItem(label, value) {
    return '<div class="detail-item"><label>' + escapeHtml(label) + '</label><div>' + escapeHtml(valueText(value)) + '</div></div>'
  }
  function recordsTable(records) {
    if (!records || !records.length) return '<div class="empty">暂无每日 records。</div>'
    var keySet = {}
    records.forEach(function (record) { Object.keys(record || {}).forEach(function (key) { keySet[key] = true }) })
    var keys = Object.keys(keySet)
    var html = '<div class="table-wrap record-table"><table><thead><tr>'
    keys.forEach(function (key) { html += '<th>' + escapeHtml(key) + '</th>' })
    html += '</tr></thead><tbody>'
    records.forEach(function (record) {
      html += '<tr>'
      keys.forEach(function (key) {
        var value = record[key]
        if (value && typeof value === 'object') value = JSON.stringify(value)
        html += '<td>' + escapeHtml(valueText(value)) + '</td>'
      })
      html += '</tr>'
    })
    return html + '</tbody></table></div>'
  }
  async function openDetail(userId, batchId) {
    var row = await AdminSync.fetchOne(userId, batchId)
    var emails = await AdminSync.ownerEmailMap([userId])
    var config = row.config || {}
    AdminState.detail = { row: row, email: emails[userId] || '—' }
    var grid = [
      ['用户邮箱', AdminState.detail.email], ['批次 ID', row.id], ['批次名称', config.name], ['栏位', config.farmRoom],
      ['健康状态', config.healthStatus], ['起始日龄', config.startAge], ['最终日龄', config.endAge], ['初重', config.startWeight],
      ['头数', config.headCount], ['胎次', config.sowParity], ['产子数', config.litterSize], ['状态', row.status],
      ['当前进度', row.current_day_index], ['revision', row.revision], ['创建时间', dateText(row.created_at)], ['更新时间', dateText(row.updated_at)]
    ]
    byId('detailBody').innerHTML = '<div class="detail-grid">' + grid.map(function (item) { return detailItem(item[0], item[1]) }).join('') + '</div><h3 style="margin:20px 0 0">完整 records</h3>' + recordsTable(row.records || [])
    byId('detailModal').hidden = false
  }
  async function openEdit(userId, batchId) {
    var row = await AdminSync.fetchOne(userId, batchId)
    byId('editUserId').value = userId
    byId('editBatchId').value = row.id
    byId('editRevision').value = String(row.revision)
    byId('editConfig').value = JSON.stringify(row.config || {}, null, 2)
    byId('editRecords').value = JSON.stringify(row.records || [], null, 2)
    byId('editCurrentDay').value = row.current_day_index
    byId('editStatus').value = row.status
    byId('editConfigLocked').value = row.config_locked ? 'true' : 'false'
    byId('editControlStartDay').value = row.control_start_day
    byId('editMessage').textContent = ''
    byId('editModal').hidden = false
  }
  function closeModal(id) { byId(id).hidden = true }

  function trainingDataFor(row) {
    var config = row.config || {}
    var plan = null
    try {
      if (typeof generatePlan === 'function') {
        plan = generatePlan({ startAge: config.startAge, endAge: config.endAge, startWeight: config.startWeight, headCount: config.headCount })
      }
    } catch (error) {
      plan = null
    }
    if (typeof exportTrainingData !== 'function') throw new Error('训练数据导出模型未加载。')
    return exportTrainingData({
      records: row.records || [], startAge: config.startAge, endAge: config.endAge, startWeight: config.startWeight,
      headCount: config.headCount, sowParity: config.sowParity, litterSize: config.litterSize,
      healthStatus: config.healthStatus, farmRoom: config.farmRoom,
      totalMilkPlanG: plan && plan.totalMilkPlanG, standardWeight: plan && plan.standardWeight
    })
  }
  function timestampForFilename(date) {
    function p(value) { return String(value).padStart(2, '0') }
    return date.getFullYear() + p(date.getMonth() + 1) + p(date.getDate()) + '-' + p(date.getHours()) + p(date.getMinutes()) + p(date.getSeconds())
  }
  function downloadExport(rows, emails) {
    var batches = rows.map(function (row) {
      return { owner: { userId: row.user_id, email: emails[row.user_id] || null }, snapshot: row, trainingData: trainingDataFor(row) }
    })
    var output = { exportVersion: 'naibaji-admin-v1', exportedAt: new Date().toISOString(), batchCount: batches.length, batches: batches }
    var blob = new Blob([JSON.stringify(output, null, 2)], { type: 'application/json;charset=utf-8' })
    var url = URL.createObjectURL(blob)
    var link = document.createElement('a')
    link.href = url
    link.download = '奶爸机-批次批量导出-' + timestampForFilename(new Date()) + '.json'
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(function () { URL.revokeObjectURL(url) }, 1000)
  }
  async function exportRows(rows) {
    if (!rows.length) throw new Error('没有可导出的批次。')
    setExportProgress('正在生成导出文件（共 ' + rows.length + ' 个批次）……')
    var emails = await AdminSync.ownerEmailMap(rows.map(function (row) { return row.user_id }))
    downloadExport(rows, emails)
    setExportProgress('导出完成：' + rows.length + ' 个批次。')
    setTimeout(function () { setExportProgress('') }, 1800)
  }
  async function exportSelected() {
    var keys = Array.from(AdminState.selected)
    if (!keys.length) throw new Error('请先勾选要导出的批次。')
    var rows = []
    for (var i = 0; i < keys.length; i++) {
      var pair = JSON.parse(keys[i])
      setExportProgress('正在读取选中批次 ' + (i + 1) + ' / ' + keys.length + '……')
      rows.push(await AdminSync.fetchOne(pair[0], pair[1]))
    }
    await exportRows(rows)
  }
  async function exportFiltered() {
    var filters = AdminState.filters
    var ids = await AdminSync.resolveEmailUserIds(filters.email)
    var query = AdminSync.batchQuery(filters, ids, true)
    if (!query) return exportRows([])
    var first = await query.range(0, 199)
    if (first.error) throw first.error
    var total = first.count || 0
    var rows = first.data || []
    setExportProgress('正在读取筛选结果 ' + rows.length + ' / ' + total + '……')
    for (var from = 200; from < total; from += 200) {
      var pageQuery = AdminSync.batchQuery(filters, ids, false)
      var page = await pageQuery.range(from, Math.min(from + 199, total - 1))
      if (page.error) throw page.error
      rows = rows.concat(page.data || [])
      setExportProgress('正在读取筛选结果 ' + rows.length + ' / ' + total + '……')
    }
    await exportRows(rows)
  }

  async function initializeForUser(user) {
    if (!user || AdminState.initializedUserId === user.id) return
    AdminState.initializedUserId = user.id
    showOnly('loadingScreen')
    try {
      if (!await AdminSync.verifyAdmin()) {
        AdminState.user = null
        showOnly('noPermissionScreen')
        return
      }
      AdminState.user = user
      AdminState.page = 1
      AdminState.total = 0
      AdminState.rows = []
      AdminState.selected.clear()
      AdminState.filters = readFilters()
      AdminState.apiConfigLoaded = false
      AdminState.apiConfig = null
      AdminState.sopLoaded = false
      AdminState.sopTemplates = []
      setAdminView('batchAdminView')
      byId('adminEmail').textContent = user.email || user.id
      showOnly('adminRoot')
      await Promise.all([refreshStats(), loadPage(1, false)])
    } catch (error) {
      console.warn('[admin] 初始化失败', error)
      AdminState.user = null
      AdminState.initializedUserId = null
      showOnly('loginScreen')
      setLoginMessage('无法验证管理员权限：' + errorText(error), true)
    }
  }
  function showLogin(message) {
    AdminState.user = null
    AdminState.initializedUserId = null
    AdminState.apiConfigLoaded = false
    AdminState.apiConfig = null
    AdminState.sopLoaded = false
    showOnly('loginScreen')
    setLoginMessage(message || '', !!message)
  }
  async function signOut() {
    try {
      var result = await requireClient().auth.signOut()
      if (result.error) throw result.error
    } catch (error) {
      console.warn('[admin] 退出失败', error)
    } finally {
      showLogin()
    }
  }

  function bindEvents() {
    renderSopFriendlyFields()
    resetSopEditor(null)
    document.querySelectorAll('.admin-tab').forEach(function (tab) {
      tab.addEventListener('click', async function () {
        var viewId = tab.dataset.adminView
        setAdminView(viewId)
        try {
          if (viewId === 'apiAdminView') await loadApiConfig(false)
          if (viewId === 'sopAdminView') await loadSopTemplates(false)
        } catch (error) {
          console.warn('[admin] 功能页加载失败', error)
        }
      })
    })
    byId('apiProvider').addEventListener('change', function () {
      var provider = byId('apiProvider').value
      var baseUrl = byId('apiBaseUrl').value.trim()
      byId('apiMode').disabled = provider !== 'openai'
      if (
        !baseUrl ||
        baseUrl === 'https://api.openai.com/v1' ||
        baseUrl === 'https://api.anthropic.com/v1'
      ) {
        byId('apiBaseUrl').value = provider === 'openai'
          ? 'https://api.openai.com/v1'
          : 'https://api.anthropic.com/v1'
      }
    })
    byId('apiConfigForm').addEventListener('submit', async function (event) {
      event.preventDefault()
      var save = byId('apiSaveButton')
      save.disabled = true
      byId('apiValidateButton').disabled = true
      setElementNotice('apiConfigNotice', '正在加密保存配置……', false)
      try {
        var payload = {
          enabled: byId('apiEnabled').checked,
          provider: byId('apiProvider').value,
          model: byId('apiModel').value.trim(),
          apiMode: byId('apiMode').value,
          baseUrl: byId('apiBaseUrl').value.trim(),
          apiKey: byId('apiKey').value.trim(),
          clearApiKey: byId('apiClearKey').checked
        }
        if (
          !payload.clearApiKey &&
          !payload.apiKey &&
          !(AdminState.apiConfig && AdminState.apiConfig.hasApiKey)
        ) {
          throw new Error('NBJ_AGENT_API_KEY_REQUIRED')
        }
        if (payload.clearApiKey && payload.enabled) {
          throw new Error('删除 API Key 前请先关闭 Agent。')
        }
        var config = await adminApi('/api/admin/feeding-agent/config', {
          method: 'PUT',
          body: JSON.stringify(payload)
        })
        if (payload.apiKey && !config.hasApiKey) {
          throw new Error('NBJ_AGENT_API_KEY_SAVE_FAILED')
        }
        renderApiConfig(config)
        AdminState.apiConfigLoaded = true
        setElementNotice('apiConfigNotice', '配置已保存。', false)
      } catch (error) {
        setElementNotice('apiConfigNotice', errorText(error), true)
      } finally {
        save.disabled = false
        byId('apiValidateButton').disabled = false
      }
    })
    byId('apiValidateButton').addEventListener('click', async function () {
      var button = byId('apiValidateButton')
      button.disabled = true
      setElementNotice('apiConfigNotice', '正在校验供应商、模型和密钥……', false)
      try {
        await adminApi('/api/admin/feeding-agent/config/validate', { method: 'POST' })
        setElementNotice('apiConfigNotice', '配置校验通过。', false)
      } catch (error) {
        setElementNotice('apiConfigNotice', errorText(error), true)
      } finally { button.disabled = false }
    })
    byId('sopFriendlyFields').addEventListener('input', writeSopConfigJson)
    byId('sopFriendlyFields').addEventListener('change', writeSopConfigJson)
    byId('sopConfigJson').addEventListener('change', function () {
      try {
        var config = JSON.parse(byId('sopConfigJson').value)
        if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('INVALID')
        populateFriendlyFields(config)
        setElementNotice('sopNotice', '', false)
      } catch (error) {
        setElementNotice('sopNotice', '高级配置 JSON 格式无效。', true)
      }
    })
    byId('sopTemplateRows').addEventListener('click', function (event) {
      var button = event.target.closest('button[data-clone-sop]')
      if (!button) return
      var template = AdminState.sopTemplates.find(function (item) { return item.id === button.dataset.cloneSop })
      if (template) {
        resetSopEditor(template)
        byId('sopVersion').focus()
        byId('sopEditor').scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    })
    byId('sopResetButton').addEventListener('click', function () {
      var baseId = byId('sopBaseTemplateId').value
      var template = AdminState.sopTemplates.find(function (item) { return item.id === baseId })
      resetSopEditor(template || null)
    })
    byId('sopEditor').addEventListener('submit', async function (event) {
      event.preventDefault()
      var button = byId('sopPublishButton')
      button.disabled = true
      setElementNotice('sopNotice', '正在发布不可变新版本……', false)
      try {
        var config = configFromFriendlyFields()
        validateSopConfig(config)
        var version = byId('sopVersion').value.trim()
        var name = byId('sopName').value.trim()
        var templateKey = byId('sopTemplateKey').value.trim()
        if (!version || !name || !templateKey) throw new Error('模板标识、版本号和名称不能为空。')
        await AdminSync.publishSopTemplate({
          p_base_template_id: byId('sopBaseTemplateId').value || null,
          p_template_key: templateKey,
          p_version: version,
          p_name: name,
          p_config: config,
          p_retire_base: byId('sopRetireBase').checked
        })
        AdminState.sopLoaded = false
        byId('sopBaseTemplateId').value = ''
        await loadSopTemplates(true)
        setElementNotice('sopNotice', '新 SOP 版本 ' + version + ' 已发布。', false)
      } catch (error) {
        setElementNotice('sopNotice', errorText(error), true)
      } finally { button.disabled = false }
    })
    byId('loginForm').addEventListener('submit', async function (event) {
      event.preventDefault()
      var button = byId('loginButton')
      button.disabled = true
      setLoginMessage('正在验证身份……', false)
      try {
        var result = await requireClient().auth.signInWithPassword({ email: byId('loginEmail').value.trim(), password: byId('loginPassword').value })
        if (result.error) throw result.error
        AdminState.initializedUserId = null
        await initializeForUser(result.data.user)
      } catch (error) {
        setLoginMessage(errorText(error), true)
      } finally { button.disabled = false }
    })
    byId('signOutButton').addEventListener('click', signOut)
    byId('noPermissionSignOut').addEventListener('click', signOut)
    byId('filterForm').addEventListener('submit', async function (event) {
      event.preventDefault()
      AdminState.filters = readFilters()
      try { await loadPage(1, true) } catch (error) { setNotice(errorText(error), true) }
    })
    byId('resetButton').addEventListener('click', async function () {
      var empty = { email: '', name: '', farmRoom: '', status: '', updatedFrom: '', updatedTo: '' }
      applyFilterInputs(empty)
      AdminState.filters = empty
      try { await loadPage(1, true) } catch (error) { setNotice(errorText(error), true) }
    })
    byId('prevPageButton').addEventListener('click', async function () { try { await loadPage(Math.max(1, AdminState.page - 1), false) } catch (error) { setNotice(errorText(error), true) } })
    byId('nextPageButton').addEventListener('click', async function () { try { await loadPage(AdminState.page + 1, false) } catch (error) { setNotice(errorText(error), true) } })
    byId('selectAll').addEventListener('change', function (event) {
      AdminState.rows.forEach(function (row) {
        var key = batchKey(row.user_id, row.id)
        if (event.target.checked) AdminState.selected.add(key); else AdminState.selected.delete(key)
      })
      renderRows()
    })
    byId('batchRows').addEventListener('change', function (event) {
      if (!event.target.classList.contains('row-select')) return
      var pair = decodeKey(event.target.dataset.key)
      var key = batchKey(pair[0], pair[1])
      if (event.target.checked) AdminState.selected.add(key); else AdminState.selected.delete(key)
      renderRows()
    })
    byId('batchRows').addEventListener('click', async function (event) {
      var button = event.target.closest('button[data-action]')
      if (!button) return
      var pair = decodeKey(button.dataset.key)
      try {
        if (button.dataset.action === 'view') await openDetail(pair[0], pair[1])
        if (button.dataset.action === 'edit') await openEdit(pair[0], pair[1])
        if (button.dataset.action === 'export') await exportRows([await AdminSync.fetchOne(pair[0], pair[1])])
      } catch (error) { setNotice(errorText(error), true); setExportProgress('') }
    })
    byId('exportSelectedButton').addEventListener('click', async function () { try { await exportSelected() } catch (error) { setNotice(errorText(error), true); setExportProgress('') } })
    byId('exportFilteredButton').addEventListener('click', async function () { try { await exportFiltered() } catch (error) { setNotice(errorText(error), true); setExportProgress('') } })
    document.querySelectorAll('[data-close]').forEach(function (button) { button.addEventListener('click', function () { closeModal(button.dataset.close) }) })
    byId('editForm').addEventListener('submit', async function (event) {
      event.preventDefault()
      var message = byId('editMessage')
      var save = byId('editSaveButton')
      try {
        var config = JSON.parse(byId('editConfig').value)
        var records = JSON.parse(byId('editRecords').value)
        var currentDay = Number(byId('editCurrentDay').value)
        var controlStartDay = Number(byId('editControlStartDay').value)
        if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('config 必须是 JSON 对象。')
        if (!Array.isArray(records)) throw new Error('records 必须是 JSON 数组。')
        if (!Number.isInteger(currentDay) || currentDay < 0) throw new Error('当前进度必须是非负整数。')
        if (!Number.isInteger(controlStartDay) || controlStartDay < -1) throw new Error('控奶开始日必须不小于 -1。')
        save.disabled = true
        message.textContent = '正在保存……'
        await AdminSync.saveSnapshot({
          p_target_user_id: byId('editUserId').value, p_id: byId('editBatchId').value,
          p_config: config, p_records: records, p_current_day_index: currentDay,
          p_status: byId('editStatus').value, p_config_locked: byId('editConfigLocked').value === 'true',
          p_control_start_day: controlStartDay, p_expected_revision: Number(byId('editRevision').value)
        })
        closeModal('editModal')
        await Promise.all([loadPage(AdminState.page, false), refreshStats()])
      } catch (error) {
        message.textContent = isAdminConflict(error) ? '该批次已被用户或其他管理员更新，请重新加载后再修改。' : errorText(error)
      } finally { save.disabled = false }
    })
  }

  document.addEventListener('DOMContentLoaded', async function () {
    bindEvents()
    if (!window.supabaseClient) { showLogin('登录服务未加载，请检查网络连接后刷新页面。'); return }
    window.supabaseClient.auth.onAuthStateChange(function (_event, session) {
      setTimeout(function () {
        if (!session || !session.user) {
          showLogin()
          return
        }
        if (AdminState.initializedUserId !== session.user.id) {
          void initializeForUser(session.user)
        }
      }, 0)
    })
    try {
      var result = await window.supabaseClient.auth.getSession()
      if (result.error) throw result.error
      if (result.data && result.data.session && result.data.session.user) await initializeForUser(result.data.session.user)
      else showLogin()
    } catch (error) { showLogin('无法读取登录会话：' + errorText(error)) }
  })
})()
