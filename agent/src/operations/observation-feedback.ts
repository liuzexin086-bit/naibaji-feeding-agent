import { createHash } from "node:crypto";
import {
  previewDiarrheaAdjustment,
  type CreepGrade,
  type DeviceSetting,
  type DiarrheaGrade,
  type FeedingDecision,
  type FeedingMode,
} from "../decision/index.js";
import {
  buildDailyOperationItems,
  digestDailyOperationItems,
} from "./daily-operation-plan.js";
import {
  computeFrozenBatchDecision,
  loadFrozenBatchDecisionContext,
} from "../decision/batch-decision-service.js";
import type {
  DailyOperationItem,
  DailyOperationPlan,
  EnsureDailyOperationPlanInput,
  FeedbackDeviceProposal,
  FeedbackOrigin,
  FeedbackOriginKind,
  LocalBatch,
  LocalStore,
} from "../shared/local-store-contract.js";

type JsonObject = Record<string, unknown>;

const CREEP_ORDER: CreepGrade[] = ["none", "low", "medium", "high", "excellent"];
const DIARRHEA_ORDER: DiarrheaGrade[] = ["none", "mild", "moderate", "severe"];
const DIARRHEA_RATIO: Record<Exclude<DiarrheaGrade, "none">, number> = {
  mild: 0.9,
  moderate: 0.75,
  severe: 0.5,
};

export function sustainedCreepGrade(records: JsonObject[]): CreepGrade {
  const recent = records.slice(-3).map((row) => {
    const grade = String(row.creepGrade ?? "none");
    return CREEP_ORDER.includes(grade as CreepGrade) ? grade as CreepGrade : "none";
  });
  if (recent.length < 2) return "none";
  for (let index = CREEP_ORDER.length - 1; index >= 1; index -= 1) {
    if (recent.filter((grade) => CREEP_ORDER.indexOf(grade) >= index).length >= 2) {
      return CREEP_ORDER[index];
    }
  }
  return "none";
}

function recordsOf(batch: LocalBatch): JsonObject[] {
  return Array.isArray(batch.data.records)
    ? batch.data.records.filter((row): row is JsonObject => Boolean(row) && typeof row === "object" && !Array.isArray(row))
    : [];
}

function sortedRecords(records: JsonObject[]): JsonObject[] {
  return [...records].sort((left, right) => {
    const leftAt = String(left.recordedAt ?? left.created_at ?? "");
    const rightAt = String(right.recordedAt ?? right.created_at ?? "");
    return leftAt.localeCompare(rightAt);
  });
}

function latestDiarrheaRecord(records: JsonObject[]): JsonObject | undefined {
  const sorted = sortedRecords(records);
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const row = sorted[index];
    const grade = String(row.diarrheaGrade ?? "none");
    if (grade !== "none" && DIARRHEA_ORDER.includes(grade as DiarrheaGrade)) return row;
  }
  return undefined;
}

function latestCreepRecord(records: JsonObject[]): JsonObject | undefined {
  const sorted = sortedRecords(records);
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const row = sorted[index];
    const grade = String(row.creepGrade ?? "none");
    if (CREEP_ORDER.includes(grade as CreepGrade) && grade !== "none") return row;
  }
  return undefined;
}

export function feedbackOriginId(
  kind: FeedbackOriginKind,
  businessDate: string,
  source: unknown,
): string {
  return createHash("sha256")
    .update([
      "nbj-feedback-v1",
      kind,
      businessDate,
      JSON.stringify(source ?? {}).normalize("NFC"),
    ].join("\u001f"), "utf8")
    .digest("hex")
    .slice(0, 32);
}

export function digestFeedbackProposal(proposal: FeedbackDeviceProposal): string {
  const canonical = { ...proposal, proposalDigest: "" };
  return createHash("sha256")
    .update(JSON.stringify(canonical).normalize("NFC"), "utf8")
    .digest("hex")
    .toUpperCase();
}

