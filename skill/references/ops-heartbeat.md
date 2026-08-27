# Swarm 心跳与回收
## 公开 `heartbeat` 操作

输入为调用方持有的完整 `tasks` 数组和 `workerId`。当前返回 `active: true`、`lastSeenAt`、`workerId` 以及归属该 worker 的 `assignedTaskIds`。

该公开操作不验证 worker 是否存在，不保存心跳，也不自动扫描超时。`active: true` 只表示本次纯函数响应成功，不是远端 worker 存活证明。

## 公开 `reclaim` 操作

输入为 `tasks`、`taskId` 和可选 `reason`。任务不存在时返回 `RECLAIM_FAILED`；已是 `backlog` 时返回 `RECLAIM_NOOP`。其他已找到状态当前都会被设为 `backlog`、清空 owner，并返回完整 tasks。

公开 `reclaim` 不校验调用角色，也不限于 assigned/claimed/running。调用方必须在权威层控制调用者和可回收状态，不得将当前路由写成已完成权限强制。

## 内部运维函数

- `buildAgents`：从 org JSON 生成带状态、最后心跳、miss 次数和进度字段的 agent 数组。
- `recordHeartbeat`：更新已存在 agent 的时间、清零 miss，并可把 dead/red 恢复为 green。
- `scanHeartbeats`：按 30 秒计一次 miss；1–2 次为 yellow，3 次及以上标记 worker dead。
- `reclaimTasks`：只回收指定 worker 名下 `assigned|claimed|running` 任务，设为 backlog 并记录 `inheritedFrom`。
- `replaceWorker`：从已有 agent 数组选择另一个 green worker，将回收任务重新设为 assigned，写入 `assignedBy: ops` 与继承信息。

## 调度边界

当前公开 operation 清单没有 `scan-heartbeats` 或 `replace-worker`，运行时也没有定时器、事件流、后台进程或主动推送。运维智能体/本地 runner 必须持久化完整 agent/task 状态，定时调用心跳扫描和接替函数，才能实现自治运维。

## 实现依据

`swarm-runtime.mjs` 的 `buildAgents`、`recordHeartbeat`、`scanHeartbeats`、`reclaimTasks`、`replaceWorker` 以及 `heartbeat`/`reclaim` 路由是本文的权威来源。
