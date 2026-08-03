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

  it("removes predictive risk and emits deterministic curve exception actions", () => {
    const normal = computeDayDecision(baseInput({
      sop: { directTotalPowderGrams: 700 },
      requestedStatus: "active",
    }));
    expect(normal.status).toBe("active");
    expect(normal).not.toHaveProperty("risk");
    expect(normal.exceptionActions).toEqual([]);

    const aboveCurve = computeDayDecision(baseInput({
      sop: { directTotalPowderGrams: 805 },
      requestedStatus: "active",
    }));
    expect(aboveCurve.status).toBe("active");
    expect(aboveCurve.setting.dailyPowderGrams).toBe(805);
    expect(aboveCurve.exceptionActions).toMatchObject([
      { type: "curve_cap", requiresHumanConfirmation: true },
    ]);
  });

  it("maps the five creep grades to their fixed internal values", () => {
    expect([creepGrade(0), creepGrade(10), creepGrade(45), creepGrade(80), creepGrade(130)])
      .toEqual(["none", "low", "medium", "high", "excellent"]);
    expect(majorityCreepGrade([10, 45, 45])).toBe("medium");
    expect(majorityCreepGrade(["low", "excellent", "excellent"])).toBe("excellent");
    expect(majorityCreepGrade(["none", "low", "high"])).toBe("low");
    expect(majorityCreepGrade(["high"])).toBe("none");
  });

  it("computes the control grade from grade-only field and records its evidence", () => {
    const decision = computeDayDecision(baseInput({
      creepFeedGradesLast3Days: ["low", "medium", "medium"],
    }));
    expect(decision.evidence.inputs).toMatchObject({
      creepFeedGradesLast3Days: ["low", "medium", "medium"],
      creepFeedGramsLast3Days: [],
    });
    expect(decision.evidence.steps.find((step) => step.name === "creep_sustained_grade"))
      .toMatchObject({
        value: { grade: "medium", inputSource: "recorded_grades" },
      });
  });

  it("prefers recorded grades while keeping gram history compatible", () => {
    const preferred = computeDayDecision(baseInput({
      creepFeedGradesLast3Days: ["none", "low", "low"],
      creepFeedGramsLast3Days: [80, 80, 80],
    }));
    expect(preferred.evidence.steps.find((step) => step.name === "creep_sustained_grade")?.value)
      .toEqual({ grade: "low", inputSource: "recorded_grades" });

    const legacy = computeDayDecision(baseInput({ creepFeedGramsLast3Days: [0, 10, 80] }));
    expect(legacy.evidence.steps.find((step) => step.name === "creep_sustained_grade")?.value)
      .toEqual({ grade: "low", inputSource: "legacy_grams" });
  });

  it("uses the fixed six-meal teaching program and SOP single amount", () => {
    const decision = computeDayDecision(baseInput({
      precisionGrams: 1,
      sop: { powderGramsPerTwentyHeadsPerMeal: 35, mealCount: 6 },
      teachingProgram: { enabled: true, firstTeachingLocal: "20:00" },
    }));
    expect(decision.setting.timedMeals.map((meal) => meal.timeLocal)).toEqual([
      "17:00", "20:00", "23:00", "02:00", "05:00", "08:00",
    ]);
    expect(decision.setting.source).toBe("sop_indirect");
    expect(decision.setting.singlePowderGrams).toBe(35);
    expect(decision.setting.dailyPowderGrams).toBe(210);
    expect(decision.setting.timedMeals.every((meal) => meal.powderGrams === 35)).toBe(true);
  });

  it("allocates a direct first-day SOP total across the six device times", () => {
    const decision = computeDayDecision(baseInput({
      precisionGrams: 1,
      sop: { directTotalPowderGrams: 211, mealCount: 6 },
      teachingProgram: { enabled: true, firstTeachingLocal: "17:00" },
    }));
    expect(decision.setting.source).toBe("sop_direct");
    expect(decision.setting.dailyPowderGrams).toBe(211);
    expect(decision.setting.timedMeals).toHaveLength(6);
    expect(decision.setting.timedMeals.reduce((sum, meal) => sum + meal.powderGrams, 0)).toBe(211);
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

  it("returns deterministic exception operations without a risk prediction", () => {
    const decision = computeDayDecision(baseInput({
      requestedMode: "free_feeding",
      exceptionSignals: { refusal: true, blockage: true, probeContaminated: true },
    }));
    expect(decision.setting.mode).toBe("timed_quantity");
    expect(decision.exceptionActions.map((action) => action.type)).toEqual([
      "refusal",
      "blockage",
      "probe_contamination",
    ]);
    expect(decision.exceptionActions.every((action) => action.requiresHumanConfirmation)).toBe(true);
    expect(decision).not.toHaveProperty("risk");
  });

  it("keeps SOP per-meal quantity for free-feeding and model quantity for fallback", () => {
    const divided = computeDayDecision(baseInput({
      requestedMode: "free_feeding",
      precisionGrams: 3,
      sop: { powderGramsPerMeal: 25, mealCount: 4 },
    }));
    expect(divided.setting).toMatchObject({
      mode: "free_feeding",
      dailyPowderGrams: 99,
      singlePowderGrams: 24,
      mealCount: 4,
      timedMeals: [],
    });

    const modelSingle = computeDayDecision(baseInput({ requestedMode: "free_feeding" }));
    expect(modelSingle.setting.singlePowderGrams).toBe(70);
    expect(modelSingle.setting.dailyPowderGrams)
      .toBe(modelSingle.setting.singlePowderGrams * modelSingle.setting.mealCount);
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
