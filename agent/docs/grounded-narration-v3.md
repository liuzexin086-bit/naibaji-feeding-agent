# LangGraph v3：已核实上下文自然叙述（Grounded Narration）

## v3.1 补充（2026-08-05）

- general 意图也注入“已核实现场上下文”（批次名、第 N 天、日龄、生效模式、
  设备方案、今日操作、知识检索和腹泻预览），数值校验统一使用
  `narrationWhitelist(state)`。
- 异常意图中的腹泻问题改走确定性 `preview_diarrhea_adjustment` 证据工具，
  返回包含批次日龄、剩余餐次、时间点、单次下粉和人工确认要求的固定文案；
  未提供腹泻档位时返回明确补充提示，不猜测等级。
- 聊天请求可携带 `observation`（当前表单的腹泻档位、实际累计下粉量），
  工具优先使用观察值计算剩余额度；未录入时按最近记录或 0 估算并在上下文中
  标注来源。

## 目标
设备方案、批次概览、今日操作、知识检索四类意图改为 LLM 自然叙述，回答只基于
确定性工具产生的“已核实现场上下文”；输出数值必须命中白名单，失败自动回退到
确定性模板；异常、弱仔、安全阻断保持固定安全文案；general 同样注入已核实现场
上下文，但不得生成设备数值或审批指令。

## 执行者拥有文件（唯一写权限）
- `agent/src/agent/langgraph/runtime.ts`
- `agent/tests/langgraph-runtime.test.ts`

除测试证明必须外，不得修改 state.ts、router.ts、responses.ts、UI、schema 或部署文件；
如测试暴露必须改其它文件，先停下并在报告中说明，等待根代理决定。

## 行为规格
1. 在 runtime.ts 增加常量 `NARRATION_SYSTEM_PROMPT`，原文：
   ```
   你是奶爸机现场执行助手。请用自然、简洁的中文回答现场问题。
   规则：
   1. 只能使用“已核实现场上下文”中的信息，不得使用上下文之外的数据。
   2. 不得编造或推算任何数值；回答中出现的每个数字必须能在上下文中找到。
   3. 设备方案类回答保持简短：单次下粉量、程序总量、配奶时间点；以现场执行台显示为准。
   4. 若上下文缺少答案所需信息，明确说明“当前未提供该信息”，不要猜测。
   5. 不得提及内部工具名、证据摘要、版本或元数据。
   ```
2. 增加辅助函数（runtime.ts 内部）：
   - `narrationContextText(state)`：输出可读上下文，依次包含
     批次（名称/第N天/日龄/生效模式/单次下粉/程序总量/餐次/配奶时间点/自由采食时段）、
     今日操作（日期/状态/条目）、冻结SOP检索（每条 title+text），
     末尾追加“以上数字均已通过确定性证据校验。”
   - `narrationWhitelist(state)`：数值并集 = `state.numericWhitelist`
     ∪ batchSummary 全部数字（含 mealTimes/freeWindows/dayNumber/dayAge/粉量/餐次）
     ∪ todayOperations 的 businessDate/status/operations 标题与起止时间数字
     ∪ knowledgeResults 的 title+text 数字。
   - `deterministicFallbackText(state)`：
     knowledge 且 knowledgeResults 非空 → `knowledgeResponseText(...)`；
     否则 `deterministicResponse(intent, requestsMutation, batchSummary, todayOperations)`。
3. `renderResponseNode` 分支顺序：
   - safe_block/stale → `safeBlockText`（不变）
   - exception / laggard → `deterministicResponse`（不变）
   - general → 现有 LLM 路径（不变）
   - batch_overview / device_plan_or_mode / timeline_or_today_operations / knowledge →
     自然叙述：
     - 消息：`SystemMessage(NARRATION_SYSTEM_PROMPT)`、
       `SystemMessage("已核实现场上下文：\n" + narrationContextText(state))`、
       `...run.history`、`HumanMessage(run.message)`
     - 模型返回含 tool_calls → 抛 `NBJ_AGENT_MODEL_TOOL_CALL_FORBIDDEN`（不得吞掉）
     - 空文本 → 回退
     - `validateNumericResponse(text, narrationWhitelist(state))` 失败 → 回退
     - 模型调用异常 → 回退
4. `validateResponseNode`：
   - general 用 `state.numericWhitelist`（不变）
   - 其余意图用 `narrationWhitelist(state)`
   - 删除当前 knowledgeResults 跳过逻辑
   - general 数字错误仍按现有优雅拒答逻辑处理，非 general 失败照常抛出
5. 不新增 checkpoint 通道，不改变图节点结构。

## 测试更新（tests/langgraph-runtime.test.ts）
1. “uses the static timeline evidence plan…”：fake model 改为返回 `new AIMessage("43 克")`
   （数字不在白名单 → 回退确定性文本），期望 `model.calls` 为 1，原文本断言不变。
2. 设备+概览测试：fake model 改为 `new AIMessage("43 克")` → 回退，原断言不变。
3. 今日操作渲染测试：fake model 改为 `new AIMessage("43 克")` → 回退，原断言不变。
4. 首日知识测试：fake model 返回合法叙述
   `断奶第 1 天：17:00 第一次教奶；每 3 小时供奶一次；第二天切换自由采食。以现场执行台显示为准。`
   断言包含“断奶第 1 天”和“17:00 第一次教奶”；删除 `toContain("冻结 SOP")`。
5. 新增：合法设备叙述被采用（定时定量：单次下粉 35g、程序总量 210g、
   时间点 10:00/14:00/16:00，白名单覆盖），断言 `result.text` 等于模型文本、
   `model.calls === 1`。
6. 新增：叙述意图下模型尝试 tool_calls 仍抛
   `NBJ_AGENT_MODEL_TOOL_CALL_FORBIDDEN`。

## 验收命令（在 E:\plan\agent 执行）
```powershell
npm run check
npm test
npm run build
```

## 验收标准
- 四个叙述意图在合法输出下恰好调用一次 narrationModel。
- 数字越界/空文本/模型异常/tool_calls 处理符合规格。
- 既有确定性回退文本保持可用。
- check、全部测试、build 全绿。

## 叶子报告格式
```
task_id:
status: COMPLETE | BLOCKED
summary:
files_changed:
verification:
evidence:
risks_or_blockers:
```

## 禁止事项
- 不提交、不推送、不部署。
- 不回退他人改动；同一文件只由本叶子修改。
- 不创建子代理。
