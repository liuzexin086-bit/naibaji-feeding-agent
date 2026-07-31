# 奶爸机 Agent V2 共享契约

## 目标

在 `agent` 子项目内实现确定性奶量/设备决策、批次级 Agent 工具和可恢复的流式对话。旧 Supabase 适配器暂时保留，但新模块必须通过仓储接口访问数据，不能把 LLM 作为计算依赖。

## 共享类型

```ts
export type FeedingMode = "timed_quantity" | "free_feeding";
export type CreepGrade = "none" | "low" | "medium" | "high";
export type RiskLevel = "normal" | "elevated" | "high" | "exception";

export interface DeviceWindow { startLocal: string; endLocal: string; }
export interface DeviceSetting {
  mode: FeedingMode;
  dayAge: number;
  dailyPowderGrams: number;
  singlePowderGrams: number;
  mealCount: number;
  timedMeals: Array<{ timeLocal: string; powderGrams: number }>;
  freeWindows: DeviceWindow[];
  precisionGrams: number;
  source: "sop_direct" | "sop_indirect" | "production_model";
}
export interface DecisionEvidence {
  sopVersion: string;
  modelVersion: string;
  calculationDate: string;
  reasons: string[];
  inputs: Record<string, unknown>;
  steps: Array<{ name: string; value: unknown; explanation: string }>;
}
export interface FeedingDecision {
  revision: number;
  batchId: string;
  dateLocal: string;
  setting: DeviceSetting;
  risk: { level: RiskLevel; score: number; overCurveRatio: number; reasons: string[] };
  evidence: DecisionEvidence;
  status: "draft" | "active" | "superseded";
}
```

## 决策接口

```ts
computeDayDecision(input: DayDecisionInput): FeedingDecision;
previewDiarrheaAdjustment(input: DiarrheaAdjustmentInput): FeedingDecision;
```

决策顺序固定为：SOP 直接总量 → SOP 参数可推导总量 → `feeding-model + V5-Lite`。模型标准曲线为上限；`>100%` 标记腹泻风险，`>115%` 标记高风险并禁止自动启用。教槽等级为无/低/中/高，对应 0、<30、30–<70、≥70；三日采用多数档。

## Agent 工具契约

工具必须只返回 JSON 证据，所有数字带 `sopVersion`、`modelVersion`、`calculationDate` 和 `evidence`：

`get_batch_context`、`get_today_timeline`、`compute_production_plan`、`compute_sop_meal`、`check_execution_gap`、`check_data_quality`、`manage_laggard_case`、`search_feeding_knowledge`、`draft_daily_decision`、`preview_diarrhea_adjustment`。

## HTTP/SSE 契约

- `POST /api/agent/chat`：请求 `{ batchId, sessionId, message, clientMessageId }`；响应 SSE 事件 `message_start`、`delta`、`tool_evidence`、`message_end`、`error`。
- `POST /api/batches/:id/advance`：保存当天最小记录并原子返回 `{ closedDay, nextDay, decision, tasks }`；重复 `idempotencyKey` 返回同一结果。
- `POST /api/batches/:id/diarrhea/preview`：请求必须包含 `{ observedAt, grades, cumulativePowderGrams }`，返回未生效的 `FeedingDecision`。
- 旧 revision 统一返回 HTTP 409 和错误码 `NBJ_AGENT_STALE`。
- 认证失败 401，权限不足 403，参数错误 400，确定性规则错误 422，LLM 故障 503；LLM 故障不阻塞数据和决策接口。

## 文件所有权

- 决策智能体：`src/decision/**`、`src/shared/agent-v2-contract.ts`、`tests/decision/**`。
- Agent/流式智能体：`src/container/tools.ts`、`src/container/server.ts`、`src/agent/**`、`tests/agent/**`。
- 运行配置与部署智能体：`src/container/runtime-config.ts`、`Dockerfile`、`wrangler.jsonc`、`docker/**`、`README.md`、`tests/runtime/**`。

智能体不得修改其他所有权范围；如发现契约冲突，先报告主智能体，不自行重写公共接口。
