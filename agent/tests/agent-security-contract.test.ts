import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const tools = readFileSync(resolve(root, "src/container/tools.ts"), "utf8");
const decisionService = readFileSync(resolve(root, "src/decision/batch-decision-service.ts"), "utf8");
const server = readFileSync(resolve(root, "src/container/server.ts"), "utf8");
const graphRuntime = readFileSync(resolve(root, "src/agent/langgraph/runtime.ts"), "utf8");
const models = readFileSync(resolve(root, "src/agent/langgraph/models.ts"), "utf8");
const nginx = readFileSync(resolve(root, "docker/nginx.conf.template"), "utf8");
const compose = readFileSync(resolve(root, "docker/compose.local.yaml"), "utf8");
const runtimeConfig = readFileSync(resolve(root, "src/container/runtime-config.ts"), "utf8");
const localAuth = readFileSync(resolve(root, "src/container/local-auth.ts"), "utf8");
const localApi = readFileSync(resolve(root, "src/container/local-api.ts"), "utf8");
const page = readFileSync(resolve(root, "../index.html"), "utf8");
const onsitePage = readFileSync(resolve(root, "ui/liquid-index.html"), "utf8");
const adminPage = readFileSync(resolve(root, "../admin.html"), "utf8");
const adminScript = readFileSync(resolve(root, "../admin.js"), "utf8");

const allowedTools = [
  "get_batch_context",
  "get_today_timeline",
  "compute_production_plan",
  "compute_sop_meal",
  "check_execution_gap",
  "check_data_quality",
  "manage_laggard_case",
  "search_feeding_knowledge",
  "draft_daily_decision",
];

