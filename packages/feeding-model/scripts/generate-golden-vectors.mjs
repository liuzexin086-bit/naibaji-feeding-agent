#!/usr/bin/env node
/**
 * P2-6 golden-vector generator (deterministic).
 *
 * Requires the BASELINE parity oracle E:/plan/feeding-model.js and produces
 * >= 100 vectors over a defined input space:
 *   - every age 3..21 (19) x creep grade none/low/medium/high/excellent (5) = 95
 *   - plus boundary cases (below-3 / above-21 / headCount 0 / fractional
 *     headCount / null fields / omitted diarrhea fields / explicit zero /
 *     mode+currentDay edges / capacity override / first-day d1 ramp /
 *     max d4Plus ramp / INV-007 non-monotonic) => >= 103 total.
 *
 * Each vector: { id, label, input: { batchConfig, records, controlStartDay? },
 *   expected: { plan, control, training } } where plan = generatePlan output,
 *   control = computeControlPlan output, training = exportTrainingData output
 *   (exportedAt EXCLUDED - non-deterministic date), all JSON-round-tripped.
 *
 * The file is byte-stable across runs: every object is built in a fixed key
 * order and serialized with JSON.stringify(value, null, 2); no wall-clock or
 * random input is used.
 */

import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASELINE = require('E:/plan/feeding-model.js');

const WEIGHT_STANDARD = BASELINE.WEIGHT_STANDARD;
const CREEP_GRADE_ORDER = ['none', 'low', 'medium', 'high', 'excellent'];

// Round-trip through JSON: drops undefined, canonicalizes NaN/Infinity, and
// fixes key order for byte-stable serialization.
function rt(value) {
  return JSON.parse(JSON.stringify(value));
}

// Execute one function in a try/catch, normalizing to { ok | error }.
function run(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return { ok: false, error: err && err.message != null ? String(err.message) : String(err) };
  }
}

/**
 * The exact deterministic computation pipeline (mirrored in the vitest harness
 * so package and baseline results compare 1:1 against the stored expected).
 * Returns { plan, control, training } where:
 *   - plan     : generatePlan value, or { __error: msg }
 *   - control  : computeControlPlan value, or { __error: msg }; null when the
 *                plan itself failed (control is undefined without a plan)
 *   - training : exportTrainingData value with exportedAt stripped, or
 *                { __error: msg }
 */
function computeVector(rel, input) {
  const batchConfig = input.batchConfig;
  const records = input.records || [];
  const controlStartDay = input.controlStartDay;

  function startWeightFor(age) {
    return WEIGHT_STANDARD[age] != null ? WEIGHT_STANDARD[age] : 2.3;
  }

  // --- plan ---
  let planValue = null;
  const planRun = run(function () { return rel.generatePlan(batchConfig); });
  let plan;
  if (planRun.ok) {
    plan = rt(planRun.value);
    planValue = planRun.value;
  } else {
    plan = { __error: planRun.error };
  }

  // --- control ---
  let control;
  if (planRun.ok) {
    const ctrlRun = run(function () { return rel.computeControlPlan(planValue, records, controlStartDay); });
    control = ctrlRun.ok ? rt(ctrlRun.value) : { __error: ctrlRun.error };
  } else {
    control = null;
  }

  // --- training ---
  const batchInfo = {
    records: records,
    startAge: batchConfig.startAge,
    endAge: batchConfig.endAge,
    startWeight: batchConfig.startWeight != null ? batchConfig.startWeight : startWeightFor(batchConfig.startAge),
    headCount: batchConfig.headCount,
    totalMilkPlanG: planRun.ok ? planValue.totalMilkPlanG : 0,
    standardWeight: planRun.ok ? planValue.standardWeight : (WEIGHT_STANDARD[batchConfig.endAge] != null ? WEIGHT_STANDARD[batchConfig.endAge] : 4.4),
  };
  const trainRun = run(function () { return rel.exportTrainingData(batchInfo); });
  let training;
  if (trainRun.ok) {
    training = rt(trainRun.value);
    delete training.exportedAt; // non-deterministic date
  } else {
    training = { __error: trainRun.error };
  }

  return {
    plan: rt(plan),
    control: rt(control),
    training: rt(training),
  };
}

