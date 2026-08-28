# AutoCoord 协调协议

本地入口：`cli-swarm local <operation> <repositoryRoot>`，JSON 从 stdin 传入。先调用 `capabilities`，按返回的 `operationSchemas` 构造请求。

## 唯一事实源

- `.coord/state.json`：任务卡、锁、队列、等待、事件、消息和真人裁决。
- `.coord/leases/`：Ed25519 签名短期租约；释放、续期或 TTL 到期后旧租约立即失效。
- `.coord/audit.jsonl`：全部协调动作的只追加审计。
- 协调承诺不得只写在对话；上下文被清空后必须从台账恢复。

## 任务卡与冲突

任务卡必须声明 `taskScope`、`plannedActions`、`deployTarget`、`eta`、`baselineHash` 与 `archConstraints`。协调器检查范围重叠、同部署目标发布竞争、`forbid-scope:<path>` 架构冲突及 `requirement:<key>=<value>` 决策矛盾。零冲突不路由协调消息。

## 三锁协议

- 文件锁：绑定任务、agent、chain 与路径；Aimlock `guarded-write` 在同一写入临界区重验签名租约和路径范围。
- 构建/部署锁：同资源排队；申请前必须完成当前基线握手。
- 基线握手：观察哈希必须等于任务卡基线，否则任务转为等待并返回重取清单。
- 所有租约 TTL 最长 3600 秒；续期签发新租约，旧租约不再处于活动状态。

## 依赖等待

等待前调用 `dependency-wait`，明确 `waiter`、`waitFor`、结构化 `event`、`expectedWithinMs`、到达/超时策略和 `refetchPaths`。活动等待会阻断同 chain 的 Aimlock 预算读取。

- 事件到达：5 秒目标窗口内路由唤醒包，内容含事件与重取清单。
- 对方失败或被回收：立即以 `dependency-terminated` 唤醒，不等超时。
- 超时：按声明处置；`escalate-need-human` 和连续第二次超时生成高风险 Confirm Protocol 请求。
- 成环：登记时或 `tick` 检出后立即打断全部相关等待，并生成真人裁决请求。
- 未登记等待：`task-status=waiting` 返回 `undeclaredWait=true` 和补登提示。

等待必须由事件到达、终止通知、超时处置或死锁打断结束，不允许无限期静默挂起。
