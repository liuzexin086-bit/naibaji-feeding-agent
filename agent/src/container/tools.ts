import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  computeDayDecision,
  previewDiarrheaAdjustment,
  type CreepGrade,
  type DayDecisionInput,
  type DiarrheaGrade,
  type FeedingDecision,
} from "../decision/index.js";
import {
  checkDataQuality,
  checkExecutionGap,
  DEFAULT_SOP_TEMPLATE,
  PRODUCTION_MODEL_VERSION,
} from "../sop/engine.js";
import { searchKnowledge } from "../knowledge/sop-knowledge.js";
import {
  supabaseInsert,
  supabaseRest,
  type SupabaseRuntime,
} from "../shared/supabase-rest.js";
import type { SqliteLocalStore } from "../local-db/index.js";

export type AgentToolStorage =
  | { backend: "local"; store: SqliteLocalStore }
  | { backend: "supabase"; env: SupabaseRuntime; token: string };

export interface AgentRequestContext {
  storage: AgentToolStorage;
  userId: string;
  batchId: string;
  sessionId: string;
  evidence: Map<string, unknown>;
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
  }> = {},
) {
  const calculationDate = metadata.calculationDate ?? new Date().toISOString().slice(0, 10);
  const wrapped = {
    toolVersion: TOOL_CONTRACT_VERSION,
    sopVersion: metadata.sopVersion ?? DEFAULT_SOP_TEMPLATE.version,
    modelVersion: metadata.modelVersion ?? PRODUCTION_MODEL_VERSION,
    calculationDate,
    basis: metadata.basis ?? "仅依据已注册的确定性工具与版本化现场数据。",
    evidence: metadata.evidence ?? {
      toolName,
      calculationDate,
      reason: "输出由契约工具生成，LLM 未参与数值计算。",
    },
    data: details,
  };
  context.evidence.set(toolName, wrapped);
  return result(wrapped);
}

async function currentRun(context: AgentRequestContext) {
  if (context.storage.backend === "local") return null;
  const rows = await supabaseRest<Array<Record<string, unknown>>>(
    context.storage.env,
    context.storage.token,
    `/rest/v1/feeding_sop_runs?batch_id=eq.${encodeURIComponent(context.batchId)}&status=in.(active,paused)&select=*&order=started_at.desc&limit=1`,
  );
  return rows[0] ?? null;
}

function finiteNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
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
  template: typeof DEFAULT_SOP_TEMPLATE;
  modelInput: DayDecisionInput["modelInput"];
  revision: number;
  currentDayAge: number;
  dateLocal: string;
  sopVersion: string;
}

function localDateAt(instant: Date, utcOffsetMinutes: number): string {
  return new Date(instant.getTime() + utcOffsetMinutes * 60_000)
    .toISOString()
    .slice(0, 10);
}

