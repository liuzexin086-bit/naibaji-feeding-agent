import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  computeFrozenBatchDecision,
  digestFrozenSopSnapshot,
  loadFrozenBatchDecisionContext,
} from "../decision/batch-decision-service.js";
import {
  defaultFreeFeedingSlots,
  enabledFreeFeedingWindows,
  normalizeFreeFeedingSlots,
} from "../decision/free-feeding-slots.js";
import {
  buildDailyOperationItems,
  digestDailyOperationItems,
} from "../operations/daily-operation-plan.js";
import {
  materializeObservationFeedbackPlan,
  sustainedCreepGrade,
  type FeedbackEngineResult,
} from "../operations/observation-feedback.js";
import { computeProductionPlan, modelStandardWeight } from "../model/production-model.js";
import { LocalStoreError, type SqliteLocalStore } from "../local-db/index.js";
import { createLangChainModel } from "../agent/langgraph/models.js";
import type { FeedingMode } from "../shared/agent-v2-contract.js";
import { normalizeIsoTimestamp } from "../shared/iso-time.js";
import type {
  DevicePlanSnapshot,
  DailyOperationPlan,
  EnsureDailyOperationPlanInput,
  FreeFeedingTemplateSnapshot,
  LocalBatch,
  LocalSopTemplate,
  LocalUser,
  LocalUserRole,
  TimedQuantityTemplateSnapshot,
} from "../shared/local-store-contract.js";
import { ChromaKnowledgeIndex } from "../knowledge/chroma-index.js";
import { DEFAULT_EMBEDDING_MODEL, SOP_PARSER_VERSION, sha256Text } from "../knowledge/sop-knowledge.js";
import { MemoryKnowledgeIndex, publishSop } from "../knowledge/sop-publication.js";
import {
  authenticateLocalUser,
  clearSessionCookie,
  getSessionToken,
  hashSessionToken,
  hashPassword,
  normalizeEmail,
  requireLocalAdmin,
  requireLocalAuth,
  resolveLocalAuth,
  setSessionCookie,
  validatePassword,
} from "./local-auth.js";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_RUNTIME_TIMEOUT,
  loadRuntimeAgentConfig,
  normalizeBaseUrl,
  normalizeProvider,
} from "./runtime-config.js";
import {
  confirmSopEdit,
  draftSopEdit,
  SOP_NL_INSTRUCTION_MAX,
  type SopEditModel,
} from "../sop/natural-language.js";

export const CREEP_VALUES = {
  none: 0,
  low: 10,
  medium: 45,
  high: 80,
  excellent: 130,
} as const;

export const DEFAULT_LOCAL_SOP_VERSION = "2026.08.03-v6-first-day-sop";
export const DEFAULT_DEVICE_PLAN_VERSION = "device-plan@2026-08-04-v1";

const FIRST_DAY_MEAL_TIMES = ["17:00", "20:00", "23:00", "02:00", "05:00", "08:00"];
const TIMED_QUANTITY_MEAL_TIMES = [
  "10:00", "14:00", "16:00", "18:00", "20:00",
  "22:00", "02:00", "04:00", "06:00", "08:00",
];
const DEFAULT_REDUCTION_PRIORITY = [
  "20:00", "16:00", "04:00", "14:00", "06:00",
  "18:00", "02:00", "22:00", "10:00",
];

export const DEFAULT_SOP_CONFIG: Record<string, unknown> = {
  teachingProgramEnabled: true,
  teachingFirstLocal: "17:00",
  teachingIntervalHours: 3,
  teachingEndLocal: "08:00",
  teachingDirectTotalPowderGrams: 0,
  teachingPowderGramsPerTwenty: 35,
  teachingQuantitySource: "sop",
  quantityAuthorityOrder: ["sop_direct", "sop_indirect", "production_model"],
  modelQuantityFallbackEnabled: true,
  devicePowderPrecisionGrams: 1,
  waterClosedUntilDayAge: 12,
  initialMealCount: 10,
  excludedMealTimes: ["00:00", "12:00"],
  productionProgramStartLocal: "09:00",
  freeFeedingTemplate: {
    windows: defaultFreeFeedingSlots(),
    reductionPriority: ["00:00"],
    stageConditions: { earliestBatchDay: 1, requiresOperatorSelection: true },
    exceptionBlockers: ["milk_control", "diarrhea", "refusal", "blockage", "probe_contamination", "curve_cap"],
  },
};

type JsonObject = Record<string, unknown>;

interface LocalApiEnv {
  AGENT_GATEWAY_SECRET?: string;
  LOCAL_ADMIN_EMAIL?: string;
  LOCAL_ADMIN_PASSWORD?: string;
  CHROMA_URL?: string;
  EMBEDDING_BASE_URL?: string;
  EMBEDDING_MODEL?: string;
  CONFIG_ENCRYPTION_KEY?: string;
  AGENT_CONFIG_PATH?: string;
  LLM_PROVIDER?: string;
  LLM_MODEL?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
}

export interface LocalApiDeps {
  /** Test seam; defaults to the same runtime model configuration as the Agent. */
  createSopEditModel?: (env: LocalApiEnv) => Promise<SopEditModel> | SopEditModel;
}

async function defaultSopEditModel(env: LocalApiEnv): Promise<SopEditModel> {
  const runtimeConfig = await loadRuntimeAgentConfig(env);
  const provider = normalizeProvider(runtimeConfig?.provider ?? env.LLM_PROVIDER ?? "openai");
  const apiKey = runtimeConfig?.apiKey ??
    (provider === "openai" ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY);
  if (!apiKey) throw new Error("NBJ_SOP_NL_MODEL_UNAVAILABLE");
  return createLangChainModel({
    provider,
    model: runtimeConfig?.model ?? env.LLM_MODEL ?? "gpt-5.6-luna",
    apiKey,
    baseUrl: normalizeBaseUrl(provider, runtimeConfig?.baseUrl),
    apiMode: runtimeConfig?.apiMode ?? "responses",
    timeout: runtimeConfig?.timeout ?? DEFAULT_RUNTIME_TIMEOUT,
    maxOutputTokens: runtimeConfig?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  }) as SopEditModel;
}

function json(response: ServerResponse, body: unknown, status = 200, extra?: Record<string, string>): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extra,
  });
  response.end(JSON.stringify(body));
}

function errorCode(error: unknown): string {
  if (error instanceof LocalStoreError) {
    const codes: Record<string, string> = {
      LOCAL_STORE_USER_EXISTS: "NBJ_USER_EXISTS",
      LOCAL_STORE_USER_NOT_FOUND: "NBJ_USER_NOT_FOUND",
      LOCAL_STORE_USER_SELF_DELETE: "NBJ_USER_SELF_DELETE",
      LOCAL_STORE_USER_CONFIRM_MISMATCH: "NBJ_USER_CONFIRM_EMAIL_MISMATCH",
      LOCAL_STORE_LAST_ADMIN: "NBJ_LAST_ADMIN",
      LOCAL_STORE_STALE_REVISION: "NBJ_BATCH_STALE",
      LOCAL_STORE_BATCH_TERMINAL: "NBJ_BATCH_TERMINAL",
      LOCAL_STORE_DAILY_OPERATION_CONFIRMED: "NBJ_SOP_MIGRATION_TODAY_CONFIRMED",
      LOCAL_STORE_IDEMPOTENCY_CONFLICT: "NBJ_IDEMPOTENCY_CONFLICT",
      LOCAL_STORE_INVALID_INPUT: "NBJ_LOCAL_API_INVALID_INPUT",
      LOCAL_STORE_INVALID_TIMESTAMP: "NBJ_RECORDED_AT_INVALID",
    };
    return codes[error.code] ?? `NBJ_${error.code.replace(/^LOCAL_STORE_/, "")}`;
  }
  return error instanceof Error && error.message.startsWith("NBJ_")
    ? error.message
    : "NBJ_LOCAL_API_UNAVAILABLE";
}

