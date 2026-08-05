# 奶爸机超早期断奶执行 Agent

本项目将确定性饲喂决策核心封装为本地 Node 24/TypeScript Agent，并使用
LangGraph 管理 Agent 流程、Chroma 保存冻结版本的 SOP 检索索引、LangSmith
记录脱敏运行元数据。生产入口由 Docker Compose 统一管理：

```text
浏览器 → Cloudflare（公网 TLS）→ Cloudflare Tunnel → Nginx（内部 HTTP）→ Node Agent
                                                              ├→ Chroma
                                                              └→ CPU Embedding
```

Nginx 提供同源静态页面并代理 `/api/*` 和 SSE。Chroma、embedding 与 Agent
均不映射公网端口；本机只在环回地址暴露 Nginx。Cloudflare Worker、Cloudflare
Container、Wrangler 和 Caddy 不再属于运行链路。

## 安全与数据边界

- 奶量、餐次、时间点、控奶和设备参数只由确定性业务核心与工具计算；检索内容和
  LLM 均不能成为数值权威。
- `AGENT_GATEWAY_SECRET`、数据库加密密钥、管理员密码、Tunnel token 和
  LangSmith key 由 Compose secrets 注入，不写入镜像或配置文件。
- LangSmith 只允许上报时长、状态/错误码、版本、结果 ID 与 HMAC 查询摘要；禁止
  上报原始对话、批次/猪只数据、工具入参/结果、凭据和供应商响应正文。
- Nginx 拒绝 `/internal/*`，对 API/SSE 关闭响应和请求缓冲、关闭缓存，并将上游
  读取超时设为一小时。
- 公网 TLS 在 Cloudflare 终止，Tunnel 到 Nginx 使用 Compose 私网 HTTP；宿主机
  不需要开放入站端口。

## 固定运行组件

| 组件 | 镜像/运行时 | 持久化 |
| --- | --- | --- |
| Agent | `node:24.18.0-slim` | `naibaji-agent-config`、`naibaji-agent-checkpoints` |
| Nginx | `nginx:1.29.1-alpine` | 静态资源构建进只读镜像层 |
| Chroma | `chromadb/chroma:1.5.9` | `naibaji-chroma-data` |
| Embedding | `ghcr.io/huggingface/text-embeddings-inference:cpu-1.9.3` | `naibaji-embedding-cache` |
| Tunnel | `cloudflare/cloudflared:2026.7.0` | 无 |

embedding 模型固定为 `BAAI/bge-small-zh-v1.5` 的提交
`534b6bfaaf500e70bcb9f3771cebc940c23b219d`。该模型面向中文检索、输出 512
维向量，适合现场 CPU 服务；更换模型或提交必须创建新的索引 revision，不能复用
旧批次冻结的 Chroma revision。

## 启动与验证

要求 Docker Compose 2.30+（支持从环境变量创建 secrets）。首次启动前，在当前
PowerShell 会话设置：

```powershell
cd E:\plan\agent
$env:AGENT_GATEWAY_SECRET = '<高强度随机值>'
$env:CONFIG_ENCRYPTION_KEY = '<32 字节随机值的 Base64>'
$env:LOCAL_ADMIN_EMAIL = '<管理员邮箱>'
$env:LOCAL_ADMIN_PASSWORD = '<管理员密码>'
$env:LANGSMITH_API_KEY = 'disabled' # 追踪关闭时使用非密钥占位值
$env:LANGSMITH_TRACING = 'false'
```

启用 LangSmith 时设置 API key 和独立项目名。应用的 metadata-only trace wrapper
是强制边界，不能通过环境变量关闭脱敏：

```powershell
$env:LANGSMITH_API_KEY = '<LangSmith API key>'
$env:LANGSMITH_TRACING = 'true'
$env:LANGSMITH_PROJECT = 'naibaji-feeding-agent-production'
```

构建并启动私有数据层、Agent 与 Nginx：

```powershell
npm run prepare:assets
docker compose -f docker/compose.local.yaml config --quiet
docker compose -f docker/compose.local.yaml pull chroma embedding
docker compose -f docker/compose.local.yaml up -d --build chroma embedding agent nginx
docker compose -f docker/compose.local.yaml ps
Invoke-RestMethod http://127.0.0.1:8788/health
```

