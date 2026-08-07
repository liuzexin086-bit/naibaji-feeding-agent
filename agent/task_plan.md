# Codex Work Plan: SOP 驱动 LangGraph v2 与“今日操作”

## NBJ-SAFETY-P1 Execution State

执行依据：用户消息中提供的《NBJ-SAFETY-P1-Codex-Plan.md》全文。仓库中未找到同名计划文件，已在 P1-0 证据中记录该事实；后续以消息内计划为准。

- P1-0 baseline and optimizer quarantine: complete
- P1-1 unify optimizer parameter contract: complete
- P1-2 make growth calibration identifiable: complete
- P1-3 enforce diarrhea adjustment safety contract: complete
- P1-4 persist post-confirmation amendments: complete
- P1-5 render protected numeric facts deterministically: complete
- P1-6 add safety release gates and evidence: complete

## Review Remediation — 2026-08-06

针对复审 `FAIL WITH BLOCKING FINDINGS` 的修复批次：

- P0-1: amendment `confirm` 只记录审批，不激活设备决策；`apply` 才创建 active decision 并保存 `decision_id`；manual-only 不能 apply。
- P0-2: 新增 `daily_operation_amendment_actions` 动作幂等表，confirm/reject/apply 重放返回原始结果。
- P0-3: 未填写 `diarrheaGrade` 不再落成 `none`，只有显式 `none` 才关闭事件。
- P1-3/P1-4: origin ID 包含 user/batch/immutable observation id；同 origin 不同 digest/revision fail closed。
- P1-5: severity 可为 null，新增 priority；creep_control 修订不再显示为“腹泻轻度”。
- P1-1/P1-2: 顶层 schemaVersion 校验、farm_tune 导入、边界感知梯度、CLI smoke。
- P1-6: 最近消息改为最新 N 条后升序返回；evidence 精确 SQL 查询。
- P1-7 请求体/登录限速按原计划保留为 P3 范围，不在本次 P1 修复。

## NBJ-SAFETY-P1-R1 Execution State

- R1-1 Observation + Batch + Feedback 原子事务: complete
- R1-2 Amendment revision/source lifecycle: complete
- R1-3 Explicit-none 自动 supersede: complete
- R1-4 Remaining-deliverable 设备方案约束: complete
- R1-5 LangGraph amendment 状态投影: complete
- R1-6 V8→V9 索引迁移测试: complete

## NBJ-SAFETY-P1-R2 Execution State

- R2-1 Schema V9→V10 with superseded/cancelled and exact old V9 migration test: complete
- R2-2 Diarrhea status from observation event history: complete
- R2-3 Supersede audit with system action semantics: complete
- R2-4 Permanent `daily_observations.id` binding: complete
- R2-5 mild→omitted API integration regression: complete

## NBJ-SAFETY-P1-R3 Execution State

- R3-1 V9→V10 migration preserves `daily_operation_amendment_actions`: complete
- R3-2 V9 confirmed/applied amendment + action-history + idempotency replay regression: complete
- R3-3 `recordedAt`/`observedAt` UTC normalization and epoch-based observation sorting: complete
- Message list uses monotonic `created_at` plus chronological ordering so latest-N retrieval is stable under rapid writes.

## NBJ-SAFETY-P1-R3.1 Execution State

- R3.1-1 Strict calendar-valid ISO parser with real day/month/year, hour/minute/second and offset ranges: complete
- R3.1-2 Invalid legacy timestamps sort as oldest, never newest: complete
- R3.1-3 Parser, feedback sorting, and API impossible-calendar-date regressions: complete

## NBJ-SAFETY-P1-R3.2 Execution State

- R3.2-1 Invalid legacy observations are quarantined before diarrhea/creep decisions: complete
- R3.2-2 Feedback, Agent tool, and LangGraph summary paths filter malformed timestamps: complete
- R3.2-3 Only-invalid diarrhea, only-invalid creep, and valid-source preference regressions: complete

## NBJ-SAFETY-P1 Final Acceptance — 2026-08-07

- NBJ-SAFETY-P1: PASS
- Safety Contract Gate: OPEN
- Merge to main Gate: OPEN
- Optimizer Production Gate: CLOSED
- Real Device Control Gate: CLOSED

## NBJ-DIARRHEA-CLOSURE Revision — 2026-08-07

