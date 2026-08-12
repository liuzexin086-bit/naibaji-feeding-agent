import { describe, expect, it } from "vitest";
import type { FeedingDecision } from "../../src/shared/agent-v2-contract.js";
import type { DailyOperationItem } from "../../src/shared/local-store-contract.js";
import {
  digestFeedbackProposal,
  evaluateObservationFeedback,
  feedbackOriginId,
  mergeFeedbackOperations,
  proposalToDeviceSetting,
  sustainedCreepGrade,
  type FeedbackEngineInput,
} from "../../src/operations/observation-feedback.js";

function baseDecision(): FeedingDecision {
  return {
    revision: 3,
    batchId: "batch-1",
    dateLocal: "2026-08-05",
    setting: {
      mode: "timed_quantity",
      dayAge: 4,
      dailyPowderGrams: 600,
      singlePowderGrams: 50,
      mealCount: 12,
      timedMeals: Array.from({ length: 12 }, (_, index) => ({
        timeLocal: `${String((10 + index) % 24).padStart(2, "0")}:00`,
        powderGrams: 50,
      })),
      freeWindows: [],
      precisionGrams: 1,
      source: "sop_indirect",
    },
    exceptionActions: [],
    evidence: {
      sopVersion: "sop@test-v1",
      modelVersion: "model@test-v1",
      calculationDate: "2026-08-05",
      reasons: ["base decision"],
      inputs: {},
      steps: [],
    },
    status: "active",
  };
}

function engineInput(overrides: Partial<FeedbackEngineInput> = {}): FeedbackEngineInput {
  return {
    userId: "user-a",
    batchId: "batch-1",
    records: [],
    businessDate: "2026-08-05",
    currentDayIndex: 1,
    dayAge: 4,
    config: { controlStartDay: -1 },
    decision: baseDecision(),
    reductionPriority: ["10:00"],
    freeReductionPriority: ["09:00"],
    ...overrides,
  };
}