function sendError(response: ServerResponse, error: unknown): void {
  const code = errorCode(error);
  const status = code === "NBJ_AUTH_REQUIRED" || code === "NBJ_AUTH_INVALID_CREDENTIALS"
    ? 401
    : code === "NBJ_ADMIN_REQUIRED"
      ? 403
      : code === "NBJ_BATCH_STALE" || code === "NBJ_IDEMPOTENCY_CONFLICT" ||
          code === "NBJ_BATCH_MODE_FIRST_DAY_LOCKED" || code === "NBJ_BATCH_TERMINAL" ||
          code === "NBJ_SOP_MIGRATION_TODAY_CONFIRMED" ||
          code === "NBJ_USER_EXISTS" || code === "NBJ_LAST_ADMIN"
        ? 409
        : code === "NBJ_BATCH_NOT_FOUND" || code === "NBJ_USER_NOT_FOUND"
          ? 404
          : code === "NBJ_METHOD_NOT_ALLOWED"
            ? 405
            : 400;
  json(response, { code }, status);
}

function publicUser(user: LocalUser): LocalUser {
  // LocalUser intentionally contains no password hash/salt. Keep this
  // projection explicit so future credential fields cannot leak accidentally.
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
    disabled: user.disabled,
  };
}

function userRole(value: unknown): LocalUserRole {
  if (value === undefined || value === null || value === "") return "operator";
  if (value !== "admin" && value !== "operator") throw new Error("NBJ_AUTH_ROLE_INVALID");
  return value;
}

async function readJson(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (Buffer.concat(chunks).length > 256 * 1024) throw new Error("NBJ_REQUEST_TOO_LARGE");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("NBJ_JSON_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("NBJ_JSON_INVALID");
  return parsed as JsonObject;
}

function text(value: unknown, field: string, max = 320): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`NBJ_${field.toUpperCase()}_INVALID`);
  }
  return value.trim();
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`NBJ_${field.toUpperCase()}_INVALID`);
  }
  return value;
}

function finite(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`NBJ_${field.toUpperCase()}_INVALID`);
  }
  return value;
}

function object(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`NBJ_${field.toUpperCase()}_INVALID`);
  return value as JsonObject;
}

function feedingMode(value: unknown): FeedingMode {
  if (value === "timed_quantity" || value === "free_feeding") return value;
  throw new Error("NBJ_BATCH_MODE_INVALID");
}

function localTime(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`NBJ_${field.toUpperCase()}_INVALID`);
  }
  return value;
}

function localTimeList(value: unknown, fallback: string[], field: string): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) throw new Error(`NBJ_${field.toUpperCase()}_INVALID`);
  const times = value.map((item) => localTime(item, field));
  if (new Set(times).size !== times.length) throw new Error(`NBJ_${field.toUpperCase()}_INVALID`);
  return times;
}

function stringList(value: unknown, fallback: string[], field: string): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new Error(`NBJ_${field.toUpperCase()}_INVALID`);
  }
  const result = value.map((item) => String(item).trim());
  if (new Set(result).size !== result.length) throw new Error(`NBJ_${field.toUpperCase()}_INVALID`);
  return result;
}

function buildDevicePlanSnapshot(sopConfig: JsonObject): DevicePlanSnapshot {
  const timedInput = sopConfig.timedQuantityTemplate && typeof sopConfig.timedQuantityTemplate === "object" &&
      !Array.isArray(sopConfig.timedQuantityTemplate)
    ? sopConfig.timedQuantityTemplate as JsonObject
    : {};
  const mealTimes = localTimeList(timedInput.mealTimes, TIMED_QUANTITY_MEAL_TIMES, "timed_meal_times");
  const excludedMealTimes = localTimeList(
    timedInput.excludedMealTimes ?? sopConfig.excludedMealTimes,
    ["00:00", "12:00"],
    "excluded_meal_times",
  );
  const usableTimes = mealTimes.filter((time) => !excludedMealTimes.includes(time));
  if (usableTimes.length === 0) throw new Error("NBJ_TIMED_MEAL_TIMES_INVALID");
  const configuredPriority = localTimeList(
    timedInput.reductionPriority,
    DEFAULT_REDUCTION_PRIORITY,
    "reduction_priority",
  );
  const reductionPriority = [
    ...configuredPriority.filter((time) => usableTimes.includes(time)),
    ...usableTimes.filter((time) => !configuredPriority.includes(time)).slice(0, -1),
  ];
  const timedQuantity: TimedQuantityTemplateSnapshot = {
    mealTimes: usableTimes,
    excludedMealTimes,
    precisionGrams: finite(
      timedInput.precisionGrams ?? sopConfig.devicePowderPrecisionGrams ?? 1,
      "devicePowderPrecisionGrams",
      0.1,
      100,
    ),
    reductionPriority,
  };

  const freeInput = sopConfig.freeFeedingTemplate && typeof sopConfig.freeFeedingTemplate === "object" &&
      !Array.isArray(sopConfig.freeFeedingTemplate)
    ? sopConfig.freeFeedingTemplate as JsonObject
    : {};
  const slots = normalizeFreeFeedingSlots(freeInput.windows ?? defaultFreeFeedingSlots());
  const freeFeeding: FreeFeedingTemplateSnapshot = {
    slots,
    windows: enabledFreeFeedingWindows(slots),
    ...(freeInput.reductionPriority === undefined
      ? {}
      : { reductionPriority: stringList(freeInput.reductionPriority, [], "free_reduction_priority") }),
    stageConditions: freeInput.stageConditions && typeof freeInput.stageConditions === "object" &&
        !Array.isArray(freeInput.stageConditions)
      ? structuredClone(freeInput.stageConditions as JsonObject)
      : { earliestBatchDay: 1, requiresOperatorSelection: true },
    exceptionBlockers: stringList(
      freeInput.exceptionBlockers,
      ["milk_control", "diarrhea", "refusal", "blockage", "probe_contamination", "curve_cap"],
      "exception_blockers",
    ),
  };
  const version = typeof sopConfig.devicePlanVersion === "string" && sopConfig.devicePlanVersion.trim()
    ? sopConfig.devicePlanVersion.trim()
    : DEFAULT_DEVICE_PLAN_VERSION;
  const immutable = {
    version,
    firstDay: { mode: "timed_quantity" as const, mealTimes: [...FIRST_DAY_MEAL_TIMES] },
    templates: { timed_quantity: timedQuantity, free_feeding: freeFeeding },
  };
  return { ...immutable, sha256: sha256Text(JSON.stringify(immutable)) };
}

/** Keep the long-standing editor field names compatible with the frozen
 * decision contract. The canonical keys are what a batch snapshot uses. */