- Mild diarrhea is an individual intervention: isolate affected piglets, one piglet milk-control opportunity, no whole-pen device change and no `DeviceSetting` proposal.
- Moderate diarrhea is a whole-pen feeding reduction: one frozen-priority meal/window removed, mode preserved, independent human confirmation required before apply.
- Severe diarrhea is an emergency manual path: immediate isolation, clinical/environment checks, no device proposal, no automatic medication/diagnosis.
- `DiarrheaAdjustmentKind` now uses `individual_intervention`, `feeding_reduction_proposal`, and `manual_only`; `preview_only` and mild-as-proposal are removed.
- Unknown cumulative actual powder in moderate fails closed to `manual_only`; no assumed-zero device proposal.
- LangGraph deterministic responses, Agent tools, UI labels, and regressions follow the revised mild/moderate/severe contract.

## NBJ-DIARRHEA-CLOSURE-R1 — 2026-08-07

- Moderate diarrhea is removed from `DailyOperationPlan.proposedSetting` and materialized as an independent amendment even before routine plan confirmation.
- `today-operations/confirm` never applies diarrhea proposals; only amendment `confirm → apply` creates an active device decision.
- Mild and severe no longer create device amendments; they are audited as individual intervention or emergency manual disposition.
- Frontend renders independent diarrhea exception cards with mild/manual, moderate confirm/reject/apply, and severe manual actions.
- Docker web image builds from source-controlled `agent/ui/` and root static files without requiring gitignored `agent/public`; `/version` reports the build commit.

## NBJ-DIARRHEA-CLOSURE-R2 — 2026-08-07

- Confirmed amendments support `confirmed → cancelled` with a dedicated cancel endpoint and idempotent action record.
- Frontend confirmed card uses `取消调整` instead of an invalid `拒绝调整`; apply success reloads the canonical batch/today so top device settings refresh immediately.
- System prompt now states the revised mild/moderate/severe diarrhea contract instead of asking for concrete whole-pen device operations.
- Manual diarrhea actions use a stable `localStorage`-backed idempotency key per batch/observation/action.
- Removed unused `DIARRHEA_RATIO` residual values.

## NBJ-DIARRHEA-CLOSURE-R3 — 2026-08-07

- Mild completion uses `diarrhea.individual_intervention_completed` with explicit isolation + one piglet milk-control completion audit fields.
- Manual-action idempotency keys are deterministic (`diarrhea-manual:<batch>:<feedbackOriginId>:<action>`) and bind `feedbackOriginId`/`observationId`.
- Cancelled and superseded amendment UI labels/cards are explicit; cancelled moderate card says the plan is cancelled and device program unchanged.
- Added exact V10 → V11 migration regression preserving two action rows, payloads, replay, cancel CHECK, FK and integrity.

约束：不 reset/checkout/清理既有用户改动；每个阶段独立提交；不 push、不 merge、不打 tag；所有安全异常 fail closed。

## Goal

将当前通用 ReAct LangGraph 升级为 SOP 驱动的确定性编排：每天所有常规人工 SOP 操作汇总到独立“今日操作”栏并且一天只确认一次；管理员可在 SOP 中配置并发布8个自由采食时间段；批次继续冻结 SOP 与设备方案快照。

## Delivery Boundary

- 本文件是交给 Codex 执行的工程计划。
- 计划编制阶段不修改项目源码、不迁移数据库、不重建容器。
- 后续 Codex 必须按阶段实施、验证和更新本文件状态，不得跳过 P0 安全修复。

## Current Phase

Phase 8 verification and migration evidence complete. The persistent local stack
was deliberately left stopped; all container and schema checks used isolated
volumes or a verified backup clone.

## Four Mandatory P0 Gates

以下四项是 LangGraph v2 编排的前置安全门禁，不是普通待办。`P0-01`～`P0-04` 必须全部实现并通过回归测试，才允许开始依赖它们的 Phase 1～8 集成、容器重建或发布。

| ID | Defect | Required correction | Fail-closed behavior | Release proof |
|---|---|---|---|---|
| `P0-01` | Agent 本地 `currentRun()` 返回 `null`，Agent 与本地 API 读取的批次模式/设备方案可能漂移 | 抽取并共用 `BatchDecisionService`；Agent 必须按批次 revision 读取冻结的 `devicePlanSnapshot`、`selectedMode`、`effectiveMode`、阶段条件和异常阻断 | 找不到当前批次或冻结设备快照时阻断计划与数值建议，不得临时拼装另一套方案 | 同一批次 revision 下，Agent 与本地 API 的模式、设备 hash、餐次、窗口和数量逐项一致 |
| `P0-02` | 冻结 SOP 缺失时会回退 `DEFAULT_SOP_TEMPLATE` | 数值决策只接受批次冻结 SOP/version/hash；知识检索也必须限定冻结 digest | 缺失或 digest 不匹配时：数值路径进入 `safe_block`，知识路径返回 `unavailable`；禁止使用最新或默认 SOP | 缺失、错 hash、旧 revision 三组测试均不产生设备数值，且不会读取默认模板 |
| `P0-03` | 以 `HH:mm` 字符串判断剩余餐次会丢失跨午夜的 `02:00/05:00/08:00` | 所有餐次、排除时段和自由采食窗口统一归一化到 `09:00` 至次日 `09:00` 业务日轴 | 无法归一化、窗口重叠或日期归属不明时拒绝生成计划；控奶不得重排保留餐次 | 在 `23:30` 计算时仍正确保留次日三餐；跨午夜窗口、排除和控奶回归测试通过 |
| `P0-04` | Agent 最终回答没有程序化数值证据校验 | `build_evidence_plan` 生成必需证据，工具回执形成 `numericWhitelist`，`validate_evidence` 与 `validate_response` 双重校验 | 任一时间、数量、餐次数或设备参数无法映射到同 revision/digest 的确定性回执时拒绝输出 | 对无证据、过期回执、篡改数值和正常数值分别测试；只有正常证据可通过 |

