import { createHash } from "node:crypto";
import { Type } from "typebox";
import {
  previewDiarrheaAdjustment,
  type DiarrheaGrade,
  type FeedingDecision,
} from "../decision/index.js";
import {
  computeFrozenBatchCurve,
  computeFrozenBatchDecision,
  loadFrozenBatchDecisionContext,
  type FrozenBatchDecisionContext,
} from "../decision/batch-decision-service.js";
import { materializeObservationFeedbackPlan } from "../operations/observation-feedback.js";
import {
  checkDataQuality,
  checkExecutionGap,
  PRODUCTION_MODEL_VERSION,
} from "../sop/engine.js";
import { searchFrozenKnowledge, type SopKnowledgeIndex } from "../knowledge/sop-knowledge.js";
import { ChromaKnowledgeIndex } from "../knowledge/chroma-index.js";
import type { FrozenSopKnowledge } from "../shared/local-store-contract.js";
import { shanghaiLocalNowIso } from "../shared/shanghai-time.js";
import {
  supabaseInsert,
  supabaseRest,
  type SupabaseRuntime,
} from "../shared/supabase-rest.js";
import type { SqliteLocalStore } from "../local-db/index.js";

export interface FeedingTool<TParameters = unknown, TResult = unknown> {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  executionMode?: "sequential" | "parallel";
  execute(
    toolCallId: string,
    parameters: TParameters,
    signal?: AbortSignal,
  ): Promise<TResult>;
}

export type AgentToolStorage =
  | { backend: "local"; store: SqliteLocalStore }
  | { backend: "supabase"; env: SupabaseRuntime; token: string };

export interface AgentRequestContext {
  storage: AgentToolStorage;
  userId: string;
  batchId: string;
  sessionId: string;
  evidence: Map<string, unknown>;
  observation?: AgentObservation;
}

export interface AgentObservation {
  diarrheaGrade?: "none" | "mild" | "moderate" | "severe";
  actualPowderGrams?: number | null;
}

interface BatchRecord {
  id?: string;
  config?: Record<string, unknown>;
  records?: Array<Record<string, unknown>>;
  current_day_index?: number;
  control_start_day?: number;
  status?: string;
  revision?: number;
  created_at?: string;
  updated_at?: string;
}

function localStorageUnavailable(): never {
  throw new Error("NBJ_LOCAL_STORAGE_UNAVAILABLE");
}

async function loadBatch(context: AgentRequestContext): Promise<BatchRecord | null> {
  if (context.storage.backend === "supabase") {
    const rows = await supabaseRest<BatchRecord[]>(
      context.storage.env,
      context.storage.token,
      `/rest/v1/batches?id=eq.${encodeURIComponent(context.batchId)}&select=id,config,records,current_day_index,control_start_day,status,revision,created_at,updated_at&limit=1`,
    );
    return rows[0] ?? null;
  }
  try {
    const batch = context.storage.store.getBatch(context.userId, context.batchId);
    if (!batch) return null;
    const data = batch.data as BatchRecord;
    return {
      ...data,
      id: batch.batchId,
      current_day_index: data.current_day_index ?? batch.currentDay,
      status: batch.status,
      revision: batch.revision,
      updated_at: batch.updatedAt,
    };
  } catch {
    return localStorageUnavailable();
  }
}

async function loadSopTasks(
  context: AgentRequestContext,
  run: Record<string, unknown> | null,
  openOnly: boolean,
): Promise<Array<Record<string, unknown>>> {
  if (!run || context.storage.backend === "local") return [];
  const status = openOnly ? "&status=in.(pending,scheduled,overdue,exception)" : "";
  return supabaseRest<Array<Record<string, unknown>>>(
    context.storage.env,
    context.storage.token,
    `/rest/v1/feeding_sop_events?run_id=eq.${encodeURIComponent(String(run.id))}${status}&select=*&order=scheduled_at.asc,sequence.asc`,
  );
}

export const APPROVED_FEEDING_TOOL_NAMES = [
  "get_batch_context",
  "get_today_timeline",
  "compute_production_plan",
  "compute_sop_meal",
  "check_execution_gap",
  "check_data_quality",
  "manage_laggard_case",
  "search_feeding_knowledge",
  "draft_daily_decision",
  "preview_diarrhea_adjustment",
  "sync_observation_feedback",
] as const;

const TOOL_CONTRACT_VERSION = "agent-v2@2026-07-31";
const QUANTITY_AUTHORITY = [
  "sop_direct",
  "sop_indirect",
  "production_model",
] as const;

