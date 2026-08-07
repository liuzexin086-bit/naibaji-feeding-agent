# NBJ-EXECUTION-CONTRACT-P1

> 冻结日期：2026-08-07
> 决策策略版本：`execution-contract-v1`

## 1. 四层语义分离

系统必须把以下概念彻底分开，禁止互相冒充：

```text
selectedMode
    操作员选择的饲喂模式

controlState
    当前模式内部的教槽控奶等数量/次数调整

executionState
    当前是否允许继续执行设备程序

activeDecision
    当前真正已确认、已应用的设备方案
```

### Type 合同

```ts
type FeedingMode =
  | "timed_quantity"
  | "free_feeding";

type ExecutionState =
  | "normal"
  | "manual_hold"
  | "blocked";

interface ControlState {
  creepControlActive: boolean;
  creepGrade: CreepGrade;
  controlStartDay: number | null;
  reductionSteps: number;
}
```

## 2. 不变量

```text
第一天：
effectiveMode = timed_quantity
这是首日 SOP 特例。

第二天以后：
自动规则永远不得修改 selectedMode。

selectedMode = free_feeding
→ 控奶仍 free_feeding
→ 腹泻仍 free_feeding
→ 拒奶仍 free_feeding
→ 堵塞仍 free_feeding
→ 探头异常仍 free_feeding
```

真正改变模式的唯一路径：

```text
操作员明确发起模式切换
+ 满足模式切换确认合同
```

## 3. 模式、控奶、执行状态

### 模式权威

`selectedMode` 只能由操作员明确选择或模式切换 apply 事务改变。自动规则不得把模式改成 `timed_quantity`。

### 控奶权威

`controlState` 以 protected feeding model 为准：

```text
valid observations
→ computeProductionPlan()
→ model.controlStartDay
→ canonical ControlState
```

`config.controlStartDay` 不再参与 live decision；旧批次字段只作为 legacy evidence。

### 异常执行状态

```text
mild diarrhea       → normal
moderate diarrhea   → normal（待独立 amendment）
severe diarrhea     → manual_hold
refusal             → manual_hold
blockage            → blocked
probe contamination → blocked / manual_hold
curve cap           → manual_hold
creep control       → normal
```

异常只改变 `executionState`，不得偷偷把模式改成 `timed_quantity`。

## 4. 自由采食语义

自由采食窗口表示“允许设备工作的时间范围”，不是餐次数。

```ts
interface DeviceSetting {
  mode: FeedingMode;
  dailyPowderGrams: number;
  singlePowderGrams: number;
  mealCount: number; // compatibility
  timedMeals: TimedMeal[];
  freeWindows: DeviceWindow[];
  freeDispenseLimit?: number; // free_feeding quota
  precisionGrams: number;
  source: DeviceSetting["source"];
}
```

自由采食：

```text
mealCount
=
freeDispenseLimit
=
模型控奶后的 feedTimes
```

控奶或中度腹泻在 free mode 下：

```text
freeWindows 不变
freeDispenseLimit N → N - 1
dailyPowderGrams -= singlePowderGrams
singlePowderGrams 不变
```

`freeReductionPriority` 不再作为 free-feeding 执行权威，只保留为历史 snapshot 字段。

## 5. 腹泻合同

```text
mild
→ 个体隔离 + 病猪控奶一次
→ 整栏设备不变

moderate timed
→ 删除 frozen reductionPriority 一餐
→ 独立 confirm → apply

moderate free
→ windows 不变
→ dispense quota -1
→ 独立 confirm → apply

severe
→ 隔离、临床观察、环境检查、兽医处置
→ 无设备 proposal
```

## 6. Active Decision

除第一天外：

```text
activeDecision.setting.mode
必须等于
batch.selectedMode
```

不一致时返回 `NBJ_ACTIVE_DECISION_MODE_MISMATCH`，禁止静默显示。

模式切换 apply 必须在一个数据库事务内：

```text
更新 batch.selectedMode
+ batch revision +1
+ supersede 旧 active decision
+ 创建新 active decision
+ 写 audit
```

## 7. API 信任边界

Observation API 只接受现场事实：

```text
effectiveHeads
actualPowderGrams
creepGrade
diarrheaGrade
recordedAt
feedingResponse
deviceStatus
称重等真实观察
```

以下字段由服务器根据 canonical today 写入，客户端传入也忽略：

```text
deviceMode
singlePowderGrams
mealCount
mealTimes
plannedTotalPowderGrams
exceptionActions
modelVersion
sopVersion
waterState
```

Manual diarrhea audit 由服务器验证当前 feedbackOrigin，客户端不提供权威 observation identity。

## 8. Clean Source Build

构建不得依赖 gitignored `agent/container-models/` 或 `agent/public/`。

镜像 `/version` 返回：

```json
{
  "commit": "abc...",
  "schemaVersion": 12,
  "decisionPolicyVersion": "execution-contract-v1",
  "feedingModelSha256": "...",
  "v5LiteModelSha256": "...",
  "uiSha256": "..."
}
```

## 9. Gates

```text
NBJ-EXECUTION-CONTRACT-P1：PASS

Mode Authority Gate：OPEN
Creep Control Authority Gate：OPEN
Free Feeding Semantics Gate：OPEN
Diarrhea Contract Gate：OPEN
Execution Safety Gate：OPEN
Active Decision Consistency Gate：OPEN
Mode Change Transaction Gate：OPEN
Observation Trust Boundary Gate：OPEN
Manual Audit Integrity Gate：OPEN
Legacy Reconciliation Gate：OPEN
Clean Source Build Gate：OPEN
Container Provenance Gate：OPEN
UI Runtime Contract Gate：OPEN
Full Regression Gate：OPEN

Merge Gate：OPEN

Optimizer Production Gate：CLOSED
Real Device Control Gate：CLOSED
```
