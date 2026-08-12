import { describe, expect, it } from "vitest";
import { CREEP_CONTROL_POLICY_VERSION, INACTIVE_CREEP_CONTROL, createCreepControlState, transitionCreepControl } from "../../src/domain/creep-control.js";

describe("domain creep control", () => {
  it("starts explicitly and keeps startDay immutable after activation", () => {
    const active = transitionCreepControl(INACTIVE_CREEP_CONTROL, { currentDay: 2, sustainedGrade: "high" });
    const later = transitionCreepControl(active, { currentDay: 8, sustainedGrade: "excellent" });
    expect(active).toEqual({ status: "active", startDay: 3, triggerGrade: "high", policyVersion: CREEP_CONTROL_POLICY_VERSION });
    expect(later.startDay).toBe(3);
    expect(later.triggerGrade).toBe("high");
  });

  it("does not treat planned/inactive state as active", () => {
    expect(createCreepControlState()).toEqual(INACTIVE_CREEP_CONTROL);
    expect(() => createCreepControlState({ status: "inactive" })).toThrow("DOMAIN_CREEP_POLICY_UNSUPPORTED");
    expect(() => createCreepControlState({ status: "active", startDay: null, triggerGrade: null })).toThrow();
    expect(() => createCreepControlState({ policyVersion: "future" as never })).toThrow("DOMAIN_CREEP_POLICY_UNSUPPORTED");
  });
});
