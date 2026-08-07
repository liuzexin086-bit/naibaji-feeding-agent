import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computeFrozenBatchDecision,
  digestFrozenSopSnapshot,
  loadFrozenBatchDecisionContext,
} from "../../src/decision/batch-decision-service.js";
import { defaultFreeFeedingSlots } from "../../src/decision/free-feeding-slots.js";
import type { DevicePlanSnapshot } from "../../src/shared/local-store-contract.js";

function devicePlan(windows = [{ startLocal: "23:00", endLocal: "02:00" }, { startLocal: "03:00", endLocal: "05:00" }]): DevicePlanSnapshot {
  const slots = defaultFreeFeedingSlots().map((slot, index) => index < windows.length
    ? { ...slot, enabled: true, startLocal: windows[index]!.startLocal, endLocal: windows[index]!.endLocal }
    : slot);
  const snapshot: DevicePlanSnapshot = {
    version: "device-plan@service-test",
    sha256: "",
    firstDay: { mode: "timed_quantity", mealTimes: ["17:00", "20:00", "23:00", "02:00", "05:00", "08:00"] },
    templates: {
      timed_quantity: {
        mealTimes: ["10:00", "14:00", "16:00", "18:00", "20:00", "22:00", "02:00", "04:00", "06:00", "08:00"],
        excludedMealTimes: ["00:00", "12:00"],
        precisionGrams: 1,
        reductionPriority: ["20:00", "16:00", "04:00", "14:00", "06:00", "18:00", "02:00", "22:00", "10:00"],
      },
      free_feeding: {
        slots,
        windows,
        stageConditions: { earliestBatchDay: 1, requiresOperatorSelection: true },
        exceptionBlockers: ["diarrhea", "milk_control"],
      },
    },
  };
  snapshot.sha256 = createHash("sha256").update(JSON.stringify({
    version: snapshot.version,
    firstDay: snapshot.firstDay,
    templates: snapshot.templates,
  }).normalize("NFC"), "utf8").digest("hex").toUpperCase();
  return snapshot;
}

function source(overrides: Record<string, unknown> = {}) {
  const sopBase = {
    templateId: "sop-service-test",
    version: "sop@service-test",
    sourceSha256: "a".repeat(64),
    collectionRevision: "collection@service-test",
    parserVersion: "parser@service-test",
    embeddingModel: "embedding@service-test",
    config: {
      teachingProgramEnabled: true,
      teachingFirstLocal: "17:00",
      teachingIntervalHours: 3,
      teachingEndLocal: "08:00",
      teachingPowderGramsPerTwenty: 35,
    },
  };
  return {
    batchId: "batch-service-test",
    revision: 4,
    currentDayIndex: 1,
    config: {
      startAge: 3,
      endAge: 5,
      startWeight: 2.3,
      effectiveHeads: 20,
      selectedMode: "free_feeding",
      planStartDate: "2026-08-04",
      controlStartDay: -1,
      sopTemplate: { ...sopBase, snapshotSha256: digestFrozenSopSnapshot(sopBase) },
      devicePlanSnapshot: devicePlan(),
      ...overrides,
    },
    records: [],
  };
}

describe("BatchDecisionService frozen inputs", () => {
  it("uses the frozen selected mode, 09:00-axis cross-midnight windows, and canonical refs", () => {
    const context = loadFrozenBatchDecisionContext(source());
    const canonical = computeFrozenBatchDecision(context);
    expect(canonical).toMatchObject({
      selectedMode: "free_feeding",
      effectiveMode: "free_feeding",
      freeFeedingBlockers: [],
      sopRef: { sourceSha256: "A".repeat(64) },
      devicePlanRef: { sha256: context.devicePlan.sha256 },
    });
    expect(canonical.decision.setting.freeWindows).toEqual([
      { startLocal: "23:00", endLocal: "02:00" },
      { startLocal: "03:00", endLocal: "05:00" },
    ]);
  });

  it("keeps selected free-feeding mode when diarrhea is recorded and does not block free feeding", () => {
    const context = loadFrozenBatchDecisionContext({
      ...source(),
      records: [{ diarrheaGrade: "moderate" }],
    });
    const canonical = computeFrozenBatchDecision(context);
    expect(canonical.selectedMode).toBe("free_feeding");
    expect(canonical.effectiveMode).toBe("free_feeding");
    expect(canonical.freeFeedingBlockers).not.toContain("diarrhea");
  });

  it("keeps free-feeding mode when milk control is active and never reuses blockers to force timed", () => {
    const context = loadFrozenBatchDecisionContext({
      ...source({ controlStartDay: 1 }),
      records: [{ dayAge: 4, creepGrade: "high", headCount: 20 }],
    });
    const canonical = computeFrozenBatchDecision(context);
    expect(canonical.selectedMode).toBe("free_feeding");
    expect(canonical.effectiveMode).toBe("free_feeding");
    expect(canonical.decision.setting.mode).toBe("free_feeding");
    expect(canonical.freeFeedingBlockers).toEqual([]);
    expect(canonical.decision.exceptionActions.map((action) => action.type)).not.toContain("diarrhea");
  });

  it("fails closed for a missing or tampered frozen SOP snapshot", () => {
    const missing = source();
    delete (missing.config as Record<string, unknown>).sopTemplate;
    expect(() => loadFrozenBatchDecisionContext(missing))
      .toThrow("NBJ_FROZEN_SOP_MISSING");

    const tampered = source();
    ((tampered.config.sopTemplate as Record<string, unknown>).snapshotSha256) = "0".repeat(64);
    expect(() => loadFrozenBatchDecisionContext(tampered))
      .toThrow("NBJ_FROZEN_SOP_SNAPSHOT_DIGEST_MISMATCH");
  });

  it("rejects overlapping frozen free-feeding windows instead of reinterpreting them", () => {
    const invalid = source({
      devicePlanSnapshot: devicePlan([
        { startLocal: "23:00", endLocal: "02:00" },
        { startLocal: "01:00", endLocal: "03:00" },
      ]),
    });
    expect(() => computeFrozenBatchDecision(loadFrozenBatchDecisionContext(invalid)))
      .toThrow("NBJ_FROZEN_FREE_FEEDING_SLOTS_OVERLAP");
  });
});
