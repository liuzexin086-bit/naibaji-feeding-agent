import { describe, expect, it } from "vitest";
import {
  computeDayDecision,
  creepGrade,
  majorityCreepGrade,
  previewDiarrheaAdjustment,
} from "../../src/decision/index.js";
import type { DayDecisionInput } from "../../src/shared/agent-v2-contract.js";

function baseInput(overrides: Partial<DayDecisionInput> = {}): DayDecisionInput {
  return {
    revision: 3,
    batchId: "batch-1",
    dateLocal: "2026-07-31",
    calculationDate: "2026-07-31",
    sopVersion: "sop@1",
    modelInput: {
      startAge: 3,
      endAge: 4,
      startWeight: 2.3,
      headCount: 20,
      dayAge: 3,
      devicePowderPrecisionGrams: 1,
      programStartLocal: "00:00",
    },
    ...overrides,
  };
}

describe("deterministic day decision", () => {
  it("uses direct SOP total before indirect SOP and the production model", () => {
    const decision = computeDayDecision(baseInput({
      sop: {
        directTotalPowderGrams: 600,
        powderGramsPerTwentyHeadsPerMeal: 35,
        mealCount: 12,
      },
    }));
    expect(decision.setting.source).toBe("sop_direct");
    expect(decision.setting.dailyPowderGrams).toBe(600);
    expect(decision.evidence.steps[0]?.value).toEqual({
      source: "sop_direct",
      targetPowderGrams: 600,
    });
  });

  it("derives an indirect SOP total and falls back to the protected model", () => {
    const indirect = computeDayDecision(baseInput({
      sop: { powderGramsPerTwentyHeadsPerMeal: 35, mealCount: 12 },
    }));
    expect(indirect.setting.source).toBe("sop_indirect");
    expect(indirect.setting.dailyPowderGrams).toBe(420);

    const fallback = computeDayDecision(baseInput());
    expect(fallback.setting.source).toBe("production_model");
    expect(fallback.setting.dailyPowderGrams).toBe(700);
  });

  it("keeps >100% elevated and >115% high boundaries exact", () => {
    expect(computeDayDecision(baseInput({
      sop: { directTotalPowderGrams: 700 },
      requestedStatus: "active",
    })).risk.level).toBe("normal");
    expect(computeDayDecision(baseInput({
      sop: { directTotalPowderGrams: 700.01 },
      requestedStatus: "active",
    })).risk.level).toBe("elevated");
    const exactly115 = computeDayDecision(baseInput({
      sop: { directTotalPowderGrams: 805 },
      requestedStatus: "active",
    }));
    expect(exactly115.risk.level).toBe("elevated");
    expect(exactly115.status).toBe("active");
    const high = computeDayDecision(baseInput({
      sop: { directTotalPowderGrams: 805.01 },
      requestedStatus: "active",
    }));
    expect(high.risk.level).toBe("high");
    expect(high.status).toBe("draft");
    expect(high.setting.dailyPowderGrams).toBe(700);
  });

  it("classifies legacy gram boundaries and supports recorded-grade majority", () => {
    expect([creepGrade(0), creepGrade(29.99), creepGrade(30), creepGrade(69.99), creepGrade(70)])
      .toEqual(["none", "low", "medium", "medium", "high"]);
    expect(majorityCreepGrade([29, 30, 35])).toBe("medium");
    expect(majorityCreepGrade(["low", "high", "high"])).toBe("high");
    expect(majorityCreepGrade(["none", "low", "high"])).toBe("high");
  });

  it("computes the control grade from grade-only field and records its evidence", () => {
    const decision = computeDayDecision(baseInput({
      creepFeedGradesLast3Days: ["low", "medium", "medium"],
    }));
    expect(decision.evidence.inputs).toMatchObject({
      creepFeedGradesLast3Days: ["low", "medium", "medium"],
      creepFeedGramsLast3Days: [],
    });
    expect(decision.evidence.steps.find((step) => step.name === "creep_majority_grade"))
      .toMatchObject({
        value: { grade: "medium", inputSource: "recorded_grades" },
      });
  });

  it("prefers recorded grades while keeping gram history compatible", () => {
    const preferred = computeDayDecision(baseInput({
      creepFeedGradesLast3Days: ["none", "low", "low"],
      creepFeedGramsLast3Days: [80, 80, 80],
    }));
    expect(preferred.evidence.steps.find((step) => step.name === "creep_majority_grade")?.value)
      .toEqual({ grade: "low", inputSource: "recorded_grades" });

    const legacy = computeDayDecision(baseInput({ creepFeedGramsLast3Days: [0, 20, 80] }));
    expect(legacy.evidence.steps.find((step) => step.name === "creep_majority_grade")?.value)
      .toEqual({ grade: "high", inputSource: "legacy_grams" });
  });

  it("runs teaching through the next 08:00 and never rounds above its cap", () => {
    const decision = computeDayDecision(baseInput({
      precisionGrams: 3,
      sop: { directTotalPowderGrams: 101 },
      teachingProgram: { enabled: true, firstTeachingLocal: "20:00" },
    }));
    expect(decision.setting.timedMeals.map((meal) => meal.timeLocal)).toEqual([
      "20:00", "23:00", "02:00", "05:00", "08:00",
    ]);
    expect(decision.setting.dailyPowderGrams).toBe(99);
    expect(decision.setting.timedMeals.reduce((sum, meal) => sum + meal.powderGrams, 0)).toBe(99);
  });

  it("limits free feeding to eight windows and forces timed mode for risk/control/diarrhea", () => {
    const windows = Array.from({ length: 8 }, (_, index) => ({
      startLocal: `${String(index).padStart(2, "0")}:00`,
      endLocal: `${String(index).padStart(2, "0")}:30`,
    }));
    expect(computeDayDecision(baseInput({ requestedMode: "free_feeding", freeWindows: windows })).setting.mode)
      .toBe("free_feeding");
    expect(() => computeDayDecision(baseInput({
      requestedMode: "free_feeding",
      freeWindows: [...windows, { startLocal: "09:00", endLocal: "09:30" }],
    }))).toThrow("NBJ_DECISION_FREE_WINDOWS_LIMIT");
    expect(computeDayDecision(baseInput({ requestedMode: "free_feeding", milkControlActive: true })).setting.mode)
      .toBe("timed_quantity");
    expect(computeDayDecision(baseInput({ requestedMode: "free_feeding", diarrheaGrades: ["mild"] })).setting.mode)
      .toBe("timed_quantity");
  });

  it("computes free-feeding single powder from reference meals and caps stomach capacity", () => {
    const divided = computeDayDecision(baseInput({
      requestedMode: "free_feeding",
      precisionGrams: 3,
      sop: { directTotalPowderGrams: 101, mealCount: 4 },
    }));
    expect(divided.setting).toMatchObject({
      mode: "free_feeding",
      dailyPowderGrams: 99,
      singlePowderGrams: 24,
      mealCount: 4,
      timedMeals: [],
    });

    const capacityCapped = computeDayDecision(baseInput({
      requestedMode: "free_feeding",
      sop: { directTotalPowderGrams: 600, mealCount: 1 },
    }));
    expect(capacityCapped.setting.singlePowderGrams).toBe(58);
    expect(capacityCapped.setting.singlePowderGrams)
      .toBeLessThan(capacityCapped.setting.dailyPowderGrams);
  });
});

