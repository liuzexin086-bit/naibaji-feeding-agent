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
    apiConfigLoaded: false,
    apiConfig: null,
    sopTemplates: [],
    sopLoaded: false
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
    maintenanceEnabled: true, productionProgramStartLocal: '00:00', customTasks: [], standardCleanEveryDays: 2,
    deepCleanEveryDays: 7, creepAgeStart: 8, creepAgeEnd: 11, soakedFeedAgeStart: 12, soakedFeedAgeEnd: 14,
    soakedFeedRatio: '4:1', transitionAgeStart: 20, transitionMealsMin: 2, transitionMealsMax: 3
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
  function errorText(error) { return error && (error.message || error.code) || '请求失败' }

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
    if (viewId === 'apiAdminView') loadApiConfig(false)
    if (viewId === 'sopAdminView') loadSopTemplates(false)
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
  function configFromFriendlyFields() { var config; try { config = JSON.parse(byId('sopConfigJson').value || '{}') } catch (_) { throw new Error('SOP JSON 格式无效') } SOP_FIELDS.forEach(function (field) { var input = document.querySelector('[data-sop-key="' + field[0] + '"]'); if (!input) return; if (field[2] === 'checkbox') config[field[0]] = input.checked; else if (field[2] === 'number') config[field[0]] = Number(input.value); else config[field[0]] = input.value.trim() }); config.templateId = byId('sopTemplateKey').value.trim(); config.version = byId('sopVersion').value.trim(); return config }
  function syncSopJson() { try { var config = configFromFriendlyFields(); byId('sopConfigJson').value = JSON.stringify(config, null, 2); notice('sopNotice', '', false) } catch (error) { notice('sopNotice', error.message, true) } }
  function populateSopEditor(template) { var config = Object.assign({}, DEFAULT_SOP_CONFIG, template && template.config || {}); byId('sopBaseTemplateId').value = template ? template.id : ''; byId('sopTemplateKey').value = template ? template.templateKey || template.template_key || config.templateId : config.templateId; byId('sopTemplateKey').readOnly = !!template; byId('sopVersion').value = ''; byId('sopName').value = template ? template.name : '奶爸机超早期断奶 SOP'; byId('sopRetireBase').checked = !!template; byId('sopEditorTitle').textContent = template ? '基于 ' + (template.version || '') + ' 创建新版本' : '发布首个 SOP 版本'; renderFriendlyFields(config); byId('sopConfigJson').value = JSON.stringify(config, null, 2) }
  function renderSopTemplates() { var body = byId('sopTemplateRows'); body.innerHTML = AdminState.sopTemplates.map(function (template) { return '<tr><td>' + escapeHtml(template.templateKey || template.template_key || '—') + '</td><td>' + escapeHtml(template.version) + '</td><td>' + escapeHtml(template.name) + '</td><td><span class="template-status ' + (template.status || 'published') + '">' + escapeHtml(template.status === 'retired' ? '已退役' : '已发布') + '</span></td><td>' + escapeHtml(dateText(template.createdAt || template.created_at)) + '</td><td><button class="btn btn-outline" type="button" data-clone-sop="' + escapeHtml(template.id) + '">复制创建</button></td></tr>' }).join(''); byId('sopEmptyState').hidden = AdminState.sopTemplates.length !== 0 }
  async function loadSopTemplates(force) { if (AdminState.sopLoaded && !force) return; notice('sopNotice', '正在读取 SOP 版本……', false); try { var response = await api('/api/admin/sop/templates'); AdminState.sopTemplates = Array.isArray(response.templates) ? response.templates : []; AdminState.sopLoaded = true; renderSopTemplates(); if (!byId('sopBaseTemplateId').value) populateSopEditor(AdminState.sopTemplates.find(function (template) { return template.status === 'published' }) || null); notice('sopNotice', '', false) } catch (error) { notice('sopNotice', errorText(error), true) } }
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
    document.querySelectorAll('[data-close]').forEach(function (button) { button.addEventListener('click', function () { byId(button.dataset.close).hidden = true }) })
    byId('exportFilteredButton').addEventListener('click', function () { exportRows(AdminState.rows) }); byId('exportSelectedButton').addEventListener('click', function () { var selected = AdminState.rows.filter(function (row) { return AdminState.selected.has(encodeURIComponent(row.id || row.batch && row.batch.id)) }); exportRows(selected) })
    byId('apiProvider').addEventListener('change', function () { var openai = byId('apiProvider').value === 'openai'; byId('apiMode').disabled = !openai; if (!byId('apiBaseUrl').value || /api\.(openai|anthropic)\.com/.test(byId('apiBaseUrl').value)) byId('apiBaseUrl').value = openai ? 'https://api.openai.com/v1' : 'https://api.anthropic.com/v1' })
    byId('apiConfigForm').addEventListener('submit', async function (event) { event.preventDefault(); var save = byId('apiSaveButton'); save.disabled = true; notice('apiConfigNotice', '正在保存……', false); try { var config = await api('/api/admin/feeding-agent/config', { method: 'PUT', body: { enabled: byId('apiEnabled').checked, provider: byId('apiProvider').value, model: byId('apiModel').value.trim(), apiMode: byId('apiMode').value, baseUrl: byId('apiBaseUrl').value.trim(), apiKey: byId('apiKey').value.trim(), clearApiKey: byId('apiClearKey').checked } }); renderApiConfig(config); AdminState.apiConfigLoaded = true; notice('apiConfigNotice', '配置已保存', false) } catch (error) { notice('apiConfigNotice', errorText(error), true) } finally { save.disabled = false } })
    byId('apiValidateButton').addEventListener('click', async function () { var button = byId('apiValidateButton'); button.disabled = true; notice('apiConfigNotice', '正在校验……', false); try { await api('/api/admin/feeding-agent/config', { method: 'POST', body: { validateOnly: true } }); notice('apiConfigNotice', '配置校验通过', false) } catch (error) { notice('apiConfigNotice', errorText(error), true) } finally { button.disabled = false } })
    byId('sopFriendlyFields').addEventListener('input', syncSopJson); byId('sopFriendlyFields').addEventListener('change', syncSopJson); byId('sopConfigJson').addEventListener('change', function () { try { var config = JSON.parse(byId('sopConfigJson').value); populateFriendlyFields(config); notice('sopNotice', '', false) } catch (_) { notice('sopNotice', '高级配置 JSON 格式无效', true) } })
    byId('sopTemplateRows').addEventListener('click', function (event) { var button = event.target.closest('[data-clone-sop]'); if (!button) return; var template = AdminState.sopTemplates.find(function (item) { return String(item.id) === String(button.dataset.cloneSop) }); if (template) { populateSopEditor(template); byId('sopVersion').focus() } })
    byId('sopResetButton').addEventListener('click', function () { var base = AdminState.sopTemplates.find(function (item) { return String(item.id) === String(byId('sopBaseTemplateId').value) }); populateSopEditor(base || null) })
    byId('sopEditor').addEventListener('submit', async function (event) { event.preventDefault(); var button = byId('sopPublishButton'); button.disabled = true; try { var config = configFromFriendlyFields(); validateSopConfig(config); var response = await api('/api/admin/sop/templates', { method: 'POST', body: { version: byId('sopVersion').value.trim(), name: byId('sopName').value.trim(), config: config, copyFromId: byId('sopBaseTemplateId').value || undefined } }); AdminState.sopTemplates = [response.template].concat(AdminState.sopTemplates); renderSopTemplates(); populateSopEditor(response.template); notice('sopNotice', '新版本已发布', false) } catch (error) { notice('sopNotice', errorText(error), true) } finally { button.disabled = false } })
  }

  async function boot() {
    showOnly('loadingScreen'); bindEvents()
    try { var session = await api('/api/auth/session'); AdminState.user = session.user; if (!AdminState.user || AdminState.user.role !== 'admin') { showOnly('noPermissionScreen'); return } byId('adminEmail').textContent = AdminState.user.email || ''; showOnly('adminRoot'); populateSopEditor(null); await loadBatches() } catch (error) { if (error.status === 401) showOnly('loginScreen'); else { showOnly('loginScreen'); loginMessage(errorText(error), true) } }
  }
  boot()
}())
