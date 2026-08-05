import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const html = readFileSync(
  fileURLToPath(new URL("../ui/liquid-index.html", import.meta.url)),
  "utf8",
);
const adminHtml = readFileSync(
  fileURLToPath(new URL("../../admin.html", import.meta.url)),
  "utf8",
);
const adminJs = readFileSync(
  fileURLToPath(new URL("../../admin.js", import.meta.url)),
  "utf8",
);

describe("local frontend contract", () => {
  it("shows model-estimated weight and keeps every primary card on one width grid", () => {
    expect(html).toContain("<th>估重</th>");
    expect(html).toContain("estimatedAverageWeightKg");
    expect(html).toContain("--content-max: 1180px");
    expect(html).toContain(".topbar, .context-bar, .page");
    expect(html).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(html).toContain(".page > * { width: 100%; min-width: 0; max-width: 100%; }");
    expect(html).toContain("@keyframes surface-enter");
    expect(html).toContain("replayContentTransition");
    expect(html).toContain(".batch-menu.open");
    expect(html).toContain("requestAnimationFrame(function ()");
    expect(html).toContain("state.dialogCloseTimer");
  });
  it("uses same-origin cookie APIs without hosted SDKs", () => {
    expect(html.toLowerCase()).not.toContain("supabase");
    expect(adminHtml.toLowerCase()).not.toContain("supabase");
    expect(adminJs.toLowerCase()).not.toContain("supabase");
    expect(html).toContain("credentials: 'include'");
    expect(html).toContain("/api/auth/session");
    expect(html).toContain("/api/auth/login");
    expect(html).toContain("/api/auth/logout");
  });

  it("starts with device settings and observation data, without prediction UI", () => {
    expect(html).toContain('id="deviceHeading">今日设备设定');
    expect(html).toContain('id="quickForm"');
    expect(html).toContain('id="exceptionPanel"');
    expect(html).not.toContain("riskScore");
    expect(html).not.toContain("riskTitle");
    expect(html).not.toContain("风险预测");
    expect(html).toContain("creepValue");
  });

  it("persists the daily observation from the quick save form", () => {
    expect(html).toContain("保存当日记录");
    expect(html).toContain("'/api/batches/' + encodeURIComponent(batchId) + '/records'");
    expect(html).toContain("saveQuickBtn");
    expect(html).toContain("当日记录已保存");
  });

  it("hides the single amount and shows a 12-meal suggestion for free-feeding", () => {
    expect(html).toContain('id="singlePowderStat"');
    expect(html).toContain('id="dailyPowderLabel"');
    expect(html).toContain("function deviceMode(today)");
    expect(html).toContain("value(source, 'effectiveMode', 'effective_mode'");
    expect(html).toContain("$('singlePowderStat').hidden = freeFeeding");
    expect(html).toContain("建议单日下粉总量（");
    expect(html).toContain("suggestedDailyPowderGrams");
    expect(html).toContain('<div class="program-time-label" id="programTimeLabel">配奶时间点</div>');
    expect(html).toContain("自由采食时间段");
    expect(html).toContain("function deviceSchedule(today)");
    expect(html).toContain('<strong>定时定量</strong><span>保留既有时间点、排除时段、精度和减餐优先级</span>');
    expect(html).toContain('<strong>自由采食</strong><span>采用批次冻结 SOP 的窗口、阶段条件与异常阻断</span>');
    expect(html).not.toContain("现有定时定量模板");
    expect(html).not.toContain("SOP 自由采食模板");
    expect(html).not.toContain('<span class="label">今日餐次</span>');
    expect(html).not.toContain('<span class="label">下一次</span>');
    expect(html).not.toContain("设备按设定执行");
    expect(html).not.toContain("自动下奶");
    expect(html).toContain("只给我次日的单次奶粉量、程序总奶粉量和配奶时间点。");
  });

  it("recognizes free-feeding from the effective mode returned by the current-batch API", () => {
    const source = html.match(/function deviceMode\(today\) \{[^\n]+\}/)?.[0];
    expect(source).toBeTruthy();
    const value = (object: Record<string, unknown> | undefined, camel: string, snake: string, fallback: unknown) => {
      const result = object?.[camel] ?? object?.[snake];
      return result == null ? fallback : result;
    };
    const deviceMode = new Function("value", `${source}\nreturn deviceMode;`)(value) as (today: Record<string, unknown>) => string;
    expect(deviceMode({ effectiveMode: "free_feeding" })).toBe("free_feeding");
    expect(deviceMode({ setting: { mode: "free_feeding" } })).toBe("free_feeding");
  });

  it("keeps the complete daily table and mobile-only horizontal scrolling", () => {
    for (const heading of ["批次日", "日龄", "有效头数", "模式", "单次量", "餐次", "时间点", "程序总量", "实际总量", "教槽", "腹泻", "饮水"]) {
      expect(html).toContain(`<th>${heading}</th>`);
    }
    expect(html).toContain("overflow-x: auto");
    expect(html).toContain("长按 0.65 秒保存");
    expect(html).toContain("saveTableImage");
  });

  it("anchors the batch menu below its trigger and has one new-batch action", () => {
    expect(html).toContain("top: calc(100% + 8px)");
    expect(html).toContain('id="historyBtn" class="secondary-btn" type="button">新建批次</button>');
    expect(html).not.toContain("管理批次");
  });

  it("exposes administrator account management with destructive-action confirmation", () => {
    expect(adminHtml).toContain('id="accountsAdminTab"');
    expect(adminHtml).toContain('id="accountsAdminView"');
    expect(adminHtml).toContain('id="accountCreateForm"');
    expect(adminHtml).toContain('id="accountRows"');
    expect(adminHtml).toContain("删除会物理清理该账号的批次、现场对话和会话");
    expect(adminJs).toContain("/api/admin/users");
    expect(adminJs).toContain("confirmEmail");
    expect(adminJs).toContain("window.prompt('请输入目标账号的完整邮箱以确认删除：', '')");
    expect(adminJs).toContain("NBJ_USER_SELF_DELETE");
    expect(adminJs).toContain("NBJ_LAST_ADMIN");
  });

  it("advances with one idempotent request and renders its response", () => {
    expect(html).toContain("/advance");
    expect(html).toContain("expectedRevision");
    expect(html).toContain("idempotencyKey");
    expect(html).toContain("applyBatchResponse(response)");
    expect(html).not.toContain("/sop/today");
  });

  it("shows the active batch context in the Agent header and sends the current observation", () => {
    expect(html).toContain("$('agentStatus').textContent");
    expect(html).toContain("' · 第' + dayNumber() + '天 · 日龄' + age()");
    expect(html).toContain("observation: observationPayload()");
    expect(html).toContain("已录入' + (diarrheaLabels[savedDiarrheaGrade] || '') + '腹泻");
  });

  it("captures diarrhea before restoring the draft and keeps Agent usable without a batch", () => {
    expect(html).toContain("var savedDiarrheaGrade = $('diarrhea').value");
    const saveSource = html.slice(html.indexOf("async function saveData"), html.indexOf("async function login"));
    const captureAt = saveSource.indexOf("var savedDiarrheaGrade");
    const restoreAt = saveSource.indexOf("restoreDraft()");
    const triggerAt = saveSource.indexOf("openAgent('已录入' + (diarrheaLabels[savedDiarrheaGrade] || '') + '腹泻'");
    expect(captureAt).toBeGreaterThanOrEqual(0);
    expect(restoreAt).toBeGreaterThan(captureAt);
    expect(triggerAt).toBeGreaterThan(restoreAt);
    expect(html).toContain(": '未选择批次'");
    expect(html).toContain("当前账号没有批次，无法读取批次上下文；请先创建批次。");
    const openSource = html.slice(html.indexOf("function openAgent"), html.indexOf("function saveTableImage"));
    expect(openSource).not.toContain("if (!state.batch) { showToast('请先选择批次'); return; }");
    expect(openSource).toContain("renderAgentMessages()");
    expect(html).toContain("if (!message || !state.batch) return;");
  });

  it("switches only the selected feeding mode with revision and idempotency guards", () => {
    expect(html).toContain('id="selectedModeLabel"');
    expect(html).toContain('data-mode="timed_quantity"');
    expect(html).toContain('data-mode="free_feeding"');
    expect(html).toContain("'/mode'");
    expect(html).toContain("body: { mode: mode, expectedRevision: expectedRevision, idempotencyKey: uuid() }");
    expect(html).toContain("NBJ_BATCH_MODE_FIRST_DAY_LOCKED");
    expect(html).toContain("NBJ_BATCH_MODE_INVALID");
    expect(html).toContain("await loadBatch(batchId)");
    expect(html).not.toContain("模板独立保存、互不覆盖");
    expect(html).toContain("首日固定执行 17:00 / 20:00 / 23:00 / 02:00 / 05:00 / 08:00");
  });

  it("publishes and copies complete SOP Markdown with visible index metadata", () => {
    expect(adminHtml).toContain('id="sopSourceMarkdown"');
    expect(adminHtml).toContain('id="sopPasteButton"');
    expect(adminHtml).toContain('id="sopCopyButton"');
    expect(adminHtml).toContain("发布 / 索引状态");
    expect(adminHtml).toContain("来源摘要");
    expect(adminHtml).toContain("索引修订");
    expect(adminJs).toContain("sourceMarkdown: sourceMarkdown");
    expect(adminJs).toContain("template.sourceSha256");
    expect(adminJs).toContain("template.collectionRevision");
    expect(adminJs).toContain("template.embeddingModel");
    expect(adminJs).toContain("template.indexError");
    expect(adminJs).toContain("navigator.clipboard.writeText(source)");
    expect(adminJs).toContain("navigator.clipboard.readText()");
  });

  it("exposes administrator batch SOP migration with preview and phrase confirmation", () => {
    expect(adminHtml).toContain('id="migrationModal"');
    expect(adminHtml).toContain('id="migrationTemplateId"');
    expect(adminHtml).toContain("迁移会把该批次冻结到目标已发布 SOP");
    expect(adminJs).toContain("api('/api/admin/batches')");
    expect(adminJs).toContain("/sop-migration/preview");
    expect(adminJs).toContain("confirmationPhrase: phrase");
    expect(adminJs).toContain("迁移 SOP");
    expect(adminJs).toContain("data-action=\"migrate-sop\"");
  });

  it("edits, validates, copies, and publishes exactly eight free-feeding slots", () => {
    expect(adminHtml).toContain('id="freeFeedingSlotsHeading">自由采食时间段');
    expect(adminHtml).toContain('id="freeFeedingSlots"');
    expect(adminHtml).toContain('id="freeFeedingSlotValidation"');
    expect(adminHtml).toContain('id="sopSlotCount"');
    expect(adminHtml).toContain("已启用窗口");
    expect(adminJs).toContain("function defaultFreeFeedingSlots()")
    expect(adminJs).toContain("length: 8")
    expect(adminJs).toContain("function validateFreeFeedingSlots(slots)")
    expect(adminJs).toContain("function businessMinute(value)")
    expect(adminJs).toContain("自由采食时段重叠")
    expect(adminJs).toContain("config.freeFeedingTemplate")
    expect(adminJs).toContain("renderFreeFeedingSlots(config)")
    expect(adminJs).toContain("data-free-slot-enabled")
  });

  it("loads an immutable current-day operation list and confirms it only as one audited action", () => {
    expect(html).toContain('id="todayOperationsPanel"');
    expect(html).toContain('id="todayOperationsList"');
    expect(html).toContain('id="confirmTodayOperationsBtn"');
    expect(html).not.toContain("不对单项逐一确认");
    expect(html).toContain("function loadTodayOperations(batchId)");
    expect(html).toContain("'/today-operations'");
    expect(html).toContain("'/today-operations/confirm'");
    expect(html).toContain("function confirmTodayOperations()");
    expect(html).toContain("operationsSha256: plan.operationsSha256");
    expect(html).toContain("dailyOperationConfirmKey(plan)");
    expect(html).toContain("dailyOperationConfirmKey(plan)");
    expect(html).not.toContain("operationItemConfirm");
  });

  it("preserves Agent session switching, Markdown, waiting state, and dialog accessibility", () => {
    expect(html).toContain("/agent/session");
    expect(html).toContain("agentHistoryLoaded");
    expect(html).toContain("state.agentHistoryLoaded = false");
    expect(html).toContain("!state.agentHistoryLoaded");
    expect(html).toContain("response.agentSession.messages");
    expect(html).toContain("/api/feeding-agent/chat");
    expect(html).toContain("markdown(text)");
    expect(html).toContain("typing");
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("trapFocus");
    expect(html).toContain("env(safe-area-inset-bottom)");
  });

  it("drops stale batch responses before rendering or showing switch feedback", () => {
    expect(html).toContain("if (String(batchId) !== String(state.currentBatchId)) return false;");
    expect(html).toContain("var loaded = await loadBatch(batchId);");
    expect(html).toContain("if (loaded && String(batchId) === String(state.currentBatchId)) showToast('已切换批次');");
    expect(html).toContain("if (String(batchId) === String(state.currentBatchId)) showToast(error.message || '批次载入失败');");
  });
});
