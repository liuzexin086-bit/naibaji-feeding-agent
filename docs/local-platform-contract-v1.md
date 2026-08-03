# 奶爸机本地执行台 V1 实施合同

## 架构与边界

- 前端：静态 HTML/CSS/JavaScript，只访问同域 `/api/*`，不直接访问 Supabase。
- Worker：托管静态资源并将 `/api/*` 原样转发到本地 Container；不读写业务数据，不改 DNS。
- 后端：Node 24 + TypeScript，负责本地鉴权、SQLite、确定性模型、日推进和 Agent SSE。
- 数据库：全新 SQLite，不迁移旧 Supabase 数据；批次进度使用 `dayIndex/dayAge`，不绑定系统日期。

## 本地鉴权

- `POST /api/auth/login`：`{ email, password }`；成功写入 HttpOnly、Secure、SameSite=Lax 的 `nbj_session` Cookie。
- `GET /api/auth/session`：返回 `{ user: { id, email, role } }`，未登录返回 401。
- `POST /api/auth/logout`：撤销当前会话并清除 Cookie。
- 启动时用 `LOCAL_ADMIN_EMAIL`、`LOCAL_ADMIN_PASSWORD` 幂等创建首个管理员；密码使用 `scrypt` 加随机盐存储，数据库不保存明文。
- 除 `/health`、登录和静态资源外，所有接口必须校验本地会话；管理员 API 还须校验 `role=admin`。

## 核心数据合同

- `Batch`：`id,name,room,startAge,endAge,initialHeads,effectiveHeads,currentDayIndex,status,revision,createdAt,updatedAt`。
- `DailyRecord`：`dayIndex,dayAge,effectiveHeads,deviceMode,singlePowderGrams,mealCount,mealTimes,plannedTotalPowderGrams,actualPowderGrams,creepGrade,creepValue,diarrheaGrade,waterState,exceptionActions,modelVersion,sopVersion,revision,recordedAt`。
- 首日数量权威：冻结 SOP 直接总量优先，其次按 `35g/20头/次 × 有效头数 × 6餐` 推导；SOP 无法确定时才回退生产模型。第二日起使用生产模型与控奶逻辑。
- 教槽展示档位为 `none/low/medium/high/excellent`，内部值固定为 `0/10/45/80/130`。
- 首次记录非 `none` 教槽后，`controlStartDay` 固定为下一日；之后由生产模型根据最近三次档位对应值决定餐次，不允许 UI 自行计算。
- 正常首始餐次为 10，排除 `00:00` 与 `12:00`；程序总量固定为“模型整栏单餐下粉量 × 实际餐次”，禁止用日总量反推单餐。
- 首夜教奶为 `17:00,20:00,23:00,02:00,05:00,08:00`，每餐使用同日模型整栏单餐量。
- 删除风险分数、风险等级、风险预测和风险卡片；保留确定性 `exceptionActions`，覆盖腹泻、拒奶、设备堵塞/污染、超模型曲线上限等现场处置。

## REST / SSE 合同

| 方法 | 路径 | 请求 | 成功响应 |
|---|---|---|---|
| GET | `/api/batches` | — | `{ batches, currentBatchId }` |
| POST | `/api/batches` | `{ name,room,startAge,endAge,headCount }` | `{ batch, today, records, agentSession }` |
| GET | `/api/batches/:id` | — | `{ batch, today, records, agentSession }` |
| POST | `/api/batches/:id/advance` | `{ expectedRevision, observation, idempotencyKey }` | `{ batch, today, records, committedRecord, agentSession }` |
| POST | `/api/batches/:id/records` | `{ expectedRevision, observation, idempotencyKey }` | `{ batch, today, records, committedRecord }` |
| GET | `/api/batches/:id/agent/session` | — | `{ session, messages }` |
| POST | `/api/feeding-agent/chat` | `{ batchId,sessionId,message,clientMessageId }` | SSE；会话必须属于当前用户和批次 |
| GET/PUT/POST | `/api/admin/feeding-agent/config` | 保持现有配置语义 | 本地管理员校验后的配置结果 |
| GET | `/api/admin/sop/templates` | — | `{ templates }`，按创建时间倒序 |
| POST | `/api/admin/sop/templates` | `{ version,name,config,copyFromId? }` | `{ template }`；版本不可变，只能复制创建新版 |

- 所有错误返回 `{ code, message? }`；revision 冲突为 HTTP 409 + `NBJ_BATCH_STALE`。
- 管理后台也只调用本地 API；Agent API 配置与可自由编辑的 SOP JSON 均保留入口，不再调用 Supabase RPC。
- `advance` 在单个 SQLite 事务内完成：提交当日完整计划和观察、计算下一日、更新批次 revision、确保批次独立 Agent 会话；不得串行调用多个远程服务。
- `idempotencyKey` 防止重复推进；重复请求返回第一次的结果，不重复增加日龄。

## 前端交互合同

- 去掉顶部大型标题/今日计划卡片以及全部风险预测 UI；首屏直接显示“设备设定 + 数据录入”。
- 顶部只保留产品、在线状态、刷新、当前批次下拉和“新建批次”；移除重复入口。
- 批次下拉锚定触发按钮向下展开；新建批次使用独立 Sheet；切换批次同步切换 Agent 会话。
- 历史表完整展示：批次日、日龄、头数、模式、单次量、餐次、时间点、程序总量、实际总量、教槽、腹泻、饮水；移动端表格自身横向滚动，页面不横向溢出。
- 推进按钮立即进入 loading，并以一次 `/advance` 请求完成；成功后直接使用响应渲染，不再二次刷新。
- 保留 Markdown Agent、等待动画、保存图片、0.65 秒长按、草稿恢复、焦点管理和移动端安全区。

## 验收

- 无 Supabase 数据调用和 Supabase Auth 依赖；本地 SQLite 重启后数据与会话仍在。
- 首次非“无”教槽只影响次日；下一日开始出现模型控奶餐次。
- 无风险分数/等级/预测文案；异常录入仍给出具体设备操作。
- 推进是一次请求、一次事务、一次渲染；本机接口目标 P95 < 200ms（不含 LLM）。
- 320/390/430/768/1024/1440px 无页面级横向溢出；核心流程键盘可用。
