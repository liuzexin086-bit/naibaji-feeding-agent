# 奶爸机本机 Tunnel 测试运行手册

## 当前流量路径

`org.u3u4.top → Cloudflare Tunnel → 127.0.0.1:8787 Wrangler Worker`

- 静态页面和确定性 SOP API 由本机 Wrangler Worker 提供。
- Pi Agent Container 运行在 Docker，且仅绑定 `127.0.0.1:8080`。
- Worker 通过 `LOCAL_AGENT_URL` 转发聊天请求到 Container。
- Supabase 请求继续使用现场用户 JWT 和 publishable key。
- 当前没有模型供应商密钥，因此 `AGENT_ENABLED=false`；页面、SOP 和现场记录可测试。

## 运行对象

- Docker Container：`naibaji-feeding-agent-local`
- Tunnel：`naibaji-local-test-20260731`
- Tunnel ID：`e86e1f0f-9154-48bb-8ee4-769118ed1bd6`
- DNS：`org.u3u4.top` CNAME 到 Tunnel
- 自动启动：当前用户 Startup 目录中的 `NaibajiLocalTunnelTest.vbs`

## 日常命令

```powershell
cd E:\plan\agent
powershell -ExecutionPolicy Bypass -File scripts\start-local-tunnel-stack.ps1
powershell -ExecutionPolicy Bypass -File scripts\status-local-tunnel-stack.ps1
powershell -ExecutionPolicy Bypass -File scripts\stop-local-tunnel-stack.ps1
```

运行日志位于 `E:\plan\agent\.wrangler\`。Tunnel token 保存在被
`.gitignore` 排除的 `E:\plan\agent\.cloudflared-token`，不得提交或分享。

## 回退到旧 Worker

1. 删除 DNS 记录 `org.u3u4.top`，记录 ID：
   `f8b815fa1815c139297b698f244cfeea`。
2. 将 Worker 自定义域重新附加到服务 `bold-night-870f`：
   hostname 为 `org.u3u4.top`，zone ID 为
   `1cf71524090c8bc48b75b65a23acada6`。
3. 验证 Cloudflare 重新生成只读 AAAA 记录，公网页面返回旧 Worker。
4. 运行 `scripts\stop-local-tunnel-stack.ps1` 停止本机测试栈。

旧 Worker 本体未删除，Supabase 数据不需要回滚。