统一退出条件：

- 四项各自的单元、集成和 Agent/local API parity 测试全部通过；
- 四项未关闭前，Phase 6 不得替换旧编排，Phase 8 不得重建生产式本地 Compose 栈；
- 不允许以 feature flag、默认模板、模型提示词或人工口头确认绕过任何 P0；
- 修复必须先保留数据库备份和现有运行配置，并提供恢复到上一镜像/提交的回滚步骤。

## Locked Product Rules

1. 首日有效模式固定为 `timed_quantity`，餐次严格为 `17:00/20:00/23:00/02:00/05:00/08:00`。
2. 第二日起操作员只选择已有冻结模板；`selectedMode` 与 `effectiveMode` 分离，两模板互不覆盖。
3. 控奶只关闭冻结优先级指定的餐次，不改变保留餐次的时间和顺序。
4. 自由采食模板在管理员 SOP 编辑页固定提供8行时间段设置；每行包含启用状态、开始时间、结束时间和可选名称。
5. 每个自由采食模板必须启用1～8个有效时间段；允许跨午夜，但按09:00至次日09:00业务日归一化后不得重叠。
6. SOP 发布后，自由采食8行配置、阶段条件、异常阻断、版本和 hash 随新批次冻结；旧批次不受后台后续编辑影响。
7. 一个批次在一个业务日内只生成一份常规人工操作计划、只允许一次完成确认。
8. 现场端单独提供“今日操作”栏，汇总当天所有常规人工 SOP 操作；不为每条操作分别提供确认按钮。
9. 每日一次确认只覆盖常规 SOP 操作。异常处置、第三日弱仔去留、模式变更和设备方案调整继续使用独立审批与审计，不能被日确认替代。
10. Agent 只生成计划和待审批草案，永不直接控制设备。

## LangGraph v2 Orchestration Design

本节是实现规范，不依赖聊天上下文。Codex 实施 Phase 6 时必须保持以下图结构、状态契约、恢复语义和安全边界。

### Two-layer graph ownership

- `TurnGraph`：处理一次用户消息或系统事件，负责鉴权后的上下文装载、意图分类、证据规划、SSE、响应校验和持久化。
- `BatchSopGraph`：表达批次长期 SOP 状态，负责阶段、模式、异常、审批、每日操作计划和幂等语义。
- 两层图只编排流程，不计算奶量、餐次调整或设备参数；所有数值继续由 `src/decision/core.ts`、`src/model/production-model.ts` 和确定性工具产生。
- 图不驻留等待真实时间。定时任务由调度器生成事件后重新进入图；Agent 永不直接控制设备。

### TurnGraph main path

```text
START
  → load_turn_scope
  → verify_frozen_snapshot
  → safety_preflight
  → classify_intent
  → build_evidence_plan
  → route_subgraph
  → validate_evidence
  → action_gate
  → render_response
  → validate_response
  → persist_response
  → END
```

固定安全路由优先级：

```text
exception
  > laggard
  > device_plan_or_mode
  > timeline_or_today_operations
  > knowledge
  > general
```

- `safety_preflight` 命中异常、弱仔或设备阻断时，直接采用更高优先级路由，不允许模型降级为普通问答。
- 只有确定性规则无法归类时，模型才可从受限枚举中返回意图；模型不能选择工具、构造参数、决定数值或绕过审批。
- `build_evidence_plan` 根据意图映射静态工具顺序和必需证据，禁止自由 ReAct 工具循环。

### BatchSopGraph and subgraphs

#### `device_plan_subgraph`

输入必须包含冻结的 SOP、设备方案、批次 revision、`selectedMode` 和 `effectiveMode`。