function normalizePublishedSopConfig(config: JsonObject): JsonObject {
  const normalized: JsonObject = { ...config };
  if (normalized.teachingFirstLocal === undefined && typeof normalized.preferredFirstTeachingLocal === "string") {
    normalized.teachingFirstLocal = normalized.preferredFirstTeachingLocal;
  }
  if (normalized.teachingEndLocal === undefined && typeof normalized.teachingProgramEndLocal === "string") {
    normalized.teachingEndLocal = normalized.teachingProgramEndLocal;
  }
  if (normalized.waterClosedUntilDayAge === undefined && typeof normalized.waterClosedBeforeAgeDays === "number") {
    normalized.waterClosedUntilDayAge = normalized.waterClosedBeforeAgeDays;
  }
  const defaultFree = DEFAULT_SOP_CONFIG.freeFeedingTemplate as JsonObject;
  const configuredFree = normalized.freeFeedingTemplate && typeof normalized.freeFeedingTemplate === "object" &&
      !Array.isArray(normalized.freeFeedingTemplate)
    ? normalized.freeFeedingTemplate as JsonObject
    : {};
  return {
    ...DEFAULT_SOP_CONFIG,
    ...normalized,
    freeFeedingTemplate: { ...defaultFree, ...configuredFree },
  };
}

function frozenSopFromTemplate(template: LocalSopTemplate): JsonObject {
  const base = {
    templateId: template.id,
    version: template.version,
    config: normalizePublishedSopConfig(template.config as JsonObject),
    sourceSha256: template.sourceSha256,
    collectionRevision: template.collectionRevision,
    parserVersion: template.parserVersion,
    embeddingModel: template.embeddingModel,
  };
  return { ...base, snapshotSha256: digestFrozenSopSnapshot(base) };
}