function result<T>(details: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
  };
}

interface FrozenReceiptRef {
  revision: number;
  sopSourceSha256: string;
  devicePlanSha256: string;
}

function numericTokens(value: unknown, tokens = new Set<number>()): Set<number> {
  if (typeof value === "number" && Number.isFinite(value)) {
    tokens.add(value);
    return tokens;
  }
  if (typeof value === "string") {
    for (const match of value.matchAll(/[+-]?(?:\d+(?:\.\d+)?|\.\d+)/g)) {
      const numeric = Number(match[0]);
      if (Number.isFinite(numeric)) tokens.add(numeric);
    }
    return tokens;
  }
  if (Array.isArray(value)) {
    for (const entry of value) numericTokens(entry, tokens);
    return tokens;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      numericTokens(entry, tokens);
    }
  }
  return tokens;
}

function frozenReceipt(state: BatchDecisionState): FrozenReceiptRef {
  return {
    revision: state.revision,
    sopSourceSha256: state.frozenContext.sop.sourceSha256,
    devicePlanSha256: state.frozenContext.devicePlan.sha256,
  };
}

function record<T>(
  context: AgentRequestContext,
  toolName: string,
  details: T,
  metadata: Partial<{
    sopVersion: string;
    modelVersion: string;
    calculationDate: string;
    basis: string;
    evidence: unknown;
    frozenReceipt: FrozenReceiptRef;
  }> = {},
) {
  const calculationDate = metadata.calculationDate ?? new Date().toISOString().slice(0, 10);
  const frozen = metadata.frozenReceipt;
  const receiptPayload = frozen ? {
    toolName,
    batchId: context.batchId,
    revision: frozen.revision,
    sopSourceSha256: frozen.sopSourceSha256,
    devicePlanSha256: frozen.devicePlanSha256,
    data: details,
  } : null;
  const inputDigest = receiptPayload
    ? createHash("sha256").update(JSON.stringify(receiptPayload).normalize("NFC"), "utf8").digest("hex").toUpperCase()
    : null;
  const evidenceReceipt = frozen && inputDigest ? {
    receiptId: `nbj-receipt-${inputDigest.slice(0, 24).toLowerCase()}`,
    batchId: context.batchId,
    revision: frozen.revision,
    sopSourceSha256: frozen.sopSourceSha256,
    devicePlanSha256: frozen.devicePlanSha256,
    inputDigest,
    numericWhitelist: [...numericTokens(details)].sort((left, right) => left - right),
  } : null;
  const wrapped = {
    toolVersion: TOOL_CONTRACT_VERSION,
    sopVersion: metadata.sopVersion ?? "unavailable",
    modelVersion: metadata.modelVersion ?? PRODUCTION_MODEL_VERSION,
    calculationDate,
    basis: metadata.basis ?? "仅依据已注册的确定性工具与版本化现场数据。",
    evidence: metadata.evidence ?? {
      toolName,
      calculationDate,
      reason: "输出由契约工具生成，LLM 未参与数值计算。",
    },
    evidenceReceipt,
    data: details,
  };
  context.evidence.set(toolName, wrapped);
  return result(wrapped);
}

async function currentRun(context: AgentRequestContext) {
  if (context.storage.backend === "local") {
    const batch = await loadBatch(context);
    if (!batch) return null;
    const frozen = batch.config?.sopTemplate;
    if (!frozen || typeof frozen !== "object" || Array.isArray(frozen)) return null;
    const row = frozen as Record<string, unknown>;
    const sourceSha256 = String(row.sourceSha256 ?? "");
    const collectionRevision = String(row.collectionRevision ?? "");
    if (!sourceSha256 || !collectionRevision) return null;
    const snapshotConfig = row.config && typeof row.config === "object" && !Array.isArray(row.config)
      ? row.config as Record<string, unknown> : {};
    return {
      id: `local:${context.batchId}`,
      batch_id: context.batchId,
      status: "active",
      revision: batch.revision ?? 0,
      template_version: String(row.version ?? ""),
      template_snapshot: structuredClone(snapshotConfig),
      source_sha256: sourceSha256,
      collection_revision: collectionRevision,
      parser_version: String(row.parserVersion ?? ""),
      embedding_model: String(row.embeddingModel ?? ""),
      template_id: String(row.templateId ?? ""),
    };
  }
  const rows = await supabaseRest<Array<Record<string, unknown>>>(
    context.storage.env,
    context.storage.token,
    `/rest/v1/feeding_sop_runs?batch_id=eq.${encodeURIComponent(context.batchId)}&status=in.(active,paused)&select=*&order=started_at.desc&limit=1`,
  );
  return rows[0] ?? null;
}

