import { describe, expect, it } from "vitest";
import { activateDecision, appliedDecision, createDecisionState, isApplied, projectDecision } from "../../src/domain/decision.js";

const planned = {
  id: "p1", batchId: "b1", businessDate: "2026-08-12", revision: 1,
  mode: "timed_quantity" as const, status: "planned" as const,
  evidence: { policyVersion: "execution-contract-v1", modelVersion: "m1", sopVersion: "s1" },
  setting: { mealCount: 6 },
};

describe("domain decision", () => {
  it("keeps planned preview separate from active application", () => {
    const state = createDecisionState({ plannedDecision: planned });
    const projection = projectDecision(state);
    expect(projection.previewSource).toBe("planned");
    expect(projection.isApplied).toBe(false);
    expect(appliedDecision(state)).toBeNull();
    expect(isApplied(state)).toBe(false);
  });

  it("only exposes an active decision after explicit activation", () => {
    const state = createDecisionState({ plannedDecision: planned });
    const active = activateDecision(state, { ...planned, id: "a1", status: "active" });
    expect(active.activeDecision?.id).toBe("a1");
    expect(isApplied(active)).toBe(true);
  });
});
