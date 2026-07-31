import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  computeProductionPlan,
  getModelDerivedMealAmount,
} from "../model/production-model.js";
import {
  checkDataQuality,
  checkExecutionGap,
  computeSopMeal,
  DEFAULT_SOP_TEMPLATE,
  teachingProgramTimes,
} from "../sop/engine.js";
import { searchKnowledge } from "../knowledge/sop-knowledge.js";
import {
  supabaseInsert,
  supabaseRest,
  type SupabaseRuntime,
} from "../shared/supabase-rest.js";

export interface AgentRequestContext {
  env: SupabaseRuntime;
  token: string;
  userId: string;
  batchId: string;
  sessionId: string;
  evidence: Map<string, unknown>;
}

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
): ReturnType<typeof result<T>> {
  context.evidence.set(toolName, details);
  return result(details);
}

async function currentRun(context: AgentRequestContext) {
  const rows = await supabaseRest<Array<Record<string, unknown>>>(
    context.env,
    context.token,
    `/rest/v1/feeding_sop_runs?batch_id=eq.${encodeURIComponent(context.batchId)}&status=in.(active,paused)&select=*&order=started_at.desc&limit=1`,
  );
  const run = rows[0] ?? null;
  if (!run) return null;
  const storedPhase = String(run.phase || "adaptation");
  if (
    run.status === "active" &&
    ["adaptation", "first_teaching", "teaching_loop", "production_feeding"]
      .includes(storedPhase)
  ) {
    const now = Date.now();
    const firstTeaching = Date.parse(String(run.first_teaching_at));
    const admitted = Date.parse(String(run.admitted_at));
    const template = (run.template_snapshot ?? {}) as Record<string, unknown>;
    const offsetMinutes = finiteNumber(template.utcOffsetMinutes, 480);
    const endDayOffset = Math.max(
      0,
      Math.floor(finiteNumber(template.teachingProgramEndDayOffset, 1)),
    );
    const endMatch = String(template.teachingProgramEndLocal ?? "08:00")
      .match(/^(\d{2}):(\d{2})$/);
    const endMinutes = endMatch ? Number(endMatch[1]) * 60 + Number(endMatch[2]) : 480;
    const localDate = new Date(admitted + offsetMinutes * 60_000)
      .toISOString()
      .slice(0, 10);
    const teachingEnd =
      Date.parse(`${localDate}T00:00:00.000Z`) +
      endDayOffset * 86_400_000 +
      endMinutes * 60_000 -
      offsetMinutes * 60_000;
    run.phase =
      Number.isFinite(firstTeaching) && now < firstTeaching
        ? "adaptation"
        : Number.isFinite(teachingEnd) && now < teachingEnd
          ? "teaching_loop"
          : "production_feeding";
  }
  return run;
}

function finiteNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

async function productionPlanForBatch(
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
  const batches = await supabaseRest<Array<{
    config?: Record<string, unknown>;
    records?: Array<Record<string, unknown>>;
    current_day_index?: number;
    control_start_day?: number;
  }>>(
    context.env,
    context.token,
    `/rest/v1/batches?id=eq.${encodeURIComponent(context.batchId)}&select=config,records,current_day_index,control_start_day&limit=1`,
  );
  const batch = batches[0];
  if (!batch) throw new Error("NBJ_BATCH_NOT_FOUND");
  const config = batch.config ?? {};
  const run = await currentRun(context);
  const template = (run?.template_snapshot ?? DEFAULT_SOP_TEMPLATE) as typeof DEFAULT_SOP_TEMPLATE;
  const startAge = overrides.startAge ?? finiteNumber(config.startAge, 3);
  const endAge = overrides.endAge ?? finiteNumber(config.endAge, 21);
  const currentDayIndex = finiteNumber(batch.current_day_index, 0);
  return computeProductionPlan({
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
    programStartLocal: template.productionProgramStartLocal ?? "00:00",
  });
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
      const batches = await supabaseRest<Array<Record<string, unknown>>>(
        context.env,
        context.token,
        `/rest/v1/batches?id=eq.${encodeURIComponent(context.batchId)}&select=id,config,records,current_day_index,status,revision,updated_at&limit=1`,
      );
      const run = await currentRun(context);
      const tasks = run
        ? await supabaseRest<Array<Record<string, unknown>>>(
            context.env,
            context.token,
            `/rest/v1/feeding_sop_events?run_id=eq.${encodeURIComponent(String(run.id))}&status=in.(pending,scheduled,overdue,exception)&select=*&order=scheduled_at.asc,sequence.asc`,
          )
        : [];
      const productionPlan = batches[0]
        ? await productionPlanForBatch(context)
        : null;
      return record(context, "get_batch_context", {
        batch: batches[0] ?? null,
        run,
        openTasks: tasks,
        fullFeedingCurve: productionPlan,
      });
    },
  };

  const getTodayTimeline: AgentTool = {
    name: "get_today_timeline",
    label: "读取今日流程",
    description: "读取当前批次按时间排序的饲喂、巡栏、饮水和维护任务。",
    parameters: Type.Object({}),
    execute: async () => {
      const run = await currentRun(context);
      const tasks = run
        ? await supabaseRest<Array<Record<string, unknown>>>(
            context.env,
            context.token,
            `/rest/v1/feeding_sop_events?run_id=eq.${encodeURIComponent(String(run.id))}&select=*&order=scheduled_at.asc,sequence.asc`,
          )
        : [];
      return record(context, "get_today_timeline", {
        calculationDate: new Date().toISOString().slice(0, 10),
        sopVersion: run?.template_version ?? DEFAULT_SOP_TEMPLATE.version,
        tasks,
      });
    },
  };

  const computeProduction: AgentTool = {
    name: "compute_production_plan",
    label: "计算生产饲喂计划",
    description: "从当前批次调用唯一权威 feeding-model + V5-Lite，返回完整日龄配奶曲线、餐次、定时下奶时间、下粉量和风险。",
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
      const details = await productionPlanForBatch(context, params);
      return record(context, "compute_production_plan", details);
    },
  };

  const computeTeaching: AgentTool = {
    name: "compute_sop_meal",
    label: "计算教奶餐",
    description: "按 SOP 直接总量、SOP 参数推导、生产模型兜底的顺序确定教奶量；设备只设置下粉量和下奶时间。",
    parameters: Type.Object({
      activeHeadCount: Type.Integer({ minimum: 1, maximum: 10000 }),
    }),
    execute: async (_id, rawParams) => {
      const params = rawParams as { activeHeadCount: number };
      const run = await currentRun(context);
      const template = (run?.template_snapshot ?? DEFAULT_SOP_TEMPLATE) as typeof DEFAULT_SOP_TEMPLATE;
      const production = await productionPlanForBatch(context, {
        headCount: params.activeHeadCount,
      });
      const modelMeal = getModelDerivedMealAmount(production);
      const scheduledMealCount = run
        ? teachingProgramTimes({
            firstTeachingAt: String(run.first_teaching_at),
            admittedAt: String(run.admitted_at),
            template,
          }).length
        : 1;
      const details = {
        ...computeSopMeal(
          params.activeHeadCount,
          modelMeal,
          template,
          scheduledMealCount,
          0,
        ),
        basis:
          "数量权威顺序为 SOP 直接总量、SOP 参数可推导总量、feeding-model + V5-Lite 兜底；时间由冻结 SOP 排定。",
      };
      return record(context, "compute_sop_meal", details);
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
      const quality = context.evidence.get("check_data_quality") as
        | { mayDraftStandardDecision?: boolean; exceptionMode?: boolean }
        | undefined;
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
        context.env,
        context.token,
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
  ];
}
