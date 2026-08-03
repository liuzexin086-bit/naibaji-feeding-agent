import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOP_TEMPLATE,
  checkDataQuality,
  checkExecutionGap,
  computeFirstTeachingTime,
  computeSopMeal,
  createLaggardCase,
  evaluateLaggardDay3,
  generateAgeTasks,
  generateCustomTasks,
  generateMaintenanceTasks,
  generateTeachingTasks,
  generateWaterTasks,
  recordLaggardSupplement,
  startSopRun,
  teachingCommittedPlan,
} from "../src/sop/engine.js";

const modelMeal = {
  powderGrams: 70,
  dailyPowderGrams: 700,
  mealCount: 10,
  dayAge: 3,
  calculationDate: "2026-07-31",
  modelVersion: "feeding-model+V5-Lite@2026-08-03",
};

function createRun(admittedAt = "2026-07-31T01:00:00.000Z") {
  return startSopRun({
    id: "run-1",
    batchId: "batch-1",
    userId: "user-1",
    admittedAt,
    activeHeadCount: 20,
    dilutionRatio: "1:4",
    modelMeal,
    now: admittedAt,
  }).run;
}

describe("first teaching window", () => {
  it("uses local 17:00 for a 09:00 admission", () => {
    expect(computeFirstTeachingTime("2026-07-31T01:00:00.000Z")).toEqual({
      firstTeachingAt: "2026-07-31T09:00:00.000Z",
    });
  });

  it("keeps first teaching fixed at local 17:00 outside the old adaptation window", () => {
    const result = computeFirstTeachingTime("2026-07-31T03:30:00.000Z");
    expect(result.firstTeachingAt).toBe("2026-07-31T09:00:00.000Z");
    expect(result.deviation).toBeUndefined();
  });

  it("uses the next local 17:00 when admission is after the fixed start", () => {
    expect(computeFirstTeachingTime("2026-07-31T10:00:00.000Z")).toEqual({
      firstTeachingAt: "2026-08-01T09:00:00.000Z",
    });
  });
});

describe("teaching meal", () => {
  it.each([
    [10, 18],
    [20, 35],
    [17, 30],
  ])("uses the SOP single-meal amount for %i active heads", (heads, expectedPowder) => {
    expect(computeSopMeal(heads, modelMeal)).toMatchObject({
      activeHeadCount: heads,
      powderGrams: expectedPowder,
      dailyPowderGrams: expectedPowder,
      mealCount: 1,
      amountSource: "sop_indirect_total",
      quantityAuthority: "sop_indirect",
      planSource: "sop_teaching",
    });
  });

  it("honors configurable device precision", () => {
    expect(
      computeSopMeal(
        17,
        modelMeal,
        { ...DEFAULT_SOP_TEMPLATE, devicePowderPrecisionGrams: 5 },
      )
        .powderGrams,
    ).toBe(30);
  });

  it("uses a direct SOP program total before indirect parameters", () => {
    const first = computeSopMeal(
      20,
      modelMeal,
      { ...DEFAULT_SOP_TEMPLATE, teachingQuantitySource: "sop", teachingDirectTotalPowderGrams: 211 },
      6,
      0,
    );
    const last = computeSopMeal(
      20,
      modelMeal,
      { ...DEFAULT_SOP_TEMPLATE, teachingQuantitySource: "sop", teachingDirectTotalPowderGrams: 211 },
      6,
      5,
    );
    expect(first).toMatchObject({
      powderGrams: 35,
      dailyPowderGrams: 211,
      amountSource: "sop_direct_total",
      quantityAuthority: "sop_direct",
    });
    expect(last.powderGrams).toBe(36);
  });

  it("falls back to the production model only when SOP cannot determine quantity", () => {
    expect(computeSopMeal(
      20,
      modelMeal,
      {
        ...DEFAULT_SOP_TEMPLATE,
        teachingQuantitySource: "sop",
        teachingDirectTotalPowderGrams: 0,
        teachingPowderGramsPerTwenty: 0,
      },
      6,
      0,
    )).toMatchObject({
      powderGrams: 70,
      dailyPowderGrams: 420,
      mealCount: 6,
      amountSource: "production_model_fallback",
      quantityAuthority: "production_model",
      modelFallback: true,
    });
  });
});

