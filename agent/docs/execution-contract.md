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
  deviceLatch: "normal" | "blocked" | "probe_contaminated";
  feedingLatch: "normal" | "refusal";
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
INV-007  Control Monotonicity
         控奶启动后：feedTimes(day N+1) <= feedTimes(day N)
         未提交的未来计划同样适用；本 P1 不实现自动增加次数。
         新 creep 数据允许 10→8、10→9、9→8；
         禁止 8→10、8→9、9→10。
         除非未来存在独立的人工解除/恢复合同，否则不得自动反增。
INV-008  No Double Control Reduction
         protected feeding model 输出 feedTimes 后只映射一次：
         timed mode → base meal count = feedTimes
         free mode  → freeDispenseLimit = feedTimes
         禁止 controlState active 后再执行 quota-- 或 meal--。
         只有新的独立事件（如 moderate diarrhea）才允许基于 base
         生成 amendment proposal 8；基础模型输出 9 不得被控奶再减成 8。
```

## 2.1 Creep Control Authority

`controlState` 是 server-owned persisted state，不是每次从最新观察临时推断出的派生值。

```ts
interface CreepControlState {
  status: "inactive" | "active";
  startDay: number | null;
  triggerGrade: CreepGrade | null;
  policyVersion: "creep-control-v2";
}
```

`CreepControlState.policyVersion` 使用与 decision policy 相同的版本兼容规则：

```text
creep-control-v2 → current policy
null / missing / 其它未知值 → fail closed
```

禁止把未来未知版本解释为旧版本。

首次触发：

```text
inactive
↓
valid observations 达到持续教槽条件
↓
同一事务写入
startDay = currentDay + 1
status = active
```

一旦 `startDay != null`，之后不得因为后来 observation 修订而自动恢复为 `null` 或 `-1`。

职责边界：

```text
protected model       负责发现首次触发条件
persisted controlState 负责触发后的 deterministic replay
```

禁止同时存在 `config.controlStartDay` 与 `model.controlStartDay` 两个实时权威。

任何自动恢复或自动反增必须由独立的人工解除/恢复合同显式授权；没有该合同则保持 fail closed。

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

### Curve Cap Approval Semantics

```text
curve_cap 不修改 mode。
curve_cap 不修改 runtimeState。
curve_cap 使 plannedDecision.approvalState = manual_confirmation_required。
未人工确认前，不得形成新的 activeDecision。
```

### Severe diarrhea

severe 不自动停止整栏设备，也不自动设置 runtime hold；除非现场另有 refusal/blockage/probe contamination 事实。

### Runtime State Lifecycle

`runtimeState` 由两个独立 domain latch 聚合，任何 observation 都只能影响自己所属 domain；omitted 不等于 normal。

```text
device runtime latch:
normal / blocked / probe_contaminated

feeding runtime latch:
normal / refusal
```

最终聚合优先级：

```text
blocked > manual_hold > normal

任何 device blocked/probe
→ runtimeState = blocked

否则如果 feeding refusal
→ runtimeState = manual_hold

否则
→ runtimeState = normal
```

`reasons` 为当前未解除原因的并集。

domain latch 只允许显式 observation 清除，且只能清除自己 domain：

```text
deviceStatus = blocked
↓
device latch = blocked

下一次 observation 没有 deviceStatus
↓
device latch 仍 blocked

下一次显式 deviceStatus = normal
↓
只清除 device latch
feeding latch 不受影响
```

```text
feedingResponse = refusal
↓
feeding latch = refusal

omitted
↓
feeding latch 保持 refusal

显式 feedingResponse = normal
↓
只清除 feeding latch
device latch 不受影响
```

非法时间戳或未通过 observation quarantine 的记录不得作为显式清除依据。

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

### Free feeding 与控奶映射

free mode 下 protected model 的输出是唯一数量来源：

```text
feedTimes = 9
↓
freeDispenseLimit = 9
dailyPowderGrams = singlePowderGrams × 9
```

控奶不得再执行 `quota--`；moderate diarrhea 只能在模型 base 之上生成独立 amendment。

## 4.1 Legacy Decision Reconciliation

### Policy Compatibility

`decisionPolicyVersion` 不能通过“不等于 v1”推断为 legacy。必须使用显式版本分类：

```text
KNOWN_LEGACY_POLICY_VERSIONS = []

