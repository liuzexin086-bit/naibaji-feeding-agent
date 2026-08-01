# Findings

## 2026-07-07 架构输入理解

- 当前项目是 Electron 包装的静态前端原型，主数据状态在 `index.html` 的 `state` 和 `localStorage` 中。
- 核心模型已经存在：`feeding-model.js` 负责基础饲喂计划和控奶计划，`v5lite-model.js` 负责风险修正、三等级生长代理、数据质量和批次影子学习。
- 用户提供的目标架构明确要求后端模块化：计划、影子风险、估重、批次学习、数据质量、推荐、审批、设备同步和导出。
- 数据表应覆盖 batch、daily_record、weigh_sample、recommendation_log、execution_log、approval_log、scene_state、model_registry。
- 早期生产约束：只允许自动下调；上调必须人工确认；三等级只能弱学习；有称重锚点才强校正；推荐必须记录版本和原因。

## 2026-07-07 仓库现状

- 根目录包含 `main.js`、`index.html`、`feeding-model.js`、`feeding-model.min.js`、`v5lite-model.js`、`chart.umd.min.js` 和 Electron 打包产物。
- `package.json` 只有 Electron、electron-builder 和 chart.js，没有 Express 或 SQLite 依赖。
- `main.js` 当前只创建窗口并加载本地 `index.html`。
- 推荐实现路径是使用 Node 内置 `http` 模块提供本地 API，避免新增原生数据库依赖影响 Windows 打包。

## 2026-07-07 实现结论

- 已实现本地后端化路线：Electron 主进程启动 Node HTTP API，页面通过 query 参数获取 API 地址。
- 后端使用表式 JSON 存储，覆盖批次、每日记录、称重样本、推荐日志、审批日志、执行日志、sceneState、modelRegistry 和 auditLogs。
- Snapshot API 让现有前端低扰动接入：启动迁移 localStorage，保存时镜像完整批次并重算推荐。
- 推荐服务完整串联 BaseMilk、WeightCorrection、RiskAdjustFactor，并保留早期生产限制：自动建议不做无审批上调。
- Smoke test 已覆盖推荐、审批、设备执行、导出和批次完成学习闭环。

## 2026-07-10 Supabase 改造审阅

- `index.html` 共 1772 行；现有 `BackendSync` 以 URL 参数 `?api=` 访问本地 REST API，`STORAGE` 仍使用全局 `nbj_batches` 与 `nbj_current`。
- 所有本地存储和同步入口集中在约 571–818 行，完成批次时另有 `BackendSync.completeBatch` 调用；可用适配器替换，避免影响饲喂、影子和图表逻辑。
- 页面现有 DOMContentLoaded 会先启动同步再初始化业务数据；Supabase 版本须改成先鉴权、再按用户命名空间合并和初始化，避免未授权闪现。

## 2026-07-10 生产安全复核

- 旧 nbj_batches 若使用每用户迁移标记，会被第二个无缓存账号再次复制；需改为全局所有权键，仅首个认领用户可迁移。
- 原 pendingSnapshots + saveChains 结构没有任务 revision 与用户绑定；失败的旧任务可能晚于新任务重试，且认证自动登出后残留任务可能关联到新用户。
- 解决方案是每个 user_id + batch_id 仅有一个 worker，任务在创建时冻结 userId 与本地顺序；RPC 保存以数据库 revision 为条件，冲突时拒绝自动覆盖并保留本地冲突副本。
- 影子学习状态至少须按 user_id + farmRoom 隔离，即使暂不迁移上云。

## 2026-07-10 SQL 前端契约校准

- 最新前端 RPC 仅传递 p_id、JSON 快照字段、创建时间与 expected revision；数据库必须从 auth.uid() 派生用户身份并返回包含 user_id 和 revision 的完整批次行。
- 新记录以 revision 1 创建；更新由 UPDATE WHERE revision = p_expected_revision 原子控制，触发器负责服务器 updated_at 与 revision 加一。
- 复合主键升级使用 PostgreSQL 系统目录检查现有主键列，仅在不是 (user_id, id) 时替换，避免依赖默认约束名和删除业务数据。

## 2026-07-10 弹窗与表格截图

- 新建批次弹窗当前使用 2 列和 3 列 inline grid，窄屏会压缩字段；可替换为统一的两列响应式网格。
- 每日明细由 renderTable() 写入 #planTable，外层 .table-wrap 提供横向滚动；截图应深度克隆 #planTable 到屏幕外容器，不能捕捉滚动窗口。

## 2026-07-11 管理员后台安全基线

- 当前 `batches` 使用 `(user_id, id)` 复合主键、revision 乐观锁和 `save_batch_snapshot` 的原子条件写入；普通用户 RLS 按 `auth.uid() = user_id` 隔离。
- 管理员需求须在数据库内以 `security definer` 的 `is_admin()` 判断角色；浏览器仅使用 Publishable Key，不能携带 service_role 或调用 Auth Admin API。
- 管理员编辑必须是单独的 `admin_save_batch_snapshot` RPC，按目标用户、批次 ID 与 expected revision 原子更新，并记录审计快照。
- `profiles` 应由 `auth.users` 回填和触发器维护，管理员通过 RLS 读取邮箱；不能由浏览器任意写入。
- 现有 Electron 打包白名单须加入 `admin.html` 和可能的 `admin.js`，否则桌面安装包不会包含后台入口。

## 2026-07-11 执行缺口语义

- 设备具有液位探头，设备实际执行配奶量可作为猪群当日实际消耗能力的代理；计划量与实际执行量之差只能解释为执行缺口，不能再表述为剩奶。
- 执行缺口仅在 `executionStatus === 'normal'` 时参与猪群执行风险；人工停机、设备故障、清洗维护、停电和其他异常应保留缺口指标但排除该风险项。
- 历史记录允许在读取旧影子字段时回退兼容，但所有新保存和导出字段应只使用 executionDeficit/executionRate/riskExecution 命名。
- 当前 V5-Lite 将差值写为 `estimatedLeftoverRate`、`riskMachine`，并允许 `record.leftoverRate` 作为手工覆盖；该覆盖分支必须删除，避免保留“剩奶”业务含义。
- 当前数据质量会对单日高差值且腹泻/教槽优异直接扣分；将改成仅在连续两日及以上出现且执行状态正常时记录一次“需复核”，再做单次保守扣分。
- 每日记录当前只有总配奶量而无设备/人工异常说明；须新增 `executionStatus`，保存、禁用、清空和影子预览均需同步。

## 2026-07-11 日记录真实性与计划冻结

- 自动预填计划量已有 `data-auto-filled` 标识；保存入口必须拒绝该标识，确保计划参考值不会冒充设备实际执行量。
- 提交日的总计划量必须按当日确认的有效头数计算，历史天继续以 `planTotalAtCommit` 为权威。
- Layer 3 是否可运行只能依据已保存的影子字段完整性，不能依赖完成瞬间的 UI 复选框状态。
- `feeding-model.js` 与浏览器加载的 `feeding-model.min.js` 均须含相同的控奶冻结和训练导出字段逻辑。
- 预览记录已含执行、腹泻、生长与 avgTemp，但漏掉称重样本、死亡和淘汰；共享的轻量输入读取函数可消除与提交路径的漂移。
- `computeControlPlan()` 已保存历史 `feedTimesAtCommit`，但提交日分支没有写回 `feedTimes[i]`；此处仅补一行冻结恢复。
- `getTodayRecommendedMilkTotal()`、`renderTodayCard()` 和 `advanceDay()` 分别使用了基于初始头数的总量；改为继续使用现有头均值，再乘当日有效/确认头数。