describe("teaching timeline", () => {
  it("generates each 3h through the next-day 08:00 inspection cutoff", () => {
    const run = createRun();
    const through = "2026-08-03T03:00:00.000Z";
    const tasks = generateTeachingTasks(run, through, modelMeal);
    const meals = tasks.filter((task) => task.kind === "teaching_meal");
    expect(meals[0]?.scheduledAt).toBe("2026-07-31T12:00:00.000Z");
    expect(meals.map((task) => task.scheduledAt)).toEqual([
      "2026-07-31T12:00:00.000Z",
      "2026-07-31T15:00:00.000Z",
      "2026-07-31T18:00:00.000Z",
      "2026-07-31T21:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    ]);
    expect(tasks.find((task) => task.kind === "inspection")).toMatchObject({
      scheduledAt: "2026-08-01T00:00:00.000Z",
      requiresConfirmation: true,
    });
    expect(tasks.at(-1)?.kind).toBe("laggard_day3_evaluation");
  });

  it("does not duplicate the first meal in the loop", () => {
    const started = startSopRun({
      id: "run-1",
      batchId: "batch-1",
      userId: "user-1",
      admittedAt: "2026-07-31T01:00:00.000Z",
      activeHeadCount: 20,
      dilutionRatio: "1:4",
      modelMeal,
    });
    const generated = generateTeachingTasks(
      started.run,
      "2026-07-31T12:00:00.000Z",
      modelMeal,
    );
    expect(started.initialTasks.filter((task) => task.kind === "teaching_meal")).toHaveLength(1);
    expect(generated.filter((task) => task.kind === "teaching_meal")).toHaveLength(1);
  });

  it("stores teaching meals as device-program entries without per-meal confirmation", () => {
    const started = startSopRun({
      id: "run-1",
      batchId: "batch-1",
      userId: "user-1",
      admittedAt: "2026-07-31T01:00:00.000Z",
      activeHeadCount: 20,
      dilutionRatio: "水:粉=6:1",
      modelMeal,
    });
    const meals = [
      ...started.initialTasks,
      ...generateTeachingTasks(started.run, "2026-07-31T15:00:00.000Z", modelMeal),
    ].filter((task) => task.kind === "teaching_meal");
    expect(meals.every((task) => task.status === "scheduled")).toBe(true);
    expect(meals.every((task) => task.requiresConfirmation === false)).toBe(true);
    expect(meals[0]?.metadata).toMatchObject({
      executionMode: "device_program",
      amountSource: "sop_indirect_total",
      quantityAuthority: "sop_indirect",
      resolvedProgramTotalPowderGrams: 210,
      deviceConfigurationFields: ["powderGrams", "timeLocal"],
    });
    expect(meals[0]?.numericPlan).not.toHaveProperty("liquidMl");
  });
});

describe("execution gap semantics", () => {
  it("uses only scheduled SOP meals as the teaching commitment", () => {
    const started = startSopRun({
      id: "run-1",
      batchId: "batch-1",
      userId: "user-1",
      admittedAt: "2026-07-31T01:00:00.000Z",
      activeHeadCount: 20,
      dilutionRatio: "1:4",
      modelMeal,
    });
    const committed = teachingCommittedPlan([
      ...started.initialTasks,
      ...generateTeachingTasks(started.run, "2026-07-31T15:00:00.000Z", modelMeal),
    ]);
    expect(committed).toMatchObject({
      planSource: "sop_teaching",
      mealCount: 3,
      plannedPowderGrams: 105,
    });
    expect(
      checkExecutionGap({
        planSource: "sop_teaching",
        committedPlan: 105,
        actual: 70,
        submittedRevision: 4,
        currentRevision: 4,
      }),
    ).toMatchObject({ gap: 35, stale: false });
  });

  it("rejects an old revision", () => {
    expect(
      checkExecutionGap({
        planSource: "production_model",
        committedPlan: 100,
        actual: 90,
        submittedRevision: 1,
        currentRevision: 2,
      }),
    ).toMatchObject({ stale: true, code: "NBJ_AGENT_STALE" });
  });
});

describe("laggard, water, transition, and maintenance", () => {
  it("limits automatic laggard supplementation to three records", () => {
    let caseItem = createLaggardCase({
      id: "lag-1",
      runId: "run-1",
      pigTag: "A-01",
      observedAt: "2026-07-31T09:00:00.000Z",
      notApproachingTrough: true,
      hollowAbdomen: true,
    });
    caseItem = recordLaggardSupplement(caseItem);
    caseItem = recordLaggardSupplement(caseItem);
    caseItem = recordLaggardSupplement(caseItem);
    expect(() => recordLaggardSupplement(caseItem)).toThrow(
      "NBJ_LAGGARD_SUPPLEMENT_REVIEW_REQUIRED",
    );
    expect(evaluateLaggardDay3(caseItem, "keep").status).toBe("keep");
  });

  it("blocks water prompts in exception mode", () => {
    const result = generateWaterTasks(createRun(), 10, "2026-07-31T09:00:00.000Z", {
      diarrhea: "severe",
    });
    expect(result.blocked).toBe(true);
    expect(result.tasks).toHaveLength(0);
  });

  it("closes water on admission and reopens only at age 12", () => {
    const result = generateWaterTasks(createRun(), 3, "2026-07-31T01:00:00.000Z", {
      diarrhea: "none",
      feedingResponse: "active",
      abdomenState: "full",
      deviceStatus: "ok",
    });
    expect(result.tasks.map((task) => task.kind)).toEqual([
      "water_close",
      "water_restore",
    ]);
    expect(result.tasks.every((task) => task.requiresConfirmation)).toBe(true);
    expect(result.tasks[0]?.scheduledAt).toBe("2026-07-31T01:00:00.000Z");
    expect(result.tasks[1]?.scheduledAt).toBe("2026-08-09T01:00:00.000Z");
    expect(result.tasks[1]?.metadata).toMatchObject({ reopenAgeDays: 12 });
  });

  it("creates age-specific tasks and cleaning cycles", () => {
    const run = createRun();
    expect(generateAgeTasks(run, 9, "2026-07-31T00:00:00.000Z")[0]?.kind).toBe(
      "creep_feed",
    );
    expect(generateAgeTasks(run, 13, "2026-07-31T00:00:00.000Z")[0]).toMatchObject({
      kind: "milk_soaked_feed",
      numericPlan: { feedRatio: "4:1" },
    });
    expect(generateAgeTasks(run, 20, "2026-07-31T00:00:00.000Z")[0]).toMatchObject({
      kind: "transition_feed",
      numericPlan: { mealCount: 3 },
    });
    expect(
      generateMaintenanceTasks(run, 14, "2026-07-31T00:00:00.000Z").map(
        (task) => task.kind,
      ),
    ).toEqual(["clean_water_cycle", "deep_clean"]);
  });

  it("supports module switches and validated custom tasks", () => {
    const run = createRun();
    run.template = {
      ...run.template,
      creepFeedEnabled: false,
      customTasks: [{
        title: "检查自定义料槽",
        ageDay: 10,
        localTime: "08:30",
        requiresConfirmation: false,
        plannedValues: { note: "场区自定义" },
      }],
    };
    expect(generateAgeTasks(run, 9, "2026-07-31T00:00:00.000Z")).toHaveLength(0);
    expect(generateCustomTasks(run, 3)[0]).toMatchObject({
      kind: "custom",
      status: "scheduled",
      requiresConfirmation: false,
      metadata: { ageDay: 10, note: "场区自定义" },
    });
  });
});

describe("exception mode", () => {
  it("blocks standard decisions on severe or equipment data", () => {
    expect(
      checkDataQuality({
        headCount: 20,
        averageWeightKg: 2.1,
        feedingResponse: "active",
        abdomenState: "full",
        diarrhea: "severe",
        deaths: 0,
        deviceStatus: "blocked",
        operatorConfirmed: true,
      }),
    ).toMatchObject({
      complete: true,
      exceptionMode: true,
      mayDraftStandardDecision: false,
    });
  });
});