- 首日始终生成定时定量六餐：`17:00/20:00/23:00/02:00/05:00/08:00`。
- 第二日起只读取随批次冻结的定时定量模板或自由采食模板。
- 异常、控奶或设备限制可把 `effectiveMode` 临时降级为定时定量，但不得覆盖 `selectedMode`，也不得修改任一冻结模板。
- 所有设备计划和调整结果由确定性核心渲染；模型只解释，不生成数值。

#### `first_day_subgraph`

按 SOP 阶段执行下列节点：入栏前检查 → 入栏 → `8–10h` 适应 → 迟到冲突转主管 → `17:00` 首次教槽 → `10min` 赶动 → 首夜六餐 → 观察循环 → 弱仔分支。

- 入栏过晚导致适应时长与 17:00 教槽冲突时，不自行压缩 SOP，生成主管审批草案。
- 阶段输出进入当日操作计划；常规操作不逐条中断，也不逐条确认。

#### `timed_quantity_subgraph`

- 只读取冻结的时间点、排除时段、精度和 `reductionPriority`。
- 控奶仅关闭明确指定或按冻结优先级命中的餐次。
- 保留餐次的时间、顺序和数值精度不得重排或重算为另一套模板。

#### `free_feeding_subgraph`

- 只读取管理员已发布并随批次冻结的8行时间段配置、阶段条件和异常阻断。
- 配置必须恰有8个 slot，启用数量为 `1..8`；允许跨午夜，但须在 `09:00` 至次日 `09:00` 业务日轴上归一化且不重叠。
- 任一阶段条件或异常阻断命中时 fail closed：生成阻断证据，并使 `effectiveMode` 使用确定性降级方案；不得改写 `selectedMode` 或自由采食模板。

#### `exception_subgraph`

- 先读取批次、观察、质量和当前计划证据，再判断缺失字段。
- 腹泻必须收集等级、累计实际采食量和观察时间。
- 拒食、空腹、堵料、探针异常和死亡等情形必须进入人工处置或审批，不能由模型给出设备执行命令。
- 只追问真正缺失的字段；设备或方案变化必须形成独立审批和审计事件。

#### `laggard_subgraph`

- 记录弱仔标识和证据，安排慢速补喂及 `2–3` 次重新教槽。
- 第三日去留是独立审批，不并入“今日操作”的一次确认。

#### `timeline_today_operations_subgraph`

为当前业务日生成或读取一份冻结的 `DailyOperationPlan`，覆盖 SOP 对应阶段：

```text
ensure_daily_operation_plan
  → load_or_freeze_today_operations
  → return_today_operation_column
  → confirm_once_per_business_day_via_dedicated_api
```

- 准备与入栏前检查；
- `8–10h` 适应、首日 17:00 教槽、10 分钟赶动和首夜观察；
- `8–11` 日龄教槽、`12–14` 日龄 `4:1` 奶泡料、`20+` 日龄渐进转料；
- 每日巡检、每2日维护、每7日维护和批次结束维护。

全部常规人工操作聚合进独立“今日操作”栏：一个批次、一个业务日只生成一份计划并只确认一次。单项任务不带确认状态，也不触发图中断。阶段任务只提示人员操作，不自动切换饲喂模式。

#### `knowledge_subgraph`

- 检索必须限定批次冻结的 `sopSourceSha256`、SOP version 和 collection revision。
- 优先 Chroma；不可用时只允许使用相同 digest 的本地词法索引；没有 digest 匹配则返回 `unavailable`，禁止静默读取最新 SOP。
- 证据返回 section/chunk 引用。SOP 文本是解释证据，不能覆盖确定性决策输入或生成设备数值。

#### `approval_subgraph`

- 草案 ID 由 `userId + batchId + sessionId + turnId + actionDigest` 稳定派生。
- 中断载荷只暴露 `approvalId`、`basedOnRevision`、`actionDigest` 和安全摘要。
- 审批事实写入业务 SQLite；恢复使用 LangGraph `Command`，恢复后重新读取审批状态、批次 revision、SOP digest 和设备方案 digest。
- revision/digest 已变化、审批被拒绝或草案过期时取消动作并返回 stale，不复用旧决定。
- 模式切换继续通过图外 `POST /api/batches/:id/mode` 完成并审计。
- “今日操作”常规确认不是审批中断：使用专用的一日一次确认 API，不能进入此子图。

### Typed graph state

