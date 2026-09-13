# Swarm TestEvidence 与红黄绿
## TestEvidence 合同

`report.evidence` 必须是数组。每个证据项的 `schemaVersion` 必须为 `cli.tax.test-evidence/1.0`，并包含：

- 非空 `evidenceId`；
- `kind`：`test|build|lint|security|benchmark`；
- `runner`：`local|trusted-runner`；
- 非空 `command`；
- 整数 `exitCode`；
- 有限且大于等于零的 `durationMs`；
- 非空 `summary`；
- 可选 `artifactSha256`：64 位小写十六进制 SHA-256。

结构错误会使 `report` 阻断并返回 TestEvidence findings。

## “通过证据”定义

任务的 `report.evidence` 必须非空且exitCode为0；accept还要求task.validationContext.validationRunId等于taskId，并复用Validator验证subject、artifactSha256、receipt签名、结果与有效期。缺少可信公钥或任一不匹配均阻断。

## 灯色规则

| 任务状态 | 条件 | 灯色 |
|---|---|---|
| `reported` | 有 passing TestEvidence，尚未验收 | yellow |
| `reported` | 缺少 passing TestEvidence | yellow |
| `accepted` | 有 passing TestEvidence | green |
| `accepted` | 无 passing TestEvidence | red |
| `failed|blocked|cancelled` | 任意 | red |
| `backlog|assigned|claimed|running` | 任意 | yellow |

`swarm-status` 会为每个 task 附上 `trafficLight`，并返回 green/yellow/red 数量和 dead worker 数量。`traffic-light` 只计算调用方提供的单个 task，不读取服务端状态。

## 证据信任边界

Swarm与Validator共享签名验证实现；单独填写runner字段不能通过。validationContext必须由宿主预先锁定，纯函数传入的角色和任务清单仍需宿主认证，不得宣称远端纯函数拥有持久任务身份控制。

## 实现依据

`swarm-runtime.mjs` 的 `validateTestEvidence`、`normalizeTestEvidence`、`hasPassingTestEvidence`、`taskTrafficLight`、`report`、`accept`、`swarm-status` 和 `traffic-light` 分支是本文的权威来源。
