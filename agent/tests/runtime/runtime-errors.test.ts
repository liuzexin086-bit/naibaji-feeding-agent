import { describe, expect, it } from "vitest";
import { classifyAgentRuntimeError } from "../../src/container/runtime-errors.js";

describe("Agent runtime error classification", () => {
  it("reports unavailable provider models without leaking the upstream body", () => {
    expect(classifyAgentRuntimeError("503 model_not_found")).toBe(
      "NBJ_AGENT_MODEL_NOT_FOUND",
    );
    expect(classifyAgentRuntimeError("No available channel for model x")).toBe(
      "NBJ_AGENT_MODEL_NOT_FOUND",
    );
  });

  it("classifies authentication, rate limit, timeout, and unknown failures", () => {
    expect(classifyAgentRuntimeError("401 invalid_api_key")).toBe(
      "NBJ_AGENT_AUTH_FAILED",
    );
    expect(classifyAgentRuntimeError("429 too many requests")).toBe(
      "NBJ_AGENT_RATE_LIMITED",
    );
    expect(classifyAgentRuntimeError("request timed out")).toBe(
      "NBJ_AGENT_TIMEOUT",
    );
    expect(classifyAgentRuntimeError("socket closed")).toBe(
      "NBJ_AGENT_UNAVAILABLE",
    );
  });
});
