import { computeProductionPlan } from "../dist/model/production-model.js";

const output = computeProductionPlan({
  startAge: 3,
  endAge: 4,
  startWeight: 2.3,
  headCount: 20,
  dayAge: 3,
  devicePowderPrecisionGrams: 1,
});

if (!output.selectedDay.deviceProgram) {
  throw new Error("NBJ_DIST_MODEL_SMOKE_UNAVAILABLE");
}

console.log(
  `dist model smoke ok: mode=${output.deviceOperation.mode} meals=${output.selectedDay.deviceProgram.mealCount}`,
);