describe("Agent security boundary", () => {
  it.each(allowedTools)("registers the approved tool %s", (name) => {
    expect(tools).toContain(`name: "${name}"`);
    expect(server).toContain(`"${name}"`);
  });

  it("does not register coding, filesystem, shell, or arbitrary network tools", () => {
    expect(tools).not.toMatch(/name:\s*["'](?:bash|shell|read_file|write_file|edit_file|fetch_url)/);
    expect(server).not.toContain("bash is disabled");
  });

  it("requires deterministic evidence before drafting a decision", () => {
    expect(tools).toContain("NBJ_AGENT_DETERMINISTIC_EVIDENCE_REQUIRED");
    expect(tools).toContain("requiresHumanApproval: true");
    expect(tools).toContain("controlsEquipment: false");
  });

  it("scopes local data to an authenticated cookie and server-selected batch", () => {
    expect(localAuth).toContain('SESSION_COOKIE_NAME = "nbj_session"');
    expect(localAuth).toContain('role !== "admin"');
    expect(localApi).toContain("requireLocalAuth");
    expect(nginx).toContain("proxy_set_header X-Agent-Gateway-Secret");
    expect(tools).not.toContain("service_role");
    expect(nginx).not.toContain("service_role");
  });

  it("keeps the public Nginx edge outside authentication and business-data concerns", () => {
    expect(nginx).toContain("proxy_pass http://agent:8080");
    expect(nginx).not.toContain("supabaseRest");
    expect(compose).toContain("CHROMA_URL: http://chroma:8000");
  });

  it("keeps Agent controls hidden outside an authenticated application", () => {
    expect(page).toContain('id="agentLauncher" type="button"');
    expect(page).toContain('id="feedingAgentDrawer" aria-label="奶爸机现场 Agent" hidden');
    expect(page).toContain("document.getElementById('agentLauncher').hidden = true");
  });

  it("exposes only the current SOP step and requires explicit actual-milk confirmation", () => {
    expect(page).toContain('id="inputMilkConfirmed"');
    expect(page).toContain("sop-current-step");
    expect(page).toContain("完成本步");
    expect(page).toContain("futureTasks");
    expect(page).toContain("请先核对设备记录，并勾选“以上数值为实际总配奶量”");
  });

  it("parses complete SSE frames and keeps long Agent responses alive", () => {
    expect(page).toContain("consumeSseBlock");
    expect(page).toContain("buffer.split(/\\r?\\n\\r?\\n/)");
    expect(page).toContain("decoder.decode()");
    expect(page).toContain("streamDone");
    expect(server).toContain('response.write(": keepalive\\n\\n")');
    expect(server).toContain("response.flushHeaders()");
  });

  it("keeps Agent memory batch-scoped and restores its history", () => {
    expect(page).toContain("ensure_feeding_agent_session");
    expect(page).toContain("sessionBatchId");
    expect(page).toContain("feeding_agent_messages");
    expect(server).toContain("NBJ_AGENT_SESSION_BATCH_MISMATCH");
    expect(server).toContain("storedRows.reverse()");
    expect(server).toContain("history,");
    expect(graphRuntime).toContain("...run.history");
    expect(graphRuntime).toContain("NBJ_AGENT_RESUME_INPUT_MISMATCH");
  });

  it("uses deterministic complete curves for concrete device advice", () => {
    expect(tools).toContain("fullFeedingCurve");
    expect(tools).toContain("loadFrozenBatchDecisionContext");
    expect(decisionService).toContain("devicePowderPrecisionGrams");
    expect(server).toContain("常规日计划回复只输出三行");
    expect(server).toContain("单次配奶粉量、程序总奶粉量、配奶时间点");
    expect(server).toContain("不得把加水量或奶液量说成设备设置项");
    expect(server).toContain("教奶程序固定为断奶首日 17:00、20:00、23:00");
    expect(server).toContain("次日 02:00、05:00、08:00");
    expect(server).toContain("正常饲喂初始为每天 10 次");
    expect(server).toContain("当日 09:00 至次日 09:00");
    expect(server).toContain("00:00 与 12:00 不配奶");
    expect(server).toContain("低/中/高/极好餐次下限为 9/8/6/4");
    expect(server).toContain("餐次只减不增、每天最多减一次且最高 10 次");
    expect(server).toContain("estimatedAverageWeightKg/estimatedEndWeightKg");
    expect(tools).toContain("estimatedWeightCurve");
    expect(server).toContain("SOP 直接给出的总量优先");
    expect(server).toContain("只有 SOP 不能直接或间接确定总量时");
    expect(page).toContain("首夜教奶程序");
    expect(page).not.toContain("mL奶液");
    expect(page).not.toContain("多数已主动到槽");
  });

  it("shows a waiting animation and safely renders Agent Markdown", () => {
    expect(page).toContain("agent-thinking");
    expect(page).toContain("renderMarkdown: function");
    expect(page).toContain("setAssistantContent");
    expect(page).toContain("rel=\"noopener noreferrer\"");
    expect(page).toContain("escapeHtml(String(text || ''))");
  });

  it("advances a batch with one local atomic request and renders its response", () => {
    expect(page).toContain("this.current.tasks = (this.current.tasks || []).map");
    expect(page).toContain("setTimeout(function() { FeedingAgentUI.refresh({ preserveStatus: true }) }, 0)");
    expect(page).toContain("正在保存…");
    expect(localApi).toContain('suffix === "advance"');
    expect(localApi).toContain("store.commitAdvance");
    expect(localApi).toContain("idempotencyKey");
  });

  it("requires a verified local administrator for runtime API configuration", () => {
    expect(localAuth).toContain("requireLocalAdmin");
    expect(localApi).toContain('"/api/admin/feeding-agent/config"');
    expect(server).toContain("handleAdminConfig");
    expect(nginx).not.toContain("is_admin");
  });

  it("encrypts runtime credentials and never stores them in Supabase", () => {
    expect(runtimeConfig).toContain('"aes-256-gcm"');
    expect(runtimeConfig).toContain("cipher.getAuthTag()");
    expect(runtimeConfig).not.toContain("supabase");
    expect(adminScript).not.toMatch(/localStorage|sessionStorage/);
    expect(adminPage).toContain('id="apiKey" type="password"');
  });

  it("provides separate admin entries for Agent API and immutable SOP versions", () => {
    expect(adminPage).toContain('data-admin-view="apiAdminView"');
    expect(adminPage).toContain('data-admin-view="sopAdminView"');
    expect(adminScript).toContain("/api/admin/sop/templates");
    expect(adminPage).toContain('id="sopSourceMarkdown"');
    expect(adminScript).toContain("sourceMarkdown: sourceMarkdown");
    expect(adminScript).toContain("template.sourceSha256");
    expect(adminScript).toContain("template.collectionRevision");
  });

  it("keeps operator mode switching revision-safe and template-immutable", () => {
    expect(onsitePage).toContain("'/mode'");
    expect(onsitePage).toContain("expectedRevision: expectedRevision");
    expect(onsitePage).toContain("idempotencyKey: uuid()");
    expect(onsitePage).toContain("NBJ_BATCH_MODE_FIRST_DAY_LOCKED");
    expect(onsitePage).toContain("NBJ_BATCH_STALE");
    expect(onsitePage).not.toContain("只切换本批次采用的模板，不修改任何模板参数");
    expect(onsitePage).not.toMatch(/\/mode[^\n]+(?:config|template)\s*:/);
  });

  it("supports custom HTTPS provider endpoints and OpenAI-compatible API modes", () => {
    expect(adminPage).toContain('id="apiBaseUrl"');
    expect(adminPage).toContain('id="apiMode"');
    expect(server).toContain("normalizeBaseUrl");
    expect(models).toContain("ChatOpenAI");
    expect(models).toContain("useResponsesApi");
    expect(server).toContain("validateProviderConnection");
  });

  it("prevents stale public admin bundles after a configuration rollout", () => {
    expect(nginx).toContain('add_header Cache-Control "no-store" always');
    expect(adminPage).toContain("admin.js?v=20260804-1");
  });
});