```ts
interface AgentGraphState {
  turn: {
    turnId: string;
    userId: string;
    batchId: string;
    sessionId: string;
    clientMessageId: string;
    messageRef: string;
    graphVersion: string;
  };
  snapshot: {
    batchRevision: number;
    currentDayIndex: number;
    currentDayAge: number;
    selectedMode: FeedingMode;
    effectiveMode: FeedingMode;
    sopRef: FrozenSopRef;
    devicePlanRef: FrozenDevicePlanRef;
  };
  intent: {
    kind: IntentKind;
    requestedDay?: string;
    asksForExplanation: boolean;
    requestsMutation: boolean;
    confidence: number;
  };
  safety: {
    exceptionMode: boolean;
    blockers: SafetyBlocker[];
    missingFields: string[];
  };
  evidencePlan: {
    requiredTools: PlannedToolCall[];
    optionalTools: PlannedToolCall[];
    responseKind: ResponseKind;
  };
  evidenceRefs: EvidenceRef[]; // reducer key: toolName + inputDigest
  dailyOperations?: {
    planId: string;
    businessDate: string;
    operationsSha256: string;
    status: "pending" | "confirmed";
  };
  approval: {
    approvalId: string;
    status: ApprovalStatus;
    basedOnRevision: number;
    actionDigest: string;
  } | null;
  responseSpec: {
    format: ResponseFormat;
    requiredEvidence: string[];
    numericWhitelist: NumericEvidence[];
  };
  outputRef?: string;
  errorCode?: string;
  status: TurnStatus;
}
```

Checkpoint 仅保存引用、digest 和必要摘要。严禁保存 API key、Bearer token、完整消息正文、完整批次对象、猪只标签、原始工具参数/结果或供应商响应正文。

### Node contracts

| Node | Required behavior |
|---|---|
| `load_turn_scope` | 校验用户、会话和批次归属；加载最小引用，不信任 graph `thread_id` 做鉴权。 |
| `verify_frozen_snapshot` | 校验 SOP 与设备方案 digest。缺设备快照时阻断数值建议；缺知识索引时仅把知识状态标记为 unavailable。 |
| `safety_preflight` | 依据结构化事实提升异常、弱仔和设备阻断路由。 |
| `classify_intent` | 返回受限 schema；禁止工具名、自由参数和未经证据的数值。 |
| `build_evidence_plan` | 从静态映射生成工具顺序、必需证据、响应种类和数值白名单要求。 |
| `execute_evidence` | 校验工具回执，将回执原子持久化，并只通过 `tool_evidence` SSE 发安全摘要。 |
| `validate_evidence` | 校验批次 revision、两个冻结 digest、必需回执和证据完整性。 |
| `action_gate` | 区分一日一次常规确认、异常审批、模式变更和只读回答。 |
| `render_response` | 设备、计划和异常结论使用确定性模板；模型仅可润色一般说明或基于引用解释知识。 |
| `validate_response` | 响应中每个数值必须能映射到 `numericWhitelist` 的确定性证据；否则 fail closed。 |
| `persist_response` | 先持久化最终文本、证据引用和状态，再发 `message_end`。 |

### Checkpoint, idempotency and replay

- `thread_id = nbj:${userId}:${batchId}:${sessionId}`；该值只用于图状态分区，不能代替授权检查。
- `checkpoint_ns = turn:${clientMessageId}`。
- checkpoint metadata 固定包含 `graphVersion`、`turnId`、`batchRevision`、SOP digest 和设备方案 digest。
- `agent_turns` 对 `(userId, sessionId, clientMessageId)` 建唯一约束，并使用短租约避免同一 turn 并发执行。
- 证据节点幂等键为 `turnId + nodeName + inputDigest`；审批或副作用幂等键为 `actionDigest`。
- 已完成 turn 从 assistant message store 重放；已中断 turn 从 checkpoint 恢复。
- 恢复时必须重新验证归属、revision 和两个 digest；变化时终止并返回 `NBJ_AGENT_STALE`，不得继续旧路径。
- 不迁移旧 v1 checkpoint；旧消息仍可读取，新消息一律进入 v2 namespace。
- checkpoint 使用独立 `/data/agent-checkpoints.db`。若 LangGraph SQLite saver 的 `better-sqlite3` 无法在 Node 24 slim 稳定构建，实现基于 `node:sqlite` 的 saver，并以恢复测试作为准入条件。

### SSE and persistence contract

保持现有事件名称：`message_start`、`delta`、`tool_evidence`、`message_end`、`error`。

- `tool_evidence` 可增加 `receiptId`，但不得包含原始工具参数、原始结果或敏感业务内容。
- 需要审批时，以 `delta` 输出待确认摘要，再以 `message_end` 和 `status: interrupted` 正常结束当前连接。
- 最终文本必须通过响应校验并成功持久化后才能发送 `message_end`。
- Abort 中止模型流和当前未提交节点；已提交的业务事实与回执不回滚，重试依靠幂等键恢复。

### Graph-out system boundaries

下列职责必须留在图外：

