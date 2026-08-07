# NBJ-EXECUTION-CONTRACT-P1

> 冻结日期：2026-08-07
> 决策策略版本：`execution-contract-v1`

## 1. 五层权威模型

```text
Layer 1 selectedMode
Layer 2 controlState
Layer 3 plannedDecision
Layer 4 activeDecision
Layer 5 runtimeState
```

### selectedMode

操作员选择 `timed_quantity` 或 `free_feeding`。

唯一修改来源：用户模式切换事务。

唯一系统例外：Day 0 首日冻结 SOP 强制定时定量。

### controlState

只表达教槽控奶是否启动、何时启动、模型生成多少次饲喂。

不得表达 mode。

### plannedDecision

今天如果重新计算，deterministic backend 建议执行什么；尚未应用。

### activeDecision

已经经过所需确认、当前真正生效的设备程序。

任何“当前已应用设备设定”只来自 activeDecision。

### runtimeState

```ts
interface RuntimeExecutionState {
  state: "normal" | "manual_hold" | "blocked";
  reasons: string[];
  sourceObservationIds: string[];
}
```

runtimeState 不属于 immutable FeedingDecision。

## 2. 不变量

```text
INV-001  Day0 以后 plannedDecision.setting.mode = selectedMode
INV-002  activeDecision.setting.mode = selectedMode，否则 fail closed
INV-003  creep control 只改次数/日额度，不改 mode
INV-004  freeWindows 是许可时间范围，不等于餐次
INV-005  dailyPowderGrams = singlePowderGrams × freeDispenseLimit
INV-006  blocked/manual_hold 不得改变 selectedMode 或 planned mode
```

## 3. Mode Eligibility 与 Runtime Safety 分离

### Mode Eligibility

只判断用户能否选择 free feeding：

```text
Day 0
free feeding earliest day 未到
SOP snapshot 不支持
free feeding config 非法
```

不满足时直接 `409 NBJ_FREE_FEEDING_NOT_ELIGIBLE`，不得选完再改回 timed。

### Runtime Safety

```text
refusal             → manual_hold
blockage            → blocked
probe contamination → blocked
curve cap           → approval: manual_confirmation_required
```

异常不得改变 mode。

### Severe diarrhea

severe 不自动停止整栏设备，也不自动设置 runtime hold；除非现场另有 refusal/blockage/probe contamination 事实。

## 4. 自由采食 V2

```ts
interface FreeFeedingSetting {
  windows: FreeFeedingWindow[];
  singlePowderGrams: number;
  freeDispenseLimit: number;
  dailyPowderGrams: number;
}
```

`freeDispenseLimit` 是当天最多标准配奶次数。

```text
singlePowder = 317 g
freeDispenseLimit = 9
dailyPowder = 2853 g
```

### 控奶

free mode 不额外减一次；直接采用 protected model 输出的 `feedTimes / perFeed / daily`。

禁止：control active 后再执行 `quota--`，否则就是双减。

### 中度腹泻

free mode 基于控奶后 base limit：

```text
adjustedLimit = baseLimit - 1
windows 不变
singlePowder 不变
daily = singlePowder × adjustedLimit
```

`baseLimit <= 1` 时 fail closed，返回 manual_only。

`freeReductionPriority` 不再作为新执行合同权威。

### future deliverable

```text
remainingDeliverable =
adjustedDailyPowder - cumulativeActual

如果存在 active/future free window：
futureDeliverable = remainingDeliverable
否则 futureDeliverable = 0
```

禁止 `futureWindows.length × singlePowder`。

## 5. Mode Change 生命周期

```text
Day 0 free request → 409 NBJ_MODE_SWITCH_FIRST_DAY_LOCKED

current day actualPowder > 0 → 409 NBJ_MODE_SWITCH_AFTER_EXECUTION_BLOCKED

actualPowder unknown → 409

存在 pending/confirmed safety amendment → 409 NBJ_MODE_SWITCH_AMENDMENT_PENDING
```

Pending plan + actual=0：直接事务切换。

Confirmed/active plan + actual=0：创建 `mode_change` amendment。

mode apply 原子事务：

