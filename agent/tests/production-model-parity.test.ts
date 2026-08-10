import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { computeProductionPlan, modelStandardWeight } from "../src/model/production-model.js";

const projectRoot = resolve(import.meta.dirname, "../..");

function sha256(path: string): string {
  const source = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  return createHash("sha256").update(source, "utf8").digest("hex").toUpperCase();
}

describe("protected production model parity", () => {
  it("matches missing start weight to the model standard for the start age", () => {
    expect(modelStandardWeight(3)).toBe(2.3);
    expect(modelStandardWeight(7)).toBe(3);
    expect(modelStandardWeight(21)).toBe(5.8);
    expect(modelStandardWeight(22)).toBe(6);
  });
  it("keeps the reviewed production model hashes", () => {
    expect(sha256(resolve(projectRoot, "feeding-model.js"))).toBe(
      "35A0DD40E66D4C1FC4DC4EF6FB20CF44C28F70AA284EB5DADFE6F05F0E760C6D",
    );
    expect(sha256(resolve(projectRoot, "v5lite-model.js"))).toBe(
      "124385A11FD247013C7C4DD14FE95642DDEBF0B9621A797E72EB91794EC16EAE",
    );
  });

  it.each([
    {
      input: { startAge: 5, endAge: 21, startWeight: 1.8, headCount: 20 },
      totalMilkPlanG: 36360,
      finalWeightPlan: 3.82,
      firstTotal: 560,
      lastTotal: 3160,
      firstMeals: 10,
      lastMeals: 10,
    },
    {
      input: { startAge: 7, endAge: 28, startWeight: 2.2, headCount: 17 },
      totalMilkPlanG: 56712,
      finalWeightPlan: 5.907,
      firstTotal: 578,
      lastTotal: 4148,
      firstMeals: 10,
      lastMeals: 10,
    },
  ])("matches the current golden plan for $input", (golden) => {
    const output = computeProductionPlan(golden.input) as {
      plan: { totalMilkPlanG: number; finalWeightPlan: number };
      control: { planMilkTotalControl: number[]; feedTimes: number[] };
    };
    expect(output.plan.totalMilkPlanG).toBe(golden.totalMilkPlanG);
    expect(output.plan.finalWeightPlan).toBe(golden.finalWeightPlan);
    expect(output.control.planMilkTotalControl[0]).toBe(golden.firstTotal);
    expect(output.control.planMilkTotalControl.at(-1)).toBe(golden.lastTotal);
    expect(output.control.feedTimes[0]).toBe(golden.firstMeals);
    expect(output.control.feedTimes.at(-1)).toBe(golden.lastMeals);
  });

  it("returns the complete deterministic device-operation curve", () => {
    const output = computeProductionPlan({
      startAge: 3,
      endAge: 4,
      startWeight: 2.3,
      headCount: 20,
      dilutionRatio: "水:粉=6:1",
      devicePowderPrecisionGrams: 1,
      programStartLocal: "00:00",
    }) as {
      deviceOperation: {
        curve: Array<{
          dayAge: number;
          dailyPowderGrams: number;
          mealCount: number;
          meals: Array<{ timeLocal: string; powderGrams: number }>;
        }>;
      };
    };
    expect(output.deviceOperation.curve).toHaveLength(2);
    expect(output.deviceOperation.curve[0]).toMatchObject({
      dayAge: 3,
      dailyPowderGrams: 700,
      mealCount: 10,
    });
    expect(output.deviceOperation.curve[0]?.meals[0]).toMatchObject({
      timeLocal: "10:00",
      powderGrams: 70,
    });
    expect(output.deviceOperation.curve[0]?.meals[0]).not.toHaveProperty("waterMl");
    expect(
      output.deviceOperation.curve[0]?.meals.reduce(
        (sum, meal) => sum + meal.powderGrams,
        0,
      ),
    ).toBe(700);
    expect(output.deviceOperation.curve[0]?.meals.map((meal) => meal.timeLocal)).toEqual([
      "10:00", "14:00", "16:00", "18:00", "20:00",
      "22:00", "02:00", "04:00", "06:00", "08:00",
    ]);
    expect(output.deviceOperation.programStartLocal).toBe("09:00");
    expect(output.deviceOperation.curve[0]?.meals.map((meal) => meal.timeLocal))
      .not.toContain("00:00");
    expect(output.deviceOperation.curve[0]?.meals.map((meal) => meal.timeLocal))
      .not.toContain("12:00");
  });

  it("derives program total from the model single-meal amount instead of reversing the daily total", () => {
    const output = computeProductionPlan({
      startAge: 3,
      endAge: 4,
      startWeight: 2.3,
      headCount: 17,
      dayAge: 3,
      devicePowderPrecisionGrams: 1,
    });
    const program = output.selectedDay.deviceProgram!;
    expect(output.selectedDay.perHeadPerMealGrams).toBe(3.5);
    expect(program.meals[0]?.powderGrams).toBe(59);
    expect(program.dailyPowderGrams).toBe(590);
    expect(program.dailyPowderGrams).toBe(
      program.meals[0]!.powderGrams * program.mealCount,
    );
    expect(output.selectedDay.totalMilkGrams).toBe(595);
  });

  it("does not start control from a single non-none creep grade", () => {
    const output = computeProductionPlan({
      startAge: 3,
      endAge: 8,
      startWeight: 2.3,
      headCount: 20,
      records: [{ dayAge: 4, creepGrade: "high", creepValue: 80, headCount: 20 }],
    });
    expect(output.controlStartDay).toBe(6);
    expect(output.control.feedTimes.every((count) => count === 10)).toBe(true);
    expect(output.deviceOperation.curve[0]?.meals).toHaveLength(10);
  });

  it("keeps a persisted control start as replay authority even when later observations no longer sustain", () => {
    const output = computeProductionPlan({
      startAge: 3,
      endAge: 8,
      startWeight: 10,
      headCount: 20,
      controlStartDay: 2,
      records: [{ dayAge: 4, creepGrade: "high", headCount: 20 }],
    });
    expect(output.controlStartDay).toBe(2);
    expect(output.control.feedTimes).toEqual([10, 10, 10, 10, 10, 10]);
  });

  it.each([
    { grade: "low", floor: 9 },
    { grade: "medium", floor: 8 },
    { grade: "high", floor: 6 },
    { grade: "excellent", floor: 4 },
  ])("reduces at most once daily to the sustained $grade floor of $floor", ({ grade, floor }) => {
    const output = computeProductionPlan({
      startAge: 3,
      endAge: 12,
      startWeight: 10,
      headCount: 20,
      records: [
        { dayAge: 3, creepGrade: grade, headCount: 20 },
        { dayAge: 4, creepGrade: grade, headCount: 20 },
      ],
    });
    expect(output.controlStartDay).toBe(2);
    expect(output.control.feedTimes.slice(0, 2)).toEqual([10, 10]);
    expect(Math.max(...output.control.feedTimes)).toBe(10);
    expect(Math.min(...output.control.feedTimes)).toBe(floor);
    expect(output.control.feedTimes.every((count) => count >= floor && count <= 10)).toBe(true);
    output.control.feedTimes.slice(1).forEach((count, index) => {
      const previous = output.control.feedTimes[index];
      expect(count).toBeLessThanOrEqual(previous);
      expect(previous - count).toBeLessThanOrEqual(1);
    });
  });

  it("treats two of the latest three observations at a grade or higher as sustained", () => {
    const output = computeProductionPlan({
      startAge: 3,
      endAge: 7,
      startWeight: 10,
      headCount: 20,
      records: [
        { dayAge: 3, creepGrade: "low", headCount: 20 },
        { dayAge: 4, creepGrade: "none", headCount: 20 },
        { dayAge: 5, creepGrade: "high", headCount: 20 },
      ],
    });
    expect(output.controlStartDay).toBe(3);
    expect(output.control.feedTimes).toEqual([10, 10, 10, 9, 9]);
  });

  it("anchors the next reduction to the last committed meal count", () => {
    const output = computeProductionPlan({
      startAge: 3,
      endAge: 7,
      startWeight: 10,
      headCount: 20,
      records: [
        { dayAge: 3, creepGrade: "high", headCount: 20 },
        { dayAge: 4, creepGrade: "high", headCount: 20 },
        { dayAge: 5, creepGrade: "high", headCount: 20, planPerPigAtCommit: 300, planTotalAtCommit: 6000, feedTimesAtCommit: 10 },
        { dayAge: 6, creepGrade: "high", headCount: 20, planPerPigAtCommit: 320, planTotalAtCommit: 6400, feedTimesAtCommit: 10 },
      ],
    });
    expect(output.control.feedTimes).toEqual([10, 10, 10, 10, 9]);
  });

  it("rejects a generated 9 followed by a committed 10 as non-monotonic", () => {
    expect(() => computeProductionPlan({
      startAge: 3,
      endAge: 9,
      startWeight: 10,
      headCount: 20,
      controlStartDay: 2,
      records: [
        { dayAge: 3, creepGrade: "high", headCount: 20 },
        { dayAge: 4, creepGrade: "high", headCount: 20 },
        {
          dayAge: 6,
          creepGrade: "high",
          headCount: 20,
          planPerPigAtCommit: 300,
          planTotalAtCommit: 6000,
          feedTimesAtCommit: 10,
        },
      ],
    })).toThrow("NBJ_CONTROL_HISTORY_NON_MONOTONIC");
  });

  it("rejects committed 10 -> 8 as an invalid control step", () => {
    expect(() => computeProductionPlan({
      startAge: 3,
      endAge: 9,
      startWeight: 10,
      headCount: 20,
      controlStartDay: 2,
      records: [
        { dayAge: 3, creepGrade: "high", headCount: 20 },
        { dayAge: 4, creepGrade: "high", headCount: 20 },
        {
          dayAge: 5,
          creepGrade: "high",
          headCount: 20,
          planPerPigAtCommit: 300,
          planTotalAtCommit: 6000,
          feedTimesAtCommit: 10,
        },
        {
          dayAge: 6,
          creepGrade: "high",
          headCount: 20,
          planPerPigAtCommit: 300,
          planTotalAtCommit: 6000,
          feedTimesAtCommit: 8,
        },
      ],
    })).toThrow("NBJ_CONTROL_HISTORY_STEP_INVALID");
  });

  it("fails closed when committed control history is non-monotonic", () => {
    expect(() => computeProductionPlan({
      startAge: 3,
      endAge: 9,
      startWeight: 10,
      headCount: 20,
      records: [
        { dayAge: 3, creepGrade: "high", headCount: 20 },
        { dayAge: 4, creepGrade: "high", headCount: 20 },
        {
          dayAge: 5,
          creepGrade: "high",
          headCount: 20,
          planPerPigAtCommit: 300,
          planTotalAtCommit: 6000,
          feedTimesAtCommit: 8,
        },
        {
          dayAge: 6,
          creepGrade: "high",
          headCount: 20,
          planPerPigAtCommit: 300,
          planTotalAtCommit: 6000,
          feedTimesAtCommit: 10,
        },
      ],
    })).toThrow("NBJ_CONTROL_HISTORY_NON_MONOTONIC");
  });

  it("accepts valid committed history 10 -> 9 -> 8 and keeps future non-increasing", () => {
    const output = computeProductionPlan({
      startAge: 3,
      endAge: 10,
      startWeight: 10,
      headCount: 20,
      controlStartDay: 2,
      records: [
        { dayAge: 3, creepGrade: "high", headCount: 20 },
        { dayAge: 4, creepGrade: "high", headCount: 20 },
        {
          dayAge: 5,
          creepGrade: "high",
          headCount: 20,
          planPerPigAtCommit: 300,
          planTotalAtCommit: 6000,
          feedTimesAtCommit: 10,
        },
        {
          dayAge: 6,
          creepGrade: "high",
          headCount: 20,
          planPerPigAtCommit: 300,
          planTotalAtCommit: 6000,
          feedTimesAtCommit: 9,
        },
        {
          dayAge: 7,
          creepGrade: "high",
          headCount: 20,
          planPerPigAtCommit: 300,
          planTotalAtCommit: 6000,
          feedTimesAtCommit: 8,
        },
      ],
    });
    expect(output.control.feedTimes.slice(0, 5)).toEqual([10, 10, 10, 9, 8]);
    output.control.feedTimes.slice(1).forEach((count, index) => {
      expect(count).toBeLessThanOrEqual(output.control.feedTimes[index]!);
    });
  });

  it("keeps all days at ten meals when no non-none grade is recorded", () => {
    const output = computeProductionPlan({
      startAge: 3,
      endAge: 8,
      startWeight: 2.3,
      headCount: 20,
      records: [{ dayAge: 4, creepGrade: "none", creepValue: 0, headCount: 20 }],
    });
    expect(output.controlStartDay).toBe(6);
    expect(output.control.feedTimes.every((count) => count === 10)).toBe(true);
  });
});
