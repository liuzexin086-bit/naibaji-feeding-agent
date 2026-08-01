# 奶爸机后端化完整功能计划

## Goal

在现有 Electron + 静态前端原型基础上，完成一套可本地运行、可持久化、可追踪模型版本和推荐原因的后端化程序。

## Backend Design Decision

- 运行形态：Electron 主进程启动本地 Node HTTP API，前端通过 `fetch` 调用 `http://127.0.0.1:<port>/api`。
- 持久化：使用 JSON 文件数据库落到 Electron `userData` 目录，开发环境可用项目内 `.data/naibaji-db.json`。
- 模块边界：`backend/src/routes` 处理 HTTP，`controllers` 组装请求，`services` 执行业务闭环，`repositories` 封装表式 JSON 存储，`models` 复用现有 `feeding-model.js` 与 `v5lite-model.js`。
- 核心闭环：batch -> daily_record -> recommendation_log -> approval_log -> execution_log -> batch_learning -> scene_state。
- 生产限制：早期只允许自动下调；上调建议必须进入人工审批；所有推荐保留模型版本、风险、估重和原因。

## Phases

### Phase 1: Plan and Existing Flow
Status: complete

- Read pasted architecture.
- Inspect current Electron entry, package config, front-end storage and model exports.
- Create planning files.

### Phase 2: Backend Foundation
Status: complete

- Add local HTTP server bootstrap.
- Add JSON database with table-like collections and ID generation.
- Add repositories for batch, daily record, recommendation, approval, execution, scene state, model registry.
- Add validators and error response helpers.

### Phase 3: Business Services
Status: complete

- Add feeding plan service.
- Add shadow risk service.
- Add weight estimation service.
- Add data quality service.
- Add recommendation service.
- Add approval, device sync, export and batch learning services.

### Phase 4: API Routes
Status: complete

- Implement health, batch, daily record, recommendation, approval, execution, model, export routes.
- Ensure creating or updating daily records automatically recomputes recommendation logs.
- Ensure completing a batch runs data quality and batch learning.

### Phase 5: Frontend Integration
Status: complete

- Add backend client adapter.
- Make existing `STORAGE` use backend when available and fall back to localStorage if unavailable.
- Keep current UI behavior intact.

### Phase 6: Verification and Docs
Status: complete

- Add Node test script with service/API smoke tests.
- Update README with local backend behavior.
- Run tests and a basic Electron-compatible syntax check.

## Errors Encountered

| Error | Attempt | Resolution |
|---|---|---|
| Existing `/goal` already active | Tried to create a new goal for this request | Continue under active goal returned by tool |
| Not a git repository | Ran `git diff --stat` and `git status --short` | Recorded limitation; used tests and syntax checks for verification |

## Supabase 静态网页接入（2026-07-10）

### Phase 1: 现状审阅与方案
Status: complete

- 完整审阅 `index.html` 的认证前页面、存储、同步、初始化和影子状态路径。
- 保持 `chart.umd.min.js`、`feeding-model.min.js`、`v5lite-model.js` 不变。

### Phase 2: 认证与同步实现
Status: complete

- 新增 Supabase 浏览器客户端、账号隔离缓存和安全迁移队列。
- 在 `index.html` 增加登录/加载界面及会话控制，并替换旧 REST 同步调用。

### Phase 3: 数据库和使用说明
Status: complete

- 新增幂等 SQL（表、索引、触发器、RLS、授权）和中文部署说明。

### Phase 4: 验证与交付
Status: complete

- 已执行内联脚本与客户端解析、映射/账号缓存/新建快照适配器测试及既有 backend smoke test。
- 已检查 SDK 加载顺序、旧同步引用、前端管理员凭据模式及三份受保护模型文件哈希。

## Errors Encountered（Supabase）

| Error | Attempt | Resolution |
|---|---|---|
| PowerShell 内联 Node 引号转义导致语法检查命令失败 | 1 | 改用 here-string 管道，语法检查通过。 |
| 浏览器安全策略禁止访问本地 file URL | 1 | 未绕过策略；以解析、适配器单测和既有烟测替代，待部署后进行真实登录验证。 |
| 适配器测试创建批次后触发了测试环境的空 Supabase mock 警告 | 1 | 测试收尾显式清理防抖定时器；不影响产品代码。 |

## Supabase 生产安全加固（2026-07-10）

### Phase 1: 审查复核与设计
Status: complete

- 复核外部审查指出的旧数据重复认领、异步旧快照重试、认证切换、跨设备覆盖和影子状态串号问题。
- 采用单一旧缓存所有权、任务绑定用户的单 worker 队列、revision 乐观锁与用户级复合主键。

### Phase 2: 前端同步和认证修复
Status: complete

- 重构 SupabaseSync 队列并保存任务的用户、批次和本地序号。
- 修复自动 SIGNED_OUT 清理，并让影子状态按用户与栏位隔离。

### Phase 3: SQL 与文档升级
Status: complete

- 将 batches 迁移为 (user_id, id) 主键并增加 revision、约束和条件保存 RPC。

### Phase 4: 并发回归验证
Status: complete

- 已覆盖旧任务失败、新任务续传、自动认证清理、冲突副本、旧缓存单一所有权与影子状态隔离。
- 已通过脚本解析、SQL 合约检查和既有 backend smoke test。

## Supabase SQL 前端契约校准（2026-07-10）

### Phase 1: 参数与迁移复核
Status: complete

- 已完整对照 SupabaseSync、映射函数、保存队列、冲突识别与 Storage 同步元数据。

### Phase 2: SQL 原子保存升级
Status: complete

- RPC 参数顺序与前端一致；新批次 revision 为 1，更新通过 revision 条件原子执行，冲突返回实际 revision。

