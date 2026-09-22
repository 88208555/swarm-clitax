# cli-swarm

swarm — 智能体蜂群编排 skill（CLI.Tax 发布）。

- 大脑调度创建 N 个子智能体，企业级组织架构规则
- 项目 JSON 任务派单/认领/回传 + 红绿灯状态 + 进度/错误汇报
- 固定运维智能体：心跳检测、回收卡死智能体、派新智能体继承任务续跑
- 固定安全守卫智能体：注入/危险指令检测、异常警报
- 固定协调智能体：`.coord/` 任务卡、冲突扫描、文件/构建锁、基线握手、依赖等待、超时与死锁处置
- 同级任务协商：background/normal/high/urgent 四级排序；重叠路径等待、非冲突路径继续，双方自主通知
- 超时重排：固定幂等键请求一个新任务窗口并自动派发；只允许一层派生，禁止旧任务来回切换

```bash
npx cli-swarm@latest install
```

本地 AutoCoord 首次调用：

```bash
cli-swarm local capabilities /absolute/repository/path
```

其余操作从 stdin 接收 capabilities 返回 Schema 对应的 JSON；协调事实只写入 `.coord/`，不依赖对话上下文。

并发写入使用 `peer-coordinate → lock-acquire → guarded-write → lock-release → peer-complete`。高优先任务可越过尚未拿锁的等待项；已有签名锁只能由占用方在安全检查点释放。等待方通过 `peer-status` 取得 `refetchPaths`，重新读取基线、创建新鲜 Aimlock 快照并申请新锁后继续。超过显式 `coordinationTimeoutMs` 后，宿主消费唯一 `spawnRequest` 创建新任务窗口并以 `peer-spawn-bind` 迁移阻塞路径；派生任务不能再次派生。协调消息本身不授予写权限。


也可以直接从 CLI.Tax 对象存储安装（与站点「安装命令」一致）：

```bash
npx https://cli.tax/cli-downloads/clitax-zj7fTPVh4p.tgz install
```

Source: https://github.com/88208555/swarm-clitax.git

## 受限调用与自动评价

使用 `npx cli-swarm@latest invoke <operation> '<JSON对象>'`，或让 IDE 以 JSON stdin 调用 `npx cli-swarm@latest broker`。broker 本身只需要 Brain Client HTTPS、受限身份文件和显式传入路径，不需要完整磁盘访问。要保证 IDE 看不到 token，必须把 broker 作为独立低权限账户或沙箱服务运行并只暴露受限 IPC；同一系统账户下的 `0600` 不能隔离 IDE 与 broker。

Brain Client 服务端在同一次 runtime 请求的事务中绑定真实响应、生成并持久化权威评分与评语，再返回已提交回执。broker 只验证 `feedbackReceiptId`、`feedbackInvocationId` 和权威摘要，不发起第二次评价写入，也不生成分数或评语。`not-reported`、验证不完整、P0/P1 findings、`blocked` 或 `failed` 都不得生成好评；缺凭证、缺回执、摘要不匹配、响应非法或 HTTP 失败都会显式失败。

本地 CLI 不提供手工评分或评语提交命令，人类不能选择技能分数或填写技能评价。日常聊天不属于评价协议。

## 网络中断与原回执恢复

仅在 TLS 握手前确定尚未发送 HTTP 请求时，broker 才允许最多 3 次连接尝试，并受总超时约束。请求发出后发生断线或响应中断，只用 GET 查询原 requestId 的服务端回执，禁止重发 POST；未取得有效回执时保留不确定状态，不得假定成功或继续依赖步骤。

`npx cli-swarm@latest recover <operation> <requestId>` 可重新查询原调用，不会重做操作或重复计费。链恢复不会跳过人工确认，也不会自动重跑结果不确定的本地命令。代理连接需 Node.js 22.21+ 或 24.5+；不支持的运行时会明确报错。

## 账号共享凭据与自动更新

在已登录的能力市场复制安装入口，将内容粘贴给 IDE。页面只展示原地址，剪贴板会携带当前账号凭据。IDE 将四字段凭据 JSON 经标准输入交给 `npx cli-aimlock@latest configure`；不要放到命令参数、项目文件或日志中。一次配置供同一操作系统账号的所有项目、分支和任务使用，八个技能共享同一文件。

默认位置：macOS 为 `~/Library/Application Support/CLI.Tax/broker/credential.json`，Linux 为 `~/.local/share/CLI.Tax/broker/credential.json`，Windows 为 `%LOCALAPPDATA%\CLI.Tax\broker\credential.json`。显式 `CLITAX_BRAIN_CLIENT_TOKEN_FILE` 仍按绝对路径覆盖默认位置；迁移旧 IDE 配置时移除其过时覆盖，再使用账号共享文件。macOS/Linux 校验当前账号所有权和0600权限；Windows校验仅当前账号与SYSTEM可访问的ACL。

每次新技能调用先查询官方发布版本，精确版本下载并校验身份后自动使用；更新已托管的当前项目与账号技能目录，失败恢复旧目录，禁止覆盖 Git 跟踪源码或未托管内容。升级返回 `upgrade.reloadRequired` 和说明路径时，IDE 应读取更新后的 SKILL.md、核对本任务合同再继续。install/check同样自动更新，不需要每次人工发升级指令。查询不确定调用的原回执不升级、不重发操作。

升级不会清除账号凭据；各调用重新读取共享文件，因此重新同步一次密钥后所有任务使用新值。已撤销或失效的密钥不能为自己取得新权限，必须从已认证网页重新同步一次。两个不同操作系统账号不共享私密文件。

English: configure once using JSON stdin; all tasks under the same OS account reuse the credential. Each new invocation checks and updates the official package and managed documentation. Reload updated instructions when indicated. Revoked keys require a fresh authenticated copy.

Русский: настройте ключ один раз через JSON stdin для всех задач пользователя ОС. Перед новым вызовом пакет и управляемые инструкции обновляются автоматически. Отозванный ключ требует повторной синхронизации с авторизованной страницы.