function addDays(dateLocal: string, days: number): string {
  const date = new Date(`${dateLocal}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function configOf(batch: LocalBatch): JsonObject {
  const config = batch.data.config;
  return config && typeof config === "object" && !Array.isArray(config)
    ? config as JsonObject
    : {};
}

function recordsOf(batch: LocalBatch): JsonObject[] {
  return Array.isArray(batch.data.records)
    ? batch.data.records.filter((row): row is JsonObject => Boolean(row) && typeof row === "object" && !Array.isArray(row))
    : [];
}

function modelRecords(records: JsonObject[]): JsonObject[] {
  return records.map((row) => {
    const heads = finite(row.effectiveHeads ?? row.headCount ?? 0, "effectiveHeads", 0);
    const value = finite(row.creepValue ?? CREEP_VALUES[String(row.creepGrade) as keyof typeof CREEP_VALUES] ?? 0, "creepValue");
    const committedTotal = Number(row.planTotalAtCommit ?? row.plannedTotalPowderGrams ?? 0);
    const committedMeals = Number(row.feedTimesAtCommit ?? row.mealCount ?? 0);
    return {
      ...row,
      dayAge: finite(row.dayAge ?? 0, "dayAge"),
      headCount: heads,
      totalCreepG: value * heads,
      ...(committedTotal > 0 && committedMeals > 0 ? {
        planPerPigAtCommit: Number(row.planPerPigAtCommit ?? committedTotal / Math.max(1, heads)),
        planTotalAtCommit: committedTotal,
        feedTimesAtCommit: committedMeals,
      } : {}),
    };
  });
}

function frozenContextOf(batch: LocalBatch) {
  return loadFrozenBatchDecisionContext({
    batchId: batch.batchId,
    revision: batch.revision,
    currentDayIndex: batch.currentDay,
    config: configOf(batch),
    records: modelRecords(recordsOf(batch)),
  });
}

function batchPublic(batch: LocalBatch): JsonObject {
  const config = configOf(batch);
  const context = frozenContextOf(batch);
  const devicePlan = context.devicePlan;
  const initialHeads = Number(config.initialHeads ?? config.headCount ?? 0);
  const effectiveHeads = context.modelInput.headCount;
  return {
    id: batch.batchId,
    name: String(config.name ?? batch.batchId),
    room: String(config.room ?? ""),
    startAge: context.modelInput.startAge,
    endAge: context.modelInput.endAge,
    initialHeads,
    effectiveHeads,
    startWeight: context.modelInput.startWeight,
    startWeightSource: String(config.startWeightSource ?? "model_age_standard"),
    currentDayIndex: batch.currentDay,
    currentDayAge: context.modelInput.startAge + batch.currentDay,
    status: batch.status,
    revision: batch.revision,
    selectedMode: context.selectedMode,
    sopTemplateId: context.sop.templateId,
    sopVersion: context.sop.version,
    sopSourceSha256: context.sop.sourceSha256,
    sopCollectionRevision: context.sop.collectionRevision,
    sopParserVersion: context.sop.parserVersion,
    sopEmbeddingModel: context.sop.embeddingModel,
    devicePlanVersion: devicePlan.version,
    devicePlanSha256: devicePlan.sha256,
    availableModes: ["timed_quantity", "free_feeding"],
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
  };
}

function decisionFor(batch: LocalBatch, dayIndex = batch.currentDay, revision = batch.revision, confirmedDecision?: JsonObject): JsonObject {
  const context = frozenContextOf(batch);
  const canonical = computeFrozenBatchDecision(context, dayIndex, revision);
  const decision = (confirmedDecision ?? canonical.decision) as unknown as JsonObject;
  const setting = object(decision.setting, "decision_setting");
  const exceptionActions = Array.isArray(decision.exceptionActions)
    ? decision.exceptionActions
    : [];
  const dayAge = context.modelInput.startAge + dayIndex;
  return {
    ...decision,
    selectedMode: canonical.selectedMode,
    effectiveMode: setting.mode === "timed_quantity" || setting.mode === "free_feeding"
      ? setting.mode
      : canonical.effectiveMode,
    sopRef: canonical.sopRef,
    devicePlanRef: canonical.devicePlanRef,
    freeFeedingBlockers: canonical.freeFeedingBlockers,
    setting,
    dayIndex,
    dayAge,
    plannedTotalPowderGrams: Number(setting.dailyPowderGrams ?? 0),
    estimatedAverageWeightKg: Number(setting.estimatedAverageWeightKg ?? 0),
    estimatedEndWeightKg: Number(setting.estimatedEndWeightKg ?? 0),
    singlePowderGrams: Number(setting.singlePowderGrams ?? 0),
    mealCount: Number(setting.mealCount ?? 0),
    suggestedDailyPowderGrams: Number(setting.suggestedDailyPowderGrams ?? 0),
    suggestedDailyMealCount: Number(setting.suggestedDailyMealCount ?? 0),
    mealTimes: Array.isArray(setting.timedMeals)
      ? (setting.timedMeals as JsonObject[]).map((meal) => String(meal.timeLocal))
      : [],
    freeWindows: Array.isArray(setting.freeWindows)
      ? (setting.freeWindows as JsonObject[]).map((window) => ({
        startLocal: String(window.startLocal ?? ""),
        endLocal: String(window.endLocal ?? ""),
      }))
      : [],
    exceptionActions,
    modelVersion: String((decision.evidence as JsonObject | undefined)?.modelVersion ?? "feeding-model+V5-Lite"),
    sopVersion: canonical.sopRef.version,
    waterState: dayAge < Number(context.sop.config.waterClosedUntilDayAge) ? "closed" : "open",
    planWindow: { startLocal: "09:00", endLocal: "09:00", endDayOffset: 1 },
  };
}

function confirmedDecisionFor(store: SqliteLocalStore, userId: string, batch: LocalBatch): JsonObject | null {
  const context = frozenContextOf(batch);
  const canonical = computeFrozenBatchDecision(context, batch.currentDay, batch.revision);
  const active = store.getActiveDecision(userId, batch.batchId, canonical.decision.dateLocal);
  return active ? active as unknown as JsonObject : null;
}

function decisionForToday(store: SqliteLocalStore, userId: string, batch: LocalBatch): JsonObject {
  return decisionFor(batch, batch.currentDay, batch.revision, confirmedDecisionFor(store, userId, batch) ?? undefined);
}

function dailyOperationPlanInputFor(userId: string, batch: LocalBatch): EnsureDailyOperationPlanInput {
  const context = frozenContextOf(batch);
  const canonical = computeFrozenBatchDecision(context, batch.currentDay, batch.revision);
  const dateLocal = canonical.decision.dateLocal;
  const operations = buildDailyOperationItems({
    dayIndex: batch.currentDay,
    dayAge: context.modelInput.startAge + batch.currentDay,
    endAge: context.modelInput.endAge,
    sopConfig: context.sop.config,
  });
  return {
    userId,
    batchId: batch.batchId,
    businessDate: dateLocal,
    basedOnBatchRevision: batch.revision,
    sopTemplateId: canonical.sopRef.templateId,
    sopSourceSha256: canonical.sopRef.sourceSha256,
    devicePlanVersion: canonical.devicePlanRef.version,
    devicePlanSha256: canonical.devicePlanRef.sha256,
    selectedMode: canonical.selectedMode,
    effectiveMode: canonical.effectiveMode,
    operations,
    operationsSha256: digestDailyOperationItems(operations),
  };
}

function ensureCurrentDailyOperationPlan(
  store: SqliteLocalStore,
  userId: string,
  batch: LocalBatch,
  requestedDateLocal?: string | null,
) {
  const input = dailyOperationPlanInputFor(userId, batch);
  if (requestedDateLocal !== undefined && requestedDateLocal !== null && requestedDateLocal !== input.businessDate) {
    throw new Error("NBJ_DAILY_OPERATION_DATE_INVALID");
  }
  const existing = store.getDailyOperationPlan(userId, batch.batchId, input.businessDate);
  if (existing?.status === "confirmed") return existing;
  return materializeFeedbackPlan(store, userId, batch, {}).plan;
}

function materializeFeedbackPlan(
  store: SqliteLocalStore,
  userId: string,
  batch: LocalBatch,
  observation: JsonObject,
) {
  return materializeObservationFeedbackPlan({
    store,
    userId,
    batch,
    observation,
  });
}

function batchWithMigratedSop(batch: LocalBatch, template: LocalSopTemplate): LocalBatch {
  const frozenSop = frozenSopFromTemplate(template);
  const config = configOf(batch);
  const nextData: JsonObject = {
    ...batch.data,
    config: {
      ...config,
      sopTemplate: frozenSop,
      devicePlanSnapshot: buildDevicePlanSnapshot(object(frozenSop.config, "frozen_sop_config")),
    },
  };
  return { ...batch, revision: batch.revision + 1, data: nextData };
}

function freeFeedingSummary(plan: DevicePlanSnapshot): JsonObject {
  const slots = plan.templates.free_feeding.slots
    .filter((slot) => slot.enabled)
    .map((slot) => ({ slot: slot.slot, label: slot.label ?? `时段 ${slot.slot}`, startLocal: slot.startLocal, endLocal: slot.endLocal }));
  return { enabledSlotCount: slots.length, slots };
}

function dailyPlanSummary(plan: DailyOperationPlan | null): JsonObject | null {
  if (!plan) return null;
  return {
    id: plan.id,
    businessDate: plan.businessDate,
    status: plan.status,
    basedOnBatchRevision: plan.basedOnBatchRevision,
    sopTemplateId: plan.sopTemplateId,
    sopSourceSha256: plan.sopSourceSha256,
    devicePlanSha256: plan.devicePlanSha256,
    operationsSha256: plan.operationsSha256,
    operationCount: plan.operations.length,
  };
}

function feedbackPublic(result: FeedbackEngineResult): JsonObject {
  return {
    kind: result.kind,
    reason: result.reason,
    operations: result.operations,
    feedbackOrigin: result.feedbackOrigin,
    proposedSetting: result.proposedSetting,
  };
}

function sopMigrationPreview(
  store: SqliteLocalStore,
  userId: string,
  batch: LocalBatch,
  target: LocalSopTemplate,
): JsonObject {
  const current = frozenContextOf(batch);
  const nextBatch = batchWithMigratedSop(batch, target);
  const next = frozenContextOf(nextBatch);
  const currentPlanInput = dailyOperationPlanInputFor(userId, batch);
  const currentPlan = store.getDailyOperationPlan(userId, batch.batchId, currentPlanInput.businessDate);
  const nextPlanInput = dailyOperationPlanInputFor(userId, nextBatch);
  const blockedByConfirmedPlan = currentPlan?.status === "confirmed";
  return {
    batch: batchPublic(batch),
    currentSop: {
      templateId: current.sop.templateId,
      version: current.sop.version,
      sourceSha256: current.sop.sourceSha256,
      devicePlanVersion: current.devicePlan.version,
      devicePlanSha256: current.devicePlan.sha256,
    },
    targetSop: {
      templateId: next.sop.templateId,
      version: next.sop.version,
      sourceSha256: next.sop.sourceSha256,
      devicePlanVersion: next.devicePlan.version,
      devicePlanSha256: next.devicePlan.sha256,
    },
    ruleChanges: {
      teachingPowderGramsPerTwenty: {
        from: current.sop.config.teachingPowderGramsPerTwenty,
        to: next.sop.config.teachingPowderGramsPerTwenty,
      },
      teachingIntervalHours: {
        from: current.sop.config.teachingIntervalHours,
        to: next.sop.config.teachingIntervalHours,
      },
      waterClosedUntilDayAge: {
        from: current.sop.config.waterClosedUntilDayAge,
        to: next.sop.config.waterClosedUntilDayAge,
      },
      freeFeeding: {
        from: freeFeedingSummary(current.devicePlan),
        to: freeFeedingSummary(next.devicePlan),
      },
    },
    todayOperation: {
      current: dailyPlanSummary(currentPlan),
      proposed: {
        businessDate: nextPlanInput.businessDate,
        basedOnBatchRevision: nextPlanInput.basedOnBatchRevision,
        sopTemplateId: nextPlanInput.sopTemplateId,
        devicePlanSha256: nextPlanInput.devicePlanSha256,
        operationsSha256: nextPlanInput.operationsSha256,
        operationCount: nextPlanInput.operations.length,
      },
      effect: blockedByConfirmedPlan
        ? "blocked_confirmed"
        : currentPlan
          ? "refresh_pending"
          : "generate_after_migration",
    },
    confirmationPhrase: "迁移 SOP",
    canMigrate: batch.status === "active" && current.sop.templateId !== next.sop.templateId && !blockedByConfirmedPlan,
  };
}

function recordPublic(
  row: JsonObject,
  fallback: { dayIndex: number; dayAge: number; heads: number; revision: number },
  modelWeight?: { weightStart?: number; weightEnd?: number },
): JsonObject {
  const grade = String(row.creepGrade ?? "none");
  return {
    dayIndex: Number(row.dayIndex ?? fallback.dayIndex),
    dayAge: Number(row.dayAge ?? fallback.dayAge),
    effectiveHeads: Number(row.effectiveHeads ?? row.headCount ?? fallback.heads),
    deviceMode: String(row.deviceMode ?? "timed_quantity"),
    singlePowderGrams: Number(row.singlePowderGrams ?? 0),
    mealCount: Number(row.mealCount ?? 0),
    mealTimes: Array.isArray(row.mealTimes) ? row.mealTimes : [],
    plannedTotalPowderGrams: Number(row.plannedTotalPowderGrams ?? row.planTotalAtCommit ?? 0),
    estimatedAverageWeightKg: Number(row.estimatedAverageWeightKg ?? modelWeight?.weightStart ?? 0) || null,
    estimatedEndWeightKg: Number(row.estimatedEndWeightKg ?? modelWeight?.weightEnd ?? 0) || null,
    actualPowderGrams: row.actualPowderGrams == null ? null : Number(row.actualPowderGrams),
    creepGrade: grade,
    creepValue: Number(row.creepValue ?? CREEP_VALUES[grade as keyof typeof CREEP_VALUES] ?? 0),
    diarrheaGrade: row.diarrheaGrade == null ? null : String(row.diarrheaGrade),
    waterState: String(row.waterState ?? "closed"),
    exceptionActions: Array.isArray(row.exceptionActions) ? row.exceptionActions : [],
    modelVersion: String(row.modelVersion ?? "feeding-model+V5-Lite"),
    sopVersion: String(row.sopVersion ?? "local-sop-default-v1"),
    revision: Number(row.revision ?? fallback.revision),
    recordedAt: row.recordedAt ?? null,
  };
}

function allRecords(batch: LocalBatch): JsonObject[] {
  const context = frozenContextOf(batch);
  const heads = context.modelInput.headCount;
  const model = computeProductionPlan(context.modelInput);
  const weights = new Map((model.control.days ?? []).map((day) => [Number(day.dayAge), day]));
  return recordsOf(batch).map((row) => recordPublic(row, {
    dayIndex: Number(row.dayIndex ?? 0),
    dayAge: Number(row.dayAge ?? context.modelInput.startAge),
    heads,
    revision: batch.revision,
  }, weights.get(Number(row.dayAge))));
}

/**
 * Batch responses carry the complete history for that batch's Agent session.
 * Keeping it nested under agentSession preserves the existing response shape
 * while preventing the frontend from reusing a previous batch's transcript.
 */
function agentSessionPublic(
  store: SqliteLocalStore,
  userId: string,
  batchId: string,
): JsonObject {
  const session = store.listSessions(userId, batchId)[0] ?? store.createSession({
    id: randomUUID(),
    userId,
    batchId,
    status: "active",
  });
  return {
    ...session,
    messages: store.listMessages(userId, batchId, session.id, { limit: 1_000 }),
  };
}

/**
 * The agent is only exposed through Nginx. Preserve the Secure flag when an
 * HTTPS reverse proxy tells us the original scheme, while keeping the local
 * loopback Compose endpoint usable over plain HTTP.
 */
function requestUsesHttps(request: IncomingMessage): boolean {
  const forwarded = request.headers["x-forwarded-proto"];
  const values = Array.isArray(forwarded) ? forwarded : [forwarded ?? ""];
  return values.some((value) => value.split(",").some((part) => part.trim().toLowerCase() === "https"));
}

function parseObservation(body: JsonObject, today: JsonObject, batch: LocalBatch): JsonObject {
  const source = object(body.observation ?? {}, "observation");
  const config = configOf(batch);
  const heads = integer(source.effectiveHeads ?? source.headCount ?? config.effectiveHeads ?? config.headCount ?? 1, "effectiveHeads", 0, 100_000);
  const grade = String(source.creepGrade ?? "none");
  if (!(grade in CREEP_VALUES)) throw new Error("NBJ_CREEP_GRADE_INVALID");
  const diarrhea = source.diarrheaGrade == null || source.diarrheaGrade === ""
    ? undefined
    : String(source.diarrheaGrade);
  if (diarrhea !== undefined && !["none", "mild", "moderate", "severe"].includes(diarrhea)) {
    throw new Error("NBJ_DIARRHEA_GRADE_INVALID");
  }
  let recordedAt = new Date().toISOString();
  if (source.recordedAt !== undefined && source.recordedAt !== null) {
    const normalized = typeof source.recordedAt === "string"
      ? normalizeIsoTimestamp(source.recordedAt)
      : null;
    if (!normalized) throw new Error("NBJ_RECORDED_AT_INVALID");
    recordedAt = normalized;
  }
  const record = {
    ...source,
    dayIndex: Number(today.dayIndex),
    dayAge: Number(today.dayAge),
    effectiveHeads: heads,
    headCount: heads,
    deviceMode: String(source.deviceMode ?? object(today.setting, "today_setting").mode ?? "timed_quantity"),
    singlePowderGrams: Number(source.singlePowderGrams ?? today.singlePowderGrams ?? 0),
    mealCount: Number(source.mealCount ?? today.mealCount ?? 0),
    mealTimes: Array.isArray(source.mealTimes) ? source.mealTimes : today.mealTimes,
    plannedTotalPowderGrams: Number(source.plannedTotalPowderGrams ?? today.plannedTotalPowderGrams ?? 0),
    estimatedAverageWeightKg: Number(today.estimatedAverageWeightKg ?? 0),
    estimatedEndWeightKg: Number(today.estimatedEndWeightKg ?? 0),
    actualPowderGrams: source.actualPowderGrams == null ? null : finite(source.actualPowderGrams, "actualPowderGrams", 0),
    creepGrade: grade,
    creepValue: CREEP_VALUES[grade as keyof typeof CREEP_VALUES],
    ...(diarrhea === undefined ? {} : { diarrheaGrade: diarrhea }),
    waterState: String(source.waterState ?? today.waterState ?? "closed"),
    exceptionActions: Array.isArray(source.exceptionActions) ? source.exceptionActions : today.exceptionActions,
    modelVersion: String(today.modelVersion ?? "feeding-model+V5-Lite"),
    sopVersion: String(today.sopVersion ?? "local-sop-default-v1"),
    recordedAt,
  };
  return record;
}

export async function handleLocalApi(
  request: IncomingMessage,
  response: ServerResponse,
  store: SqliteLocalStore,
  env: LocalApiEnv = {},
  deps: LocalApiDeps = {},
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://container");
  if (!url.pathname.startsWith("/api/")) return false;
  // Agent streaming and provider configuration retain dedicated handlers in
  // server.ts so SSE headers and provider validation stay centralized.
  if (
    url.pathname === "/api/feeding-agent/chat" ||
    url.pathname === "/api/admin/feeding-agent/config"
  ) return false;
  try {
    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      const body = await readJson(request);
      const result = authenticateLocalUser(store, body.email, body.password);
      setSessionCookie(response, result.token, undefined, requestUsesHttps(request));
      json(response, { user: result.user });
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/auth/session") {
      const auth = resolveLocalAuth(request, store);
      if (!auth) throw new Error("NBJ_AUTH_REQUIRED");
      json(response, { user: auth.user });
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
      const auth = resolveLocalAuth(request, store);
      const token = getSessionToken(request);
      if (auth && token) store.revokeAuthSession(hashSessionToken(token));
      clearSessionCookie(response, requestUsesHttps(request));
      json(response, { ok: true });
      return true;
    }
    const auth = requireLocalAuth(request, store);

    if (url.pathname === "/api/admin/users") {
      const admin = requireLocalAdmin(request, store);
      if (request.method === "GET") {
        json(response, { users: store.listUsers().map(publicUser) });
        return true;
      }
      if (request.method === "POST") {
        const body = await readJson(request);
        const email = normalizeEmail(body.email);
        const password = validatePassword(body.password);
        const role = userRole(body.role);
        const { hash, salt } = hashPassword(password);
        const user = store.createUser({
          email,
          passwordHash: hash,
          passwordSalt: salt,
          role,
        });
        // Keep the actor reference in the branch so authorization remains
        // explicit even though the store performs the insert atomically.
        void admin;
        json(response, { user: publicUser(user) }, 201);
        return true;
      }
      throw new Error("NBJ_METHOD_NOT_ALLOWED");
    }

    const userDeleteMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (userDeleteMatch) {
      const admin = requireLocalAdmin(request, store);
      if (request.method !== "DELETE") throw new Error("NBJ_METHOD_NOT_ALLOWED");
      const body = await readJson(request);
      const confirmEmail = body.confirmEmail;
      if (typeof confirmEmail !== "string" || !confirmEmail) {
        throw new Error("NBJ_USER_CONFIRM_EMAIL_REQUIRED");
      }
      const userId = decodeURIComponent(userDeleteMatch[1]);
      store.deleteUser({ userId, actorUserId: admin.user.id, confirmEmail });
      json(response, { ok: true, userId });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/batches") {
      const batches = store.listBatches(auth.user.id).map(batchPublic);
      json(response, { batches, currentBatchId: batches[0]?.id ?? null });
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/batches") {
      const body = await readJson(request);
      const name = text(body.name, "batch_name");
      const room = typeof body.room === "string" ? body.room.trim().slice(0, 160) : "";
      // Keep the public boundary aligned with the frozen feeding model. The
      // model supports a 1–30 day window and requires a genuine end day after
      // the starting day; accepting a wider range only fails later as a
      // generic API error while creating the batch.
      const startAge = integer(body.startAge, "start_age", 1, 29);
      const endAge = integer(body.endAge, "end_age", startAge + 1, 30);
      const headCount = integer(body.headCount, "head_count", 1, 100_000);
      const hasStartWeight = body.startWeight !== undefined && body.startWeight !== null && body.startWeight !== "";
      const startWeight = hasStartWeight
        ? finite(body.startWeight, "start_weight", 0.1, 50)
        : modelStandardWeight(startAge);
      const id = randomUUID();
      const nowDate = new Date().toISOString().slice(0, 10);
      const latestSop = store.getPublishedSopTemplate();
      const builtinDigest = sha256Text(JSON.stringify(DEFAULT_SOP_CONFIG));
      const frozenSopBase = latestSop
        ? {
            templateId: latestSop.id,
            version: latestSop.version,
            config: normalizePublishedSopConfig(latestSop.config as JsonObject),
            sourceSha256: latestSop.sourceSha256,
            collectionRevision: latestSop.collectionRevision,
            parserVersion: latestSop.parserVersion,
            embeddingModel: latestSop.embeddingModel,
          }
        : { templateId: "builtin-default", version: DEFAULT_LOCAL_SOP_VERSION,
            config: { ...DEFAULT_SOP_CONFIG }, sourceSha256: builtinDigest,
            collectionRevision: `builtin:${builtinDigest}`, parserVersion: SOP_PARSER_VERSION,
            embeddingModel: env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL };
      const frozenSop = {
        ...frozenSopBase,
        snapshotSha256: digestFrozenSopSnapshot(frozenSopBase),
      };
      const devicePlanSnapshot = buildDevicePlanSnapshot(frozenSop.config);
      const batch = store.createBatch({
        userId: auth.user.id,
        batchId: id,
        data: {
          config: {
            name, room, startAge, endAge,
            initialHeads: headCount, effectiveHeads: headCount,
            headCount, startWeight,
            startWeightSource: hasStartWeight ? "operator" : "model_age_standard",
            planStartDate: nowDate,
            controlStartDay: -1,
            sopTemplate: frozenSop,
            selectedMode: "timed_quantity",
            devicePlanSnapshot,
          },
          records: [],
          current_day_index: 0,
          control_start_day: -1,
        },
      });
      const session = agentSessionPublic(store, auth.user.id, id);
      const today = decisionFor(batch);
      json(response, { batch: batchPublic(batch), today, records: [], agentSession: session }, 201);
      return true;
    }

    const batchMatch = url.pathname.match(/^\/api\/batches\/([^/]+)(?:\/(.*))?$/);
    if (batchMatch) {
      const batchId = decodeURIComponent(batchMatch[1]);
      const suffix = batchMatch[2] ?? "";
      let batch = store.getBatch(auth.user.id, batchId);
      if (!batch) throw new Error("NBJ_BATCH_NOT_FOUND");
      if (request.method === "GET" && !suffix) {
        const session = agentSessionPublic(store, auth.user.id, batchId);
        json(response, {
          batch: batchPublic(batch),
          today: decisionForToday(store, auth.user.id, batch),
          records: allRecords(batch),
          agentSession: session,
          messages: session.messages,
        });
        return true;
      }
      if (request.method === "GET" && suffix === "agent/session") {
        const session = agentSessionPublic(store, auth.user.id, batchId);
        json(response, { session, messages: session.messages });
        return true;
      }
      if (suffix === "today-operations" && request.method === "GET") {
        const plan = ensureCurrentDailyOperationPlan(
          store,
          auth.user.id,
          batch,
          url.searchParams.get("dateLocal"),
        );
        json(response, {
          plan,
          confirmation: store.getDailyOperationConfirmation(auth.user.id, batchId, plan.businessDate),
          amendments: store.getDailyOperationAmendments(auth.user.id, batchId, plan.businessDate),
        });
        return true;
      }
      if (suffix === "today-operations/confirm") {
        if (request.method === "POST") {
          const body = await readJson(request);
          const plan = ensureCurrentDailyOperationPlan(store, auth.user.id, batch);
          const planId = text(body.planId, "daily_operation_plan_id", 128);
          const operationsSha256 = text(body.operationsSha256, "operations_sha256", 64).toUpperCase();
          if (planId !== plan.id || operationsSha256 !== plan.operationsSha256) {
            throw new Error("NBJ_DAILY_OPERATION_PLAN_STALE");
          }
          const committed = store.confirmDailyOperationPlan({
            userId: auth.user.id,
            batchId,
            businessDate: plan.businessDate,
            planId,
            operationsSha256,
            confirmedBy: auth.user.id,
            idempotencyKey: text(body.idempotencyKey, "idempotency_key", 160),
            ...(body.note === undefined ? {} : { note: text(body.note, "daily_operation_note", 500) }),
          });
          json(response, {
            plan: store.getDailyOperationPlan(auth.user.id, batchId, plan.businessDate),
            confirmation: committed.confirmation,
            replayed: committed.replayed,
            decision: store.getActiveDecision(auth.user.id, batchId, plan.businessDate),
          });
          return true;
        }
        throw new Error("NBJ_METHOD_NOT_ALLOWED");
      }
      const amendmentDecisionMatch = suffix.match(
        /^amendments\/([^/]+)\/(confirm|reject|apply)$/,
      );
      if (amendmentDecisionMatch && request.method === "POST") {
        const amendmentId = decodeURIComponent(amendmentDecisionMatch[1]);
        const action = amendmentDecisionMatch[2] as "confirm" | "reject" | "apply";
        const body = await readJson(request);
        const amendment = store.getDailyOperationAmendment(
          auth.user.id,
          batchId,
          amendmentId,
        );
        if (!amendment) throw new Error("NBJ_AMENDMENT_NOT_FOUND");
        const committed = store.decideDailyOperationAmendment({
          userId: auth.user.id,
          batchId,
          amendmentId,
          action,
          decidedBy: auth.user.id,
          expectedRevision: integer(
            body.expectedRevision,
            "expected_revision",
            0,
            Number.MAX_SAFE_INTEGER,
          ),
          expectedAmendmentSha256: text(
            body.expectedAmendmentSha256,
            "expected_amendment_sha256",
            64,
          ).toUpperCase(),
          idempotencyKey: text(body.idempotencyKey, "idempotency_key", 160),
        });
        json(response, {
          amendment: committed.amendment,
          replayed: committed.replayed,
          amendments: store.getDailyOperationAmendments(
            auth.user.id,
            batchId,
            amendment.businessDate,
          ),
        });
        return true;
      }
      if (suffix === "mode") {
        if (request.method !== "POST") throw new Error("NBJ_METHOD_NOT_ALLOWED");
        if (batch.currentDay === 0) throw new Error("NBJ_BATCH_MODE_FIRST_DAY_LOCKED");
        const body = await readJson(request);
        const mode = feedingMode(body.mode);
        const expectedRevision = integer(body.expectedRevision, "expected_revision", 0, Number.MAX_SAFE_INTEGER);
        const key = text(body.idempotencyKey, "idempotency_key", 160);
        const config = configOf(batch);
        const context = frozenContextOf(batch);
        const devicePlan = context.devicePlan;
        const fromMode = context.selectedMode;
        const nextData: JsonObject = {
          ...batch.data,
          config: { ...config, selectedMode: mode },
        };
        const nextBatch = {
          ...batch,
          revision: batch.revision + 1,
          data: nextData,
        } as LocalBatch;
        const result = {
          batch: batchPublic(nextBatch),
          today: decisionForToday(store, auth.user.id, nextBatch),
          records: allRecords(nextBatch),
        };
        const committed = store.commitModeSwitch({
          userId: auth.user.id,
          batchId,
          expectedRevision,
          idempotencyKey: key,
          fromMode,
          toMode: mode,
          devicePlanVersion: devicePlan.version,
          devicePlanSha256: devicePlan.sha256,
          nextData,
          result,
        });
        json(response, committed.result);
        return true;
      }
      if (request.method === "POST" && (suffix === "advance" || suffix === "records")) {
        const body = await readJson(request);
        const expectedRevision = integer(body.expectedRevision, "expected_revision", 0, Number.MAX_SAFE_INTEGER);
        const key = text(body.idempotencyKey, "idempotency_key", 160);
        const today = decisionFor(batch);
        const observation = parseObservation(body, today, batch);
        const existingRecords = recordsOf(batch);
        const nextRecords = [...existingRecords.filter((row) => Number(row.dayIndex) !== Number(observation.dayIndex)), observation];
        let controlStartDay = Number(configOf(batch).controlStartDay ?? -1);
        if (controlStartDay < 0 && sustainedCreepGrade(nextRecords) !== "none") {
          controlStartDay = batch.currentDay + 1;
        }
        const nextData: JsonObject = {
          ...batch.data,
          config: { ...configOf(batch), controlStartDay },
          records: nextRecords,
          current_day_index: suffix === "advance" ? batch.currentDay + 1 : batch.currentDay,
          control_start_day: controlStartDay,
        };
        if (suffix === "advance") {
          const nextBatch = {
            ...batch,
            currentDay: batch.currentDay + 1,
            revision: batch.revision + 1,
            data: nextData,
          } as LocalBatch;
          const nextToday = decisionForToday(store, auth.user.id, nextBatch);
          const session = agentSessionPublic(store, auth.user.id, batchId);
          const result = {
            batch: batchPublic(nextBatch),
            today: nextToday,
            records: allRecords(nextBatch),
            committedRecord: recordPublic(observation, { dayIndex: Number(observation.dayIndex), dayAge: Number(observation.dayAge), heads: Number(observation.effectiveHeads), revision: batch.revision }),
            agentSession: session,
            messages: session.messages,
            feedback: null,
            amendments: [],
          };
          const committed = store.commitAdvance({
            userId: auth.user.id,
            batchId,
            expectedRevision,
            idempotencyKey: key,
            dateLocal: String(observation.dateLocal ?? today.dateLocal ?? addDays(String(configOf(batch).planStartDate ?? batch.createdAt.slice(0, 10)), batch.currentDay)),
            observedAt: String(observation.recordedAt),
            observation,
            nextDayIndex: batch.currentDay + 1,
            nextData,
            result,
            feedbackBatch: nextBatch,
          });
          json(response, committed.result);
          return true;
        }
        const nextBatch = { ...batch, revision: batch.revision + 1, data: nextData } as LocalBatch;
        const result = {
          batch: batchPublic(nextBatch),
          today: decisionForToday(store, auth.user.id, nextBatch),
          records: allRecords(nextBatch),
          committedRecord: recordPublic(observation, { dayIndex: Number(observation.dayIndex), dayAge: Number(observation.dayAge), heads: Number(observation.effectiveHeads), revision: batch.revision }),
          feedback: null,
          amendments: [],
        };
        const committed = store.commitRecord({ userId: auth.user.id, batchId, expectedRevision, idempotencyKey: key, dateLocal: String(observation.dateLocal ?? today.dateLocal ?? addDays(String(configOf(batch).planStartDate ?? batch.createdAt.slice(0, 10)), batch.currentDay)), observedAt: String(observation.recordedAt), observation, nextData, result, feedbackBatch: nextBatch });
        json(response, committed.result);
        return true;
      }
    }

    if (request.method === "GET" && url.pathname === "/api/admin/batches") {
      requireLocalAdmin(request, store);
      const batches = store.listAllBatches().map((batch) => {
        const owner = store.getUserById(batch.userId);
        return {
          ...batchPublic(batch),
          userId: batch.userId,
          userEmail: owner?.email ?? "",
        };
      });
      json(response, { batches });
      return true;
    }

    const sopMigrationMatch = url.pathname.match(/^\/api\/admin\/batches\/([^/]+)\/sop-migration(?:\/preview)?$/);
    if (sopMigrationMatch) {
      const admin = requireLocalAdmin(request, store);
      const batchId = decodeURIComponent(sopMigrationMatch[1]);
      const preview = url.pathname.endsWith("/preview");
      if (preview && request.method !== "GET") throw new Error("NBJ_METHOD_NOT_ALLOWED");
      if (!preview && request.method !== "POST") throw new Error("NBJ_METHOD_NOT_ALLOWED");
      const body = preview ? null : await readJson(request);
      const userId = text(preview ? url.searchParams.get("userId") : body?.userId, "batch_owner_id", 128);
      const templateId = text(preview ? url.searchParams.get("templateId") : body?.templateId, "sop_template_id", 128);
      const batch = store.getBatch(userId, batchId);
      if (!batch) throw new Error("NBJ_BATCH_NOT_FOUND");
      const target = store.getSopTemplate(templateId);
      if (!target) throw new Error("NBJ_SOP_TEMPLATE_NOT_FOUND");
      if (target.status !== "published") throw new Error("NBJ_SOP_TEMPLATE_NOT_PUBLISHED");
      const migrationPreview = sopMigrationPreview(store, userId, batch, target);
      if (preview) {
        json(response, migrationPreview);
        return true;
      }
      if (body?.confirmationPhrase !== "迁移 SOP") throw new Error("NBJ_SOP_MIGRATION_CONFIRMATION_REQUIRED");
      const expectedRevision = integer(body?.expectedRevision, "expected_revision", 0, Number.MAX_SAFE_INTEGER);
      // A retry is allowed to reach the store's idempotency lookup even after
      // the first successful request has already changed the frozen snapshot.
      const mayBeReplay = expectedRevision < batch.revision;
      if (migrationPreview.canMigrate !== true && !mayBeReplay) {
        const effect = object(migrationPreview.todayOperation, "sop_migration_today_operation").effect;
        if (effect === "blocked_confirmed") throw new Error("NBJ_SOP_MIGRATION_TODAY_CONFIRMED");
        throw new Error("NBJ_SOP_MIGRATION_NOT_AVAILABLE");
      }
      const nextBatch = batchWithMigratedSop(batch, target);
      const nextPlanInput = dailyOperationPlanInputFor(userId, nextBatch);
      const previousPlan = store.getDailyOperationPlan(userId, batchId, nextPlanInput.businessDate);
      const result = {
        batch: batchPublic(nextBatch),
        today: decisionForToday(store, auth.user.id, nextBatch),
        records: allRecords(nextBatch),
      };
      const committed = store.commitSopMigration({
        userId,
        batchId,
        expectedRevision,
        idempotencyKey: text(body?.idempotencyKey, "idempotency_key", 160),
        actorUserId: admin.user.id,
        targetTemplateId: target.id,
        nextData: nextBatch.data,
        result,
        replacementDailyOperationPlan: previousPlan?.status === "pending" ? nextPlanInput : undefined,
        auditDetails: {
          previousSop: object(migrationPreview.currentSop, "sop_migration_current_sop"),
          targetSop: object(migrationPreview.targetSop, "sop_migration_target_sop"),
          ruleChanges: object(migrationPreview.ruleChanges, "sop_migration_rule_changes"),
          previousDailyOperationPlan: dailyPlanSummary(previousPlan),
          proposedDailyOperationPlan: object(migrationPreview.todayOperation, "sop_migration_today_operation").proposed,
          confirmationPhrase: "迁移 SOP",
        },
      });
      json(response, {
        ...committed.result,
        replayed: committed.replayed,
        todayOperation: store.getDailyOperationPlan(userId, batchId, nextPlanInput.businessDate),
      });
      return true;
    }

    if (url.pathname === "/api/admin/sop/templates") {
      if (request.method === "GET") {
        requireLocalAdmin(request, store);
        json(response, { templates: store.listSopTemplates() });
        return true;
      }
      if (request.method === "POST") {
        const admin = requireLocalAdmin(request, store);
        const body = await readJson(request);
        const sourceId = body.copyFromId == null ? null : text(body.copyFromId, "copy_from_id", 128);
        const source = sourceId ? store.listSopTemplates().find((row) => row.id === sourceId) : null;
        if (sourceId && !source) throw new Error("NBJ_SOP_TEMPLATE_NOT_FOUND");
        const config = normalizePublishedSopConfig({
          ...(source?.config ?? {}),
          ...object(body.config ?? {}, "config"),
        });
        const name = text(body.name, "name", 200);
        const sourceMarkdown = typeof body.sourceMarkdown === "string" && body.sourceMarkdown.trim()
          ? body.sourceMarkdown
          : `# ${name}\n\n${JSON.stringify(config, null, 2)}`;
        const index = env.CHROMA_URL && env.EMBEDDING_BASE_URL
          ? new ChromaKnowledgeIndex({ chromaUrl: env.CHROMA_URL, embeddingBaseUrl: env.EMBEDDING_BASE_URL })
          : new MemoryKnowledgeIndex();
        const template = await publishSop({ store, index, version: text(body.version, "version", 160),
          name, config, sourceMarkdown, createdBy: admin.user.id, sourceTemplateId: sourceId,
          embeddingModel: env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL });
        json(response, { template }, 201);
        return true;
      }
      throw new Error("NBJ_METHOD_NOT_ALLOWED");
    }
    const sopNlBase = "/api/admin/sop/natural-language/tasks";
    if (url.pathname === sopNlBase || url.pathname.startsWith(`${sopNlBase}/`)) {
      const admin = requireLocalAdmin(request, store);
      if (request.method === "POST" && url.pathname === sopNlBase) {
        const body = await readJson(request);
        const instruction = text(body.instruction, "instruction", SOP_NL_INSTRUCTION_MAX);
        const templateId = body.templateId == null || body.templateId === ""
          ? null
          : text(body.templateId, "template_id", 128);
        if (templateId && !store.getSopTemplate(templateId)) {
          throw new Error("NBJ_SOP_NL_TEMPLATE_NOT_FOUND");
        }
        const model = await (deps.createSopEditModel ?? defaultSopEditModel)(env);
        const task = store.createSopEditTask({
          templateId,
          instruction,
          createdBy: admin.user.id,
        });
        // draftSopEdit records draft_failed itself; this catch only prevents
        // an unexpected rejection from becoming an unhandled async error.
        void draftSopEdit({ store, model, taskId: task.id }).catch(() => undefined);
        json(response, { task }, 202);
        return true;
      }
      if (request.method === "GET" && url.pathname === sopNlBase) {
        json(response, { tasks: store.listSopEditTasks(100) });
        return true;
      }
      const rejectMatch = url.pathname.match(
        /^\/api\/admin\/sop\/natural-language\/tasks\/([^/]+)\/reject$/,
      );
      if (request.method === "POST" && rejectMatch) {
        json(response, {
          task: store.rejectSopEditTask({
            taskId: rejectMatch[1],
            rejectedBy: admin.user.id,
          }),
        });
        return true;
      }
      const confirmMatch = url.pathname.match(
        /^\/api\/admin\/sop\/natural-language\/tasks\/([^/]+)\/confirm$/,
      );
      if (request.method === "POST" && confirmMatch) {
        const body = await readJson(request);
        const index = env.CHROMA_URL && env.EMBEDDING_BASE_URL
          ? new ChromaKnowledgeIndex({
              chromaUrl: env.CHROMA_URL,
              embeddingBaseUrl: env.EMBEDDING_BASE_URL,
            })
          : new MemoryKnowledgeIndex();
        const result = await confirmSopEdit({
          store,
          index,
          taskId: confirmMatch[1],
          version: text(body.version, "version", 160),
          name: text(body.name, "name", 200),
          confirmationPhrase: typeof body.confirmationPhrase === "string"
            ? body.confirmationPhrase
            : "",
          confirmedBy: admin.user.id,
        });
        json(response, { task: result.task, template: result.template });
        return true;
      }
      const detailMatch = url.pathname.match(
        /^\/api\/admin\/sop\/natural-language\/tasks\/([^/]+)$/,
      );
      if (request.method === "GET" && detailMatch) {
        const task = store.getSopEditTask(detailMatch[1]);
        if (!task) throw new Error("NBJ_SOP_NL_TASK_NOT_FOUND");
        json(response, { task });
        return true;
      }
      throw new Error("NBJ_METHOD_NOT_ALLOWED");
    }
    throw new Error("NBJ_LOCAL_API_ROUTE_NOT_FOUND");
  } catch (error) {
    sendError(response, error);
    return true;
  }
}
