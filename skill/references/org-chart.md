# Swarm 组织架构
## 协议与层级

`org-chart` 返回 `swarm.org-chart/1.0` JSON，包含三层：

- `board`：决策层，负责派单、验收、停止和回收等决策。
- `management`：固定的 `dispatcher`、`ops`、`security-guard`。
- `execution`：按 `workerCount` 生成的 `worker-NNN` 描述项。

返回的 `permissions` 是角色动作表。实际运行时会在 `dispatch`、`accept` 等关键状态迁移中再检查角色，不应只依赖展示用的权限表。

## 输入与输出

`input` 可包含 `workerCount`、`projectName`、`tasks` 和 `blueprintEnabled`。当前 `workerCount` 默认为 4，并限制在 1–50。成功输出包含 `org`、`fixedAgents`、`workerCount`、`blueprintEnabled` 和 `nextStep`。

如果输入中提供非空 `tasks`，运行时会分析依赖图，把每个无环层的最大宽度（上限 50）返回为 `recommendedWorkerCount`。建议值不会覆盖已生成的 execution worker 数量。

## 依赖图错误

以下情况会产生结构化 findings 并阻断 `org-chart`：

- `taskId` 不合法或重复；
- `dependsOn` 引用不存在的任务；
- 依赖图存在环。

## 当前边界

`org-chart` 只生成组织 JSON，不创建真实子智能体、不建立心跳连接、不存储状态。调用方负责根据组织描述建立实际执行者，并保存每次返回的完整状态。

## 实现依据

`swarm-runtime.mjs` 的 `ORG_LAYERS`、`ORG_PERMISSIONS`、`analyzeTaskGraph`、`buildOrgChart` 和 `validateOrgChart` 是本文的权威来源。
