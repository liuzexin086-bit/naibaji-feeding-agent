import { createHash } from "node:crypto";
import {
  previewDiarrheaAdjustment,
  type CreepGrade,
  type DeviceSetting,
  type DiarrheaAdjustmentResult,
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
  DailyOperationAmendment,
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

/**
 * Returns the newest record that explicitly states a diarrhea grade, including
 * "none". A later "none" therefore closes an earlier diarrhea event instead of
 * leaving the old abnormal record active forever.
 */
function latestDiarrheaStatusRecord(records: JsonObject[]): JsonObject | undefined {
  const sorted = sortedRecords(records);
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const row = sorted[index];
    const grade = String(row.diarrheaGrade ?? "");
    if (DIARRHEA_ORDER.includes(grade as DiarrheaGrade)) return row;
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
  context: { userId: string; batchId: string; observationId?: string },
): string {
  return createHash("sha256")
    .update([
      "nbj-feedback-v2",
      context.userId,
      context.batchId,
      kind,
      businessDate,
      context.observationId ?? "no-observation-id",
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
  userId: string;
  batchId: string;
  observation?: JsonObject;
  records: JsonObject[];
  businessDate: string;
  currentDayIndex: number;
  dayAge: number;
  config: JsonObject;
  decision: FeedingDecision;
  reductionPriority?: string[];
  freeReductionPriority?: string[];
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
      requiresDeviceConfirmation: proposal !== null,
    },
  };
}

function diarrheaProposal(
  kind: FeedbackOriginKind,
  businessDate: string,
  grade: Exclude<DiarrheaGrade, "none">,
  result: DiarrheaAdjustmentResult,
): FeedbackDeviceProposal | null {
  if (!result.proposal) return null;
  const proposal: FeedbackDeviceProposal = {
    kind,
    businessDate,
    mode: result.proposal.mode,
    dayAge: result.proposal.dayAge,
    dailyPowderGrams: result.proposal.dailyPowderGrams,
    singlePowderGrams: result.proposal.singlePowderGrams,
    mealCount: result.proposal.mealCount,
    timedMeals: result.proposal.timedMeals,
    freeWindows: result.proposal.freeWindows,
    precisionGrams: result.proposal.precisionGrams,
    source: result.proposal.source,
    rationale: [
      `按冻结 SOP 目标槽位 ${result.targetSlot ?? "未指定"} 减少一次配奶/自由采食窗口。`,
      "该方案为待确认设备提案；未确认前设备保持不变。",
    ],
    manualDispositionRequired: result.manualDispositionRequired,
    proposalDigest: "",
    resultKind: result.kind === "proposal"
      ? "proposal"
      : result.kind === "preview_only"
        ? "preview_only"
        : "manual_only",
    adjustedProgramTotal: result.adjustedProgramTotal,
    remainingDeliverable: result.remainingDeliverable,
    ...(result.targetSlot ? { targetSlot: result.targetSlot } : {}),
    ...(result.targetAlreadyHappened ? { targetAlreadyHappened: true } : {}),
    ...(result.cumulativeActual >= 0 ? { cumulativePowderGrams: result.cumulativeActual } : {}),
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
  const diarrheaRecord = latestDiarrheaStatusRecord(input.records);
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
    const originId = feedbackOriginId(
      "diarrhea",
      input.businessDate,
      sourceRef,
      {
        userId: input.userId,
        batchId: input.batchId,
        observationId: String(
          sourceRecord.id ??
          sourceRecord.observationId ??
          sourceRecord.idempotencyKey ??
          "unknown",
        ),
      },
    );
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
      reductionPriority: input.reductionPriority,
      freeReductionPriority: input.freeReductionPriority,
    });
    const proposal = diarrheaProposal(
      "diarrhea",
      input.businessDate,
      diarrheaGrade,
      preview,
    );
    const originStatus = preview.kind === "proposal" ? "proposed" : "manual";
    const resultLabel = preview.kind === "proposal"
      ? "生成待确认设备提案"
      : preview.kind === "preview_only"
        ? "仅生成预览，不自动应用"
        : "转人工处置，不生成可执行设备方案";
    const operationTitle = preview.kind === "proposal"
      ? `腹泻处置确认（${gradeLabel}）`
      : preview.kind === "preview_only"
        ? `腹泻人工处置（${gradeLabel}）`
        : `腹泻紧急人工处置（${gradeLabel}）`;
    const operationNote = preview.kind === "proposal"
      ? "按冻结 SOP 目标槽位减少一次配奶/自由采食窗口；未确认前设备保持不变。"
      : "不生成可执行设备方案；需现场负责人人工处置并留痕。";
    const origin: FeedbackOrigin = {
      ...originBase,
      status: originStatus,
      reason: `已记录${gradeLabel}腹泻，${resultLabel}。`,
      proposal,
    };
    const operation = feedbackOperation(
      origin,
      proposal,
      "feedback_diarrhea_confirm",
      operationTitle,
      operationNote,
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
    const originId = feedbackOriginId(
      "creep_control",
      input.businessDate,
      sourceRef,
      {
        userId: input.userId,
        batchId: input.batchId,
        observationId: String(
          creepRecord.id ??
          creepRecord.observationId ??
          creepRecord.idempotencyKey ??
          "unknown",
        ),
      },
    );
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
  amendment?: DailyOperationAmendment;
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
  const result = evaluateObservationFeedback({
    userId: input.userId,
    batchId: batch.batchId,
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
    reductionPriority: context.devicePlan.templates.timed_quantity.reductionPriority,
    freeReductionPriority: context.devicePlan.templates.free_feeding.reductionPriority,
  });
  const records = recordsOf(batch);
  const latestDiarrhea = latestDiarrheaStatusRecord(records);
  if (latestDiarrhea?.diarrheaGrade === "none") {
    input.store.supersedeDailyOperationAmendments({
      userId: input.userId,
      batchId: batch.batchId,
      businessDate: baseInput.businessDate,
      originKind: "diarrhea",
    });
  }
  const operations = mergeFeedbackOperations(baseOperations, existing?.operations ?? [], result);
  if (existing?.status === "confirmed") {
    if (!result?.operations.length) {
      return { plan: existing, feedback: null };
    }
    const confirmation = input.store.getDailyOperationConfirmation(
      input.userId,
      batch.batchId,
      baseInput.businessDate,
    );
    if (!confirmation) {
      throw new Error("NBJ_AMENDMENT_CONFIRMATION_REQUIRED");
    }
    const severity = result.kind === "diarrhea"
      ? (result.feedbackOrigin.sourceObservation.diarrheaGrade ?? null)
      : null;
    if (severity !== null && severity !== "mild" && severity !== "moderate" && severity !== "severe") {
      throw new Error("NBJ_AMENDMENT_SEVERITY_INVALID");
    }
    const priority = severity === "severe"
      ? "critical"
      : severity === "moderate"
        ? "warning"
        : "routine";
    const amendmentResult = input.store.ensureDailyOperationAmendment({
      userId: input.userId,
      batchId: batch.batchId,
      businessDate: baseInput.businessDate,
      basePlanId: existing.id,
      baseConfirmationId: confirmation.id,
      originId: result.feedbackOrigin.id,
      originKind: result.kind,
      severity,
      priority,
      operations: result.operations,
      proposal: result.proposedSetting,
      basedOnBatchRevision: batch.revision,
      idempotencyKey: `daily-operation-amendment:${result.feedbackOrigin.id}`,
    });
    input.store.supersedeDailyOperationAmendments({
      userId: input.userId,
      batchId: batch.batchId,
      businessDate: baseInput.businessDate,
      originKind: result.kind,
      excludeAmendmentId: amendmentResult.amendment.id,
    });
    return {
      plan: existing,
      feedback: result,
      amendment: amendmentResult.amendment,
    };
  }
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
  };
}