export function proposalToDeviceSetting(proposal: FeedbackDeviceProposal): DeviceSetting {
  return {
    mode: proposal.mode,
    dayAge: proposal.dayAge,
    dailyPowderGrams: proposal.dailyPowderGrams,
    singlePowderGrams: proposal.singlePowderGrams,
    mealCount: proposal.mealCount,
    timedMeals: proposal.timedMeals,
    freeWindows: proposal.freeWindows,
    precisionGrams: proposal.precisionGrams,
    source: proposal.source,
  };
}

export interface FeedbackEngineInput {
  observation?: JsonObject;
  records: JsonObject[];
  businessDate: string;
  currentDayIndex: number;
  dayAge: number;
  config: JsonObject;
  decision: FeedingDecision;
}

export interface FeedbackEngineResult {
  kind: FeedbackOriginKind;
  reason: string;
  operations: DailyOperationItem[];
  feedbackOrigin: FeedbackOrigin;
  proposedSetting: FeedbackDeviceProposal | null;
}

function feedbackOperation(
  origin: FeedbackOrigin,
  proposal: FeedbackDeviceProposal | null,
  code: string,
  title: string,
  safetyNote: string,
  requiredObservationFields: string[],
): DailyOperationItem {
  return {
    code,
    title,
    dueWindow: { startLocal: "09:00", endLocal: "09:00", endDayOffset: 1 },
    sopSection: origin.kind === "diarrhea" ? "现场反馈.腹泻" : "现场反馈.教槽控奶",
    requiredObservationFields,
    safetyNotes: [safetyNote],
    feedbackRef: {
      originId: origin.id,
      kind: origin.kind,
      ...(proposal ? { proposalDigest: proposal.proposalDigest } : {}),
      requiresDeviceConfirmation: true,
    },
  };
}

function diarrheaProposal(
  kind: FeedbackOriginKind,
  businessDate: string,
  grade: Exclude<DiarrheaGrade, "none">,
  preview: FeedingDecision,
): FeedbackDeviceProposal {
  const proposal: FeedbackDeviceProposal = {
    kind,
    businessDate,
    mode: preview.setting.mode,
    dayAge: preview.setting.dayAge,
    dailyPowderGrams: preview.setting.dailyPowderGrams,
    singlePowderGrams: preview.setting.singlePowderGrams,
    mealCount: preview.setting.mealCount,
    timedMeals: preview.setting.timedMeals,
    freeWindows: preview.setting.freeWindows,
    precisionGrams: preview.setting.precisionGrams,
    source: preview.setting.source,
    rationale: [
      ...preview.evidence.reasons.slice(-2),
      "确认后减少一次配奶/自由采食窗口。",
    ],
    manualDispositionRequired: false,
    proposalDigest: "",
  };
  proposal.proposalDigest = digestFeedbackProposal(proposal);
  return proposal;
}

function creepControlProposal(
  businessDate: string,
  decision: FeedingDecision,
  currentDayIndex: number,
): FeedbackDeviceProposal {
  const proposal: FeedbackDeviceProposal = {
    kind: "creep_control",
    businessDate,
    mode: decision.setting.mode,
    dayAge: decision.setting.dayAge,
    dailyPowderGrams: decision.setting.dailyPowderGrams,
    singlePowderGrams: decision.setting.singlePowderGrams,
    mealCount: decision.setting.mealCount,
    timedMeals: decision.setting.timedMeals,
    freeWindows: decision.setting.freeWindows,
    precisionGrams: decision.setting.precisionGrams,
    source: decision.setting.source,
    rationale: [
      "教槽采食连续达到同一档或更高档，按批次冻结 SOP 在次日启动控奶。",
      "该方案为今日操作确认项，确认后写入当日设备设定。",
    ],
    manualDispositionRequired: false,
    proposalDigest: "",
    controlStartDay: currentDayIndex,
  };
  proposal.proposalDigest = digestFeedbackProposal(proposal);
  return proposal;
}