// Representative matrix vector: batch from a given start age for a 10-day
// window (ages range climbs above the WEIGHT_STANDARD ceiling to exercise the
// fallback), fixed head count, a committed-plan anchor on two mid days, and a
// sustained creep-grade observation on the first three feeding days.
function buildMatrixVector(startAge, creepGrade) {
  const endAge = Math.min(30, startAge + 9);
  const headCount = 24;
  const batchConfig = { startAge: startAge, endAge: endAge, startWeight: WEIGHT_STANDARD[startAge] != null ? WEIGHT_STANDARD[startAge] : 2.3, headCount: headCount };

  const records = [];
  for (let age = startAge; age <= endAge; age++) {
    const idx = age - startAge;
    const rec = {
      dayAge: age,
      headCount: headCount,
      totalMilkG: 100 + idx * 37,
      totalCreepG: idx < 3 ? (CREEP_GRADE_ORDER.indexOf(creepGrade) * 21) : 0,
      diarrheaMild: idx % 3,
      diarrheaModerate: idx % 2,
      diarrheaSevere: 0,
    };
    if (idx < 3) rec.creepGrade = creepGrade;
    if (idx === 4 || idx === 6) {
      rec.planPerPigAtCommit = null; // filled below
      rec.feedTimesAtCommit = idx === 4 ? 8 : 7;
    }
    records.push(rec);
  }

  return { batchConfig: batchConfig, records: records };
}

