# Swarm 任务生命周期
## 项目 JSON

`validate-json` 要求 `input.project` 为对象且 `project.tasks` 为非空数组。任务需要稳定 `taskId`；`dependsOn` 必须引用已存在任务，依赖图不得有环。失败返回 `status: blocked` 和 findings。

内部 `buildTasks` 可把项目任务展开为 `swarm.tasks/1.0` 状态项，常用字段包括 `taskId`、`title`、`owner`、`status`、`priority`、`dependsOn`、`report`、进度与继承信息。公开路由不会在服务端持久化这些项。

## 状态迁移

| 操作 | 前置 | 成功结果 |
|---|---|---|
| `dispatch` | 调用角色是 `dispatcher` 或 `board`；任务为 `backlog`；所有依赖为 `accepted` 且有任务绑定的可信证据；提交符合门槛且无冲突的 `input.facts` | `assigned`，写入 owner 和 assignedBy |
| `claim` | 任务为 `assigned`；已有 owner 时必须与 workerId 一致 | `claimed`，写入 claimedAt |
| `report` | 任务为 `claimed` 或 `running`；worker 与 owner 一致；report 至少含非空 output 或 evidence 字段 | `reported`，写入 report 和 reportedAt |
| `accept` | 只允许 `board`；任务为 `reported`；`accept: true` 时必须有 Validator 验证通过的任务绑定签名 TestEvidence | `accepted`；拒绝时为 `failed` |

操作失败会返回对应的 `DISPATCH_FAILED`、`CLAIM_FAILED`、`REPORT_FAILED` 或 `ACCEPT_FAILED` finding，不返回伪造成功。

## 完整状态传递

`dispatch`、`claim`、`report`、`accept` 会修改调用方传入的 `tasks` 数组并返回整个数组。调用方必须保存该完整返回值，下一次操作时原样传回；服务端无会话状态，不能只合并一个 task 片段。

## 派单事实与可信验收

`input.facts` 必须包含 `ownerId`、`estimatedChangedLines`、`fileCount`、`crossModule`、`parallelSafe` 与精确相对 `targetPaths`。规模至少满足200行、3文件或跨模块之一；文件数必须与路径数一致，活动写入路径不得冲突。规模达标不能代替业务必要性。

还必须包含 `delegation`：非空 `businessNeed`、`deliverable`、`acceptanceCriteria`、`mainAgentWork`；`independent` 与 `substantial` 均为 true；有限非负数 `estimatedSavedMinutes` 严格大于 `coordinationMinutes`。估算包含上下文传递、协调和验收成本，禁止虚增估算。简单工作或缺失依据明确拒绝派单，主代理继续执行。组织规划使用相同的 `tasks[].facts`，并在 `delegationDecisions` 返回逐任务理由。

任务在开始前声明 `validationContext`，其 `validationRunId` 必须等于 `taskId`，并绑定计划与产物。`report.evidence` 的可信签名由 Validator 公钥验证；仅本地自报或命令退出码为0仍不能验收为绿色。Blueprint 编译只提供计划，调用方必须补充实际派单事实和可信执行凭证。

## Blueprint 桥接

`blueprint-bridge` 要求非空 `projectName`、非空 tasks、每任务 title 和合法依赖图。成功时它生成 `blueprint.ir/1.0` 与 Blueprint `compile-inline` 请求信封，包含任务节点、依赖边和验收标准。

桥接本身不访问网络，也不证明 Blueprint 已编译成功。调用方必须将生成的请求发送到允许的 Blueprint 端点，并且只在返回成功后继续派单。

## 实现依据

`swarm-runtime.mjs` 的 `validateProjectJson`、`buildTasks`、`dispatchTask`、`claimTask`、`reportTask`、`acceptTask` 和 `buildBlueprintBridge` 是本文的权威来源。
