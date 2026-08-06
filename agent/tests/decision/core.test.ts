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

  it("limits free feeding to eight windows and forces timed only for control, not diarrhea", () => {
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
      .toBe("free_feeding");
  });

  it("normalizes free-feeding windows on the 09:00 business-day axis", () => {
    expect(computeDayDecision(baseInput({
      requestedMode: "free_feeding",
      freeWindows: [
        { startLocal: "23:00", endLocal: "02:00" },
        { startLocal: "03:00", endLocal: "05:00" },
      ],
    })).setting.mode).toBe("free_feeding");

    expect(() => computeDayDecision(baseInput({
      requestedMode: "free_feeding",
      freeWindows: [{ startLocal: "23:00", endLocal: "02:00" }, { startLocal: "01:00", endLocal: "03:00" }],
    }))).toThrow("NBJ_DECISION_FREE_WINDOWS_OVERLAP");
    expect(() => computeDayDecision(baseInput({
      requestedMode: "free_feeding",
      freeWindows: [{ startLocal: "09:00", endLocal: "09:00" }],
    }))).toThrow("NBJ_DECISION_FREE_WINDOW_ZERO_DURATION");
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
      suggestedDailyPowderGrams: 684,
      suggestedDailyMealCount: 12,
      timedMeals: [],
    });

    const modelSingle = computeDayDecision(baseInput({ requestedMode: "free_feeding" }));
    expect(modelSingle.setting.singlePowderGrams).toBe(70);
    expect(modelSingle.setting.dailyPowderGrams)
      .toBe(modelSingle.setting.singlePowderGrams * modelSingle.setting.mealCount);
    expect(modelSingle.setting).toMatchObject({
      suggestedDailyPowderGrams: 696,
      suggestedDailyMealCount: 12,
    });
  });
});

