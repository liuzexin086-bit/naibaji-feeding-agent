import { describe, expect, it } from "vitest";
import { applyOperation, confirmOperation, createOperationPlan, operationState } from "../../src/domain/operation.js";

const plan = {
  id: "op1", batchId: "b1", businessDate: "2026-08-12", revision: 2,
  operations: [{ code: "patrol", title: "巡栏" }], status: "planned" as const,
};

describe("domain operation", () => {
  it("protects confirmed/applied transitions", () => {
    const confirmed = confirmOperation(createOperationPlan(plan), "u1", "2026-08-12T01:00:00Z");
    const applied = applyOperation(confirmed, "u1", "2026-08-12T01:01:00Z");
    expect(operationState(confirmed)).toBe("confirmed");
    expect(operationState(applied)).toBe("applied");
    expect(() => applyOperation(createOperationPlan(plan), "u1", "now")).toThrow("DOMAIN_OPERATION_TRANSITION_INVALID");
    expect(() => confirmOperation(applied, "u1", "later")).toThrow("DOMAIN_OPERATION_TRANSITION_INVALID");
  });
});
