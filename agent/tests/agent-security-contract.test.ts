import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const tools = readFileSync(resolve(root, "src/container/tools.ts"), "utf8");
const server = readFileSync(resolve(root, "src/container/server.ts"), "utf8");
const worker = readFileSync(resolve(root, "src/worker/index.ts"), "utf8");
const runtimeConfig = readFileSync(resolve(root, "src/container/runtime-config.ts"), "utf8");
const wrangler = readFileSync(resolve(root, "wrangler.jsonc"), "utf8");
const page = readFileSync(resolve(root, "../index.html"), "utf8");
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

  it("scopes all data access to the caller JWT and server-selected batch", () => {
    expect(worker).toContain("verifySupabaseJwt");
    expect(worker).toContain("const auth = await authenticate(request, env)");
    expect(tools).not.toContain("service_role");
    expect(worker).not.toContain("service_role");
  });

  it("keeps staging Agent chat disabled until provider simulation is approved", () => {
    expect(wrangler).toContain('"AGENT_ENABLED": "false"');
    expect(worker).toContain('requireFeature(env.AGENT_ENABLED, "NBJ_AGENT_DISABLED")');
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
    expect(server).toContain("messages: history");
  });

  it("uses deterministic complete curves for concrete device advice", () => {
    expect(tools).toContain("fullFeedingCurve");
    expect(tools).toContain("devicePowderPrecisionGrams");
    expect(server).toContain("下奶时间点、当日总粉量、餐次和单次下粉量");
    expect(server).toContain("不得把加水量或奶液量说成设备设置项");
    expect(server).toContain("教奶程序覆盖断奶首日和首夜");
    expect(server).toContain("次日 08:00 下奶并完成早间巡栏后结束");
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

  it("applies completion results locally and reconciles without blocking the click", () => {
    expect(page).toContain("this.current.tasks = (this.current.tasks || []).map");
    expect(page).toContain("setTimeout(function() { FeedingAgentUI.refresh({ preserveStatus: true }) }, 0)");
    expect(page).toContain("正在保存…");
    expect(worker).toContain("const [tasks, laggards] = await Promise.all");
  });

  it("requires a verified admin before forwarding runtime API configuration", () => {
    expect(worker).toContain('"/rest/v1/rpc/is_admin"');
    expect(worker).toContain("await ensureAdmin(env, auth)");
    expect(worker).toContain('headers.set("x-agent-admin", "true")');
    expect(server).toContain('request.headers["x-agent-admin"] !== "true"');
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
    expect(adminScript).toContain("admin_publish_feeding_sop_template");
  });

  it("supports custom HTTPS provider endpoints and OpenAI-compatible API modes", () => {
    expect(adminPage).toContain('id="apiBaseUrl"');
    expect(adminPage).toContain('id="apiMode"');
    expect(server).toContain("normalizeBaseUrl");
    expect(server).toContain("openAICompletionsApi");
    expect(server).toContain("validateProviderConnection");
  });

  it("prevents stale public admin bundles after a configuration rollout", () => {
    expect(wrangler).toContain('"/admin.js"');
    expect(worker).toContain('headers.set("cache-control", "no-store, max-age=0")');
    expect(adminPage).toContain("admin.js?v=20260731-4");
  });
});