async function localFrozenKnowledge(context: AgentRequestContext): Promise<FrozenSopKnowledge | null> {
  if (context.storage.backend !== "local") return null;
  const run = await currentRun(context);
  if (!run) return null;
  const frozen: FrozenSopKnowledge = {
    templateId: String(run.template_id ?? ""), sopVersion: String(run.template_version ?? ""),
    sourceSha256: String(run.source_sha256 ?? ""), collectionRevision: String(run.collection_revision ?? ""),
    parserVersion: String(run.parser_version ?? ""), embeddingModel: String(run.embedding_model ?? ""),
  };
  return Object.values(frozen).every(Boolean) ? frozen : null;
}

function configuredKnowledgeIndex(): SopKnowledgeIndex | null {
  const chromaUrl = process.env.CHROMA_URL;
  const embeddingBaseUrl = process.env.EMBEDDING_BASE_URL;
  return chromaUrl && embeddingBaseUrl ? new ChromaKnowledgeIndex({ chromaUrl, embeddingBaseUrl }) : null;
}

export function stableDecisionDraftId(input: {
  userId: string;
  batchId: string;
  sessionId: string;
  toolCallId: string;
}): string {
  const digest = createHash("sha256").update([
    "draft_daily_decision",
    input.userId,
    input.batchId,
    input.sessionId,
    input.toolCallId,
  ].join("\u001f")).digest("hex").split("");
  digest[12] = "5";
  digest[16] = ["8", "9", "a", "b"][Number.parseInt(digest[16]!, 16) & 3]!;
  const value = digest.join("").slice(0, 32);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

interface BatchDecisionState {
  batchId: string;
  batch: {
    config?: Record<string, unknown>;
    records?: Array<Record<string, unknown>>;
    current_day_index?: number;
    control_start_day?: number;
    revision?: number;
  };
  run: Record<string, unknown> | null;
  frozenContext: FrozenBatchDecisionContext;
  revision: number;
  currentDayAge: number;
  dateLocal: string;
  sopVersion: string;
}

async function batchDecisionState(
  context: AgentRequestContext,
  overrides: Partial<{
    startAge: number;
    endAge: number;
    startWeight: number;
    headCount: number;
    controlStartDay: number;
    dayAge: number;
  }> = {},
) {
  if (Object.values(overrides).some((value) => value !== undefined)) {
    throw new Error("NBJ_FROZEN_DECISION_OVERRIDE_FORBIDDEN");
  }
  const batch = await loadBatch(context);
  if (!batch) throw new Error("NBJ_BATCH_NOT_FOUND");
  const run = await currentRun(context);
  if (!run) throw new Error("NBJ_FROZEN_SOP_MISSING");
  const frozenContext = loadFrozenBatchDecisionContext({
    batchId: context.batchId,
    revision: Number(batch.revision),
    currentDayIndex: Number(batch.current_day_index),
    config: batch.config ?? {},
    records: batch.records ?? [],
  });
  return {
    batchId: context.batchId,
    batch,
    run,
    frozenContext,
    revision: frozenContext.revision,
    currentDayAge: frozenContext.modelInput.startAge + frozenContext.currentDayIndex,
    dateLocal: computeFrozenBatchDecision(frozenContext).decision.dateLocal,
    sopVersion: frozenContext.sop.version,
  } satisfies BatchDecisionState;
}

async function productionDecisionsForBatch(
  context: AgentRequestContext,
  overrides: Parameters<typeof batchDecisionState>[1] = {},
) {
  const state = await batchDecisionState(context, overrides);
  const activeDecision = context.storage.backend === "local"
    ? context.storage.store.getActiveDecision(context.userId, context.batchId, state.dateLocal)
    : null;
  const curve = computeFrozenBatchCurve(state.frozenContext);
  const selectedCurve = curve.selectedCurve.map((entry) => entry.decision);
  const timedQuantity = curve.timedQuantity.map((entry) => entry.decision);
  const freeFeeding = curve.freeFeeding.map((entry) => entry.decision);
  const selectedDecision = activeDecision ?? curve.selected.decision;
  const canonicalDecision = activeDecision
    ? { ...curve.selected, decision: activeDecision }
    : curve.selected;
  return {
    state,
    fullFeedingCurve: selectedCurve,
    deviceModes: {
      timed_quantity: timedQuantity,
      free_feeding: freeFeeding,
    },
    selectedDecision,
    canonicalDecision,
    singlePowderGrams: selectedDecision.setting.singlePowderGrams,
    quantityAuthorityPriority: QUANTITY_AUTHORITY,
    evidence: selectedDecision.evidence,
  };
}

export function createFeedingTools(
  context: AgentRequestContext,
): FeedingTool<any, any>[] {
  const getBatchContext: FeedingTool<any, any> = {
    name: "get_batch_context",
    label: "读取批次上下文",
    description: "读取当前用户的批次、SOP run、revision、阶段和未完成任务。",
    parameters: Type.Object({}),
    execute: async () => {
      const batch = await loadBatch(context);
      const run = await currentRun(context);
      const tasks = await loadSopTasks(context, run, true);
      const productionPlan = batch
        ? await productionDecisionsForBatch(context)
        : null;
      return record(context, "get_batch_context", {
        batch,
        run,
        openTasks: tasks,
        fullFeedingCurve: productionPlan?.fullFeedingCurve ?? null,
        estimatedWeightCurve: productionPlan?.fullFeedingCurve.map((decision) => ({
          dayAge: decision.setting.dayAge,
          estimatedAverageWeightKg: decision.setting.estimatedAverageWeightKg,
          estimatedEndWeightKg: decision.setting.estimatedEndWeightKg,
        })) ?? null,
        deviceModes: productionPlan?.deviceModes ?? null,
        selectedDecision: productionPlan?.selectedDecision ?? null,
        canonicalDecision: productionPlan?.canonicalDecision ?? null,
      }, {
        sopVersion: productionPlan?.state.sopVersion,
        modelVersion: productionPlan?.selectedDecision?.evidence.modelVersion,
        evidence: productionPlan?.evidence,
        ...(productionPlan ? { frozenReceipt: frozenReceipt(productionPlan.state) } : {}),
        basis: "批次、冻结 SOP 和 computeDayDecision 的完整曲线快照。",
      });
    },
  };

  const getTodayTimeline: FeedingTool<any, any> = {
    name: "get_today_timeline",
    label: "读取今日流程",
    description: "读取当前批次按时间排序的饲喂、巡栏、饮水和维护任务。",
    parameters: Type.Object({}),
    execute: async () => {
      const state = await batchDecisionState(context);
      if (context.storage.backend === "local") {
        const localBatch = context.storage.store.getBatch(context.userId, context.batchId);
        if (!localBatch) throw new Error("NBJ_BATCH_NOT_FOUND");
        const materialized = materializeObservationFeedbackPlan({
          store: context.storage.store,
          userId: context.userId,
          batch: localBatch,
          observation: context.observation as Record<string, unknown> | undefined,
        });
        const plan = materialized.plan;
        return record(context, "get_today_timeline", {
          calculationDate: state.dateLocal,
          sopVersion: state.sopVersion,
          dailyOperationPlan: plan,
          tasks: plan.operations,
          feedback: materialized.feedback
            ? {
                kind: materialized.feedback.kind,
                reason: materialized.feedback.reason,
                operations: materialized.feedback.operations,
                feedbackOrigin: materialized.feedback.feedbackOrigin,
                proposedSetting: materialized.feedback.proposedSetting,
              }
            : null,
        }, {
          sopVersion: state.sopVersion,
          frozenReceipt: frozenReceipt(state),
          basis: "按批次冻结 SOP 阶段、日常巡栏和维护节奏物化单份今日操作计划。",
        });
      }
      const tasks = await loadSopTasks(context, state.run, false);
      return record(context, "get_today_timeline", {
        calculationDate: state.dateLocal,
        sopVersion: state.sopVersion,
        tasks,
      }, {
        sopVersion: state.sopVersion,
        frozenReceipt: frozenReceipt(state),
      });
    },
  };

  const computeProduction: FeedingTool<any, any> = {
    name: "compute_production_plan",
    label: "计算生产饲喂计划",
    description: "从当前批次调用唯一权威 feeding-model + V5-Lite，返回完整日龄配奶曲线、餐次、定时下奶时间、下粉量和确定性异常处置。",
    parameters: Type.Object({
      startAge: Type.Optional(Type.Number({ minimum: 1, maximum: 60 })),
      endAge: Type.Optional(Type.Number({ minimum: 1, maximum: 60 })),
      startWeight: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 30 })),
      headCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })),
      controlStartDay: Type.Optional(Type.Integer({ minimum: 0, maximum: 60 })),
      dayAge: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
    }),
    execute: async (_id, rawParams) => {
      const params = rawParams as {
        startAge?: number;
        endAge?: number;
        startWeight?: number;
        headCount?: number;
        controlStartDay?: number;
        dayAge?: number;
      };
      const details = await productionDecisionsForBatch(context, params);
      return record(context, "compute_production_plan", {
        fullFeedingCurve: details.fullFeedingCurve,
        deviceModes: details.deviceModes,
        selectedDecision: details.selectedDecision,
        canonicalDecision: details.canonicalDecision,
        singlePowderGrams: details.singlePowderGrams,
        quantityAuthorityPriority: details.quantityAuthorityPriority,
      }, {
        sopVersion: details.state.sopVersion,
        modelVersion: details.selectedDecision.evidence.modelVersion,
        calculationDate: details.selectedDecision.evidence.calculationDate,
        basis: "computeDayDecision 逐日计算；模型曲线是设备设置标准上限。",
        evidence: details.evidence,
        frozenReceipt: frozenReceipt(details.state),
      });
    },
  };

  const computeTeaching: FeedingTool<any, any> = {
    name: "compute_sop_meal",
    label: "计算教奶餐",
    description: "按固定的 17:00 至次日 08:00 教奶程序计算；首日数量以冻结 SOP 为准。",
    parameters: Type.Object({
      activeHeadCount: Type.Integer({ minimum: 1, maximum: 10000 }),
    }),
    execute: async (_id, rawParams) => {
      const params = rawParams as { activeHeadCount: number };
      const production = await productionDecisionsForBatch(context);
      const { state } = production;
      if (params.activeHeadCount !== state.frozenContext.modelInput.headCount) {
        throw new Error("NBJ_FROZEN_HEAD_COUNT_MISMATCH");
      }
      const teachingDecision = computeFrozenBatchDecision(state.frozenContext, 0).decision;
      return record(context, "compute_sop_meal", {
        teachingDecision,
        fullFeedingCurve: production.fullFeedingCurve,
        deviceModes: production.deviceModes,
        singlePowderGrams: teachingDecision.setting.singlePowderGrams,
        quantityAuthorityPriority: QUANTITY_AUTHORITY,
        programEndsAt: "次日 08:00（含 08:00 餐与随后人工巡栏）",
      }, {
        sopVersion: teachingDecision.evidence.sopVersion,
        modelVersion: teachingDecision.evidence.modelVersion,
        calculationDate: teachingDecision.evidence.calculationDate,
        basis: "共享冻结决策服务使用固定 6 个教奶时间点；首日数量仅来自冻结 SOP 或冻结模型输入。",
        evidence: teachingDecision.evidence,
        frozenReceipt: frozenReceipt(state),
      });
    },
  };

  const executionGap: FeedingTool<any, any> = {
    name: "check_execution_gap",
    label: "核对执行缺口",
    description: "按提交时冻结计划和 SOP 计划来源计算真实执行缺口。",
    parameters: Type.Object({
      planSource: Type.Union([
        Type.Literal("sop_teaching"),
        Type.Literal("production_model"),
        Type.Literal("sop_transition"),
      ]),
      committedPlan: Type.Number({ minimum: 0 }),
      actual: Type.Number({ minimum: 0 }),
      submittedRevision: Type.Integer({ minimum: 0 }),
    }),
    execute: async (_id, rawParams) => {
      const params = rawParams as {
        planSource: "sop_teaching" | "production_model" | "sop_transition";
        committedPlan: number;
        actual: number;
        submittedRevision: number;
      };
      const run = await currentRun(context);
      if (!run) throw new Error("NBJ_SOP_RUN_NOT_FOUND");
      const details = {
        ...checkExecutionGap({
          ...params,
          currentRevision: Number(run.revision),
        }),
        modelVersion: run.model_version,
        sopVersion: run.template_version,
        calculationDate: new Date().toISOString().slice(0, 10),
      };
      return record(context, "check_execution_gap", details);
    },
  };

  const dataQuality: FeedingTool<any, any> = {
    name: "check_data_quality",
    label: "检查数据质量",
    description: "检查头数、体重、抢奶、腹部、腹泻、设备和人工确认；异常时阻断常规建议。",
    parameters: Type.Object({
      headCount: Type.Optional(Type.Integer({ minimum: 0 })),
      averageWeightKg: Type.Optional(Type.Number({ minimum: 0 })),
      feedingResponse: Type.Optional(Type.Union([
        Type.Literal("active"),
        Type.Literal("mixed"),
        Type.Literal("refusing"),
      ])),
      abdomenState: Type.Optional(Type.Union([
        Type.Literal("full"),
        Type.Literal("mixed"),
        Type.Literal("hollow"),
      ])),
      diarrhea: Type.Optional(Type.Union([
        Type.Literal("none"),
        Type.Literal("mild"),
        Type.Literal("moderate"),
        Type.Literal("severe"),
      ])),
      deaths: Type.Optional(Type.Integer({ minimum: 0 })),
      deviceStatus: Type.Optional(Type.Union([
        Type.Literal("ok"),
        Type.Literal("blocked"),
        Type.Literal("probe_contaminated"),
        Type.Literal("offline"),
      ])),
      waterStatusConfirmed: Type.Optional(Type.Boolean()),
      operatorConfirmed: Type.Optional(Type.Boolean()),
    }),
    execute: async (_id, rawParams) =>
      record(
        context,
        "check_data_quality",
        checkDataQuality(rawParams as Parameters<typeof checkDataQuality>[0]),
      ),
  };

  const laggard: FeedingTool<any, any> = {
    name: "manage_laggard_case",
    label: "管理掉队猪",
    description: "生成掉队猪记录草案、补奶计数或第三天处置建议；实际记录由现场人员确认提交。",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("draft_create"),
        Type.Literal("draft_supplement"),
        Type.Literal("day3_recommendation"),
      ]),
      pigTag: Type.String({ minLength: 1, maxLength: 80 }),
      notApproachingTrough: Type.Optional(Type.Boolean()),
      hollowAbdomen: Type.Optional(Type.Boolean()),
      currentSupplementCount: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
    }),
    execute: async (_id, rawParams) => {
      const params = rawParams as {
        action: "draft_create" | "draft_supplement" | "day3_recommendation";
        pigTag: string;
        notApproachingTrough?: boolean;
        hollowAbdomen?: boolean;
        currentSupplementCount?: number;
      };
      const supplementCount = params.currentSupplementCount ?? 0;
      const details = {
        ...params,
        nextSupplementCount:
          params.action === "draft_supplement" ? Math.min(3, supplementCount + 1) : supplementCount,
        requiresOperatorConfirmation: true,
        requiresDay3Decision: params.action === "day3_recommendation" || supplementCount >= 3,
        allowedOutcomes: ["keep", "return_to_sow"],
      };
      return record(context, "manage_laggard_case", details);
    },
  };

  const knowledge: FeedingTool<any, any> = {
    name: "search_feeding_knowledge",
    label: "检索饲喂知识",
    description: "检索版本化 SOP 和奶爸机知识包，不访问任意网络。",
    parameters: Type.Object({ query: Type.String({ maxLength: 500 }) }),
    execute: async (_id, rawParams) => {
      const params = rawParams as { query: string };
      if (context.storage.backend !== "local") {
        return record(context, "search_feeding_knowledge", {
          status: "unavailable", source: "none", results: [], reason: "frozen_local_knowledge_context_required",
        });
      }
      const frozen = await localFrozenKnowledge(context);
      const chunks = frozen ? context.storage.store.listSopKnowledgeChunks(frozen.templateId) : [];
      const searched = await searchFrozenKnowledge({ query: params.query, frozen, chunks, index: configuredKnowledgeIndex() });
      return record(context, "search_feeding_knowledge", searched, { sopVersion: frozen?.sopVersion });
    },
  };

  const draftDecision: FeedingTool<any, any> = {
    name: "draft_daily_decision",
    label: "生成审批草案",
    description: "仅根据本轮确定性工具结果生成待审批草案；不执行设备动作。",
    parameters: Type.Object({
      decisionType: Type.String({ minLength: 1, maxLength: 80 }),
      title: Type.String({ minLength: 1, maxLength: 160 }),
    }),
    executionMode: "sequential",
    execute: async (toolCallId, rawParams) => {
      const params = rawParams as { decisionType: string; title: string };
      const run = await currentRun(context);
      if (!run) throw new Error("NBJ_SOP_RUN_NOT_FOUND");
      if (!toolCallId.trim()) throw new Error("NBJ_AGENT_TOOL_CALL_ID_REQUIRED");
      const decisionId = stableDecisionDraftId({
        userId: context.userId,
        batchId: context.batchId,
        sessionId: context.sessionId,
        toolCallId,
      });
      if (context.storage.backend !== "supabase") {
        throw new Error("NBJ_LOCAL_DECISION_DRAFT_UNAVAILABLE");
      }
      const existing = await supabaseRest<Array<Record<string, unknown>>>(
        context.storage.env,
        context.storage.token,
        `/rest/v1/feeding_agent_decisions?id=eq.${encodeURIComponent(decisionId)}&select=*&limit=1`,
      );
      if (existing[0]) {
        return record(context, "draft_daily_decision", existing[0]);
      }
      const qualityEnvelope = context.evidence.get("check_data_quality") as
        | { data?: { mayDraftStandardDecision?: boolean; exceptionMode?: boolean } }
        | undefined;
      const quality = qualityEnvelope?.data;
      if (!quality) throw new Error("NBJ_AGENT_DETERMINISTIC_EVIDENCE_REQUIRED");
      const evidence = Object.fromEntries(context.evidence);
      const exceptionMode = quality.exceptionMode === true;
      const draft = {
        mode: exceptionMode ? "exception" : "standard",
        action: exceptionMode
          ? "暂停标准建议，完成现场检查并由人工处置"
          : "按确定性计划执行，等待现场批准",
        requiresHumanApproval: true,
        controlsEquipment: false,
      };
      const inserted = await supabaseInsert<Array<Record<string, unknown>>>(
        context.storage.env,
        context.storage.token,
        "feeding_agent_decisions",
        {
          id: decisionId,
          user_id: context.userId,
          session_id: context.sessionId,
          run_id: run.id,
          batch_id: context.batchId,
          decision_type: params.decisionType,
          title: params.title,
          draft,
          evidence,
          model_version: run.model_version,
          sop_version: run.template_version,
          calculation_date: new Date().toISOString().slice(0, 10),
          based_on_revision: run.revision,
        },
      );
      return record(context, "draft_daily_decision", inserted[0]);
    },
  };

  const previewDiarrhea: FeedingTool<any, any> = {
    name: "preview_diarrhea_adjustment",
    label: "预览腹泻调整",
    description: "按腹泻档位生成未生效草案：定时定量减少一次配奶，自由采食减少一个窗口；不按时间重排，不切换模式。",
    parameters: Type.Object({
      grades: Type.Optional(Type.Array(Type.Union([
        Type.Literal("none"),
        Type.Literal("mild"),
        Type.Literal("moderate"),
        Type.Literal("severe"),
      ]), { minItems: 1, maxItems: 10000 })),
      cumulativePowderGrams: Type.Optional(Type.Number({ minimum: 0 })),
      observedAt: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
      remainingMealTimes: Type.Optional(Type.Array(
        Type.String({ pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" }),
        { maxItems: 32 },
      )),
    }),
    execute: async (_id, rawParams) => {
      const params = rawParams as {
        grades?: DiarrheaGrade[];
        cumulativePowderGrams?: number;
        observedAt?: string;
        remainingMealTimes?: string[];
      };
      const batch = await loadBatch(context);
      const records = Array.isArray(batch?.records) ? batch.records : [];
      const sortedRecords = [...records].sort((left, right) => {
        const leftAt = String(left?.recordedAt ?? left?.created_at ?? "");
        const rightAt = String(right?.recordedAt ?? right?.created_at ?? "");
        return leftAt.localeCompare(rightAt);
      });
      const latestRecord = sortedRecords[sortedRecords.length - 1] as Record<string, unknown> | undefined;
      const observedGrade = context.observation?.diarrheaGrade &&
        context.observation.diarrheaGrade !== "none"
        ? context.observation.diarrheaGrade
        : undefined;
      const requestedGrades = (params.grades ?? []).filter((grade): grade is DiarrheaGrade =>
        grade === "mild" || grade === "moderate" || grade === "severe");
      const recordGradeRaw = latestRecord?.diarrheaGrade;
      const recordGrade = typeof recordGradeRaw === "string" &&
        recordGradeRaw !== "none" &&
        ["mild", "moderate", "severe"].includes(recordGradeRaw)
        ? recordGradeRaw as DiarrheaGrade
        : undefined;
      const grades = observedGrade
        ? [observedGrade]
        : requestedGrades.length
          ? requestedGrades
          : recordGrade
            ? [recordGrade]
            : [];
      if (!grades.length) throw new Error("NBJ_DIARRHEA_GRADE_REQUIRED");
      const recordActualRaw = latestRecord?.actualPowderGrams;
      const recordActual = recordActualRaw == null || recordActualRaw === ""
        ? Number.NaN
        : Number(recordActualRaw);
      const hasRecordActual = Number.isFinite(recordActual) && recordActual >= 0;
      const observationActual = context.observation?.actualPowderGrams;
      const cumulativeValue = observationActual != null
        ? observationActual
        : params.cumulativePowderGrams != null
          ? params.cumulativePowderGrams
          : hasRecordActual
            ? recordActual
            : 0;
      const cumulativeSource: "observation" | "request" | "latest_record" | "assumed_zero" =
        observationActual != null
          ? "observation"
          : params.cumulativePowderGrams != null
            ? "request"
            : hasRecordActual
              ? "latest_record"
              : "assumed_zero";
      const production = await productionDecisionsForBatch(context);
      const preview = previewDiarrheaAdjustment({
        decision: production.selectedDecision,
        grades,
        cumulativePowderGrams: cumulativeValue,
        observedAt: params.observedAt ?? shanghaiLocalNowIso(),
        remainingMealTimes: params.remainingMealTimes,
      });
      const worstGrade = grades.reduce<DiarrheaGrade>((worst, grade) =>
        ["none", "mild", "moderate", "severe"].indexOf(grade) >
        ["none", "mild", "moderate", "severe"].indexOf(worst)
          ? grade
          : worst,
      "none") as "mild" | "moderate" | "severe";
      return record(context, "preview_diarrhea_adjustment", {
        decision: preview,
        worstGrade,
        deviceOperation: {
          mode: preview.setting.mode,
          remainingDailyPowderGrams: preview.setting.dailyPowderGrams,
          singlePowderGrams: preview.setting.singlePowderGrams,
          timedMeals: preview.setting.timedMeals,
          freeWindows: preview.setting.freeWindows,
          clearFreeFeedingWindows: false,
          requiresHumanApproval: true,
          manualDispositionRequired: false,
        },
        cumulativePowderGrams: cumulativeValue,
        cumulativeSource,
        severeException: null,
      }, {
        sopVersion: preview.evidence.sopVersion,
        modelVersion: preview.evidence.modelVersion,
        calculationDate: preview.evidence.calculationDate,
        basis: "previewDiarrheaAdjustment 仅减少一次配奶/自由采食窗口，不按时间或累计下粉量重排；预览不自动生效。",
        evidence: preview.evidence,
        frozenReceipt: frozenReceipt(production.state),
      });
    },
  };

  const syncObservationFeedback: FeedingTool<any, any> = {
    name: "sync_observation_feedback",
    label: "同步现场观察反馈",
    description: "读取最近腹泻和教槽采食记录，把需人工确认的处置任务与设备方案物化到今日操作。",
    parameters: Type.Object({}),
    execute: async () => {
      if (context.storage.backend !== "local") {
        return record(context, "sync_observation_feedback", {
          status: "unavailable",
          reason: "supabase_backend_no_op",
          materialized: false,
        });
      }
      const localBatch = context.storage.store.getBatch(context.userId, context.batchId);
      if (!localBatch) throw new Error("NBJ_BATCH_NOT_FOUND");
      const state = await batchDecisionState(context);
      const materialized = materializeObservationFeedbackPlan({
        store: context.storage.store,
        userId: context.userId,
        batch: localBatch,
        observation: context.observation as Record<string, unknown> | undefined,
      });
      return record(context, "sync_observation_feedback", {
        status: materialized.skipped ? "skipped" : "ok",
        reason: materialized.skipped ? "confirmed" : materialized.feedback?.reason ?? null,
        materialized: !materialized.skipped,
        feedbackOrigin: materialized.plan.feedbackOrigin,
        proposedSetting: materialized.plan.proposedSetting,
        dailyOperationPlan: materialized.plan,
        operations: materialized.plan.operations,
        feedback: materialized.feedback
          ? {
              kind: materialized.feedback.kind,
              reason: materialized.feedback.reason,
              operations: materialized.feedback.operations,
              feedbackOrigin: materialized.feedback.feedbackOrigin,
              proposedSetting: materialized.feedback.proposedSetting,
            }
          : null,
      }, {
        sopVersion: state.sopVersion,
        frozenReceipt: frozenReceipt(state),
        basis: "按最近现场观察确定性物化今日操作反馈任务与待确认设备方案。",
      });
    },
  };

  return [
    getBatchContext,
    getTodayTimeline,
    computeProduction,
    computeTeaching,
    executionGap,
    dataQuality,
    laggard,
    knowledge,
    draftDecision,
    previewDiarrhea,
    syncObservationFeedback,
  ];
}