function main() {
  const vectors = [];

  // 1) Matrix: ages 3..21 x grades none/low/medium/high/excellent = 95.
  for (let age = 3; age <= 21; age++) {
    for (let gi = 0; gi < CREEP_GRADE_ORDER.length; gi++) {
      const grade = CREEP_GRADE_ORDER[gi];
      const built = buildMatrixVector(age, grade);
      const batchConfig = built.batchConfig;
      const records = built.records;
      // Fill committed values deterministically from the baseline plan.
      const plan = BASELINE.generatePlan(batchConfig);
      for (let ri = 0; ri < records.length; ri++) {
        const rec = records[ri];
        if (rec.planPerPigAtCommit === null) {
          const idx = rec.dayAge - batchConfig.startAge;
          rec.planPerPigAtCommit = plan.planMilkPP[idx];
          rec.planTotalAtCommit = plan.planMilkTotal[idx];
        }
      }
      const id = 'age' + age + '-grade-' + grade;
      vectors.push({
        id: id,
        label: 'age ' + age + ' creep ' + grade,
        input: { batchConfig: rt(batchConfig), records: rt(records) },
        expected: computeVector(BASELINE, { batchConfig: batchConfig, records: records }),
      });
    }
  }

  // 2) Boundary cases.
  const boundary = [];

  boundary.push({
    id: 'boundary-age-below-3',
    label: 'startAge below 3 (default weight)',
    input: { batchConfig: { startAge: 2, endAge: 6, startWeight: null, headCount: 18 }, records: [
      { dayAge: 2, headCount: 18, creepGrade: 'medium' },
      { dayAge: 3, headCount: 18, creepGrade: 'medium' },
    ] },
  });

  boundary.push({
    id: 'boundary-age-above-21',
    label: 'startAge above 21 (no weight standard)',
    input: { batchConfig: { startAge: 22, endAge: 27, startWeight: null, headCount: 20 }, records: [
      { dayAge: 22, headCount: 20, creepGrade: 'excellent' },
      { dayAge: 23, headCount: 20, creepGrade: 'excellent' },
    ] },
  });

  boundary.push({
    id: 'boundary-startAge-min-1',
    label: 'startAge minimum (1)',
    input: { batchConfig: { startAge: 1, endAge: 4, startWeight: null, headCount: 15 }, records: [
      { dayAge: 1, headCount: 15, creepGrade: 'low' },
      { dayAge: 2, headCount: 15, creepGrade: 'low' },
    ] },
  });

  boundary.push({
    id: 'boundary-endAge-max-30',
    label: 'endAge maximum (30)',
    input: { batchConfig: { startAge: 25, endAge: 30, startWeight: null, headCount: 22 }, records: [
      { dayAge: 25, headCount: 22, creepGrade: 'high' },
      { dayAge: 26, headCount: 22, creepGrade: 'high' },
    ] },
  });

  boundary.push({
    id: 'boundary-headCount-zero',
    label: 'headCount zero (validation error)',
    input: { batchConfig: { startAge: 5, endAge: 8, headCount: 0 }, records: [] },
  });

  boundary.push({
    id: 'boundary-headCount-fractional',
    label: 'fractional headCount',
    input: { batchConfig: { startAge: 5, endAge: 9, startWeight: null, headCount: 12.5 }, records: [
      { dayAge: 5, headCount: 12.5, creepGrade: 'medium' },
      { dayAge: 6, headCount: 12.5, creepGrade: 'medium' },
    ] },
  });

  boundary.push({
    id: 'boundary-null-omitted-fields',
    label: 'null and omitted record fields',
    input: { batchConfig: { startAge: 7, endAge: 11, startWeight: null, headCount: 19 }, records: [
      { dayAge: 7, headCount: 19 },
      { dayAge: 8, headCount: 19 },
      { dayAge: 9, headCount: 19, diarrheaMild: null, diarrheaModerate: null },
    ] },
  });

  boundary.push({
    id: 'boundary-explicit-zero',
    label: 'explicit zero fields',
    input: { batchConfig: { startAge: 9, endAge: 12, startWeight: null, headCount: 16 }, records: [
      { dayAge: 9, headCount: 16, totalMilkG: 0, totalCreepG: 0, diarrheaMild: 0, diarrheaModerate: 0, diarrheaSevere: 0 },
      { dayAge: 10, headCount: 16, creepGrade: 'low', creepValue: 10 },
    ] },
  });

  boundary.push({
    id: 'boundary-controlStart-everyDay',
    label: 'controlStartDay = nDays (no control active)',
    input: { batchConfig: { startAge: 6, endAge: 10, startWeight: null, headCount: 21 }, records: [
      { dayAge: 6, headCount: 21, creepGrade: 'high' },
      { dayAge: 7, headCount: 21, creepGrade: 'high' },
    ], controlStartDay: 5 },
  });

  boundary.push({
    id: 'boundary-controlStart-immediate',
    label: 'controlStartDay = 0 (immediate control)',
    input: { batchConfig: { startAge: 6, endAge: 10, startWeight: null, headCount: 21 }, records: [
      { dayAge: 6, headCount: 21, creepGrade: 'high' },
      { dayAge: 7, headCount: 21, creepGrade: 'high' },
    ], controlStartDay: 0 },
  });

  boundary.push({
    id: 'boundary-capacity-committed-override',
    label: 'committed perPig exceeds capacity (committed override)',
    input: { batchConfig: { startAge: 3, endAge: 7, startWeight: null, headCount: 20 }, records: [
      { dayAge: 3, headCount: 20, creepGrade: 'high' },
      { dayAge: 4, headCount: 20, creepGrade: 'high' },
      { dayAge: 5, headCount: 20, planPerPigAtCommit: 99999, planTotalAtCommit: 1999980, feedTimesAtCommit: 8 },
    ] },
  });

  boundary.push({
    id: 'boundary-first-day-d1-ramp',
    label: 'first-day d1 ramp',
    input: { batchConfig: { startAge: 4, endAge: 5, startWeight: null, headCount: 30 }, records: [
      { dayAge: 4, headCount: 30, creepGrade: 'low' },
    ], controlStartDay: 0 },
  });

  boundary.push({
    id: 'boundary-max-ramp-d4Plus',
    label: 'max d4Plus ramp, long batch',
    input: { batchConfig: { startAge: 5, endAge: 24, startWeight: null, headCount: 28 }, records: [
      { dayAge: 5, headCount: 28, creepGrade: 'excellent' },
      { dayAge: 6, headCount: 28, creepGrade: 'excellent' },
    ] },
  });

  boundary.push({
    id: 'boundary-inv007-non-monotonic',
    label: 'INV-007 non-monotonic committed history (error)',
    input: { batchConfig: { startAge: 3, endAge: 9, startWeight: null, headCount: 20 }, records: [
      { dayAge: 3, headCount: 20, creepGrade: 'high' },
      { dayAge: 4, headCount: 20, creepGrade: 'high' },
      { dayAge: 8, headCount: 20, planPerPigAtCommit: 300, planTotalAtCommit: 6000, feedTimesAtCommit: 8 },
      { dayAge: 9, headCount: 20, planPerPigAtCommit: 300, planTotalAtCommit: 6000, feedTimesAtCommit: 10 },
    ], controlStartDay: 5 },
  });

  for (let bi = 0; bi < boundary.length; bi++) {
    const v = boundary[bi];
    const inputObj = { batchConfig: rt(v.input.batchConfig), records: rt(v.input.records) };
    if (v.input.controlStartDay !== undefined) inputObj.controlStartDay = v.input.controlStartDay;
    vectors.push({
      id: v.id,
      label: v.label,
      input: inputObj,
      expected: computeVector(BASELINE, v.input),
    });
  }

  // Serialize deterministically (fixed key order, stable indentation).
  const out = {
    formatVersion: 1,
    behaviorVersion: 'naibaji-v2',
    baselineSource: 'feeding-model.js',
    vectors: vectors,
  };

  const outArg = process.argv[2];
  const file = outArg ? path.resolve(outArg) : path.join(__dirname, '..', 'golden-vectors.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n', 'utf8');

  console.log('Golden vectors written:', file);
  console.log('Total vectors:', vectors.length);
  console.log('Matrix vectors:', vectors.filter(function (v) { return v.id.indexOf('age') === 0; }).length);
  console.log('Boundary vectors:', vectors.filter(function (v) { return v.id.indexOf('boundary') === 0; }).length);
}

main();