export function evaluateObservationFeedback(input: FeedbackEngineInput): FeedbackEngineResult | null {
  const diarrheaRecord = latestDiarrheaRecord(input.records);
  const diarrheaGradeRaw = diarrheaRecord?.diarrheaGrade;
  const observedGrade = input.observation?.diarrheaGrade;
  const grade = diarrheaRecord
    ? String(diarrheaGradeRaw) as DiarrheaGrade
    : observedGrade && observedGrade !== "none" && DIARRHEA_ORDER.includes(String(observedGrade) as DiarrheaGrade)
      ? String(observedGrade) as DiarrheaGrade
      : "none";
  const diarrheaGrade = grade === "none" ? undefined : grade as Exclude<DiarrheaGrade, "none">;

  if (diarrheaGrade) {
    const rawActual = diarrheaRecord
      ? diarrheaRecord.actualPowderGrams
      : input.observation?.actualPowderGrams;
    const cumulativePowderGrams = rawActual == null || rawActual === "" ? null : Number(rawActual);
    const sourceRecord = diarrheaRecord ?? input.observation ?? {};
    const sourceRef = {
      recordedAt: String(sourceRecord.recordedAt ?? sourceRecord.created_at ?? ""),
      idempotencyKey: sourceRecord.idempotencyKey ?? null,
    };
    const originId = feedbackOriginId("diarrhea", input.businessDate, sourceRef);
    const originBase = {
      id: originId,
      kind: "diarrhea" as const,
      businessDate: input.businessDate,
      status: "proposed" as const,
      sourceObservation: {
        recordedAt: String(sourceRecord.recordedAt ?? sourceRecord.created_at ?? new Date().toISOString()),
        ...(diarrheaGrade ? { diarrheaGrade } : {}),
        ...(cumulativePowderGrams !== null ? { actualPowderGrams: cumulativePowderGrams } : {}),
      },
      reason: "",
      createdAt: new Date().toISOString(),
    };
    const gradeLabel = diarrheaGrade === "mild" ? "轻度" : diarrheaGrade === "moderate" ? "中度" : "重度";
    const preview = previewDiarrheaAdjustment({
      decision: input.decision,
      grades: [diarrheaGrade],
      cumulativePowderGrams: cumulativePowderGrams ?? 0,
      observedAt: String(sourceRecord.recordedAt ?? new Date().toISOString()),
    });
    const proposal = diarrheaProposal(
      "diarrhea",
      input.businessDate,
      diarrheaGrade,
      preview,
    );
    const origin: FeedbackOrigin = {
      ...originBase,
      reason: `已记录${gradeLabel}腹泻，按规则减少一次配奶/自由采食窗口，生成待确认设备方案。`,
      proposal,
    };
    const operation = feedbackOperation(
      origin,
      proposal,
      "feedback_diarrhea_confirm",
      `腹泻处置确认（${gradeLabel}）`,
      "确认后减少一次配奶/自由采食窗口；未确认前设备保持不变。",
      ["diarrheaGrade", "actualPowderGrams"],
    );
    return { kind: "diarrhea", reason: origin.reason, operations: [operation], feedbackOrigin: origin, proposedSetting: proposal };
  }

  const controlStartDay = typeof input.config.controlStartDay === "number"
    ? input.config.controlStartDay
    : -1;
  const creepGrade = sustainedCreepGrade(input.records);
  if (controlStartDay === input.currentDayIndex && input.currentDayIndex > 0 && creepGrade !== "none") {
    const creepRecord = latestCreepRecord(input.records) ?? input.observation ?? {};
    const sourceRef = {
      recordedAt: String(creepRecord.recordedAt ?? creepRecord.created_at ?? ""),
      idempotencyKey: creepRecord.idempotencyKey ?? null,
    };
    const originId = feedbackOriginId("creep_control", input.businessDate, sourceRef);
    const proposal = creepControlProposal(input.businessDate, input.decision, input.currentDayIndex);
    const origin: FeedbackOrigin = {
      id: originId,
      kind: "creep_control",
      businessDate: input.businessDate,
      status: "proposed",
      sourceObservation: {
        recordedAt: String(creepRecord.recordedAt ?? creepRecord.created_at ?? new Date().toISOString()),
        creepGrade,
      },
      reason: `教槽采食连续达到${creepGrade}档，第${input.currentDayIndex + 1}日启动控奶并生成待确认设备方案。`,
      proposal,
      controlStartDay: input.currentDayIndex,
      createdAt: new Date().toISOString(),
    };
    const operation = feedbackOperation(
      origin,
      proposal,
      "feedback_creep_control_confirm",
      "教槽持续采食控奶启动确认",
      "确认后按控奶方案写入当日设备设定；未确认前设备保持不变。",
      ["creepGrade"],
    );
    return { kind: "creep_control", reason: origin.reason, operations: [operation], feedbackOrigin: origin, proposedSetting: proposal };
  }
  return null;
}