null / missing
→ known legacy

execution-contract-v1
→ current policy

任何其它非空值（例如 execution-contract-v2、future-x、corrupted-value）
→ NBJ_DECISION_POLICY_UNSUPPORTED
→ FAIL CLOSED
```

未来新增 legacy version 必须先加入版本 registry、迁移和测试，不得由运行时代码临时推断。

#### Known legacy policy

当版本被归类为 known legacy，并发现：

```text
selectedMode != activeDecision.mode
```

返回：

```ts
reconciliation: {
  required: true,
  reason: "legacy_mode_mismatch"
}
```

不得自动修改历史。

如果：

```text
cumulativeActualPowderGramsForBusinessDay > 0
```

则禁止当天 reconciliation：

```text
reconciliationBlocked = true
reason = execution_already_started
```

### New policy

如果 `decisionPolicyVersion = execution-contract-v1`，却出现：

```text
selectedMode != activeDecision.mode
```

不得归类为 legacy；必须：

```text
NBJ_ACTIVE_DECISION_MODE_INVARIANT
FAIL CLOSED
```

新 policy 的 mismatch 永远不允许用“兼容旧数据”绕过。

## 5. Mode Change 生命周期

### Cumulative actual authority

模式切换的“实际已执行”判断必须使用正式字段：

```text
cumulativeActualPowderGramsForBusinessDay
```

定义：

```text
业务日累计实际下粉量
来自 canonical observation event history
只使用已提交且时间戳有效的实际记录
never estimated / planned / latest-record-with-zero replacement
```

禁止：

```text
missing actual → 0
最新一条 actualPowderGrams = 0 → 覆盖当天累计实际量
```

### Mode switch rules

```text
Day 0 free request → 409 NBJ_MODE_SWITCH_FIRST_DAY_LOCKED

cumulativeActualPowderGramsForBusinessDay > 0
→ 409 NBJ_MODE_SWITCH_AFTER_EXECUTION_BLOCKED

cumulativeActualPowderGramsForBusinessDay unknown
→ 409

显式可靠 cumulativeActualPowderGramsForBusinessDay = 0
→ 才可进入后续模式切换判断

存在 pending/confirmed safety amendment → 409 NBJ_MODE_SWITCH_AMENDMENT_PENDING
```

Pending plan + 显式累计量 = 0：直接事务切换。

Confirmed/active plan + 显式累计量 = 0：创建 `mode_change` amendment。

mode apply 原子事务：

```text
验证 expectedRevision
验证 amendment digest
重新读取 cumulativeActualPowderGramsForBusinessDay = 0
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

迁移验收必须使用 exact V11 fixture，至少包含 amendment 状态：

```text
pending
confirmed
applied
cancelled
superseded
```

以及 action 历史：

```text
confirm
reject
apply
cancel
```

升级后逐项验证：

```text
amendment count before == after
action count before == after
row payload hash before == after
旧 idempotency key replay 正常
decisionId 不变
origin CHECK 包含 mode_change
foreign_key_check = []
integrity_check = ok
schema MAX = 12
```

任何一项不满足即 FAIL，不允许以“结构看起来正确”代替迁移证据。

## 7. Observation Trust Boundary

Observation API 使用显式 schema allowlist。未列出的字段默认拒绝，采用 `additionalProperties = false` 语义；不存在“其它真实现场观察”逃生口。

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

新增现场观察字段必须依次完成：

```text
1. 修改 contract/schema
2. 增加 validation
3. 增加 test
4. 才可接受
```

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

服务端重新计算 deterministic key，不是只检查格式：

```text
diarrhea-manual:<batchId>:<feedbackOriginId>:<action>
```

action 与 severity 必须严格匹配：

```text
mild:
  individual_intervention_completed

severe:
  isolation_completed
  examination_recorded
  veterinary_referral
```

moderate 不得通过 manual-action endpoint 伪装成设备 amendment apply；moderate 只能走独立 amendment 的 confirm → apply。

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

Web 模型也必须从同一 tracked source 生成：

```text
feeding-model.js
→ Agent CJS
→ Web minified JS

同一 tracked source
```

禁止 Agent 使用新源、Web 继续复制旧工作区文件。

根 `.dockerignore` 必须包含：

```text
.git
**/.env*
**/node_modules
agent/public
agent/container-models
agent/.generated-models
agent/.generated-web
*.db
*.sqlite*
coverage
dist
```