describe("observation feedback engine", () => {
  it("computes sustained creep from the latest three records", () => {
    expect(sustainedCreepGrade([
      { recordedAt: "2026-08-05T08:00:00Z", creepGrade: "high" },
      { recordedAt: "2026-08-05T09:00:00Z", creepGrade: "none" },
      { recordedAt: "2026-08-05T10:00:00Z", creepGrade: "excellent" },
    ])).toBe("high");
    expect(sustainedCreepGrade([
      { recordedAt: "2026-08-05T08:00:00Z", creepGrade: "high" },
      { recordedAt: "2026-08-05T09:00:00Z", creepGrade: "none" },
      { recordedAt: "2026-08-05T10:00:00Z", creepGrade: "none" },
    ])).toBe("none");
  });

  it("generates individual intervention for mild diarrhea without a device proposal", () => {
    const result = evaluateObservationFeedback(engineInput({
      records: [{
        recordedAt: "2026-08-05T09:00:00+08:00",
        diarrheaGrade: "mild",
        actualPowderGrams: 0,
      }],
    }));
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("diarrhea");
    expect(result?.operations[0]?.code).toBe("feedback_diarrhea_intervention");
    expect(result?.operations[0]?.title).toBe("腹泻个体干预（轻度）");
    expect(result?.operations[0]?.feedbackRef?.requiresDeviceConfirmation).toBe(false);
    expect(result?.proposedSetting).toBeNull();
    expect(result?.feedbackOrigin.status).toBe("manual");
  });

  it("generates a feeding reduction proposal for moderate diarrhea", () => {
    const result = evaluateObservationFeedback(engineInput({
      records: [{
        recordedAt: "2026-08-05T09:00:00+08:00",
        diarrheaGrade: "moderate",
        actualPowderGrams: 0,
      }],
    }));
    expect(result?.operations[0]?.code).toBe("feedback_diarrhea_confirm");
    expect(result?.operations[0]?.feedbackRef?.requiresDeviceConfirmation).toBe(true);
    expect(result?.proposedSetting).toMatchObject({
      kind: "diarrhea",
      resultKind: "feeding_reduction_proposal",
      manualDispositionRequired: false,
    });
    expect(result?.proposedSetting?.proposalDigest).toMatch(/^[A-F0-9]{64}$/);
    expect(result?.feedbackOrigin.status).toBe("proposed");
  });

  it("returns manual-only for severe diarrhea", () => {
    const result = evaluateObservationFeedback(engineInput({
      records: [{
        recordedAt: "2026-08-05T09:00:00+08:00",
        diarrheaGrade: "severe",
        actualPowderGrams: 120,
      }],
    }));
    expect(result?.operations[0]?.code).toBe("feedback_diarrhea_confirm");
    expect(result?.proposedSetting).toBeNull();
    expect(result?.feedbackOrigin.status).toBe("manual");
    expect(result?.operations[0]?.feedbackRef?.requiresDeviceConfirmation).toBe(false);
  });

  it("generates a manual task for moderate when cumulative powder is missing", () => {
    const result = evaluateObservationFeedback(engineInput({
      records: [{
        recordedAt: "2026-08-05T09:00:00+08:00",
        diarrheaGrade: "moderate",
        actualPowderGrams: null,
      }],
    }));
    expect(result?.operations[0]?.code).toBe("feedback_diarrhea_confirm");
    expect(result?.proposedSetting).toBeNull();
    expect(result?.feedbackOrigin.status).toBe("manual");
    expect(result?.operations[0]?.title).toBe("腹泻人工处置（中度）");
  });

  it("closes diarrhea when the latest explicit grade returns to none", () => {
    const result = evaluateObservationFeedback(engineInput({
      records: [
        { recordedAt: "2026-08-05T09:00:00.000Z", diarrheaGrade: "mild", actualPowderGrams: 120 },
        { recordedAt: "2026-08-05T15:00:00.000Z", diarrheaGrade: "none", actualPowderGrams: 180 },
      ],
    }));
    expect(result).toBeNull();
  });

  it("lets a current explicit none close an earlier moderate record", () => {
    const result = evaluateObservationFeedback(engineInput({
      records: [{
        recordedAt: "2026-08-05T09:00:00.000Z",
        diarrheaGrade: "moderate",
        actualPowderGrams: 0,
      }],
      observation: { diarrheaGrade: "none", actualPowderGrams: 0 },
    }));
    expect(result).toBeNull();
  });

  it("does not treat an omitted diarrheaGrade as an explicit none", () => {
    const result = evaluateObservationFeedback(engineInput({
      records: [
        {
          recordedAt: "2026-08-05T09:00:00+08:00",
          diarrheaGrade: "moderate",
          actualPowderGrams: 100,
        },
        {
          recordedAt: "2026-08-05T14:00:00+08:00",
          actualPowderGrams: 180,
        },
      ],
    }));
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("diarrhea");
  });

  it("orders observations by instant instead of timestamp string", () => {
    const result = evaluateObservationFeedback(engineInput({
      records: [
        {
          recordedAt: "2026-08-05T10:00:00+08:00",
          diarrheaGrade: "mild",
          actualPowderGrams: 0,
        },
        {
          recordedAt: "2026-08-05T03:00:00Z",
          diarrheaGrade: "none",
          actualPowderGrams: 180,
        },
      ],
    }));
    expect(result).toBeNull();
  });

  it("does not let invalid legacy timestamps become the newest diarrhea status", () => {
    const result = evaluateObservationFeedback(engineInput({
      records: [
        {
          recordedAt: "2026-08-05T10:00:00Z",
          diarrheaGrade: "mild",
          actualPowderGrams: 0,
        },
        {
          recordedAt: "invalid-legacy-time",
          diarrheaGrade: "none",
          actualPowderGrams: 180,
        },
      ],
    }));
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("diarrhea");
  });

  it("ignores an invalid legacy diarrhea record as the only source", () => {
    const result = evaluateObservationFeedback(engineInput({
      records: [{
        recordedAt: "invalid-legacy-time",
        diarrheaGrade: "mild",
        actualPowderGrams: 100,
      }],
    }));
    expect(result).toBeNull();
  });

  it("does not trigger creep control from invalid legacy records", () => {
    const result = evaluateObservationFeedback(engineInput({
      currentDayIndex: 2,
      dayAge: 5,
      config: { controlStartDay: 2 },
      records: [
        { recordedAt: "invalid-legacy-time", creepGrade: "high" },
        { recordedAt: "invalid-legacy-time", creepGrade: "high" },
      ],
    }));
    expect(result).toBeNull();
  });

  it("uses only the valid mild record when invalid legacy mild exists", () => {
    const result = evaluateObservationFeedback(engineInput({
      records: [
        {
          recordedAt: "invalid-legacy-time",
          diarrheaGrade: "mild",
          actualPowderGrams: 100,
        },
        {
          recordedAt: "2026-08-05T10:00:00.000Z",
          diarrheaGrade: "mild",
          actualPowderGrams: 200,
        },
      ],
    }));
    expect(result).not.toBeNull();
    expect(result?.feedbackOrigin.sourceObservation).toMatchObject({
      recordedAt: "2026-08-05T10:00:00.000Z",
      actualPowderGrams: 200,
    });
  });

  it("drops previously materialized diarrhea feedback when the latest grade is none", () => {
    const base = [{
      code: "daily_patrol",
      title: "日常巡栏",
      dueWindow: { startLocal: "09:00", endLocal: "10:00" },
      sopSection: "SOP.日常巡栏",
      requiredObservationFields: [],
      safetyNotes: [],
    }] as DailyOperationItem[];
    const existing = [{
      code: "feedback_diarrhea_confirm",
      title: "腹泻处置确认（轻度）",
      dueWindow: { startLocal: "09:00", endLocal: "09:00", endDayOffset: 1 },
      sopSection: "现场反馈.腹泻",
      requiredObservationFields: [],
      safetyNotes: [],
      feedbackRef: {
        originId: "origin-1",
        kind: "diarrhea",
        proposalDigest: "A".repeat(64),
        requiresDeviceConfirmation: true,
      },
    }] as DailyOperationItem[];
    const merged = mergeFeedbackOperations(base, existing, null);
    expect(merged.map((item) => item.code)).not.toContain("feedback_diarrhea_confirm");
  });

  it("starts creep control confirmation on the configured control day", () => {
    const result = evaluateObservationFeedback(engineInput({
      currentDayIndex: 2,
      dayAge: 5,
      config: { controlStartDay: 2 },
      records: [
        { recordedAt: "2026-08-06T10:00:00.000Z", creepGrade: "high" },
        { recordedAt: "2026-08-07T10:00:00.000Z", creepGrade: "high" },
      ],
    }));
    expect(result?.kind).toBe("creep_control");
    expect(result?.operations[0]?.code).toBe("feedback_creep_control_confirm");
    expect(result?.proposedSetting).toMatchObject({
      kind: "creep_control",
      controlStartDay: 2,
    });
  });

  it("returns no feedback when neither signal is active", () => {
    expect(evaluateObservationFeedback(engineInput())).toBeNull();
  });

  it("merges feedback operations without duplicating base tasks", () => {
    const base = [{
      code: "daily_patrol",
      title: "日常巡栏",
      dueWindow: { startLocal: "09:00", endLocal: "10:00" },
      sopSection: "SOP.日常巡栏",
      requiredObservationFields: [],
      safetyNotes: [],
    }];
    const result = evaluateObservationFeedback(engineInput({
      records: [{ recordedAt: "2026-08-05T09:00:00+08:00", diarrheaGrade: "mild", actualPowderGrams: 0 }],
    }))!;
    const merged = mergeFeedbackOperations(base, [], result);
    expect(merged.map((item) => item.code)).toContain("feedback_diarrhea_intervention");
    expect(merged.filter((item) => item.code === "daily_patrol")).toHaveLength(1);
  });

  it("hashes proposals and maps them to device settings deterministically", () => {
    const result = evaluateObservationFeedback(engineInput({
      records: [{ recordedAt: "2026-08-05T09:00:00+08:00", diarrheaGrade: "moderate", actualPowderGrams: 0 }],
    }))!;
    const proposal = result.proposedSetting!;
    expect(digestFeedbackProposal(proposal)).toBe(proposal.proposalDigest);
    const setting = proposalToDeviceSetting(proposal);
    expect(setting).toMatchObject({
      mode: proposal.mode,
      dayAge: proposal.dayAge,
      dailyPowderGrams: proposal.dailyPowderGrams,
      source: proposal.source,
    });
    expect(feedbackOriginId("diarrhea", "2026-08-05", { recordedAt: "x" }, {
      userId: "user-a",
      batchId: "batch-1",
      observationId: "obs-1",
    }))
      .toMatch(/^[0-9a-f]{32}$/);
  });
});
