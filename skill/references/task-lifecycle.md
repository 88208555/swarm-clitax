# Swarm 任务生命周期
## 项目 JSON

`validate-json` 要求 `input.project` 为对象且 `project.tasks` 为非空数组。任务需要稳定 `taskId`；`dependsOn` 必须引用已存在任务，依赖图不得有环。失败返回 `status: blocked` 和 findings。

内部 `buildTasks` 可把项目任务展开为 `swarm.tasks/1.0` 状态项，常用字段包括 `taskId`、`title`、`owner`、`status`、`priority`、`dependsOn`、`report`、进度与继承信息。公开路由不会在服务端持久化这些项。

## 状态迁移

| 操作 | 前置 | 成功结果 |
|---|---|---|
| `dispatch` | 调用角色是 `dispatcher` 或 `board`；任务为 `backlog`；所有依赖为 `accepted` | `assigned`，写入 owner 和 assignedBy |
| `claim` | 任务为 `assigned`；已有 owner 时必须与 workerId 一致 | `claimed`，写入 claimedAt |
| `report` | 任务为 `claimed` 或 `running`；worker 与 owner 一致；report 至少含非空 output 或 evidence 字段 | `reported`，写入 report 和 reportedAt |
| `accept` | 只允许 `board`；任务为 `reported`；`accept: true` 时必须有通过的 TestEvidence | `accepted`；拒绝时为 `failed` |

操作失败会返回对应的 `DISPATCH_FAILED`、`CLAIM_FAILED`、`REPORT_FAILED` 或 `ACCEPT_FAILED` finding，不返回伪造成功。

## 完整状态传递

`dispatch`、`claim`、`report`、`accept` 会修改调用方传入的 `tasks` 数组并返回整个数组。调用方必须保存该完整返回值，下一次操作时原样传回；服务端无会话状态，不能只合并一个 task 片段。

## Blueprint 桥接

`blueprint-bridge` 要求非空 `projectName`、非空 tasks、每任务 title 和合法依赖图。成功时它生成 `blueprint.ir/1.0` 与 Blueprint `compile-inline` 请求信封，包含任务节点、依赖边和验收标准。

桥接本身不访问网络，也不证明 Blueprint 已编译成功。调用方必须将生成的请求发送到允许的 Blueprint 端点，并且只在返回成功后继续派单。

## 实现依据

`swarm-runtime.mjs` 的 `validateProjectJson`、`buildTasks`、`dispatchTask`、`claimTask`、`reportTask`、`acceptTask` 和 `buildBlueprintBridge` 是本文的权威来源。
