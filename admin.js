/* 奶爸机本地管理员后台：仅访问同域本地 API。 */
(function () {
  'use strict'

  var AdminState = window.AdminState = {
    user: null,
    rows: [],
    selected: new Set(),
    page: 1,
    total: 0,
    pageSize: 50,
    activeView: 'batchAdminView',
    users: [],
    usersLoaded: false,
    apiConfigLoaded: false,
    apiConfig: null,
    sopTemplates: [],
    sopLoaded: false,
    sopNlTasks: [],
    sopNlTimer: null,
    sopNlSelectedTask: null
  }

  var DEFAULT_SOP_CONFIG = {
    templateId: 'naibaji-early-weaning', version: '2026.08-local-v1', timezone: 'Asia/Shanghai', utcOffsetMinutes: 480,
    defaultAdmissionDeadlineLocal: '09:00', preferredFirstTeachingLocal: '17:00', adaptationMinHours: 8, adaptationMaxHours: 10,
    teachingIntervalHours: 3, teachingLiquidMlPerHead: 10, teachingPowderGramsPerTwenty: 35, devicePowderPrecisionGrams: 1,
    teachingProgramEndDayOffset: 1, teachingProgramEndLocal: '08:00', teachingDirectTotalPowderGrams: 0,
    quantityAuthorityOrder: ['sop_direct', 'sop_indirect', 'production_model'], modelQuantityFallbackEnabled: true,
    teachingQuantitySource: 'sop', deviceConfigurationFields: ['powderGrams', 'timeLocal'], teachingLatestDay: 3,
    waterClosedBeforeAgeDays: 12, waterPolicyEnabled: true, teachingProgramEnabled: true, gentleMovementEnabled: true,
    laggardEvaluationEnabled: true, creepFeedEnabled: true, soakedFeedEnabled: true, transitionEnabled: true,
    maintenanceEnabled: true, productionProgramStartLocal: '09:00', customTasks: [], standardCleanEveryDays: 2,
    deepCleanEveryDays: 7, creepAgeStart: 8, creepAgeEnd: 11, soakedFeedAgeStart: 12, soakedFeedAgeEnd: 14,
    soakedFeedRatio: '4:1', transitionAgeStart: 20, transitionMealsMin: 2, transitionMealsMax: 3,
    freeFeedingTemplate: { windows: defaultFreeFeedingSlots(), stageConditions: { earliestBatchDay: 1, requiresOperatorSelection: true }, exceptionBlockers: ['milk_control', 'diarrhea', 'refusal', 'blockage', 'probe_contamination', 'curve_cap'] }
  }
  var SOP_FIELDS = [
    ['timezone', '场区时区', 'text'], ['utcOffsetMinutes', 'UTC 偏移（分钟）', 'number'], ['defaultAdmissionDeadlineLocal', '默认入栏截止', 'time'],
    ['preferredFirstTeachingLocal', '首次教奶', 'time'], ['adaptationMinHours', '适应期最短（小时）', 'number'], ['adaptationMaxHours', '适应期最长（小时）', 'number'],
    ['teachingIntervalHours', '教奶间隔（小时）', 'number'], ['teachingLiquidMlPerHead', '奶液（mL/头/次）', 'number'],
    ['teachingPowderGramsPerTwenty', '单餐粉量（g/20头/次）', 'number'], ['teachingDirectTotalPowderGrams', '直接总粉量（g）', 'number'],
    ['devicePowderPrecisionGrams', '设备精度（g）', 'number'], ['teachingProgramEndDayOffset', '截止日偏移', 'number'],
    ['teachingProgramEndLocal', '教奶截止时间', 'time'], ['teachingLatestDay', '掉队评估日龄', 'number'],
    ['waterClosedBeforeAgeDays', '恢复给水日龄', 'number'], ['waterPolicyEnabled', '启用饮水策略', 'checkbox'],
    ['teachingProgramEnabled', '启用教奶程序', 'checkbox'], ['gentleMovementEnabled', '启用轻柔驱赶', 'checkbox'],
    ['laggardEvaluationEnabled', '启用掉队评估', 'checkbox'], ['creepFeedEnabled', '启用教槽任务', 'checkbox'],
    ['soakedFeedEnabled', '启用奶泡料任务', 'checkbox'], ['transitionEnabled', '启用过渡任务', 'checkbox'],
    ['maintenanceEnabled', '启用维护清洗', 'checkbox'], ['productionProgramStartLocal', '正式程序起点', 'time'],
    ['standardCleanEveryDays', '标准清洗周期（天）', 'number'], ['deepCleanEveryDays', '深度清洗周期（天）', 'number'],
    ['creepAgeStart', '教槽开始日龄', 'number'], ['creepAgeEnd', '教槽结束日龄', 'number'],
    ['soakedFeedAgeStart', '奶泡料开始日龄', 'number'], ['soakedFeedAgeEnd', '奶泡料结束日龄', 'number'],
    ['soakedFeedRatio', '奶料比例', 'text'], ['transitionAgeStart', '过渡开始日龄', 'number'],
    ['transitionMealsMin', '过渡最少餐次', 'number'], ['transitionMealsMax', '过渡最多餐次', 'number']
  ]

  function byId(id) { return document.getElementById(id) }
  function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>'"]/g, function (char) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char] }) }
  function valueText(value) { return value == null || value === '' ? '—' : String(value) }
  function dateText(value) { if (!value) return '—'; var date = new Date(value); return isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false }) }
  function showOnly(id) { ;['loadingScreen', 'loginScreen', 'noPermissionScreen', 'adminRoot'].forEach(function (screen) { byId(screen).hidden = screen !== id }) }
  function loginMessage(text, isError) { var el = byId('loginMessage'); el.textContent = text || ''; el.style.color = isError ? '' : 'var(--muted)' }
  function notice(id, text, isError) { var el = byId(id); if (!el) return; el.textContent = text || ''; el.className = 'notice' + (isError ? '' : ' ok') }
  function errorText(error) {
    var code = error && error.code
    var messages = {
      NBJ_USER_EXISTS: '该邮箱已存在。',
      NBJ_USER_NOT_FOUND: '账号不存在或已被删除。',
      NBJ_USER_SELF_DELETE: '不能删除当前登录管理员。',
      NBJ_USER_CONFIRM_EMAIL_MISMATCH: '确认邮箱与目标账号不一致。',
      NBJ_USER_CONFIRM_EMAIL_REQUIRED: '必须输入确认邮箱。',
      NBJ_LAST_ADMIN: '不能删除最后一个启用管理员。',
      NBJ_AUTH_ROLE_INVALID: '角色只能选择管理员或操作员。',
      NBJ_AUTH_PASSWORD_INVALID: '密码长度必须为 8–512 个字符。',
      NBJ_AUTH_EMAIL_INVALID: '请输入有效邮箱地址。',
      NBJ_ADMIN_REQUIRED: '需要管理员权限。',
      NBJ_AUTH_REQUIRED: '登录已失效，请重新登录。',
      NBJ_SOP_INDEX_VERIFY_FAILED: 'SOP 索引校验失败，上一已发布版本仍然有效。',
      NBJ_SOP_INDEX_FAILED: 'SOP 建立索引失败，上一已发布版本仍然有效。',
      NBJ_SOP_EMPTY: '请粘贴完整 SOP Markdown 原文。',
      NBJ_SOP_TEMPLATE_NOT_FOUND: '来源 SOP 版本不存在，请刷新后重试。',
      NBJ_SOP_NL_TASK_NOT_FOUND: 'SOP 自然语言任务不存在。',
      NBJ_SOP_NL_TASK_NOT_DRAFT_READY: '该任务当前不可确认发布。',
      NBJ_SOP_NL_CONFIRM_PHRASE_MISMATCH: '确认短语不匹配，未发布。',
      NBJ_SOP_NL_TEMPLATE_NOT_FOUND: '目标 SOP 模板不存在。',
      NBJ_SOP_NL_DRAFT_PARSE_FAILED: '模型输出无法解析，草稿生成失败。',
      NBJ_SOP_NL_DRAFT_INVALID: '模型提案未通过 SOP 校验，草稿生成失败。',
      NBJ_SOP_NL_DRAFT_UNCHANGED: '提案与当前模板没有实际变化，已标记失败。',
      NBJ_SOP_NL_MODEL_UNAVAILABLE: 'Agent 模型未配置，无法生成草稿。',
      NBJ_SOP_NL_DRAFT_FAILED: '草稿生成失败。',
      NBJ_FREE_FEEDING_SLOTS_INVALID: '自由采食必须保留完整的 8 个有效时段。',
      NBJ_FREE_FEEDING_SLOTS_OVERLAP: '已启用的自由采食时段在业务日内重叠。',
      NBJ_FREE_FEEDING_SLOT_ZERO_DURATION: '自由采食时段不能使用相同的开始和结束时间。'
    }
    return messages[code] || error && (error.message || code) || '请求失败。'
  }

  async function api(path, options) {
    var request = Object.assign({ credentials: 'include', headers: {} }, options || {})
    request.headers = Object.assign({}, request.headers)
    if (request.body && typeof request.body !== 'string') { request.headers['content-type'] = 'application/json'; request.body = JSON.stringify(request.body) }
    var response = await fetch(path, request)
    var text = await response.text(); var data = {}
    if (text) { try { data = JSON.parse(text) } catch (_) { data = { message: text } } }
    if (!response.ok) { var error = new Error(data.message || data.code || ('请求失败（' + response.status + '）')); error.code = data.code; error.status = response.status; throw error }
    return data
  }

  function setView(viewId) {
    AdminState.activeView = viewId
    document.querySelectorAll('.admin-view').forEach(function (view) { view.hidden = view.id !== viewId })
    document.querySelectorAll('.admin-tab').forEach(function (tab) { var active = tab.getAttribute('data-admin-view') === viewId; tab.setAttribute('aria-selected', active ? 'true' : 'false') })
    if (viewId === 'accountsAdminView') loadUsers(false)
    if (viewId === 'apiAdminView') loadApiConfig(false)
    if (viewId === 'sopAdminView') loadSopTemplates(false)
    if (viewId === 'sopNlAdminView') { loadSopTemplates(false); loadSopNlTasks(false) }
  }

  function renderStats() {
    var rows = AdminState.rows; byId('statBatches').textContent = rows.length; byId('statActive').textContent = rows.filter(function (row) { return row.status !== 'completed' }).length; byId('statCompleted').textContent = rows.filter(function (row) { return row.status === 'completed' }).length; byId('statUsers').textContent = new Set(rows.map(function (row) { return row.userId || row.user_id || AdminState.user && AdminState.user.id })).size
  }
  function renderBatches() {
    var body = byId('batchRows'); var rows = AdminState.rows
    body.innerHTML = rows.map(function (row) {
      var batch = row.batch || row; var id = batch.id || ''; var name = batch.name || (batch.config && batch.config.name) || '未命名批次'; var heads = batch.effectiveHeads || batch.initialHeads || (batch.config && batch.config.headCount) || '—'; var key = encodeURIComponent(id)
      return '<tr><td><input type="checkbox" data-select-batch="' + escapeHtml(key) + '" aria-label="选择 ' + escapeHtml(name) + '"></td><td>' + escapeHtml(row.userEmail || row.user_email || (AdminState.user && AdminState.user.email) || '本地用户') + '</td><td>' + escapeHtml(name) + '</td><td>' + escapeHtml(batch.room || (batch.config && batch.config.farmRoom) || '—') + '</td><td>' + escapeHtml(batch.startAge || (batch.config && batch.config.startAge) || '—') + '</td><td>' + escapeHtml(batch.endAge || (batch.config && batch.config.endAge) || '—') + '</td><td>' + escapeHtml(batch.status === 'completed' ? '已完成' : '进行中') + '</td><td>' + escapeHtml(Array.isArray(batch.records) ? batch.records.length : '—') + '</td><td>' + escapeHtml(batch.revision == null ? '—' : batch.revision) + '</td><td>' + escapeHtml(dateText(batch.updatedAt || batch.updated_at)) + '</td><td><button class="btn btn-outline" type="button" data-action="detail" data-batch-id="' + escapeHtml(key) + '">查看</button></td></tr>'
    }).join('')
    byId('emptyState').hidden = rows.length !== 0; renderStats(); byId('resultSummary').textContent = '共 ' + rows.length + ' 个批次'; byId('pageInfo').textContent = '本地数据'
  }
  async function loadBatches() { notice('queryNotice', '正在读取本地批次……', false); try { var response = await api('/api/batches'); AdminState.rows = Array.isArray(response.batches) ? response.batches : []; renderBatches(); notice('queryNotice', '', false) } catch (error) { AdminState.rows = []; renderBatches(); notice('queryNotice', errorText(error), true) } }

  function renderUsers() {
    var body = byId('accountRows');
    if (!body) return
    body.innerHTML = AdminState.users.map(function (user) {
      var current = AdminState.user && String(AdminState.user.id) === String(user.id)
      var role = user.role === 'admin' ? '管理员' : '操作员'
      var status = user.disabled ? '已停用' : '启用'
      var action = current ? '<span class="secret-hint">当前登录</span>' : user.email ? '<button class="btn btn-outline" type="button" data-delete-user="' + escapeHtml(user.id) + '">删除</button>' : '<span class="secret-hint">未绑定邮箱</span>'
      return '<tr><td>' + escapeHtml(user.email || '未绑定邮箱') + '</td><td>' + role + '</td><td>' + status + '</td><td>' + escapeHtml(dateText(user.createdAt || user.created_at)) + '</td><td>' + action + '</td></tr>'
    }).join('')
    byId('accountEmptyState').hidden = AdminState.users.length !== 0
  }

  async function loadUsers(force) {
    if (AdminState.usersLoaded && !force) { renderUsers(); return true }
    notice('accountNotice', '正在读取账号……', false)
    try {
      var response = await api('/api/admin/users')
      AdminState.users = Array.isArray(response.users) ? response.users : []
      AdminState.usersLoaded = true
      renderUsers()
      notice('accountNotice', '', false)
      return true
    } catch (error) {
      AdminState.users = []
      renderUsers()
      notice('accountNotice', errorText(error), true)
      return false
    }
  }

  async function deleteUser(userId) {
    var user = AdminState.users.find(function (item) { return String(item.id) === String(userId) })
    if (!user || (AdminState.user && String(user.id) === String(AdminState.user.id))) return
    var warning = '删除账号“' + (user.email || '未绑定邮箱') + '”将物理清理该账号的批次、现场对话和登录会话；其创建的 SOP 模板会转移给当前管理员。此操作不可撤销。继续吗？'
    if (!window.confirm(warning)) return
    var confirmEmail = window.prompt('请输入目标账号的完整邮箱以确认删除：', '')
    if (confirmEmail === null) return
    notice('accountNotice', '正在删除账号……', false)
    try {
      await api('/api/admin/users/' + encodeURIComponent(user.id), { method: 'DELETE', body: { confirmEmail: confirmEmail } })
      if (await loadUsers(true)) notice('accountNotice', '账号已删除。', false)
    } catch (error) {
      notice('accountNotice', errorText(error), true)
    }
  }

  function renderApiConfig(config) {
    config = config || {}; AdminState.apiConfig = config
    byId('apiProvider').value = config.provider || 'anthropic'; byId('apiModel').value = config.model || ''; byId('apiMode').value = config.apiMode || 'responses'; byId('apiMode').disabled = config.provider !== 'openai'; byId('apiBaseUrl').value = config.baseUrl || (config.provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com/v1'); byId('apiEnabled').checked = !!config.enabled; byId('apiKey').value = ''; byId('apiClearKey').checked = false
    byId('apiStatusEnabled').textContent = config.configured ? (config.enabled ? '已启用' : '已停用') : '未配置'; byId('apiStatusProvider').textContent = valueText(config.provider); byId('apiStatusModel').textContent = valueText(config.model); byId('apiStatusMode').textContent = config.apiMode === 'chat_completions' ? 'Chat Completions' : 'Responses API'; byId('apiStatusBaseUrl').textContent = valueText(config.baseUrl); byId('apiStatusKey').textContent = config.hasApiKey ? (config.apiKeyHint || '已保存') : '未保存'; byId('apiStatusUpdated').textContent = dateText(config.updatedAt); byId('apiStatusUpdatedBy').textContent = valueText(config.updatedBy)
  }
  async function loadApiConfig(force) { if (AdminState.apiConfigLoaded && !force) return; notice('apiConfigNotice', '正在读取配置……', false); try { renderApiConfig(await api('/api/admin/feeding-agent/config')); AdminState.apiConfigLoaded = true; notice('apiConfigNotice', '', false) } catch (error) { notice('apiConfigNotice', errorText(error), true) } }

  function renderFriendlyFields(config) {
    byId('sopFriendlyFields').innerHTML = SOP_FIELDS.map(function (field) { var key = field[0]; var label = field[1]; var type = field[2]; if (type === 'checkbox') return '<label class="inline-check"><input type="checkbox" data-sop-key="' + escapeHtml(key) + '">' + escapeHtml(label) + '</label>'; return '<label class="field">' + escapeHtml(label) + '<input type="' + escapeHtml(type) + '" data-sop-key="' + escapeHtml(key) + '"></label>' }).join(''); populateFriendlyFields(config)
  }
  function populateFriendlyFields(config) { SOP_FIELDS.forEach(function (field) { var input = document.querySelector('[data-sop-key="' + field[0] + '"]'); if (!input) return; if (field[2] === 'checkbox') input.checked = config[field[0]] === true; else input.value = config[field[0]] == null ? '' : String(config[field[0]]) }) }
  function defaultFreeFeedingSlots() { return Array.from({ length: 8 }, function (_, index) { return { slot: index + 1, enabled: index === 0, label: '自由采食时段 ' + (index + 1), startLocal: index === 0 ? '00:00' : '09:00', endLocal: index === 0 ? '23:59' : '10:00' } }) }
  function isLocalTime(value) { return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || '')) }
  function businessMinute(value) { var pieces = String(value).split(':').map(Number); return ((pieces[0] * 60 + pieces[1] - 540) + 1440) % 1440 }
  function slotRowsFromConfig(config) {
    var raw = config && config.freeFeedingTemplate && config.freeFeedingTemplate.windows
    if (!Array.isArray(raw) || raw.length !== 8) {
      var migrated = defaultFreeFeedingSlots()
      if (Array.isArray(raw) && raw[0] && isLocalTime(raw[0].startLocal) && isLocalTime(raw[0].endLocal)) migrated[0] = Object.assign({}, migrated[0], { startLocal: raw[0].startLocal, endLocal: raw[0].endLocal })
      return migrated
    }
    return raw.map(function (row, index) { var fallback = defaultFreeFeedingSlots()[index]; return {
      slot: index + 1,
      enabled: row && typeof row.enabled === 'boolean' ? row.enabled : fallback.enabled,
      label: row && typeof row.label === 'string' ? row.label : fallback.label,
      startLocal: row && isLocalTime(row.startLocal) ? row.startLocal : fallback.startLocal,
      endLocal: row && isLocalTime(row.endLocal) ? row.endLocal : fallback.endLocal
    } })
  }
  function setSlotValidation(message, invalidRows) {
    var result = byId('freeFeedingSlotValidation'); var count = byId('sopSlotCount'); var rows = Array.from(document.querySelectorAll('[data-free-slot-row]'))
    rows.forEach(function (row) { row.classList.toggle('invalid', (invalidRows || []).indexOf(Number(row.dataset.freeSlotRow)) >= 0) })
    result.textContent = message || ''
    result.className = 'slot-validation' + (message ? '' : ' ok')
    var enabled = rows.filter(function (row) { var input = row.querySelector('[data-free-slot-enabled]'); return input && input.checked }).length
    count.textContent = enabled + ' / 8 已启用'
  }
  function validateFreeFeedingSlots(slots) {
    if (!Array.isArray(slots) || slots.length !== 8) throw new Error('自由采食必须恰有 8 个时段。')
    var enabled = []; var invalid = []
    slots.forEach(function (slot, index) { if (slot.slot !== index + 1 || !isLocalTime(slot.startLocal) || !isLocalTime(slot.endLocal) || String(slot.label || '').trim().length > 80) invalid.push(index + 1); if (slot.enabled && slot.startLocal === slot.endLocal) invalid.push(index + 1); if (slot.enabled) enabled.push(slot) })
    if (invalid.length) { setSlotValidation('请修正标红时段：时间须为 HH:mm，启用时段不能为零长度。', invalid); throw new Error('自由采食时段格式无效') }
    if (!enabled.length) { setSlotValidation('至少启用 1 个自由采食时段。', []); throw new Error('至少启用 1 个自由采食时段') }
    var intervals = []
    enabled.forEach(function (slot) { var start = businessMinute(slot.startLocal); var duration = (businessMinute(slot.endLocal) - start + 1440) % 1440; var end = start + duration; if (end <= 1440) intervals.push({ start: start, end: end, slot: slot.slot }); else { intervals.push({ start: start, end: 1440, slot: slot.slot }); intervals.push({ start: 0, end: end - 1440, slot: slot.slot }) } })
    intervals.sort(function (left, right) { return left.start - right.start || left.end - right.end })
    for (var index = 1; index < intervals.length; index += 1) if (intervals[index].start < intervals[index - 1].end) { var affected = [intervals[index].slot, intervals[index - 1].slot]; setSlotValidation('启用时段在 09:00 至次日 09:00 的业务日内重叠。', affected); throw new Error('自由采食时段重叠') }
    setSlotValidation('', [])
    return slots
  }
  function freeFeedingSlotsFromEditor() { var rows = Array.from(document.querySelectorAll('[data-free-slot-row]')); var slots = rows.map(function (row, index) { return { slot: index + 1, enabled: row.querySelector('[data-free-slot-enabled]').checked, label: row.querySelector('[data-free-slot-label]').value.trim(), startLocal: row.querySelector('[data-free-slot-start]').value, endLocal: row.querySelector('[data-free-slot-end]').value } }); return validateFreeFeedingSlots(slots) }
  function renderFreeFeedingSlots(config) { var slots = slotRowsFromConfig(config); byId('freeFeedingSlots').innerHTML = slots.map(function (slot) { return '<div class="free-slot" data-free-slot-row="' + slot.slot + '"><span class="free-slot-number">' + slot.slot + '</span><label class="inline-check"><input type="checkbox" data-free-slot-enabled' + (slot.enabled ? ' checked' : '') + '>启用</label><label class="slot-label"><span class="sr-only">时段 ' + slot.slot + ' 名称</span><input data-free-slot-label maxlength="80" value="' + escapeHtml(slot.label) + '" aria-label="时段 ' + slot.slot + ' 名称"></label><label class="slot-time"><span class="sr-only">时段 ' + slot.slot + ' 开始时间</span><input type="time" data-free-slot-start value="' + escapeHtml(slot.startLocal) + '" aria-label="时段 ' + slot.slot + ' 开始时间"></label><label class="slot-time"><span class="sr-only">时段 ' + slot.slot + ' 结束时间</span><input type="time" data-free-slot-end value="' + escapeHtml(slot.endLocal) + '" aria-label="时段 ' + slot.slot + ' 结束时间"></label></div>' }).join(''); try { freeFeedingSlotsFromEditor() } catch (_) {} }
  function configFromFriendlyFields() { var config; try { config = JSON.parse(byId('sopConfigJson').value || '{}') } catch (_) { throw new Error('SOP JSON 格式无效') } SOP_FIELDS.forEach(function (field) { var input = document.querySelector('[data-sop-key="' + field[0] + '"]'); if (!input) return; if (field[2] === 'checkbox') config[field[0]] = input.checked; else if (field[2] === 'number') config[field[0]] = Number(input.value); else config[field[0]] = input.value.trim() }); config.freeFeedingTemplate = Object.assign({}, config.freeFeedingTemplate || {}, { windows: freeFeedingSlotsFromEditor() }); config.templateId = byId('sopTemplateKey').value.trim(); config.version = byId('sopVersion').value.trim(); return config }
  function syncSopJson() { try { var config = configFromFriendlyFields(); byId('sopConfigJson').value = JSON.stringify(config, null, 2); notice('sopNotice', '', false) } catch (error) { notice('sopNotice', error.message, true) } }
  function updateSopSourceMeta() { var source = byId('sopSourceMarkdown').value || ''; var lines = source ? source.split(/\r?\n/).length : 0; byId('sopSourceMeta').textContent = source.trim() ? lines + ' 行 · ' + source.length + ' 字符' : '尚未粘贴原文' }
  function populateSopEditor(template) { var config = Object.assign({}, DEFAULT_SOP_CONFIG, template && template.config || {}); byId('sopBaseTemplateId').value = template ? template.id : ''; byId('sopTemplateKey').value = template ? template.templateKey || template.template_key || config.templateId : config.templateId; byId('sopTemplateKey').readOnly = !!template; byId('sopVersion').value = ''; byId('sopName').value = template ? template.name : '奶爸机超早期断奶 SOP'; byId('sopEditorTitle').textContent = template ? '基于 ' + (template.version || '') + ' 创建新版本' : '发布首个 SOP 版本'; renderFriendlyFields(config); renderFreeFeedingSlots(config); try { config.freeFeedingTemplate = Object.assign({}, config.freeFeedingTemplate || {}, { windows: freeFeedingSlotsFromEditor() }) } catch (_) {} byId('sopConfigJson').value = JSON.stringify(config, null, 2); byId('sopSourceMarkdown').value = template && (template.sourceMarkdown || template.source_markdown) || ''; updateSopSourceMeta() }
  function sopStatus(status) { return ({ published: '已发布 · 索引可用', draft: '草稿 · 索引中', failed: '失败 · 未激活' })[status] || '状态未知' }
  function shortDigest(value) { var text = String(value || ''); return text ? text.slice(0, 12) + (text.length > 12 ? '…' : '') : '—' }
  function renderSopTemplates() { var body = byId('sopTemplateRows'); body.innerHTML = AdminState.sopTemplates.map(function (template) { var status = template.status || 'draft'; var digest = template.sourceSha256 || template.source_sha256 || ''; var revision = template.collectionRevision || template.collection_revision || ''; var parser = template.parserVersion || template.parser_version || '—'; var model = template.embeddingModel || template.embedding_model || '—'; var indexError = template.indexError || template.index_error || ''; var enabledSlots = slotRowsFromConfig(template.config || {}).filter(function (slot) { return slot.enabled }).length; return '<tr><td>' + escapeHtml(template.templateKey || template.template_key || template.config && template.config.templateId || '—') + '</td><td>' + escapeHtml(template.version) + '</td><td>' + escapeHtml(template.name) + '</td><td><span class="template-status ' + escapeHtml(status) + '">' + escapeHtml(sopStatus(status)) + '</span></td><td><span class="metadata-code" title="' + escapeHtml(digest) + '">' + escapeHtml(shortDigest(digest)) + '</span></td><td><span class="metadata-code" title="' + escapeHtml(revision) + '">' + escapeHtml(revision || '—') + '</span></td><td>' + escapeHtml(parser) + '<br><span class="metadata-code" title="' + escapeHtml(model) + '">' + escapeHtml(model) + '</span></td><td>' + enabledSlots + ' / 8</td><td>' + escapeHtml(template.chunkCount == null ? (template.chunk_count == null ? '—' : template.chunk_count) : template.chunkCount) + '</td><td>' + escapeHtml(dateText(template.publishedAt || template.published_at)) + '</td><td><div class="index-error">' + escapeHtml(indexError || '—') + '</div></td><td><button class="btn btn-outline" type="button" data-clone-sop="' + escapeHtml(template.id) + '">复制完整版本</button></td></tr>' }).join(''); byId('sopEmptyState').hidden = AdminState.sopTemplates.length !== 0 }
  async function loadSopTemplates(force) { if (AdminState.sopLoaded && !force) return; notice('sopNotice', '正在读取 SOP 版本……', false); try { var response = await api('/api/admin/sop/templates'); AdminState.sopTemplates = Array.isArray(response.templates) ? response.templates : []; AdminState.sopLoaded = true; renderSopTemplates(); populateSopNlTemplateSelect(); if (!byId('sopBaseTemplateId').value) populateSopEditor(AdminState.sopTemplates.find(function (template) { return template.status === 'published' }) || null); notice('sopNotice', '', false) } catch (error) { notice('sopNotice', errorText(error), true) } }
  function populateSopNlTemplateSelect() {
    var select = byId('sopNlTemplateId'); if (!select) return
    var selected = select.value
    select.innerHTML = '<option value="">新建 SOP 模板</option>' + AdminState.sopTemplates.map(function (template) {
      return '<option value="' + escapeHtml(template.id) + '">' + escapeHtml(template.name + '（' + template.version + '）') + '</option>'
    }).join('')
    if (selected && AdminState.sopTemplates.some(function (template) { return String(template.id) === String(selected) })) select.value = selected
  }
  function sopNlStatusText(status) { return ({ drafting: '生成中', draft_ready: '待确认', draft_failed: '失败', published: '已发布', rejected: '已拒绝' })[status] || status }
  function sopNlTargetText(task) {
    if (!task.templateId) return '新建模板'
    var template = AdminState.sopTemplates.find(function (item) { return String(item.id) === String(task.templateId) })
    return template ? template.name + '（' + template.version + '）' : task.templateId
  }
  function renderSopNlTasks() {
    var body = byId('sopNlTaskRows'); if (!body) return
    var tasks = AdminState.sopNlTasks || []
    body.innerHTML = tasks.map(function (task) {
      var instruction = String(task.instruction || '')
      var summary = String(task.changeSummary || task.change_summary || '')
      return '<tr><td><span class="template-status ' + escapeHtml(task.status) + '">' + escapeHtml(sopNlStatusText(task.status)) + '</span></td><td>' + escapeHtml(sopNlTargetText(task)) + '</td><td>' + escapeHtml(instruction.length > 80 ? instruction.slice(0, 80) + '…' : instruction) + '</td><td>' + escapeHtml(summary.length > 120 ? summary.slice(0, 120) + '…' : summary || '—') + '</td><td>' + escapeHtml(dateText(task.createdAt || task.created_at)) + '</td><td><button class="btn btn-outline" type="button" data-nl-view="' + escapeHtml(task.id) + '">查看</button></td></tr>'
    }).join('')
    byId('sopNlEmptyState').hidden = tasks.length !== 0
    if (AdminState.sopNlSelectedTask) showSopNlDetail(AdminState.sopNlSelectedTask)
  }
  async function loadSopNlTasks(force) {
    if (AdminState.sopNlTimer) { clearTimeout(AdminState.sopNlTimer); AdminState.sopNlTimer = null }
    try {
      var response = await api('/api/admin/sop/natural-language/tasks')
      AdminState.sopNlTasks = Array.isArray(response.tasks) ? response.tasks : []
      renderSopNlTasks()
      var drafting = AdminState.sopNlTasks.some(function (task) { return task.status === 'drafting' })
      if (AdminState.activeView === 'sopNlAdminView' && drafting) {
        AdminState.sopNlTimer = setTimeout(function () { loadSopNlTasks(true) }, 3000)
      }
    } catch (error) {
      notice('sopNlNotice', errorText(error), true)
    }
  }
  function showSopNlDetail(taskId) {
    AdminState.sopNlSelectedTask = String(taskId)
    var task = AdminState.sopNlTasks.find(function (item) { return String(item.id) === String(taskId) })
    var panel = byId('sopNlDetailPanel'); var body = byId('sopNlDetailBody')
    if (!panel || !body) return
    if (!task) { panel.hidden = true; return }
    panel.hidden = false
    byId('sopNlDetailMeta').textContent = '状态：' + sopNlStatusText(task.status) + ' · 目标：' + sopNlTargetText(task)
    byId('sopNlDetailNotice').textContent = ''
    if (task.status === 'drafting') {
      body.innerHTML = '<p class="panel-copy">草稿正在后台生成，请稍候，列表会自动刷新。</p>'
      return
    }
    if (task.status === 'draft_failed') {
      body.innerHTML = '<div class="index-error">' + escapeHtml(task.errorCode || task.error_code || 'NBJ_SOP_NL_DRAFT_FAILED') + '</div>'
      return
    }
    if (task.status === 'published' || task.status === 'rejected') {
      var published = task.publishedTemplateId && AdminState.sopTemplates.find(function (item) { return String(item.id) === String(task.publishedTemplateId) })
      body.innerHTML = '<p class="panel-copy">' + (task.status === 'published' ? '已发布为 ' + escapeHtml(published ? published.name + '（' + published.version + '）' : (task.publishedTemplateId || '新版本')) : '任务已拒绝，未发布。') + '</p>'
      return
    }
    var template = task.templateId ? AdminState.sopTemplates.find(function (item) { return String(item.id) === String(task.templateId) }) : null
    var defaultVersion = template ? template.version + '-nl-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') : ''
    var sections = Array.isArray(task.affectedSections) ? task.affectedSections.map(function (section) { return '<li>' + escapeHtml(section) + '</li>' }).join('') : ''
    var configJson = task.proposedConfig ? JSON.stringify(task.proposedConfig, null, 2) : '{}'
    body.innerHTML = '<p class="panel-copy">' + escapeHtml(task.changeSummary || '') + '</p>' + (sections ? '<p class="panel-copy">影响章节：</p><ul>' + sections + '</ul>' : '') + '<div class="config-grid"><label class="field">新版本号<input id="sopNlVersion" type="text" maxlength="160" value="' + escapeHtml(defaultVersion) + '" required></label><label class="field">版本名称<input id="sopNlName" type="text" maxlength="200" value="' + escapeHtml(template ? template.name : '') + '" required></label></div><div class="config-grid"><label class="field span-2">提案 Markdown（只读）<textarea id="sopNlProposedMarkdown" readonly spellcheck="false">' + escapeHtml(task.proposedMarkdown || '') + '</textarea></label><label class="field span-2">提案配置（只读）<textarea id="sopNlProposedConfig" readonly spellcheck="false">' + escapeHtml(configJson) + '</textarea></label></div><div class="form-actions"><button class="btn btn-primary" type="button" data-nl-confirm="' + escapeHtml(task.id) + '">确认并发布</button><button class="btn btn-danger" type="button" data-nl-reject="' + escapeHtml(task.id) + '">拒绝</button></div>'
  }
  async function confirmSopNlTask(taskId) {
    var version = byId('sopNlVersion') && byId('sopNlVersion').value.trim()
    var name = byId('sopNlName') && byId('sopNlName').value.trim()
    if (!version || !name) { notice('sopNlDetailNotice', '请填写新版本号和版本名称。', true); return }
    var button = byId('sopNlDetailBody').querySelector('[data-nl-confirm]')
    if (button) button.disabled = true
    notice('sopNlDetailNotice', '正在解析、索引并发布……', false)
    try {
      var response = await api('/api/admin/sop/natural-language/tasks/' + encodeURIComponent(taskId) + '/confirm', { method: 'POST', body: { version: version, name: name, confirmationPhrase: '发布 SOP 修改' } })
      AdminState.sopTemplates = [response.template].concat(AdminState.sopTemplates.filter(function (item) { return String(item.id) !== String(response.template.id) }))
      AdminState.sopLoaded = true
      renderSopTemplates(); populateSopNlTemplateSelect()
      notice('sopNlDetailNotice', '已发布并激活新版本。', false)
      await loadSopNlTasks(true)
    } catch (error) {
      notice('sopNlDetailNotice', errorText(error), true)
      if (button) button.disabled = false
    }
  }
  async function rejectSopNlTask(taskId) {
    if (!window.confirm('确认拒绝该 SOP 草稿？不会发布任何版本。')) return
    try {
      await api('/api/admin/sop/natural-language/tasks/' + encodeURIComponent(taskId) + '/reject', { method: 'POST' })
      notice('sopNlNotice', '草稿已拒绝。', false)
      await loadSopNlTasks(true)
    } catch (error) {
      notice('sopNlNotice', errorText(error), true)
    }
  }
  function validateSopConfig(config) { if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('配置必须是 JSON 对象'); if (!config.version) throw new Error('版本号不能为空'); if (Number(config.adaptationMaxHours) < Number(config.adaptationMinHours)) throw new Error('适应期范围无效'); if (!Array.isArray(config.customTasks)) throw new Error('customTasks 必须是数组'); if (config.teachingQuantitySource !== 'sop') throw new Error('数量权威必须设置为 SOP'); if (JSON.stringify(config.quantityAuthorityOrder) !== JSON.stringify(['sop_direct', 'sop_indirect', 'production_model'])) throw new Error('数量权威顺序无效') }

  function openDetail(batchId) { var row = AdminState.rows.find(function (item) { return String(item.id || item.batch && item.batch.id) === String(batchId) }); if (!row) return; var batch = row.batch || row; var pairs = [['批次 ID', batch.id], ['名称', batch.name || batch.config && batch.config.name], ['栏位', batch.room || batch.config && batch.config.farmRoom], ['日龄', (batch.currentDayIndex || 0) + (batch.startAge || 1)], ['头数', batch.effectiveHeads || batch.initialHeads], ['revision', batch.revision], ['状态', batch.status]]; byId('detailBody').innerHTML = pairs.map(function (pair) { return '<div class="detail-row"><dt>' + escapeHtml(pair[0]) + '</dt><dd>' + escapeHtml(valueText(pair[1])) + '</dd></div>' }).join(''); byId('detailModal').hidden = false }
  function exportRows(rows) { var payload = { exportedAt: new Date().toISOString(), batchCount: rows.length, batches: rows }; var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }); var link = document.createElement('a'); link.download = '奶爸机本地批次.json'; link.href = URL.createObjectURL(blob); link.click(); setTimeout(function () { URL.revokeObjectURL(link.href) }, 500); byId('exportProgress').textContent = '已导出 ' + rows.length + ' 个批次'; byId('exportProgress').hidden = false }

  function bindEvents() {
    document.querySelectorAll('.admin-tab').forEach(function (tab) { tab.addEventListener('click', function () { setView(tab.getAttribute('data-admin-view')) }) })
    byId('signOutButton').addEventListener('click', async function () { try { await api('/api/auth/logout', { method: 'POST' }) } catch (_) {} showOnly('loginScreen') })
    byId('noPermissionSignOut').addEventListener('click', async function () { try { await api('/api/auth/logout', { method: 'POST' }) } catch (_) {} showOnly('loginScreen') })
    byId('loginForm').addEventListener('submit', async function (event) { event.preventDefault(); var button = byId('loginButton'); loginMessage('正在登录……', false); button.disabled = true; try { var response = await api('/api/auth/login', { method: 'POST', body: { email: byId('loginEmail').value.trim(), password: byId('loginPassword').value } }); AdminState.user = response.user; if (AdminState.user && AdminState.user.role !== 'admin') { showOnly('noPermissionScreen'); return } byId('adminEmail').textContent = AdminState.user && AdminState.user.email || ''; showOnly('adminRoot'); await loadBatches() } catch (error) { loginMessage(errorText(error), true) } finally { button.disabled = false } })
    byId('refreshBtn') && byId('refreshBtn').addEventListener('click', loadBatches)
    byId('filterForm').addEventListener('submit', function (event) { event.preventDefault(); loadBatches() }); byId('resetButton').addEventListener('click', function () { byId('filterForm').reset(); loadBatches() })
    byId('selectAll').addEventListener('change', function () { document.querySelectorAll('[data-select-batch]').forEach(function (input) { input.checked = byId('selectAll').checked }) })
    byId('batchRows').addEventListener('change', function (event) { if (!event.target.matches('[data-select-batch]')) return; if (event.target.checked) AdminState.selected.add(event.target.dataset.selectBatch); else AdminState.selected.delete(event.target.dataset.selectBatch) })
    byId('batchRows').addEventListener('click', function (event) { var button = event.target.closest('[data-action="detail"]'); if (button) openDetail(decodeURIComponent(button.dataset.batchId)) })
    byId('accountRefreshButton').addEventListener('click', function () { loadUsers(true) })
    byId('accountRows').addEventListener('click', function (event) { var button = event.target.closest('[data-delete-user]'); if (button) deleteUser(button.dataset.deleteUser) })
    byId('accountCreateForm').addEventListener('submit', async function (event) {
      event.preventDefault()
      var button = byId('accountCreateButton')
      button.disabled = true
      notice('accountNotice', '正在创建账号……', false)
      try {
        await api('/api/admin/users', { method: 'POST', body: { email: byId('accountEmail').value, password: byId('accountPassword').value, role: byId('accountRole').value } })
        byId('accountCreateForm').reset()
        byId('accountRole').value = 'operator'
        if (await loadUsers(true)) notice('accountNotice', '账号已创建。', false)
      } catch (error) {
        notice('accountNotice', errorText(error), true)
      } finally {
        button.disabled = false
      }
    })
    document.querySelectorAll('[data-close]').forEach(function (button) { button.addEventListener('click', function () { byId(button.dataset.close).hidden = true }) })
    byId('exportFilteredButton').addEventListener('click', function () { exportRows(AdminState.rows) }); byId('exportSelectedButton').addEventListener('click', function () { var selected = AdminState.rows.filter(function (row) { return AdminState.selected.has(encodeURIComponent(row.id || row.batch && row.batch.id)) }); exportRows(selected) })
    byId('apiProvider').addEventListener('change', function () { var openai = byId('apiProvider').value === 'openai'; byId('apiMode').disabled = !openai; if (!byId('apiBaseUrl').value || /api\.(openai|anthropic)\.com/.test(byId('apiBaseUrl').value)) byId('apiBaseUrl').value = openai ? 'https://api.openai.com/v1' : 'https://api.anthropic.com/v1' })
    byId('apiConfigForm').addEventListener('submit', async function (event) { event.preventDefault(); var save = byId('apiSaveButton'); save.disabled = true; notice('apiConfigNotice', '正在保存……', false); try { var config = await api('/api/admin/feeding-agent/config', { method: 'PUT', body: { enabled: byId('apiEnabled').checked, provider: byId('apiProvider').value, model: byId('apiModel').value.trim(), apiMode: byId('apiMode').value, baseUrl: byId('apiBaseUrl').value.trim(), apiKey: byId('apiKey').value.trim(), clearApiKey: byId('apiClearKey').checked } }); renderApiConfig(config); AdminState.apiConfigLoaded = true; notice('apiConfigNotice', '配置已保存', false) } catch (error) { notice('apiConfigNotice', errorText(error), true) } finally { save.disabled = false } })
    byId('apiValidateButton').addEventListener('click', async function () { var button = byId('apiValidateButton'); button.disabled = true; notice('apiConfigNotice', '正在校验……', false); try { await api('/api/admin/feeding-agent/config', { method: 'POST', body: { validateOnly: true } }); notice('apiConfigNotice', '配置校验通过', false) } catch (error) { notice('apiConfigNotice', errorText(error), true) } finally { button.disabled = false } })
    byId('sopFriendlyFields').addEventListener('input', syncSopJson); byId('sopFriendlyFields').addEventListener('change', syncSopJson); byId('freeFeedingSlots').addEventListener('input', syncSopJson); byId('freeFeedingSlots').addEventListener('change', syncSopJson); byId('sopConfigJson').addEventListener('change', function () { try { var config = JSON.parse(byId('sopConfigJson').value); populateFriendlyFields(config); renderFreeFeedingSlots(config); notice('sopNotice', '', false) } catch (_) { notice('sopNotice', '高级配置 JSON 格式无效', true) } })
    byId('sopSourceMarkdown').addEventListener('input', updateSopSourceMeta)
    byId('sopCopyButton').addEventListener('click', async function () { var source = byId('sopSourceMarkdown').value; if (!source.trim()) { notice('sopNotice', '当前没有可复制的 SOP 原文。', true); return } try { await navigator.clipboard.writeText(source); notice('sopNotice', '完整 SOP 原文已复制。', false) } catch (_) { byId('sopSourceMarkdown').focus(); byId('sopSourceMarkdown').select(); notice('sopNotice', '浏览器未授予剪贴板权限，已选中全文，请手动复制。', true) } })
    byId('sopPasteButton').addEventListener('click', async function () { try { var source = await navigator.clipboard.readText(); if (!source.trim()) throw new Error('empty'); byId('sopSourceMarkdown').value = source; updateSopSourceMeta(); notice('sopNotice', '已从剪贴板粘贴完整原文，请核对后发布。', false); byId('sopSourceMarkdown').focus() } catch (_) { byId('sopSourceMarkdown').focus(); notice('sopNotice', '浏览器未授予读取剪贴板权限，请在原文框中手动粘贴。', true) } })
    byId('sopTemplateRows').addEventListener('click', function (event) { var button = event.target.closest('[data-clone-sop]'); if (!button) return; var template = AdminState.sopTemplates.find(function (item) { return String(item.id) === String(button.dataset.cloneSop) }); if (template) { populateSopEditor(template); byId('sopVersion').focus() } })
    byId('sopResetButton').addEventListener('click', function () { var base = AdminState.sopTemplates.find(function (item) { return String(item.id) === String(byId('sopBaseTemplateId').value) }); populateSopEditor(base || null) })
    byId('sopEditor').addEventListener('submit', async function (event) { event.preventDefault(); var button = byId('sopPublishButton'); var originalLabel = button.textContent; var sourceMarkdown = byId('sopSourceMarkdown').value; if (!sourceMarkdown.trim()) { notice('sopNotice', '请粘贴完整 SOP Markdown 原文后再发布。', true); byId('sopSourceMarkdown').focus(); return } button.disabled = true; button.textContent = '正在解析、索引并校验……'; notice('sopNotice', '正在建立不可变 SOP 版本，请勿关闭页面……', false); try { var config = configFromFriendlyFields(); validateSopConfig(config); var response = await api('/api/admin/sop/templates', { method: 'POST', body: { version: byId('sopVersion').value.trim(), name: byId('sopName').value.trim(), config: config, sourceMarkdown: sourceMarkdown, copyFromId: byId('sopBaseTemplateId').value || undefined } }); AdminState.sopTemplates = [response.template].concat(AdminState.sopTemplates.filter(function (item) { return String(item.id) !== String(response.template.id) })); renderSopTemplates(); populateSopEditor(response.template); notice('sopNotice', '新版本已发布，索引校验通过并已激活。', false) } catch (error) { await loadSopTemplates(true).catch(function () {}); notice('sopNotice', errorText(error), true) } finally { button.disabled = false; button.textContent = originalLabel } })
    byId('sopNlForm').addEventListener('submit', async function (event) {
      event.preventDefault()
      var button = byId('sopNlCreateButton')
      button.disabled = true
      notice('sopNlNotice', '正在创建草稿任务……', false)
      try {
        var response = await api('/api/admin/sop/natural-language/tasks', { method: 'POST', body: { templateId: byId('sopNlTemplateId').value || undefined, instruction: byId('sopNlInstruction').value.trim() } })
        byId('sopNlInstruction').value = ''
        AdminState.sopNlTasks = [response.task].concat(AdminState.sopNlTasks)
        AdminState.sopNlSelectedTask = response.task.id
        renderSopNlTasks()
        notice('sopNlNotice', '草稿任务已创建，正在后台生成。', false)
        loadSopNlTasks(true)
      } catch (error) {
        notice('sopNlNotice', errorText(error), true)
      } finally {
        button.disabled = false
      }
    })
    byId('sopNlRefreshButton').addEventListener('click', function () { loadSopNlTasks(true) })
    byId('sopNlTaskRows').addEventListener('click', function (event) {
      var button = event.target.closest('[data-nl-view]')
      if (button) showSopNlDetail(button.dataset.nlView)
    })
    byId('sopNlDetailBody').addEventListener('click', function (event) {
      var confirmButton = event.target.closest('[data-nl-confirm]')
      var rejectButton = event.target.closest('[data-nl-reject]')
      if (confirmButton) confirmSopNlTask(confirmButton.dataset.nlConfirm)
      if (rejectButton) rejectSopNlTask(rejectButton.dataset.nlReject)
    })
  }

  async function boot() {
    showOnly('loadingScreen'); bindEvents()
    try { var session = await api('/api/auth/session'); AdminState.user = session.user; if (!AdminState.user || AdminState.user.role !== 'admin') { showOnly('noPermissionScreen'); return } byId('adminEmail').textContent = AdminState.user.email || ''; showOnly('adminRoot'); populateSopEditor(null); await loadBatches() } catch (error) { if (error.status === 401) showOnly('loginScreen'); else { showOnly('loginScreen'); loginMessage(errorText(error), true) } }
  }
  boot()
}())
