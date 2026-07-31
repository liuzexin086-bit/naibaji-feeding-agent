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
      "DF77624892EB7DFF1F069EE1DBDE62888ED6B46F11BBAD11AE967BA3DC64987B",
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
      firstMeals: 12,
      lastMeals: 12,
    },
    {
      input: { startAge: 7, endAge: 28, startWeight: 2.2, headCount: 17 },
      totalMilkPlanG: 56712,
      finalWeightPlan: 5.907,
      firstTotal: 578,
      lastTotal: 4148,
      firstMeals: 12,
      lastMeals: 12,
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
      mealCount: 12,
    });
    expect(output.deviceOperation.curve[0]?.meals[0]).toMatchObject({
      timeLocal: "00:00",
      powderGrams: 58,
    });
    expect(output.deviceOperation.curve[0]?.meals[0]).not.toHaveProperty("waterMl");
    expect(
      output.deviceOperation.curve[0]?.meals.reduce(
        (sum, meal) => sum + meal.powderGrams,
        0,
      ),
    ).toBe(700);
  });
});