- `server.ts`：鉴权、会话/批次归属、SSE、历史记录、重放、Abort 和 LangSmith trace wrapper；
- SQLite 事务：批次推进、模式切换、每日确认、审批事实和审计；
- SOP 发布事务、Chroma 入库、embedding 服务和模型供应商 adapter；
- `decision/core.ts` 与 `production-model.ts` 的全部数值计算；
- 调度器/时间 worker 对业务时间事件的物化；
- 实际设备控制。

LangSmith 只发送 metadata：耗时、状态/错误码、版本、result ID 和 HMAC query hash。不得发送消息正文、批次数据、猪只标签、工具参数/结果、凭据或供应商响应正文。

### Failure policy

- 冻结设备方案缺失或数值证据不完整：阻断数值回答，不使用默认值。
- 冻结 SOP knowledge digest 缺失：知识回答 `unavailable`，不得回退最新版本。
- Chroma 不可用：仅回退相同 digest 的本地词法索引。
- 每日计划已确认：返回原确认，不创建第二次确认，也不因后续模式/异常变化重写原计划。
- SOP 发布：先建立 draft，完成解析、embedding、upsert 和 revision 校验后再原子标记 published；失败时旧发布版本继续有效。
- 审批恢复发现 stale：取消草案，不执行副作用，要求基于新 revision 重新生成。

## Data Contracts

### FreeFeedingWindowConfig

```ts
interface FreeFeedingWindowConfig {
  slot: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  enabled: boolean;
  label?: string;
  startLocal: string; // HH:mm
  endLocal: string;   // HH:mm; start > end means cross-midnight
}
```

Publication rules:

- SOP payload always contains exactly 8 ordered slots.
- Decision input uses only enabled slots.
- Enabled count must be `1..8`.
- Reject invalid local time, zero-duration windows, duplicate slots, normalized overlap, or missing stage/blocker configuration.
- Preserve slot order in the published config and snapshot hash.

### DailyOperationPlan

```ts
interface DailyOperationPlan {
  id: string;
  userId: string;
  batchId: string;
  businessDate: string;
  basedOnBatchRevision: number;
  sopTemplateId: string;
  sopSourceSha256: string;
  devicePlanVersion: string;
  devicePlanSha256: string;
  selectedMode: FeedingMode;
  effectiveMode: FeedingMode;
  operations: DailyOperationItem[];
  operationsSha256: string;
  status: "pending" | "confirmed";
  createdAt: string;
}
```

`DailyOperationItem` contains task code, title, due window, SOP section reference, required observation fields and safety notes. It must not contain per-item confirmation state.

### DailyOperationConfirmation

```ts
interface DailyOperationConfirmation {
  id: string;
  planId: string;
  userId: string;
  batchId: string;
  businessDate: string;
  operationsSha256: string;
  confirmedBy: string;
  confirmedAt: string;
  idempotencyKey: string;
}
```

Storage invariants:

- Unique `(user_id, batch_id, business_date)` for plans.
- Unique `(user_id, batch_id, business_date)` for confirmations.
- Confirmation transaction verifies plan ID, operation hash, current ownership and non-terminal batch.
- Repeated identical idempotency key replays the first result.
- A second different confirmation returns the existing confirmation and never creates another record.
- The daily plan is frozen when first materialized. Later mode changes or anomalies create separate audited events; they do not rewrite the confirmed daily plan or request a second routine confirmation.

## Phases

### Phase 0: Safety prerequisites

- [x] `P0-01`：修复 `currentRun() == null` 与模式/设备快照漂移；建立 Agent/local API 共用的 `BatchDecisionService` 读取路径。
- [x] `P0-02`：删除缺失冻结 SOP 时到 `DEFAULT_SOP_TEMPLATE` 的数值回退；缺失或不匹配必须 `safe_block`。
- [x] `P0-03`：修复 09:00 业务日轴上的跨午夜剩余餐次、排除时段和自由采食窗口计算。
- [x] `P0-04`：在最终响应前加入证据回执、revision/digest 和 `numericWhitelist` 的程序化校验。
- [x] 为四项 P0 分别增加单元测试、集成测试和 Agent/local API parity 测试。
- [x] 建立 `p0-release-gate` 测试命令或测试集合；任一 P0 失败时 CI/本地发布脚本必须非零退出。
- **Status:** complete

Acceptance:

- Agent and local API return the same selected/effective mode, device plan hash, meal times and quantities for the same batch revision.
- Missing or mismatched frozen metadata never produces equipment numbers.
- At 23:30, next-day 02:00/05:00/08:00 meals are handled correctly.
- Every emitted time, quantity and meal count is covered by deterministic evidence.
- Phase 0 can only be marked complete when `P0-01` through `P0-04` all have recorded passing evidence in `progress.md`.

