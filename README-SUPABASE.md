# 奶爸机 Supabase 部署说明

1. 打开 Supabase 项目的 **SQL Editor**。
2. 新建查询，将 supabase-setup.sql 全部粘贴并执行；即使此前执行过旧版脚本，也请执行本版升级脚本。
3. 进入 **Authentication → Users**。
4. 手动创建第一个邮箱和密码用户（本版本不提供前台注册）。
5. 将 index.html、supabase-client.js、模型文件和 Chart.js 文件一起部署到静态网站。
6. 打开网站后，用刚创建的邮箱和密码登录；新建批次并刷新页面，确认数据仍存在。

## 数据与安全说明

- localStorage 仍是本地缓存和离线降级：先本地保存，再按批次防抖同步到云端。
- 首次检测到旧 nbj_batches 时，页面会要求确认迁移到当前账号；确认后系统记录全局所有者，后续账号无法复制或查看这批旧缓存。旧缓存不会删除。
- 每个账号使用 nbj_batches:<user_id>、nbj_current:<user_id>，避免同一浏览器切换账号时串数据。
- 影子模型状态使用 v5lite_shadow_state:<user_id>:<farmRoom>，避免不同账号共享学习参数。
- batches 使用 (user_id, id) 复合主键和数据库 revision。保存必须匹配读取时的 revision；另一台设备已修改时，客户端会拒绝覆盖、保留本机冲突副本，并提示人工核对。
- 不要把 service_role key、数据库密码或任何管理员私钥放到浏览器。
- Publishable Key 出现在前端是正常的；真正的数据访问权限由 Supabase Auth 与 batches 表的 RLS 策略控制。

## 验收建议

- 用两个不同账号分别登录，确认彼此看不到对方批次。
- 断网后录入数据，确认页面提示本地保存；联网后等待片刻，确认批次同步到 public.batches。
- 在另一台电脑使用同一账号登录，确认可看到相同批次。
- 两台设备同时修改同一批次：后保存的旧 revision 必须收到冲突提示，且云端较新版本不得被覆盖。
