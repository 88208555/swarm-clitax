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

任务的 `report.evidence` 必须非空，每一项都通过上述结构校验且 `exitCode === 0`，才算 passing TestEvidence。`accept: true` 没有满足该条件时会被阻断。

## 灯色规则

| 任务状态 | 条件 | 灯色 |
|---|---|---|
| `reported` | 有 passing TestEvidence | green |
| `reported` | 缺少 passing TestEvidence | yellow |
| `accepted` | 有 passing TestEvidence | green |
| `accepted` | 无 passing TestEvidence | red |
| `failed|blocked|cancelled` | 任意 | red |
| `backlog|assigned|claimed|running` | 任意 | yellow |

`swarm-status` 会为每个 task 附上 `trafficLight`，并返回 green/yellow/red 数量和 dead worker 数量。`traffic-light` 只计算调用方提供的单个 task，不读取服务端状态。

## 证据信任边界

当前 Swarm 只校验证据字段和 `exitCode`。它不验证签名、receipt、subject 绑定或 runner 身份；`runner: trusted-runner` 仅是字段值，不得据此声称已完成密码学证明。调用方仍需在 Validator 或受信执行层完成强证据绑定。

## 实现依据

`swarm-runtime.mjs` 的 `validateTestEvidence`、`normalizeTestEvidence`、`hasPassingTestEvidence`、`taskTrafficLight`、`report`、`accept`、`swarm-status` 和 `traffic-light` 分支是本文的权威来源。