### Phase 1: Consolidate BatchDecisionService and mode audit

- [x] Treat the P0-01 shared `BatchDecisionService` as the baseline; complete its canonical snapshot loading and `computeDayDecision` input contract without creating a second path.
- [x] Make `local-api.ts` and `tools.ts` thin adapters over this service.
- [x] Preserve local API transaction boundaries and mode-switch audit behavior.
- [x] Return `selectedMode`, `effectiveMode`, SOP ref, device plan ref and deterministic evidence in one canonical result.
- **Status:** complete

Primary files:

- `src/decision/batch-decision-service.ts` (new)
- `src/container/local-api.ts`
- `src/container/tools.ts`
- `src/shared/agent-v2-contract.ts`

### Phase 2: Extend SOP config to eight free-feeding slots

- [x] Add exact eight-slot config types and validation.
- [x] Normalize windows to the 09:00 business-day axis and reject overlap.
- [x] Preserve stage conditions and exception blockers.
- [x] Include all eight slots in publication config and device plan snapshot hash.
- [x] Use only enabled slots when calling the deterministic core.
- [x] Ensure republishing creates a new immutable SOP/device-plan revision.
- **Status:** complete

Primary files:

- `src/shared/local-store-contract.ts`
- `src/container/local-api.ts`
- `src/knowledge/sop-publication.ts`
- `src/decision/core.ts` only if normalized window support belongs in the core

### Phase 3: Administrator SOP editor

- [x] Add a “自由采食时间段” section with exactly eight numbered rows.
- [x] Each row has enabled, label, start and end controls.
- [x] Show inline validation for invalid, zero-length and overlapping windows.
- [x] Serialize all eight rows into `freeFeedingTemplate.windows` on publish.
- [x] Copying an SOP version restores all eight rows exactly.
- [x] Display published template version/hash/revision and enabled-window count.
- [x] Do not allow editing a published version in place.
- **Status:** complete

Primary files:

- `E:\plan\admin.html`
- `E:\plan\admin.js`
- `tests/ui-shell-contract.test.ts`

### Phase 4: Daily operation plan persistence

- [x] Add `daily_operation_plans` and `daily_operation_confirmations` tables and indexes.
- [x] Implement `ensureDailyOperationPlan` as an idempotent transaction.
- [x] Aggregate routine human operations from the frozen SOP stage, daily patrol and maintenance schedule.
- [x] Store the operation list and SHA-256 at materialization time.
- [x] Implement one-per-business-day confirmation and matching audit event.
- [x] Do not mutate batch revision merely to confirm routine work; store `basedOnBatchRevision` and validate ownership/status instead.
- **Status:** complete

Primary files:

- `src/local-db/schema.ts`
- `src/local-db/index.ts`
- `src/shared/local-store-contract.ts`
- local integration tests

### Phase 5: Local API for “今日操作”

- [x] Add `GET /api/batches/:id/today-operations?dateLocal=YYYY-MM-DD`.
- [x] GET lazily creates or returns the frozen daily plan.
- [x] Add `POST /api/batches/:id/today-operations/confirm`.
- [x] POST body contains `planId`, `operationsSha256`, `idempotencyKey` and optional note.
- [x] Return confirmation, `replayed`, and full public plan status.
- [x] Map stale plan/hash, already confirmed, unauthorized and terminal batch errors to stable `NBJ_*` codes.
- [x] Record `daily_operations.confirmed` with actor, business date, plan ID, operation hash and frozen snapshot references.
- **Status:** complete

### Phase 6: SOP-driven LangGraph v2

- [x] Replace free-form tool selection with deterministic intent routing and static evidence plans.
- [x] Add `timeline_subgraph` backed by `ensureDailyOperationPlan`; local timeline must no longer return an empty array.
- [x] Add first-day, timed, free, abnormal, laggard, knowledge and approval subgraphs.
- [x] `daily_operation_gate` returns the complete daily operation plan but never interrupts once per item.
- [x] Daily confirmation is performed through the dedicated API/tool once, not via multiple graph interrupts.
- [x] Abnormal/device/mode actions remain separate approval paths.
- [x] Add `validate_evidence` and `validate_response` nodes.
- [x] Checkpoint only refs/summaries; business evidence and approval facts remain in SQLite.
- **Status:** complete

Primary files:

- `src/agent/langgraph/runtime.ts`
- `src/agent/langgraph/state.ts` (new)
- `src/agent/langgraph/router.ts` (new)
- `src/agent/langgraph/subgraphs/*` (new)
- `src/container/server.ts`
- `src/container/tools.ts`

### Phase 7: Onsite “今日操作” column

