import { describe, expect, it } from "vitest";
import { resolveRuntimeState } from "../../src/decision/runtime-state.js";

describe("runtime execution state resolver", () => {
  it("aggregates blocked over manual_hold and keeps reasons", () => {
    const state = resolveRuntimeState([
      {
        observationId: "o-refusal",
        recordedAt: "2026-08-07T10:00:00Z",
        feedingResponse: "refusal",
      },
      {
        observationId: "o-blocked",
        recordedAt: "2026-08-07T11:00:00Z",
        deviceStatus: "blocked",
      },
    ]);
    expect(state.state).toBe("blocked");
    expect(state.reasons).toEqual(["device_blocked", "feeding_refusal"]);
    expect(state.sourceObservationIds).toEqual(["o-refusal", "o-blocked"]);
  });

  it("keeps blocked when deviceStatus is omitted and explicit feeding normal is recorded", () => {
    const state = resolveRuntimeState([
      { observationId: "o-blocked", recordedAt: "2026-08-07T10:00:00Z", deviceStatus: "blocked" },
      { observationId: "o-normal-feed", recordedAt: "2026-08-07T11:00:00Z", feedingResponse: "normal" },
    ]);
    expect(state.state).toBe("blocked");
    expect(state.deviceLatch).toBe("blocked");
    expect(state.feedingLatch).toBe("normal");
  });

  it("only clears the device domain with explicit device normal", () => {
    const state = resolveRuntimeState([
      {
        observationId: "o-refusal",
        recordedAt: "2026-08-07T10:00:00Z",
        feedingResponse: "refusal",
      },
      {
        observationId: "o-blocked",
        recordedAt: "2026-08-07T11:00:00Z",
        deviceStatus: "blocked",
      },
      {
        observationId: "o-device-normal",
        recordedAt: "2026-08-07T12:00:00Z",
        deviceStatus: "normal",
      },
    ]);
    expect(state.state).toBe("manual_hold");
    expect(state.deviceLatch).toBe("normal");
    expect(state.feedingLatch).toBe("refusal");
  });

  it("ignores malformed legacy timestamps before runtime decisions", () => {
    const state = resolveRuntimeState([
      { observationId: "o-invalid", recordedAt: "invalid-legacy-time", deviceStatus: "blocked" },
      { observationId: "o-refusal", recordedAt: "2026-08-07T10:00:00Z", feedingResponse: "refusal" },
    ]);
    expect(state.state).toBe("manual_hold");
    expect(state.deviceLatch).toBe("normal");
    expect(state.sourceObservationIds).toEqual(["o-refusal"]);
  });

  it("normalizes legacy ok/refusing values without treating omitted as normal", () => {
    const state = resolveRuntimeState([
      { observationId: "o-legacy", recordedAt: "2026-08-07T10:00:00Z", deviceStatus: "ok", feedingResponse: "refusing" },
    ]);
    expect(state.state).toBe("manual_hold");
    expect(state.deviceLatch).toBe("normal");
    expect(state.feedingLatch).toBe("refusal");
  });
});