describe("diarrhea adjustment preview", () => {
  it("subtracts cumulative actual powder and allocates only across remaining timed meals", () => {
    const decision = computeDayDecision(baseInput({
      sop: { directTotalPowderGrams: 600, mealCount: 4 },
      timedMealTimes: ["06:00", "12:00", "18:00", "23:00"],
      requestedStatus: "active",
    }));
    const preview = previewDiarrheaAdjustment({
      decision,
      observedAt: "2026-07-31T13:00:00+08:00",
      grades: ["moderate"],
      cumulativePowderGrams: 310,
    });
    expect(preview.status).toBe("draft");
    expect(preview.setting.mode).toBe("timed_quantity");
    expect(preview.setting.dailyPowderGrams).toBe(140);
    expect(preview.setting.timedMeals).toEqual([
      { timeLocal: "18:00", powderGrams: 70 },
      { timeLocal: "23:00", powderGrams: 70 },
    ]);
    expect(preview.evidence.steps.at(-2)?.value).toEqual({
      adjustedDayCap: 450,
      cumulativePowderGrams: 310,
      remainingAllowance: 140,
    });
  });

  it("returns zero allowance when actual powder already exceeds the adjusted cap", () => {
    const decision = computeDayDecision(baseInput());
    const preview = previewDiarrheaAdjustment({
      decision,
      observedAt: "2026-07-31T09:00:00+08:00",
      grades: ["severe"],
      cumulativePowderGrams: 500,
      remainingMealTimes: ["12:00", "18:00"],
    });
    expect(preview.setting.dailyPowderGrams).toBe(0);
    expect(preview.setting.timedMeals).toEqual([]);
    expect(preview.setting.mealCount).toBe(0);
  });
});