- [x] Add a visually separate “今日操作” column to the deployed onsite UI.
- [x] Show business date, plan snapshot status, effective mode and all routine operations.
- [x] Show one button only: `确认今日操作已完成`.
- [x] After confirmation, replace the button with confirmer and timestamp; no second routine confirmation action is available.
- [x] Keep abnormal alerts and approval cards outside this column.
- [x] Mode selector remains independent and cannot rewrite today’s frozen operation plan.
- [x] Handle offline/retry through idempotency key without duplicate confirmation.
- **Status:** complete

Primary files:

- `ui/liquid-index.html`
- `scripts/prepare-assets.mjs` only if asset preparation needs contract changes
- `tests/ui-shell-contract.test.ts`

### Phase 8: Verification and migration

- [x] Run full unit, integration, contract and UI tests.
- [x] Add concurrent confirmation tests proving one row and one audit event.
- [x] Test all 8 free windows, disabled slots, overlap and cross-midnight normalization.
- [x] Test SOP republish and old-batch snapshot immutability.
- [x] Test first-day lock, mode round-trip, control no-reschedule and abnormal fallback.
- [x] Test LangGraph receipt validation and completed-checkpoint replay.
- [x] Run `npm test`, `npm run check`, `npm run build`, `git diff --check`.
- [x] Build Compose images and run Chroma/embedding/checkpoint/Nginx SSE smoke tests in isolated volumes.
- [x] Back up database and runtime config before schema migration or container replacement.
- [x] Prove that current published SOP and business data survive a current-schema migration of the verified backup clone; source data was never reset or attached.
- **Status:** complete — release evidence is isolated and reversible; no persistent runtime volume was started or replaced.

## Acceptance Test Matrix

| Area | Scenario | Expected |
|---|---|---|
| Daily operations | 5 routine tasks on one day | One column, one plan, one confirmation button |
| Confirmation replay | Same idempotency key repeated | Same confirmation, `replayed=true`, one audit row |
| Confirmation concurrency | Two operators confirm simultaneously | One confirmation row; both receive the canonical result |
| After confirmation | Later anomaly occurs | No second routine confirmation; separate abnormal approval appears |
| Business-day boundary | 08:59 and 09:00 | Correct previous/new business date plans |
| Eight slots | All 8 enabled | Publish succeeds and all 8 freeze into a new batch |
| Slot validation | 0 enabled, overlap, zero duration, invalid time | Publish rejected with field-level errors |
| Cross-midnight slot | 23:00–02:00 | Normalized correctly, no false overlap |
| Snapshot | Admin edits published template | Existing batch unchanged; new batch receives new hash |
| Mode independence | timed→free→timed | Both frozen templates remain byte/hash stable |
| Safety | Missing SOP/device digest | No equipment numbers; `safe_block` audited |
| Evidence | Model invents a number | Response validator rejects it |

## Release Gates

- P0 and P1 unresolved safety defect count must be zero.
- Daily routine operation confirmation is provably once per batch/business day.
- Eight-slot configuration, publication and batch freeze are covered by automated tests.
- Agent/local API parity tests pass for selected/effective mode and all numeric decisions.
- Numeric evidence coverage is 100%.
- No equipment change can become effective without its dedicated authenticated approval.
- Existing backup remains recoverable and SQLite integrity check is `ok` after migration.

## Decisions Made

| Decision | Rationale |
|---|---|
| Routine operations use one frozen daily plan and one confirmation | Direct user requirement; simplifies field operation and audit |
| Abnormal/mode/device approvals remain separate | Daily convenience must not weaken safety controls |
| Admin always sees exactly eight slots | Stable UI and snapshot shape; enabled flag supports fewer active windows |
| Business day is 09:00 to next 09:00 | Matches feeding model and avoids cross-midnight meal/window errors |
| Daily plan is not rewritten after confirmation | Guarantees one confirmation; later changes are separate audited events |
| Shared BatchDecisionService before graph v2 | Eliminates current local API/Agent drift before adding orchestration |

## Known Product Assumptions

- “设置8个时间段” is implemented as exactly eight editable rows with `1..8` enabled.
- Routine daily confirmation means confirmation of the complete displayed plan, not confirmation of each physical task.
- Serious abnormal handling and device-affecting changes are not routine daily operations.
- Water-policy safety exceptions and missing minimum-weight table remain separate product/domain decisions and must not be silently automated.

## Errors Encountered

| Error | Attempt | Resolution |
|---|---:|---|
| None during plan authoring | 1 | N/A |

## Codex Handoff Rule

Before implementing any phase, Codex must read `task_plan.md`, `findings.md`, and `progress.md`, mark exactly one phase `in_progress`, and update `progress.md` after each coherent batch. Existing user changes and the backup directory must be preserved.