function operationKey(item: DailyOperationItem): string {
  return `${item.code}|${item.title}`;
}

export function mergeFeedbackOperations(
  base: DailyOperationItem[],
  existing: DailyOperationItem[],
  result: FeedbackEngineResult | null,
): DailyOperationItem[] {
  const baseKeys = new Set(base.map(operationKey));
  const preserved = (existing ?? []).filter((item) =>
    !item.feedbackRef && !baseKeys.has(operationKey(item)));
  return [
    ...base,
    ...preserved,
    ...(result?.operations ?? []),
  ];
}

export interface FeedbackMaterialization {
  plan: DailyOperationPlan;
  feedback: FeedbackEngineResult | null;
  skipped: boolean;
}

export function materializeObservationFeedbackPlan(input: {
  store: LocalStore;
  userId: string;
  batch: LocalBatch;
  observation?: JsonObject;
}): FeedbackMaterialization {
  const batch = input.batch;
  const batchConfig = (batch.data.config ?? {}) as JsonObject;
  const context = loadFrozenBatchDecisionContext({
    batchId: batch.batchId,
    revision: batch.revision,
    currentDayIndex: batch.currentDay,
    config: batchConfig,
    records: recordsOf(batch),
  });
  const canonical = computeFrozenBatchDecision(context);
  const baseOperations = buildDailyOperationItems({
    dayIndex: batch.currentDay,
    dayAge: context.modelInput.startAge + batch.currentDay,
    endAge: context.modelInput.endAge,
    sopConfig: context.sop.config,
  });
  const baseInput: EnsureDailyOperationPlanInput = {
    userId: input.userId,
    batchId: batch.batchId,
    businessDate: canonical.decision.dateLocal,
    basedOnBatchRevision: batch.revision,
    sopTemplateId: canonical.sopRef.templateId,
    sopSourceSha256: canonical.sopRef.sourceSha256,
    devicePlanVersion: canonical.devicePlanRef.version,
    devicePlanSha256: canonical.devicePlanRef.sha256,
    selectedMode: canonical.selectedMode,
    effectiveMode: canonical.effectiveMode,
    operations: baseOperations,
    operationsSha256: digestDailyOperationItems(baseOperations),
  };
  const existing = input.store.getDailyOperationPlan(input.userId, batch.batchId, baseInput.businessDate);
  if (existing?.status === "confirmed") {
    return { plan: existing, feedback: null, skipped: true };
  }
  const result = evaluateObservationFeedback({
    observation: input.observation,
    records: recordsOf(batch),
    businessDate: baseInput.businessDate,
    currentDayIndex: batch.currentDay,
    dayAge: context.modelInput.startAge + batch.currentDay,
    config: {
      ...context.sop.config,
      controlStartDay: batchConfig.controlStartDay,
    },
    decision: canonical.decision,
  });
  const operations = mergeFeedbackOperations(baseOperations, existing?.operations ?? [], result);
  const plan = input.store.ensureDailyOperationPlan({
    ...baseInput,
    operations,
    operationsSha256: digestDailyOperationItems(operations),
    proposedSetting: result?.proposedSetting ?? null,
    feedbackOrigin: result?.feedbackOrigin ?? null,
  });
  return {
    plan,
    feedback: result?.operations.length ? result : null,
    skipped: false,
  };
}
