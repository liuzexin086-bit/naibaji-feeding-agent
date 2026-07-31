# 奶爸机超早期断奶执行 Agent

本目录包含独立的 Cloudflare Worker + Container 子系统。生产 `feeding-model.js`
和 `v5lite-model.js` 保持不变；构建脚本将它们复制到 Container 镜像，并由黄金样例
持续检查哈希和输出。

## 安全边界

- Pi Agent Core 固定为 `0.83.0`，Container 固定为 Node `24.18.0`。
- Agent 只注册九个奶爸机业务工具，不提供 shell、文件编辑或任意网络工具。
- 时间、奶量、餐次、状态、缺口和 revision 全部由确定性代码或生产模型计算。
- 所有 Supabase 请求使用现场用户 JWT + publishable key，不使用 `service_role`。
- Agent 不诊断疾病、不自动控制奶爸机或饮水设备；决策必须人工批准。

## 本地验证

```powershell
cd E:\plan\agent
npm install
npm run cf:types
npm run check
npm test
npm run build
npm run deploy:staging
```

### Node 24.18 本地容器

容器内 HTTP 服务固定监听 `8080`，宿主机默认只绑定
`127.0.0.1:8080`。运行所需的密钥通过当前 PowerShell 会话传入；Dockerfile
只复制依赖、编译产物和受保护模型，不复制 `.env` 或任何密钥文件：

```powershell
cd E:\plan\agent
$env:CONFIG_ENCRYPTION_KEY = '<32 字节随机值的 Base64>'
$env:AGENT_GATEWAY_SECRET = '<随机网关密钥>'
$env:SUPABASE_URL = '<Supabase URL>'
$env:SUPABASE_PUBLISHABLE_KEY = '<publishable key，不使用 service_role>'
docker compose -f docker/compose.local.yaml up -d --build agent
Invoke-RestMethod http://127.0.0.1:8080/health
```

运行配置支持 `provider`、`baseUrl`、`model`、`apiKey`、以毫秒计的
`timeout` 和 `maxOutputTokens`。OpenAI-compatible HTTPS 地址可使用任意主机；
HTTP 仅允许 `localhost`、`127.0.0.0/8` 或 `::1`，带 URL 用户名/密码、查询串
或片段的地址会被拒绝。API Key 以 AES-256-GCM 加密保存在 `/data` volume，
公共配置只返回掩码提示，日志和镜像均不包含明文密钥。

Wrangler 本地网关使用新增的 `local` profile：

```powershell
npx wrangler dev --env local --local --enable-containers=false
```

需要 Caddy 反代时启用 `proxy` profile，入口只绑定环回地址，且
`/internal/*` 不对外转发：

```powershell
docker compose -f docker/compose.local.yaml --profile proxy up -d
Invoke-RestMethod http://127.0.0.1:8788/health
```

需要 Cloudflare Tunnel 时再设置 `CLOUDFLARED_TOKEN` 并启用 `tunnel`
profile。Compose 不启动、映射或公开数据库端口；外部流量只到 Caddy/Agent HTTP
边界：

```powershell
$env:CLOUDFLARED_TOKEN = '<tunnel token>'
docker compose -f docker/compose.local.yaml --profile tunnel up -d
```

`deploy:staging` 当前是完整 dry-run：会同步静态资源、复制受保护生产模型、构建
Container 镜像并校验所有 Worker 绑定，但不会发布。

## Staging 发布

发布前在当前 PowerShell 会话配置具备 Workers Scripts、Containers、Durable
Objects 权限的 Cloudflare API Token：

```powershell
$env:CLOUDFLARE_API_TOKEN = '<由 Cloudflare 创建的最小权限 token>'
cd E:\plan\agent
npm run prepare:assets
npm run prepare:container
```

为网关生成随机密钥并作为 staging secret 写入（不要提交到源码）：

```powershell
npx wrangler secret put AGENT_GATEWAY_SECRET --env staging
```

如果要开放 Agent 对话，再配置一个模型供应商密钥：

```powershell
npx wrangler secret put ANTHROPIC_API_KEY --env staging
```

首次发布仍保持 `AGENT_ENABLED=false`：

```powershell
npx wrangler deploy --env staging
```

只有在 [现场模拟清单](../docs/feeding-agent-field-simulation.md) 完成后，才可将
staging 的 `AGENT_ENABLED` 改为 `true`。生产 Worker
`bold-night-870f` 和 `org.u3u4.top` 不在本配置的路由中。

## 当前本机 Tunnel 测试

2026-07-31 起，`org.u3u4.top` 的测试流量已切换为：

`Cloudflare Tunnel → 127.0.0.1:8787 Wrangler Worker → 本地静态资源/API`

Pi Agent 单独运行在 Docker Container
`naibaji-feeding-agent-local`，仅绑定 `127.0.0.1:8080`。Windows 原生
Wrangler 不支持本地托管 Cloudflare Container，因此本地 Worker 通过
`LOCAL_AGENT_URL` 转发；云端部署仍使用 Durable Object Container，不受影响。

管理员可在 `https://org.u3u4.top/admin` 的“Agent API”页配置
Anthropic/OpenAI 供应商、自定义模型、API 地址、Responses/Chat Completions
接口模式和密钥。首次保存必须提交密钥，“校验配置”会实际请求所填 API 的
`/models` 接口，而不是只检查 Pi 内置模型目录。密钥只进入本地 Container，以
AES-256-GCM 加密后保存到 `naibaji-agent-config` Docker volume；浏览器和
Supabase 只接收掩码状态。`.agent-config-key` 是本机解密密钥，已加入
`.gitignore`，丢失后只能重新录入供应商密钥。

“SOP 版本”页使用 `admin_publish_feeding_sop_template` 复制并发布不可变新版本；
普通用户可读取已发布模板，运行记录仍按 `user_id` 隔离，并由数据库在启动时
冻结真实模板快照。

当前 Agent API Key 已清空且 Agent 处于停用状态；确定性 SOP、Supabase 同步和
现场记录均可测试。启动、状态、停止和域名回退见
[本机 Tunnel 运行手册](../docs/local-tunnel-runbook.md)。

## Supabase

`E:\plan\supabase-setup.sql` 是可重复执行的完整契约。2026-07-31 已在
`supermilk` 应用：

- `feeding_agent_sop_v1`
- `feeding_agent_sop_v1_advisor_fixes`
- `existing_rls_initplan_optimization`
- `feeding_sop_completion_idempotency_fix`
- `feeding_sop_state_transition_v1`
- `feeding_sop_first_teaching_transition_fix`
- `feeding_sop_task_actionable_guard`
- `feeding_sop_atomic_start_v1`
- `feeding_laggard_workflow_v1`
- `admin_agent_config_and_global_sop_versions_v1`

七张新表均启用 RLS，匿名权限已撤销。模板正文不可 UPDATE/DELETE；管理员只能
发布新版本或把已发布版本退役，运行批次只引用数据库在启动时冻结的快照。

## 回滚

1. staging/生产环境将 `AGENT_ENABLED` 和 `SOP_ENABLED` 设为 `false` 后重新发布。
2. 恢复上一 Worker 版本；不要删除新表或运行记录。
3. 页面恢复旧 Worker 后，原 `batches`、生产模型和本地缓存继续工作。
4. 本地受保护基线：
   `E:\agent\backups\feeding-agent-sop-20260731-1420\protected-baseline.zip`。
