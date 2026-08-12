import { describe, expect, it } from "vitest";
import { INITIAL_RUNTIME_STATE, resolveRuntimeState, transitionRuntimeState } from "../../src/domain/runtime-state.js";

describe("domain runtime state", () => {
  it("keeps device and feeding latches independent", () => {
    const blocked = transitionRuntimeState(INITIAL_RUNTIME_STATE, { id: "d1", deviceStatus: "blocked" });
    const refusal = transitionRuntimeState(blocked, { id: "f1", feedingResponse: "refusal" });
    const clearFeeding = transitionRuntimeState(refusal, { id: "f2", feedingResponse: "normal" });
    expect(refusal).toMatchObject({ state: "blocked", deviceLatch: "blocked", feedingLatch: "refusal" });
    expect(clearFeeding).toMatchObject({ state: "blocked", deviceLatch: "blocked", feedingLatch: "normal" });
  });

  it("omission preserves the active latch", () => {
    const blocked = transitionRuntimeState(INITIAL_RUNTIME_STATE, { deviceStatus: "blocked" });
    expect(transitionRuntimeState(blocked, {})).toMatchObject({ state: "blocked", deviceLatch: "blocked" });
    expect(() => transitionRuntimeState(blocked, { deviceStatus: "invalid" })).toThrow("DOMAIN_RUNTIME_DEVICE_INVALID");
  });

  it("resolves an ordered observation stream", () => {
    expect(resolveRuntimeState([
      { deviceStatus: "blocked" },
      { feedingResponse: "refusal" },
      { deviceStatus: "normal" },
    ])).toMatchObject({ state: "manual_hold", deviceLatch: "normal", feedingLatch: "refusal" });
  });
});