describe("diarrhea adjustment preview", () => {
  it("generates a pending proposal for mild and a preview-only result for moderate", () => {
    const decision = computeDayDecision(baseInput({
      sop: { directTotalPowderGrams: 600, mealCount: 4 },
      timedMealTimes: ["06:00", "12:00", "18:00", "23:00"],
      requestedStatus: "active",
    }));
    const mild = previewDiarrheaAdjustment({
      decision,
      observedAt: "2026-07-31T13:00:00+08:00",
      grades: ["mild"],
      cumulativePowderGrams: 100,
      reductionPriority: ["18:00", "23:00"],
    });
    expect(mild.kind).toBe("proposal");
    expect(mild.proposal).not.toBeNull();
    expect(mild.decision?.status).toBe("draft");
    expect(mild.decision?.setting.mode).toBe("timed_quantity");
    expect(mild.decision?.setting.dailyPowderGrams).toBe(450);
    expect(mild.decision?.setting.timedMeals).toEqual([
      { timeLocal: "06:00", powderGrams: 150 },
      { timeLocal: "12:00", powderGrams: 150 },
      { timeLocal: "23:00", powderGrams: 150 },
    ]);
    expect(mild.remainingDeliverable).toBe(350);
    expect(mild.decision?.evidence.reasons.join(" ")).toContain("待确认设备提案");

    const moderate = previewDiarrheaAdjustment({
      decision,
      observedAt: "2026-07-31T13:00:00+08:00",
      grades: ["moderate"],
      cumulativePowderGrams: 100,
      reductionPriority: ["18:00", "23:00"],
    });
    expect(moderate.kind).toBe("preview_only");
    expect(moderate.proposal).toBeNull();
    expect(moderate.manualDispositionRequired).toBe(true);
    expect(moderate.decision?.setting.dailyPowderGrams).toBe(450);
  });

  it("returns manual-only for severe with no device proposal", () => {
    const decision = computeDayDecision(baseInput());
    const preview = previewDiarrheaAdjustment({
      decision,
      observedAt: "2026-07-31T09:00:00+08:00",
      grades: ["severe"],
      cumulativePowderGrams: 500,
      reductionPriority: ["12:00", "18:00"],
    });
    expect(preview.kind).toBe("manual_only");
    expect(preview.decision).toBeNull();
    expect(preview.proposal).toBeNull();
    expect(preview.manualDispositionRequired).toBe(true);
    expect(preview.adjustedProgramTotal).not.toBe(decision.setting.dailyPowderGrams);
    expect(preview.remainingDeliverable).toBe(
      Math.max(0, preview.adjustedProgramTotal - 500),
    );
  });

  it("does not replace another meal when the frozen target slot has already passed", () => {
    const decision = computeDayDecision(baseInput({
      sop: { directTotalPowderGrams: 600, mealCount: 6 },
      timedMealTimes: ["17:00", "20:00", "23:00", "02:00", "05:00", "08:00"],
    }));
    const preview = previewDiarrheaAdjustment({
      decision,
      observedAt: "2026-07-31T23:30:00+08:00",
      grades: ["mild"],
      cumulativePowderGrams: 0,
      reductionPriority: ["20:00"],
    });
    expect(preview.kind).toBe("manual_only");
    expect(preview.targetAlreadyHappened).toBe(true);
    expect(preview.targetSlot).toBe("20:00");
    expect(preview.proposal).toBeNull();
  });

  it("returns manual-only when cumulative powder exceeds the adjusted program total", () => {
    const decision = computeDayDecision(baseInput({
      sop: { directTotalPowderGrams: 600, mealCount: 4 },
      timedMealTimes: ["06:00", "12:00", "18:00", "23:00"],
    }));
    const preview = previewDiarrheaAdjustment({
      decision,
      observedAt: "2026-07-31T13:00:00+08:00",
      grades: ["mild"],
      cumulativePowderGrams: 500,
      reductionPriority: ["18:00", "23:00"],
    });
    expect(preview.kind).toBe("manual_only");
    expect(preview.proposal).toBeNull();
    expect(preview.manualDispositionRequired).toBe(true);
  });

  it("returns manual-only when cumulative powder equals the adjusted program total", () => {
    const decision = computeDayDecision(baseInput({
      sop: { directTotalPowderGrams: 600, mealCount: 4 },
      timedMealTimes: ["06:00", "12:00", "18:00", "23:00"],
    }));
    const preview = previewDiarrheaAdjustment({
      decision,
      observedAt: "2026-07-31T13:00:00+08:00",
      grades: ["mild"],
      cumulativePowderGrams: 450,
      reductionPriority: ["18:00", "23:00"],
    });
    expect(preview.kind).toBe("manual_only");
    expect(preview.proposal).toBeNull();
    expect(preview.remainingDeliverable).toBe(0);
  });

  it("returns manual-only when future meal powder exceeds remaining deliverable", () => {
    const decision = computeDayDecision(baseInput({
      sop: { directTotalPowderGrams: 600, mealCount: 4 },
      timedMealTimes: ["06:00", "12:00", "18:00", "23:00"],
    }));
    const preview = previewDiarrheaAdjustment({
      decision,
      observedAt: "2026-07-31T13:00:00+08:00",
      grades: ["mild"],
      cumulativePowderGrams: 400,
      reductionPriority: ["18:00", "23:00"],
    });
    expect(preview.kind).toBe("manual_only");
    expect(preview.proposal).toBeNull();
    expect(preview.futureDeliverable).toBe(300);
    expect(preview.remainingDeliverable).toBe(50);
  });

  it("fails closed when the frozen reduction slot is missing", () => {
    const decision = computeDayDecision(baseInput({
      sop: { directTotalPowderGrams: 600, mealCount: 4 },
      timedMealTimes: ["06:00", "12:00", "18:00", "23:00"],
    }));
    expect(() => previewDiarrheaAdjustment({
      decision,
      observedAt: "2026-07-31T13:00:00+08:00",
      grades: ["mild"],
      cumulativePowderGrams: 0,
    })).toThrow("NBJ_DECISION_DIARRHEA_REDUCTION_SLOT_REQUIRED");
    expect(() => previewDiarrheaAdjustment({
      decision,
      observedAt: "2026-07-31T13:00:00+08:00",
      grades: ["mild"],
      cumulativePowderGrams: 0,
      reductionPriority: ["07:00"],
    })).toThrow("NBJ_DECISION_DIARRHEA_REDUCTION_SLOT_REQUIRED");
  });

  it("uses frozen priority on the 09:00 business-day axis across midnight", () => {
    const decision = computeDayDecision(baseInput({
      sop: { directTotalPowderGrams: 600, mealCount: 6 },
      timedMealTimes: ["17:00", "20:00", "23:00", "02:00", "05:00", "08:00"],
    }));
    const preview = previewDiarrheaAdjustment({
      decision,
      observedAt: "2026-07-31T23:30:00+08:00",
      grades: ["mild"],
      cumulativePowderGrams: 0,
      reductionPriority: ["02:00", "05:00", "08:00"],
    });
    expect(preview.kind).toBe("proposal");
    expect(preview.targetSlot).toBe("02:00");
    expect(preview.targetAlreadyHappened).toBe(false);
    expect(preview.decision?.setting.timedMeals.map((meal) => meal.timeLocal))
      .toEqual(["17:00", "20:00", "23:00", "05:00", "08:00"]);
    expect(preview.decision?.setting.timedMeals.reduce((sum, meal) => sum + meal.powderGrams, 0))
      .toBe(500);
  });

  it("removes a frozen free-feeding window without inventing a default slot", () => {
    const decision = computeDayDecision(baseInput({
      requestedMode: "free_feeding",
      freeWindows: [
        { startLocal: "06:00", endLocal: "06:30" },
        { startLocal: "09:00", endLocal: "09:30" },
        { startLocal: "15:00", endLocal: "15:30" },
      ],
    }));
    const preview = previewDiarrheaAdjustment({
      decision,
      observedAt: "2026-07-31T12:00:00+08:00",
      grades: ["mild"],
      cumulativePowderGrams: 0,
      freeReductionPriority: ["15:00"],
    });
    expect(preview.kind).toBe("proposal");
    expect(preview.decision?.setting.mode).toBe("free_feeding");
    expect(preview.decision?.setting.freeWindows.map((window) => window.startLocal))
      .toEqual(["06:00", "09:00"]);
    expect(preview.decision?.setting.mealCount).toBe(decision.setting.mealCount - 1);
  });

  it("returns deterministic cumulative facts without target ratio", () => {
    const decision = computeDayDecision(baseInput({
      sop: { directTotalPowderGrams: 600, mealCount: 4 },
      timedMealTimes: ["10:00", "14:00", "18:00", "22:00"],
    }));
    const preview = previewDiarrheaAdjustment({
      decision,
      observedAt: "2026-07-31T13:00:00+08:00",
      grades: ["mild"],
      cumulativePowderGrams: 120,
      reductionPriority: ["14:00", "18:00", "22:00"],
    });
    expect(preview.kind).toBe("proposal");
    expect(preview.targetSlot).toBe("14:00");
    expect(preview.decision?.setting.timedMeals.map((meal) => meal.timeLocal))
      .toEqual(["10:00", "18:00", "22:00"]);
    expect(preview.decision?.evidence.inputs).toMatchObject({
      diarrheaAdjustment: {
        targetSlot: "14:00",
        adjustedProgramTotal: 450,
        remainingDeliverable: 330,
        cumulativePowderGrams: 120,
      },
    });
    expect(JSON.stringify(preview.evidence)).not.toContain("targetRatio");
    expect(JSON.stringify(preview.decision?.evidence.inputs ?? {})).not.toContain("targetRatio");
  });

  it("returns no adjustment when the recorded grade is none", () => {
    const decision = computeDayDecision(baseInput());
    const preview = previewDiarrheaAdjustment({
      decision,
      observedAt: "2026-07-31T09:00:00+08:00",
      grades: ["none"],
      cumulativePowderGrams: 0,
      reductionPriority: ["12:00"],
    });
    expect(preview.kind).toBe("none");
    expect(preview.proposal).toBeNull();
    expect(preview.decision).toBeNull();
  });
});
