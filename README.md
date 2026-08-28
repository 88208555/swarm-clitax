# cli-swarm

swarm — 智能体蜂群编排 skill（CLI.Tax 发布）。

- 大脑调度创建 N 个子智能体，企业级组织架构规则
- 项目 JSON 任务派单/认领/回传 + 红绿灯状态 + 进度/错误汇报
- 固定运维智能体：心跳检测、回收卡死智能体、派新智能体继承任务续跑
- 固定安全守卫智能体：注入/危险指令检测、异常警报
- 固定协调智能体：`.coord/` 任务卡、冲突扫描、文件/构建锁、基线握手、依赖等待、超时与死锁处置

```bash
npx cli-swarm@latest install
```

本地 AutoCoord 首次调用：

```bash
cli-swarm local capabilities /absolute/repository/path
```

其余操作从 stdin 接收 capabilities 返回 Schema 对应的 JSON；协调事实只写入 `.coord/`，不依赖对话上下文。


也可以直接从 CLI.Tax 对象存储安装（与站点「安装命令」一致）：

```bash
npx https://cli.tax/cli-downloads/clitax-zj7fTPVh4p.tgz install
```

Source: https://github.com/88208555/swarm-clitax.git

## 受限调用与自动评价

使用 `npx cli-swarm@latest invoke <operation> '<JSON对象>'`，或让 IDE 以 JSON stdin 调用 `npx cli-swarm@latest broker`。broker 本身只需要 Brain Client HTTPS、受限身份文件和显式传入路径，不需要完整磁盘访问。要保证 IDE 看不到 token，必须把 broker 作为独立低权限账户或沙箱服务运行并只暴露受限 IPC；同一系统账户下的 `0600` 不能隔离 IDE 与 broker。

Brain Client 服务端在同一次 runtime 请求的事务中绑定真实响应、生成并持久化权威评分与评语，再返回已提交回执。broker 只验证 `feedbackReceiptId`、`feedbackInvocationId` 和权威摘要，不发起第二次评价写入，也不生成分数或评语。`not-reported`、验证不完整、P0/P1 findings、`blocked` 或 `failed` 都不得生成好评；缺凭证、缺回执、摘要不匹配、响应非法或 HTTP 失败都会显式失败。

本地 CLI 不提供手工评分或评语提交命令，人类不能选择技能分数或填写技能评价。日常聊天不属于评价协议。