```text
验证 expectedRevision
验证 amendment digest
重新读取 cumulative actual = 0
验证无其它 pending safety amendment
更新 batch.selectedMode
revision +1
supersede 旧 active decision
重新计算 target mode canonical setting
创建 exactly one active decision
写 action/audit
```

## 6. Schema V12

```text
MIGRATION_VERSION = 12
daily_operation_amendments.origin_kind += mode_change

CREATE UNIQUE INDEX feeding_decisions_one_active_idx
ON feeding_decisions(user_id, batch_id, date_local)
WHERE status = 'active';
```

迁移前检查 duplicate active；存在则 FAIL，不自动删。

V11→V12 必须备份/恢复 amendments 与 actions，不能触发 CASCADE 丢 history。

## 7. Observation Trust Boundary

允许客户端提交：

```text
actualPowderGrams
effectiveHeads
creepGrade
diarrheaGrade
recordedAt
weight
death
cull
temperature
humidity
feedingResponse
deviceStatus
其它真实现场观察
```

禁止客户端提交：

```text
deviceMode
singlePowderGrams
mealCount
freeDispenseLimit
mealTimes
plannedTotalPowderGrams
exceptionActions
modelVersion
sopVersion
waterState
```

出现计划字段直接 `400 NBJ_OBSERVATION_PLAN_FIELD_FORBIDDEN`。

服务器写 observation 时自行加入：

```text
planPerPigAtCommit
planTotalAtCommit
feedTimesAtCommit
freeDispenseLimitAtCommit
modeAtCommit
activeDecisionIdAtCommit
policyVersionAtCommit
```

## 8. Manual Diarrhea Audit Integrity

请求：

```json
{
  "feedbackOriginId": "...",
  "action": "...",
  "idempotencyKey": "..."
}
```

服务端重新 materialize feedback、验证 origin/kind/severity/action，并从 FeedbackOrigin 取得 observation ID。

服务端校验 deterministic key：

```text
diarrhea-manual:<batchId>:<feedbackOriginId>:<action>
```

`FeedbackOrigin.sourceObservation` 增加：

```ts
sourceObservation: {
  observationId: string;
  recordedAt: string;
}
```

## 9. Clean Build 与 Provenance

模型权威源：

```text
/feeding-model.js
/v5lite-model.js
```

Agent 构建不再依赖 `agent/container-models/`。

新增：

```text
agent/scripts/prepare-model-assets.mjs
agent/.generated-models/
```

Dockerfile 从 tracked source 生成 CJS 模型。

`/version` 返回：

```json
{
  "commit": "...",
  "schemaVersion": 12,
  "decisionPolicyVersion": "execution-contract-v1",
  "feedingModelSha256": "...",
  "v5LiteModelSha256": "...",
  "uiSha256": "..."
}
```

V5-Lite 保持影子，不得进入 DeviceSetting authority。

## 10. UI Runtime Contract

UI 分四块：

```text
模式
控奶
今日计划
运行状态
```

free mode 不再显示配奶时间点，只显示允许窗口与最大配奶次数。

用户截图场景：

```text
selectedMode = free_feeding
control active
model feedTimes = 9

页面显示：
模式：自由采食
单次下粉：317 g/次
今日最大配奶次数：9 次
程序总量：2853 g
允许窗口：按 frozen SOP
```

不得显示“今日执行：定时定量”。

## 11. Gates

```text
NBJ-EXECUTION-CONTRACT-P1：PASS

Execution Contract Gate：OPEN
Mode Authority Gate：OPEN
Creep Control Gate：OPEN
Control Monotonicity Gate：OPEN
Free Feeding Semantics Gate：OPEN
Free Feeding Quantity Gate：OPEN
Diarrhea Contract Gate：OPEN
Runtime Safety Gate：OPEN
Active Decision Gate：OPEN
Mode Transaction Gate：OPEN
Schema V12 Gate：OPEN
Observation Authority Gate：OPEN
Manual Audit Gate：OPEN
Legacy Reconciliation Gate：OPEN
Clean Source Build Gate：OPEN
Model Provenance Gate：OPEN
UI Runtime Contract Gate：OPEN
CI Gate：OPEN
Full Regression Gate：OPEN

Merge Gate：OPEN

Optimizer Production Gate：CLOSED
Real Device Control Gate：CLOSED
```
