import { describe, expect, it } from "vitest";
import {
  buildDailyOperationItems,
  digestDailyOperationItems,
} from "../../src/operations/daily-operation-plan.js";

describe("daily operation materialization", () => {
  it("builds deterministic first-day, patrol, SOP, and maintenance work without item confirmation state", () => {
    const operations = buildDailyOperationItems({
      dayIndex: 0,
      dayAge: 3,
      endAge: 28,
      sopConfig: { version: "frozen" },
    });
    expect(operations.map((item) => item.code)).toEqual(["first_day_teaching"]);
    expect(operations.find((item) => item.code === "first_day_teaching")?.dueWindow)
      .toEqual({ startLocal: "17:00", endLocal: "08:00", endDayOffset: 1 });
    expect(JSON.stringify(operations)).not.toContain("confirmed");
    expect(digestDailyOperationItems(operations)).toMatch(/^[A-F0-9]{64}$/);
    expect(digestDailyOperationItems(operations)).toBe(digestDailyOperationItems(structuredClone(operations)));
  });

  it("uses the frozen stage age when composing later operation plans", () => {
    const operations = buildDailyOperationItems({
      dayIndex: 8,
      dayAge: 11,
      endAge: 28,
      sopConfig: {},
    });
    expect(operations.map((item) => item.code)).toContain("sop_creep_teaching");
    expect(operations.map((item) => item.code)).toContain("preventive_maintenance");
  });
});