首次下载 embedding 模型可能需要数分钟；`agent` 只会在 Chroma 和 embedding
健康后启动。静态首页和管理员页分别为 `http://127.0.0.1:8788/` 与
`http://127.0.0.1:8788/admin`。

启用远程托管的 Cloudflare Tunnel：

```powershell
$env:CLOUDFLARED_TOKEN = '<Tunnel token>'
docker compose -f docker/compose.local.yaml --profile tunnel up -d cloudflared
```

Cloudflare Dashboard 中新建的 public hostname 服务地址应配置为
`http://nginx:8080`。Compose 同时兼容旧远程配置 `http://127.0.0.1:8787`：
cloudflared 与 Nginx 共享网络命名空间，8787 只在该命名空间内监听，不映射到
宿主机。不要配置 HTTPS origin，也不要给 Chroma、embedding 或 Agent 增加
`ports`。本地排障只使用环回入口，可通过 `INGRESS_PORT` 改端口。

代码验证：

```powershell
npm run check
npm test
npm run build
```

## 备份

业务数据、运行配置、LangGraph checkpoint 与 Chroma 索引使用独立卷。升级、重置
测试业务数据或重新索引前必须先备份；embedding cache 可重建，无需备份。为保证
SQLite 和 Chroma 快照一致，先短暂停止写入服务：

```powershell
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "E:\plan\agent\backups\compose-$stamp"
New-Item -ItemType Directory -Path $backup | Out-Null
docker compose -f docker/compose.local.yaml stop nginx agent chroma
docker run --rm --mount type=volume,src=naibaji-agent-config,dst=/source,readonly --mount "type=bind,src=$backup,dst=/backup" alpine:3.22 tar -C /source -czf /backup/agent-config.tgz .
docker run --rm --mount type=volume,src=naibaji-agent-checkpoints,dst=/source,readonly --mount "type=bind,src=$backup,dst=/backup" alpine:3.22 tar -C /source -czf /backup/agent-checkpoints.tgz .
docker run --rm --mount type=volume,src=naibaji-chroma-data,dst=/source,readonly --mount "type=bind,src=$backup,dst=/backup" alpine:3.22 tar -C /source -czf /backup/chroma-data.tgz .
docker compose -f docker/compose.local.yaml up -d chroma embedding agent nginx
Get-FileHash "$backup\*.tgz" -Algorithm SHA256
```

把 Compose 展开后的非密钥配置一并保存，密钥只保存到受控密码库：

```powershell
docker compose -f docker/compose.local.yaml config --no-interpolate | Out-File "$backup\compose.resolved.yaml" -Encoding utf8
git rev-parse HEAD | Out-File "$backup\git-commit.txt" -Encoding ascii
```

完成备份后检查三个归档非零、SHA-256 清单存在，并对业务 SQLite 运行
`PRAGMA integrity_check`。不要仅备份 `naibaji.db` 而遗漏加密运行配置和
checkpoint。

## 发布与回滚

发布顺序固定为：备份 → 拉取固定镜像 → 构建新 Agent/Nginx → 启动 Chroma 与
embedding → 等待健康 → 启动 Agent/Nginx → 环回 API/SSE 冒烟 → 最后启动
Tunnel。发布 SOP 时必须完成“草稿解析与 embedding → 写入新 revision → 读回验证
→ SQLite 原子标记 published”；索引失败时保留上一发布版本为 active。

应用回滚优先恢复上一 Git commit/镜像并重新构建，且不删除现有 SQLite 业务表：

```powershell
docker compose -f docker/compose.local.yaml --profile tunnel down
git switch --detach <previous-commit>
docker compose -f docker/compose.local.yaml up -d --build chroma embedding agent nginx
docker compose -f docker/compose.local.yaml --profile tunnel up -d cloudflared
```

只有确认本次迁移已经破坏数据时，才停止整个栈并从上述归档恢复对应卷；恢复是覆盖
操作，必须再次备份当前卷。Chroma 和 checkpoint 卷可独立恢复或重建，不能用最新
SOP 索引替代批次冻结 digest 对应的缺失 revision。数据库回滚使用升级前
`agent-config.tgz`，不得通过删除新表或清空批次来模拟回滚。
