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

  it("shows only the single amount, program total, and feeding times in the daily setting", () => {
    expect(html).toContain('<span class="label">单次下粉</span>');
    expect(html).toContain('<span class="label">程序总量</span>');
    expect(html).toContain('<div class="program-time-label">配奶时间点</div>');
    expect(html).not.toContain('<span class="label">今日餐次</span>');
    expect(html).not.toContain('<span class="label">下一次</span>');
    expect(html).not.toContain("设备按设定执行");
    expect(html).not.toContain("自动下奶");
    expect(html).toContain("只给我次日的单次奶粉量、程序总奶粉量和配奶时间点。");
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

  it("advances with one idempotent request and renders its response", () => {
    expect(html).toContain("/advance");
    expect(html).toContain("expectedRevision");
    expect(html).toContain("idempotencyKey");
    expect(html).toContain("applyBatchResponse(response)");
    expect(html).not.toContain("/sop/today");
  });

  it("preserves Agent session switching, Markdown, waiting state, and dialog accessibility", () => {
    expect(html).toContain("/agent/session");
    expect(html).toContain("/api/feeding-agent/chat");
    expect(html).toContain("markdown(text)");
    expect(html).toContain("typing");
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("trapFocus");
    expect(html).toContain("env(safe-area-inset-bottom)");
  });
});