### Phase 3: 静态契约验证
Status: complete

- 已验证前端 RPC 参数、复合主键、RLS、函数授权、revision 和 NBJ_CONFLICT 合约。

## 弹窗响应式与每日明细截图（2026-07-10）

### Phase 1: 页面路径审阅
Status: complete

- 审阅新建批次弹窗、每日明细渲染、现有消息区和触屏事件绑定。
- 确认 html2canvas 是否作为本地静态资源存在；若缺失，仅实现安全降级提示。

### Phase 2: 最小侵入实现
Status: complete

- 新建批次弹窗改用响应式两列/单列布局。
- 增加表格长按、屏幕外克隆截图、PNG 预览、保存与可选分享。

### Phase 3: 静态与交互验证
Status: complete

- 已验证断点、650ms 长按阈值、10px 移动取消、离屏克隆、临时 DOM finally 清理及依赖缺失降级。

## Errors Encountered（截图交互）

| Error | Attempt | Resolution |
|---|---|---|
| 终端对中文正则断言发生编码替换 | 1 | 改用 ASCII 结构锚点。 |
| 全页面存在登录表单的 preventDefault，导致截图区域断言误报 | 1 | 将断言范围限定到截图函数块。 |

## 独立管理员后台（2026-07-11）

### Phase 1: 安全设计与现状审阅
Status: complete

- 需求包含角色授权、RLS 迁移、跨用户编辑 RPC、审计日志与批量数据导出，属于高风险数据库权限改动。
- 已确认仅允许修改 `supabase-setup.sql` 并新增 `admin.html`（可选 `admin.js`）；数学模型和普通用户页面不改动。
- 用户已确认安全实施计划；已确认管理员页面不读取或写入普通用户 `STORAGE`、`SupabaseSync` 或用户级 localStorage。

### Phase 2: 数据库迁移与授权
Status: complete

- 已添加角色、档案、审计日志、管理员 RLS 与条件保存 RPC 的可重复执行迁移。

### Phase 3: 独立管理员页面
Status: complete

- 已建立独立会话门禁、数据库管理员验证、50 条分页筛选、只读详情、受 revision 保护编辑与分页全量 JSON 导出。

### Phase 4: 静态与合约验证
Status: complete

- 已通过 SQL/UI 静态合约、JavaScript 语法、既有后端烟测及三份受保护模型哈希验证。
- 本机未安装 `psql`，且未连接用户的 Supabase 项目；真实 RLS/RPC 验收须在 SQL Editor 执行脚本后按交付清单进行。

## Errors Encountered（管理员后台）

| Error | Attempt | Resolution |
|---|---|---|
| None | — | — |
| 管理员隔离静态检查把注释中的 `STORAGE` 误判为调用 | 1 | 改为仅检查 `STORAGE.` 与 `SupabaseSync.` 可执行引用。 |
| 本机没有 `psql`，无法对 PostgreSQL 执行迁移级语法与 RLS 集成测试 | 1 | 已执行静态 SQL 合约复核，并在交付中列出 Supabase SQL Editor 验收步骤。 |
| PowerShell 未展开 `README*.md` 传给 `rg` | 1 | 不影响代码；后续使用 `rg --glob` 或显式文件名。 |

## V5-Lite 执行缺口语义校准（2026-07-11）

### Phase 1: 影响范围审阅
Status: complete

- 将计划量与实际执行量的差值统一定义为“执行缺口”，不再定义为“剩奶”。
- 审阅 V5-Lite 风险、影子学习、数据质量、记录写入、页面显示和 JSON 导出路径。

### Phase 2: 最小语义与字段迁移
Status: complete

- 重命名新写入字段为 executionDeficit/executionRate/riskExecution，并保留仅读取旧影子字段的兼容回退。
- 新增每日执行情况选择，非正常执行时从猪群执行风险中排除缺口。

### Phase 3: 回归验证
Status: complete

- 覆盖六个执行率/风险场景，检查旧词清理、导出字段、页面脚本语法与未改动的基础饲喂公式。
- 已通过六个数值场景、设备故障排除、单日/连续日数据质量、V5 与页面语法及既有烟测；旧影子字段仅保留历史读取兼容回退。

## Errors Encountered（执行缺口语义）

| Error | Attempt | Resolution |
|---|---|---|
| PowerShell 管道将中文断言文本编码为问号，导致原因文本断言误报 | 1 | 改用 ASCII 结构断言，不影响模型数值验收。 |

## 日记录真实性与计划冻结修复（2026-07-11）

### Phase 1: 调用链与源/压缩模型审阅
Status: complete

- 审阅实时预览、保存、计划总量、批次完成学习、控奶冻结与训练数据导出。
- 确认 `index.html` 运行 `feeding-model.min.js`，源与压缩模型必须保持同一逻辑。

### Phase 2: 最小实现
Status: complete

- 修复预览/保存输入一致性、计划预填提交门禁、当前头数总量、Layer 3 数据驱动判定、称重/环境校验。
- 修复控奶已提交天的配奶次数冻结，并扩展训练数据导出为 v2 后同步压缩模型。

### Phase 3: 回归验证
Status: complete

- 覆盖十项验收、源/压缩模型等价性、语法与既有烟测。
- 已通过页面静态合约、源/压缩模型冻结与导出对照、三份 JavaScript 语法检查和既有 backend smoke test。

## Errors Encountered（日记录真实性与计划冻结）

| Error | Attempt | Resolution |
|---|---|---|
| PowerShell 将中文静态断言文本编码为问号 | 1 | 改用 ASCII 代码结构锚点重跑；模型源/压缩一致性此前已通过。 |
