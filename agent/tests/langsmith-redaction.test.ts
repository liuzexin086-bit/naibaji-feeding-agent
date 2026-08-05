import { describe, expect, it } from "vitest";
import {
  queryHmac,
  safeTracePayload,
  withMetadataTrace,
} from "../src/observability/langsmith.js";

describe("LangSmith metadata-only boundary", () => {
  it("replaces raw Chinese queries with a stable keyed digest", () => {
    const raw = "批次A 猪号P-001 今天喂多少？";
    const payload = safeTracePayload({
      provider: "openai",
      model: "gpt-test",
      apiMode: "responses",
      graphVersion: "v1",
      query: raw,
    }, "trace-secret");
    expect(payload).toEqual({
      provider: "openai",
      model: "gpt-test",
      apiMode: "responses",
      graphVersion: "v1",
      queryHmac: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(payload)).not.toContain(raw);
    expect(JSON.stringify(payload)).not.toContain("P-001");
    expect(queryHmac(raw, "trace-secret")).toBe(payload.queryHmac);
    expect(queryHmac(raw, "different-secret")).not.toBe(payload.queryHmac);
  });

  it("does not require LangSmith and preserves operation results", async () => {
    const result = await withMetadataTrace({
      enabled: false,
      hashKey: "key",
    }, {
      provider: "anthropic",
      model: "claude-test",
      apiMode: "responses",
      graphVersion: "v1",
      query: "敏感现场数据",
    }, async () => ({ ok: true }));
    expect(result).toEqual({ ok: true });
  });
});
