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
    expect(operations.map((item) => item.code)).toEqual([
      "first_day_admission",
      "first_day_health_check",
      "first_day_water_stop",
      "first_day_mode_setup",
      "first_day_teaching",
    ]);
    expect(operations.find((item) => item.code === "first_day_teaching")?.dueWindow)
      .toEqual({ startLocal: "17:00", endLocal: "08:00", endDayOffset: 1 });
    expect(operations.find((item) => item.code === "first_day_admission")?.title)
      .toBe("挑猪入栏与分栏");
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

  it("includes SOP custom tasks on the matching day and skips invalid entries", () => {
    const config = {
      customTasks: [
        { title: "挑猪入栏复核", ageDay: 3, localTime: "09:00" },
        { title: "另一日任务", ageDay: 4, localTime: "09:00" },
        { title: "非法时间", ageDay: 3, localTime: "99:99" },
        { title: "非法结构", ageDay: 3 },
      ],
    };
    const day0 = buildDailyOperationItems({ dayIndex: 0, dayAge: 3, endAge: 28, sopConfig: config });
    expect(day0.filter((item) => item.code === "sop_custom_task").map((item) => item.title))
      .toEqual(["挑猪入栏复核"]);
    const day1 = buildDailyOperationItems({ dayIndex: 1, dayAge: 4, endAge: 28, sopConfig: config });
    expect(day1.filter((item) => item.code === "sop_custom_task").map((item) => item.title))
      .toEqual(["另一日任务"]);
  });
});