function addLocalDays(dateLocal: string, days: number): string {
  const instant = new Date(`${dateLocal}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
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
  const batch = await loadBatch(context);
  if (!batch) throw new Error("NBJ_BATCH_NOT_FOUND");
  const config = batch.config ?? {};
  const run = await currentRun(context);
  const template = (run?.template_snapshot ?? DEFAULT_SOP_TEMPLATE) as typeof DEFAULT_SOP_TEMPLATE;
  const startAge = overrides.startAge ?? finiteNumber(config.startAge, 3);
  const endAge = overrides.endAge ?? finiteNumber(config.endAge, 21);
  const currentDayIndex = finiteNumber(batch.current_day_index, 0);
  if (run?.status === "active") {
    run.phase = currentDayIndex === 0 ? "teaching_loop" : "production_feeding";
  }
  const utcOffsetMinutes = finiteNumber(template.utcOffsetMinutes, 480);
  const configuredStart = String(config.planStartDate ?? "");
  const baseDateLocal = /^\d{4}-\d{2}-\d{2}$/.test(configuredStart)
    ? configuredStart
    : localDateAt(
        new Date(String(run?.admitted_at ?? batch.created_at ?? batch.updated_at)),
        utcOffsetMinutes,
      );
  const modelInput = {
    startAge,
    endAge,
    startWeight: overrides.startWeight ?? finiteNumber(config.startWeight, 2.3),
    headCount: overrides.headCount ?? finiteNumber(config.headCount, 20),
    controlStartDay:
      overrides.controlStartDay ??
      finiteNumber(batch.control_start_day, -1),
    dayAge: overrides.dayAge ?? startAge + currentDayIndex,
    records: batch.records ?? [],
    dilutionRatio: String(run?.dilution_ratio ?? "水:粉=6:1"),
    devicePowderPrecisionGrams: finiteNumber(
      template.devicePowderPrecisionGrams,
      1,
    ),
    programStartLocal: "02:00",
  };
  return {
    batchId: context.batchId,
    batch,
    run,
    template,
    modelInput,
    revision: finiteNumber(run?.revision ?? batch.revision, 0),
    currentDayAge: modelInput.dayAge,
    dateLocal: addLocalDays(baseDateLocal, currentDayIndex),
    sopVersion: String(run?.template_version ?? template.version),
  } satisfies BatchDecisionState;
}

function decisionInput(
  state: BatchDecisionState,
  dayAge: number,
  requestedMode: "timed_quantity" | "free_feeding",
): DayDecisionInput {
  const creepGrades = state.batch.config?.creepFeedGradesLast3Days;
  return {
    revision: state.revision,
    batchId: state.batchId,
    dateLocal: addLocalDays(state.dateLocal, dayAge - state.currentDayAge),
    calculationDate: state.dateLocal,
    sopVersion: state.sopVersion,
    modelInput: { ...state.modelInput, dayAge },
    requestedMode,
    requestedStatus: "draft",
    precisionGrams: finiteNumber(state.template.devicePowderPrecisionGrams, 1),
    freeWindows: [{ startLocal: "00:00", endLocal: "23:59" }],
    creepFeedGradesLast3Days: Array.isArray(creepGrades)
      ? creepGrades.filter((grade): grade is CreepGrade =>
          ["none", "low", "medium", "high", "excellent"].includes(String(grade)))
      : undefined,
  };
}

async function productionDecisionsForBatch(
  context: AgentRequestContext,
  overrides: Parameters<typeof batchDecisionState>[1] = {},
) {
  const state = await batchDecisionState(context, overrides);
  const ages = Array.from(
    { length: state.modelInput.endAge - state.modelInput.startAge + 1 },
    (_, index) => state.modelInput.startAge + index,
  );
  const timedQuantity = ages.map((age) =>
    computeDayDecision(decisionInput(state, age, "timed_quantity")));
  const freeFeeding = ages.map((age) =>
    computeDayDecision(decisionInput(state, age, "free_feeding")));
  const selectedIndex = Math.max(0, Math.min(
    ages.length - 1,
    state.currentDayAge - state.modelInput.startAge,
  ));
  return {
    state,
    fullFeedingCurve: timedQuantity,
    deviceModes: {
      timed_quantity: timedQuantity,
      free_feeding: freeFeeding,
    },
    selectedDecision: timedQuantity[selectedIndex],
    singlePowderGrams: timedQuantity[selectedIndex]?.setting.singlePowderGrams ?? 0,
    quantityAuthorityPriority: QUANTITY_AUTHORITY,
    evidence: timedQuantity[selectedIndex]?.evidence,
  };
}

export function createFeedingTools(
  context: AgentRequestContext,
): AgentTool[] {
  const getBatchContext: AgentTool = {
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
        deviceModes: productionPlan?.deviceModes ?? null,
        selectedDecision: productionPlan?.selectedDecision ?? null,
      }, {
        sopVersion: String(run?.template_version ?? DEFAULT_SOP_TEMPLATE.version),
        modelVersion: productionPlan?.selectedDecision?.evidence.modelVersion,
        evidence: productionPlan?.evidence,
        basis: "批次、冻结 SOP 和 computeDayDecision 的完整曲线快照。",
      });
    },
  };

  const getTodayTimeline: AgentTool = {
    name: "get_today_timeline",
    label: "读取今日流程",
    description: "读取当前批次按时间排序的饲喂、巡栏、饮水和维护任务。",
    parameters: Type.Object({}),
    execute: async () => {
      const state = await batchDecisionState(context);
      const tasks = await loadSopTasks(context, state.run, false);
      return record(context, "get_today_timeline", {
        calculationDate: state.dateLocal,
        sopVersion: state.run?.template_version ?? DEFAULT_SOP_TEMPLATE.version,
        tasks,
      });
    },
  };

  const computeProduction: AgentTool = {
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
        singlePowderGrams: details.singlePowderGrams,
        quantityAuthorityPriority: details.quantityAuthorityPriority,
      }, {
        sopVersion: details.state.sopVersion,
        modelVersion: details.selectedDecision.evidence.modelVersion,
        calculationDate: details.selectedDecision.evidence.calculationDate,
        basis: "computeDayDecision 逐日计算；模型曲线是设备设置标准上限。",
        evidence: details.evidence,
      });
    },
  };

  const computeTeaching: AgentTool = {
    name: "compute_sop_meal",
    label: "计算教奶餐",
    description: "按固定的 17:00 至次日 08:00 教奶程序计算；每次下粉量采用生产模型当日单次量。",
    parameters: Type.Object({
      activeHeadCount: Type.Integer({ minimum: 1, maximum: 10000 }),
    }),
    execute: async (_id, rawParams) => {
      const params = rawParams as { activeHeadCount: number };
      const production = await productionDecisionsForBatch(context, {
        headCount: params.activeHeadCount,
      });
      const { state } = production;
      const { run, template } = state;
      const teachingDecision = computeDayDecision({
        ...decisionInput(state, state.currentDayAge, "timed_quantity"),
        teachingProgram: {
          enabled: template.teachingProgramEnabled !== false,
          firstTeachingLocal: "17:00",
          intervalHours: finiteNumber(template.teachingIntervalHours, 3),
          endLocal: "08:00",
        },
      });
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
        basis: "computeDayDecision 使用固定 6 个教奶时间点，并采用 feeding-model + V5-Lite 当日模型单次量。",
        evidence: teachingDecision.evidence,
      });
    },
  };

  const executionGap: AgentTool = {
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

  const dataQuality: AgentTool = {
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

  const laggard: AgentTool = {
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

  const knowledge: AgentTool = {
    name: "search_feeding_knowledge",
    label: "检索饲喂知识",
    description: "检索版本化 SOP 和奶爸机知识包，不访问任意网络。",
    parameters: Type.Object({ query: Type.String({ maxLength: 500 }) }),
    execute: async (_id, rawParams) => {
      const params = rawParams as { query: string };
      return record(context, "search_feeding_knowledge", searchKnowledge(params.query));
    },
  };

  const draftDecision: AgentTool = {
    name: "draft_daily_decision",
    label: "生成审批草案",
    description: "仅根据本轮确定性工具结果生成待审批草案；不执行设备动作。",
    parameters: Type.Object({
      decisionType: Type.String({ minLength: 1, maxLength: 80 }),
      title: Type.String({ minLength: 1, maxLength: 160 }),
    }),
    executionMode: "sequential",
    execute: async (_id, rawParams) => {
      const params = rawParams as { decisionType: string; title: string };
      const run = await currentRun(context);
      if (!run) throw new Error("NBJ_SOP_RUN_NOT_FOUND");
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
      if (context.storage.backend !== "supabase") {
        throw new Error("NBJ_LOCAL_DECISION_DRAFT_UNAVAILABLE");
      }
      const inserted = await supabaseInsert<Array<Record<string, unknown>>>(
        context.storage.env,
        context.storage.token,
        "feeding_agent_decisions",
        {
          id: crypto.randomUUID(),
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

  const previewDiarrhea: AgentTool = {
    name: "preview_diarrhea_adjustment",
    label: "预览腹泻调整",
    description: "先调用确定性决策核心，按腹泻档位、设备累计实际下粉量和剩余餐次生成未生效的设备调整草案；严重异常转人工处置。",
    parameters: Type.Object({
      grades: Type.Array(Type.Union([
        Type.Literal("none"),
        Type.Literal("mild"),
        Type.Literal("moderate"),
        Type.Literal("severe"),
      ]), { minItems: 1, maxItems: 10000 }),
      cumulativePowderGrams: Type.Number({ minimum: 0 }),
      observedAt: Type.String({ minLength: 1, maxLength: 80 }),
      remainingMealTimes: Type.Optional(Type.Array(
        Type.String({ pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" }),
        { maxItems: 32 },
      )),
    }),
    execute: async (_id, rawParams) => {
      const params = rawParams as {
        grades: DiarrheaGrade[];
        cumulativePowderGrams: number;
        observedAt: string;
        remainingMealTimes?: string[];
      };
      const production = await productionDecisionsForBatch(context);
      const preview = previewDiarrheaAdjustment({
        decision: production.selectedDecision,
        grades: params.grades,
        cumulativePowderGrams: params.cumulativePowderGrams,
        observedAt: params.observedAt,
        remainingMealTimes: params.remainingMealTimes,
      });
      const severe = params.grades.includes("severe");
      return record(context, "preview_diarrhea_adjustment", {
        decision: preview,
        deviceOperation: {
          mode: preview.setting.mode,
          remainingDailyPowderGrams: preview.setting.dailyPowderGrams,
          singlePowderGrams: preview.setting.singlePowderGrams,
          timedMeals: preview.setting.timedMeals,
          clearFreeFeedingWindows: true,
          requiresHumanApproval: true,
          manualDispositionRequired: severe,
        },
        severeException: severe
          ? "严重异常：暂停常规增量，执行现场检查并进入人工处置。"
          : null,
      }, {
        sopVersion: preview.evidence.sopVersion,
        modelVersion: preview.evidence.modelVersion,
        calculationDate: preview.evidence.calculationDate,
        basis: "previewDiarrheaAdjustment 使用设备累计实际下粉量，只重排剩余定时餐；预览不自动生效。",
        evidence: preview.evidence,
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
  ];
}
