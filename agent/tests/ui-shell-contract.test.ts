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
    expect(html).toContain('id="deviceHeading">今日执行状态');
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

  it("shows four layered execution blocks and canonical free-feeding plan fields", () => {
    expect(html).toContain('id="singlePowderStat"');
    expect(html).toContain('id="feedCountLabel"');
    expect(html).toContain('id="feedCount"');
    expect(html).toContain('id="dailyPowderLabel"');
    expect(html).toContain('id="deviceSourceValue"');
    expect(html).toContain('id="execModeValue"');
    expect(html).toContain('id="execControlValue"');
    expect(html).toContain('id="execPlanValue"');
    expect(html).toContain('id="execRuntimeValue"');
    expect(html).toContain("function todayPlanMode(today)");
    expect(html).toContain("function planSetting(today)");
    expect(html).toContain("function planCount(today)");
    expect(html).toContain("function decisionForDisplay(today)");
    expect(html).toContain("function planEvidence(today)");
    expect(html).toContain("function plannedExceptionActions(today)");
    expect(html).toContain("function renderExecutionState()");
    expect(html).toContain("$('singlePowderStat').hidden = false");
    expect(html).toContain("今日最大配奶次数");
    expect(html).toContain("程序总量 = 单次 × 今日最大配奶次数");
    expect(html).toContain('<div class="program-time-label" id="programTimeLabel">配奶时间点</div>');
    expect(html).toContain("自由采食窗口");
    expect(html).toContain("function deviceSchedule(today)");
    expect(html).toContain('<strong>定时定量</strong><span>保留既有时间点、排除时段、精度和减餐优先级</span>');
    expect(html).toContain('<strong>自由采食</strong><span>采用批次冻结 SOP 的窗口、阶段条件与异常阻断</span>');
    expect(html).not.toContain("现有定时定量模板");
    expect(html).not.toContain("SOP 自由采食模板");
    expect(html).not.toContain("建议单日下粉总量（");
    expect(html).not.toContain("suggestedDailyPowderGrams");
    expect(html).not.toContain("suggestedDailyMealCount");
    expect(html).not.toContain("今日执行：");
    expect(html).not.toContain('id="effectiveModeLabel"');
    for (const forbidden of [
      "source.freeWindows",
      "source.free_windows",
      "source.mealTimes",
      "source.meal_times",
      "state.today.exceptionActions",
      "state.today.exception_actions",
      "value(today, 'modelVersion'",
      "value(today, 'sopVersion'",
    ]) {
      expect(html).not.toContain(forbidden);
    }
    expect(html).toContain("只给我次日的单次奶粉量、程序总奶粉量和配奶时间点。");
  });

  it("reads today plan mode from activeDecision ?? plannedDecision", () => {
    const source = html.match(/function todayPlanMode\(today\) \{[^\n]+\}/)?.[0];
    expect(source).toBeTruthy();
    const value = (object: Record<string, unknown> | undefined, camel: string, snake: string, fallback: unknown) => {
      const result = object?.[camel] ?? object?.[snake];
      return result == null ? fallback : result;
    };
    const todayPlanMode = new Function("value", `${source}\nreturn todayPlanMode;`)(value) as (today: Record<string, unknown>) => string;
    expect(todayPlanMode({
      activeDecision: { setting: { mode: "free_feeding" } },
      plannedDecision: { setting: { mode: "timed_quantity" } },
    })).toBe("free_feeding");
    expect(todayPlanMode({
      activeDecision: null,
      plannedDecision: { setting: { mode: "free_feeding" } },
    })).toBe("free_feeding");
    expect(todayPlanMode({
      activeDecision: { setting: { mode: "timed_quantity" } },
      plannedDecision: { setting: { mode: "free_feeding" } },
    })).toBe("timed_quantity");
    expect(todayPlanMode({ effectiveMode: "free_feeding" })).toBe("");
  });

  it("renders canonical free-feeding windows instead of timed meal points", () => {
    const planSource = html.match(/function planSetting\(today\) \{[^\n]+\}/)?.[0];
    const modeSource = html.match(/function todayPlanMode\(today\) \{[^\n]+\}/)?.[0];
    const scheduleSource = html.match(/function deviceSchedule\(today\) \{[^\n]+\}/)?.[0];
    expect(planSource).toBeTruthy();
    expect(modeSource).toBeTruthy();
    expect(scheduleSource).toBeTruthy();
    const value = (object: Record<string, unknown> | undefined, camel: string, snake: string, fallback: unknown) => {
      const result = object?.[camel] ?? object?.[snake];
      return result == null ? fallback : result;
    };
    const first = (...args: unknown[]) => args.find((item) => item !== undefined && item !== null) ?? null;
    const planSetting = new Function("value", `${planSource}\nreturn planSetting;`)(value) as (today: Record<string, unknown>) => Record<string, unknown>;
    const todayPlanMode = new Function("value", `${modeSource}\nreturn todayPlanMode;`)(value) as (today: Record<string, unknown>) => string;
    const deviceSchedule = new Function("value", "first", "planSetting", "todayPlanMode", `${scheduleSource}\nreturn deviceSchedule;`)(value, first, planSetting, todayPlanMode) as (today: Record<string, unknown>) => { label: string; entries: string[] };
    const schedule = deviceSchedule({
      activeDecision: null,
      plannedDecision: {
        setting: {
          mode: "free_feeding",
          freeWindows: [{ startLocal: "09:00", endLocal: "17:00" }],
          timedMeals: [{ timeLocal: "10:00" }],
        },
      },
    });
    expect(schedule.label).toBe("自由采食窗口");
    expect(schedule.entries).toEqual(["09:00–17:00"]);

    const threeWindows = [
      { startLocal: "09:00", endLocal: "10:00" },
      { startLocal: "12:00", endLocal: "13:00" },
      { startLocal: "15:00", endLocal: "16:00" },
    ];
    const threeSchedule = deviceSchedule({
      activeDecision: null,
      plannedDecision: { setting: { mode: "free_feeding", freeWindows: threeWindows } },
    });
    expect(threeSchedule.entries).toEqual(["09:00–10:00", "12:00–13:00", "15:00–16:00"]);

    const eightWindows = Array.from({ length: 8 }, (_, index) => ({
      startLocal: `${String(9 + index).padStart(2, "0")}:00`,
      endLocal: `${String(9 + index).padStart(2, "0")}:30`,
    }));
    const eightSchedule = deviceSchedule({
      activeDecision: null,
      plannedDecision: { setting: { mode: "free_feeding", freeWindows: eightWindows } },
    });
    expect(eightSchedule.entries).toHaveLength(8);
    expect(eightSchedule.entries[0]).toBe("09:00–09:30");
    expect(eightSchedule.entries.at(-1)).toBe("16:00–16:30");
  });

  it("never falls back to flat freeWindows, mealTimes, or freeDispenseLimit", () => {
    const planSource = html.match(/function planSetting\(today\) \{[^\n]+\}/)?.[0];
    const modeSource = html.match(/function todayPlanMode\(today\) \{[^\n]+\}/)?.[0];
    const countSource = html.match(/function planCount\(today\) \{[^\n]+\}/)?.[0];
    const scheduleSource = html.match(/function deviceSchedule\(today\) \{[^\n]+\}/)?.[0];
    expect(planSource).toBeTruthy();
    expect(modeSource).toBeTruthy();
    expect(countSource).toBeTruthy();
    expect(scheduleSource).toBeTruthy();
    const value = (object: Record<string, unknown> | undefined, camel: string, snake: string, fallback: unknown) => {
      const result = object?.[camel] ?? object?.[snake];
      return result == null ? fallback : result;
    };
    const planSetting = new Function("value", `${planSource}\nreturn planSetting;`)(value) as (today: Record<string, unknown>) => Record<string, unknown>;
    const todayPlanMode = new Function("value", `${modeSource}\nreturn todayPlanMode;`)(value) as (today: Record<string, unknown>) => string;
    const planCount = new Function("value", "planSetting", "todayPlanMode", `${countSource}\nreturn planCount;`)(value, planSetting, todayPlanMode) as (today: Record<string, unknown>) => unknown;
    const deviceSchedule = new Function("value", "planSetting", "todayPlanMode", `${scheduleSource}\nreturn deviceSchedule;`)(value, planSetting, todayPlanMode) as (today: Record<string, unknown>) => { label: string; entries: string[] };

    expect(planCount({
      activeDecision: null,
      plannedDecision: { setting: { mode: "free_feeding", mealCount: 9 } },
      mealCount: 9,
    })).toBeUndefined();
    expect(planCount({
      activeDecision: null,
      plannedDecision: { setting: { mode: "timed_quantity", mealCount: 9 } },
    })).toBe(9);

    const freeMissing = deviceSchedule({
      activeDecision: null,
      plannedDecision: { setting: { mode: "free_feeding" } },
      freeWindows: [{ startLocal: "00:00", endLocal: "23:59" }],
    });
    expect(freeMissing.entries).toEqual([]);

    const timedMissing = deviceSchedule({
      activeDecision: null,
      plannedDecision: { setting: { mode: "timed_quantity" } },
      mealTimes: ["10:00", "14:00"],
    });
    expect(timedMissing.entries).toEqual([]);
  });

  it("keeps planned curve-cap and decision evidence as layered UI authority", () => {
    const exceptionSource = html.match(/function plannedExceptionActions\(today\) \{[^\n]+\}/)?.[0];
    const decisionSource = html.match(/function decisionForDisplay\(today\) \{[^\n]+\}/)?.[0];
    const evidenceSource = html.match(/function planEvidence\(today\) \{[^\n]+\}/)?.[0];
    expect(exceptionSource).toBeTruthy();
    expect(decisionSource).toBeTruthy();
    expect(evidenceSource).toBeTruthy();
    const value = (object: Record<string, unknown> | undefined, camel: string, snake: string, fallback: unknown) => {
      const result = object?.[camel] ?? object?.[snake];
      return result == null ? fallback : result;
    };
    const plannedExceptionActions = new Function("value", `${exceptionSource}\nreturn plannedExceptionActions;`)(value) as (today: Record<string, unknown>) => Array<{ type: string }>;
    const decisionForDisplay = new Function("value", `${decisionSource}\nreturn decisionForDisplay;`)(value) as (today: Record<string, unknown>) => Record<string, unknown> | null;
    const planEvidence = new Function("value", "decisionForDisplay", `${evidenceSource}\nreturn planEvidence;`)(value, decisionForDisplay) as (today: Record<string, unknown>) => Record<string, unknown>;

    expect(plannedExceptionActions({
      activeDecision: { exceptionActions: [] },
      plannedDecision: { exceptionActions: [{ type: "curve_cap" }] },
      exceptionActions: [],
    }).map((action) => action.type)).toEqual(["curve_cap"]);

    expect(planEvidence({
      activeDecision: { evidence: { modelVersion: "active-model", sopVersion: "active-sop" } },
      plannedDecision: { evidence: { modelVersion: "planned-model", sopVersion: "planned-sop" } },
      modelVersion: "flat-model",
      sopVersion: "flat-sop",
    })).toEqual({ modelVersion: "active-model", sopVersion: "active-sop" });

    expect(planEvidence({
      activeDecision: null,
      plannedDecision: { evidence: { modelVersion: "planned-model", sopVersion: "planned-sop" } },
      modelVersion: "flat-model",
      sopVersion: "flat-sop",
    })).toEqual({ modelVersion: "planned-model", sopVersion: "planned-sop" });
  });

  it("keeps the complete daily table and mobile-only horizontal scrolling", () => {
    for (const heading of ["批次日", "日龄", "有效头数", "模式", "单次量", "餐次", "时间点", "程序总量", "实际总量", "教槽", "腹泻", "饮水"]) {
      expect(html).toContain(`<th>${heading}</th>`);
    }
    expect(html).toContain("overflow-x: auto");
    expect(html).toContain("长按 0.65 秒保存");
    expect(html).toContain("saveTableImage");
    expect(html).toContain("<th>头均采食(g/头)</th>");
    expect(html).toContain("g/头");
    expect(html).toContain("perHeadPowder");
    expect(html).toContain("actualPowder, 0) / rowHeads");
    expect(html).toContain("function bindLongPress() { var target = $('dailyTable')");
    expect(html).toContain("confirmedSetting.dailyPowderGrams");
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
    expect(html).toContain("openAgent('已录入轻度腹泻");
    expect(html).toContain("不要修改整栏设备");
  });

  it("captures diarrhea before restoring the draft and keeps Agent usable without a batch", () => {
    expect(html).toContain("var savedDiarrheaGrade = $('diarrhea').value");
    const saveSource = html.slice(html.indexOf("async function saveData"), html.indexOf("async function login"));
    const captureAt = saveSource.indexOf("var savedDiarrheaGrade");
    const restoreAt = saveSource.indexOf("restoreDraft()");
    const triggerAt = saveSource.indexOf("openAgent('已录入轻度腹泻");
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

  it("shows feedback device proposal states and labels feedback operations", () => {
    expect(html).toContain('id="deviceFeedbackStatus"');
    expect(html).toContain("function renderDeviceFeedbackStatus()");
    expect(html).toContain("已应用方案");
    expect(html).toContain("待确认方案");
    expect(html).toContain("未记录方案");
    expect(html).toContain("plan.proposedSetting");
    expect(html).toContain("confirmation.deviceSetting");
    expect(html).toContain("operation-feedback");
    expect(html).toContain("现场反馈 · ");
    expect(html).toContain("item.feedbackRef.kind === 'diarrhea' ? '腹泻' : '教槽控奶'");
    expect(html).toContain("amendAction(");
    expect(html).toContain("diarrheaManualAction(");
    expect(html).toContain("已完成隔离与控奶");
    expect(html).toContain("individual_intervention_completed");
    expect(html).toContain("确认减餐");
    expect(html).toContain("应用调整");
    expect(html).toContain("取消调整");
    expect(html).toContain("已取消");
    expect(html).toContain("已被更新替代");
    expect(html).not.toContain("拒绝调整");
    expect(html).toContain("if (action === 'apply') await loadBatch(batchId);");
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