Clean Source Gate：

```bash
git archive HEAD
```

在一个只包含 tracked files 的新目录执行构建；不能只 `rm -rf container-models` 后构建，因为工作区仍可能有其他 ignored artifact。

`/version` 返回：

```json
{
  "commit": "...",
  "schemaVersion": 12,
  "decisionPolicyVersion": "execution-contract-v1",
  "feedingModelSourceSha256": "...",
  "feedingModelArtifactSha256": "...",
  "v5LiteModelSourceSha256": "...",
  "v5LiteModelArtifactSha256": "...",
  "uiSha256": "..."
}
```

Provenance 必须同时证明 source 与真实运行 artifact：

```text
feedingModelSourceSha256
= checkout /feeding-model.js SHA

feedingModelArtifactSha256
= 镜像内实际生成并执行的 Agent CJS artifact SHA

v5LiteModelSourceSha256
= checkout /v5lite-model.js SHA

v5LiteModelArtifactSha256
= 镜像内实际生成并执行的 shadow artifact SHA

uiSha256
= 镜像内实际部署 UI 的 artifact SHA
```

Web 同样必须返回：

```json
{
  "feedingModelSourceSha256": "...",
  "feedingModelArtifactSha256": "...",
  "uiSha256": "..."
}
```

CI 必须通过 deterministic build fixture 证明：

```text
source
→ generated artifact
```

是当前 clean build 产生的；source SHA 只是标签，不能替代 artifact SHA。

V5-Lite 保持影子，不得进入 DeviceSetting authority。

## 10. Today API 分层合同

Today API 必须按五层权威返回，不允许再让调用方从旧 flat 字段拼状态：

```ts
today: {
  modeState: {
    selectedMode,
    plannedMode
  },
  controlState,
  plannedDecision,
  activeDecision,
  runtimeState,
  approvalState,
  reconciliation
}
```

旧 flat 字段：

```text
effectiveMode
today.setting
...
```

可以兼容返回，但标记 `deprecated`；新业务逻辑、Agent 工具和 UI 不得读取。只有 canonical layered fields 可进入 deterministic facts。

## 11. UI Runtime Contract

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

## 12. Current Gate State

```text
EC-P1-0 Contract Freeze：PASS
EC-P1-0.1 Contract Closure：PASS
EC-P1-0.2 Final Contract Seal：PASS

Contract Freeze Gate：OPEN
Authority Model Gate：OPEN
Control Contract Gate：OPEN
Free Feeding Contract Gate：OPEN
Runtime Contract Gate：OPEN
Mode Lifecycle Contract Gate：OPEN
Migration Evidence Contract Gate：OPEN
Observation Boundary Contract Gate：OPEN
Build Provenance Contract Gate：OPEN
Plan Consistency Gate：OPEN

EC-P1-1 Implementation Gate：OPEN

其余运行时 Gate：
Active Decision Gate：CLOSED
Mode Transaction Gate：CLOSED
Schema V12 Gate：CLOSED
UI Runtime Contract Gate：CLOSED
CI Gate：CLOSED
Full Regression Gate：CLOSED

Merge Gate：CLOSED

Optimizer Production Gate：CLOSED
Real Device Control Gate：CLOSED
```

## 13. Final Target State

以下为 EC-P1-1 至 EC-P1-10 全部完成后才能记录的目标状态；不得提前写入运行证据。

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

EC-P1-1 Implementation Gate：OPEN
Merge Gate：OPEN

Optimizer Production Gate：CLOSED
Real Device Control Gate：CLOSED
```

## 14. CI Contract

GitHub Actions 固定使用 Node 24.18.0，并至少执行：

```text
npm ci
npm run check
npm test
npm run p0-release-gate
npm run p1-safety-gate
npm run build
```

构建 agent 与 web。

Provenance 验收：

```text
Agent /version commit == GITHUB_SHA
Web /version commit == GITHUB_SHA

Agent feedingModelSourceSha
== tracked feeding-model.js SHA

Agent feedingModelArtifactSha
== actual generated CJS artifact SHA in image

Web feedingModelSourceSha
== same tracked source SHA

Web feedingModelArtifactSha
== actual minified JS artifact SHA in image
```

未满足即 CI FAIL；不得以本地开发日志代替 CI 证据。
