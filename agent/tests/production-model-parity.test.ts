import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { computeProductionPlan } from "../src/model/production-model.js";

const projectRoot = resolve(import.meta.dirname, "../..");

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex").toUpperCase();
}

describe("protected production model parity", () => {
  it("keeps the reviewed production model hashes", () => {
    expect(sha256(resolve(projectRoot, "feeding-model.js"))).toBe(
      "75C132304973524490EDAD5AECDFFF795EC368CAE25FBED9B110A80259F40406",
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
      timeLocal: "02:00",
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
      "02:00", "04:00", "06:00", "08:00", "10:00",
      "14:00", "16:00", "18:00", "20:00", "22:00",
    ]);
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

  it("starts control on the day after the first non-none creep grade", () => {
    const output = computeProductionPlan({
      startAge: 3,
      endAge: 8,
      startWeight: 2.3,
      headCount: 20,
      records: [{ dayAge: 4, creepGrade: "high", creepValue: 80, headCount: 20 }],
    });
    expect(output.controlStartDay).toBe(2);
    expect(output.control.feedTimes.slice(0, 2)).toEqual([10, 10]);
    expect(output.control.feedTimes[2]).toBe(8);
    expect(output.deviceOperation.curve[0]?.meals).toHaveLength(10);
    expect(output.deviceOperation.curve[2]?.mealCount).toBe(8);
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
