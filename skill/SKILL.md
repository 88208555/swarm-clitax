---
name: swarm
description: '通过智能体大脑调度创建 N 个子智能体，用企业级组织架构实现派单、认领、回传、红绿灯和进度汇报；固定运维、安全守卫与 AutoCoord 协调智能体负责心跳回收、注入检测、持久任务卡、冲突扫描、签名锁、基线握手、依赖等待、超时升级和死锁打断。Orchestrate N sub-agents with org-chart dispatch, claims, reports, traffic lights, Ops, Security Guard, and persistent AutoCoord task cards, signed locks, baseline handshakes, dependency waits, timeout escalation, and deadlock interruption. Оркестрирует N субагентов с оргструктурой, диспетчеризацией, отчётами, эксплуатацией, защитой и постоянным AutoCoord: карточки задач, подписанные блокировки, ожидания зависимостей, тайм-ауты и разрыв взаимоблокировок.'
---

# swarm

Package version: v7.0.30

把「项目需求」编排为一支可观测、可自治、可安全运转的智能体蜂群。

Endpoint: https://cli.tax/zj7fTPVh4p

Request schema: `swarm.skill.request/1.0`

## 全链路总流程（老板视角 → 可运转蜂群）

```
老板（任何 IDE / DSH）："我要并行处理 12 个模块的迁移"
  ↓
1. 组织架构（org-chart）—— 按企业级层级生成协作规则：
   决策层（老板/主智能体）→ 管理层（调度/运维/安全守卫/协调器）→ 执行层（N 个子智能体）
  ↓
2. 任务编排（dispatch）—— 读取项目 JSON，拆解为任务包：
   派单（dispatch）→ 认领（claim）→ 执行 → 回传（report）→ 决策层验收（accept）
  ↓
3. 红绿灯（traffic-light）—— 每个任务/智能体实时状态：
   🟢 健康 / 🟡 风险 / 🔴 阻塞；进度与错误持续上报
  ↓
4. 运维接管（ops）—— 固定运维智能体：
   心跳检测 → 发现卡住/死亡（心跳停止）→ 自主收回 → 派遣新智能体接替
   → 新智能体继承原任务列表继续执行
  ↓
5. 安全守卫（security-guard）—— 固定安全智能体：
   异常行为警报 + 恶意信息注入检测（提示词注入/危险指令/越权请求）
  ↓
6. 自动协调（coordinator）—— 固定协调智能体：
   任务卡 → 冲突扫描 → 文件/构建锁 → 基线握手 → 依赖等待/唤醒 → 超时与死锁升级
  ↓
7. 交付 —— 老板得到可观测的蜂群面板 + 全量任务回传 + 安全/运维/协调审计报告
```

**关键**：老板一句话 → 组织架构 → 任务派单 → 红绿灯执行 → 运维自治 + 安全守卫 → 可运转蜂群。全程框架不变，换项目只换 JSON。

## 何时使用

- 用户有多个可并行/依赖编排的子任务（模块迁移、批量审核、多端开发、数据清洗、并行研究）
- 用户需要企业级分工、任务认领回传、进度红绿灯的可观测协作
- 用户需要自动回收卡死智能体并让继任者继承任务的自治能力
- 用户需要内置安全守卫（防注入、异常警报）的多智能体系统
- 用户希望任务先由 Blueprint 技能规划为可追溯蓝图，再交给蜂群执行（可选协同）

不要用于：单智能体就能完成的简单任务（用单 agent 即可）；与任务编排无关的纯计算。

## Blueprint 协同（可选）

intake 时可选择 `blueprintEnabled`：任务先交给 Blueprint 技能规划为可追溯的工程蓝图
（结构/引用/验收全部闭合），再回到蜂群派单执行。开启后 org-chart 的下一步是 `blueprint-bridge`，
由它生成 blueprint 请求负载（`https://cli.tax/wvz6zmRWmX`，operation `compile-inline`），
`blueprint-bridge` 生成合法的 `blueprint.ir/1.0` 与 Blueprint 请求信封；只有 `compile-inline` 成功后才继续
`dispatch → claim → report → accept`。桥接本身不发起网络请求。

## Official catalog hops

After `capabilities`, read `officialCatalog`. Default allowlist is official skills. Call another skill only when its capability matches this demand. User-named extras enter only when the user names them; then confirm that skill's capabilities before invoke. Do not call chain-unrelated or self-extended skills.

## 核心原则

1. **组织即规则**：协作结构 = 企业级组织架构（决策/管理/执行三层），派单、审批、汇报都遵循层级规则。
2. **事实分层**：远端纯运行时仍由调用方回传 `tasks`；本地 AutoCoord 的锁、等待、事件和任务卡只认 `.coord/` 台账，禁止依赖对话上下文。
3. **红绿灯透明**：每个任务/智能体实时红/黄/绿状态，进度与错误持续上报，不隐藏阻塞。
4. **运维自治**：心跳停止/卡死 = 自动收回 + 派新智能体 + 继承任务续跑，不中断整体。
5. **安全守卫**：恶意注入、危险指令、越权请求在进入执行前被拦截并触发警报。
6. **ArchGuard 块级证据**：仅当任务启用了架构合同，worker 每完成一个真实代码块就先执行 checkpoint；report 必须携带 contract digest、ledger entry digest、漂移灯和回滚结果，红灯任务禁止 accept。无合同的存量项目不伪造 checkpoint。
7. **等待必须声明**：跨任务等待先登记 `dependency-wait`；挂起期间禁止读取，事件到达/任务死亡/超时/依赖成环都必须有明确出口。

## 五步实施流程

### 1. 组织架构（org-chart）
生成三层规则：
- 决策层：老板 / 主智能体（定目标、拆任务、验收）
- 管理层：调度智能体（派单）+ 运维智能体（心跳/回收/接替）+ 安全守卫（检测/警报）+ 协调器（冲突/锁/等待/唤醒）
- 执行层：N 个按需创建的子智能体（各自认领任务、执行、回传）

### 2. 任务编排（dispatch / claim / report / accept）
读取项目 JSON：
- `dispatch`：只派发依赖全部存在且已经 `accepted` 的 backlog 任务
- `claim`：子智能体认领任务（同一任务不可被重复认领）
- `report`：执行完成回传结果和 `cli.tax.test-evidence/1.0` 证据
- `accept`：只允许 `board` 调用；缺少合法且 `exitCode: 0` 的 TestEvidence 时阻断

`org-chart` 可接收 `tasks`，用无环依赖图的最大层宽给出 `recommendedWorkerCount`（上限 50）。缺失依赖或依赖环会阻断组织架构，不会静默采用用户输入的 worker 数。

### 3. 红绿灯（traffic-light）
- 🟢 green：任务已回传或验收，且全部 TestEvidence 结构合法、`exitCode` 为 0
- 🟡 yellow：未完成，或已回传但缺少通过证据
- 🔴 red：阻塞 / 失败 / 智能体心跳停止
- 调用方传入最新完整状态后可查询；运行时不保存事件流、不主动推送

### 4. 运维接管（ops）
- 固定运维智能体监控所有子智能体心跳
- 心跳超时/卡死 → 标记死亡 → 自主收回任务
- 派遣新智能体接替 → **继承原任务列表**（含已回传部分）继续执行
- 全程不中断其他智能体

### 5. 安全守卫（security-guard）
- 固定安全智能体扫描：
  - 提示词注入（prompt injection）检测
  - 危险指令（删除/越权/提权/外泄）检测
  - 异常行为（高频重试/异常输入）触发警报
- 拦截结果进入审计日志，老板可查看

## 状态持久化边界

远端运行时是纯函数；本地 `cli-swarm local` 使用仓库 `.coord/` 作为唯一协调事实源。任务卡、锁、队列、事件、等待、裁决与审计由协调器原子写入，聊天只能引用这些记录。调用方自己的任务视图可保存为：

```
swarm-run/
├── org-chart.json        # 组织架构规则（三层）
├── project.json          # 项目需求（唯一事实源）
├── tasks.json            # 任务包（派单/认领/回传状态）
├── traffic-light.json    # 红绿灯状态快照
├── ops-audit.json        # 运维接管记录（回收/接替/继承）
├── security-audit.json   # 安全守卫记录（拦截/警报）
└── reports/              # 各智能体回传结果
```

## 实现状态

| ID | 能力 | 状态 | 边界 |
|---|---|---|---|
| S1 | 回传证据与红绿灯 | 已实现 | 使用统一 TestEvidence；无证据回传保持黄色，只有通过证据可变绿。 |
| S2 | 依赖闭包 | 已实现 | 缺失依赖、未验收依赖、重复 ID 与依赖环均阻断派单。 |
| S3 | 智能 worker 建议 | 已实现 | 按无环依赖图最大层宽计算，最多 50；不负责创建实际子智能体。 |
| S4 | 完整状态传递 | 已实现（调用方持有） | 所有变更操作返回完整 `tasks`；运行时不持久化、不可只合并单个 task。 |
| S5 | AutoCoord 台账与三锁协议 | 已实现（本地协调器） | `.coord/` 原子台账、签名 TTL 文件锁、构建/部署排队和基线握手；Aimlock 写入钩子重验活动租约。 |
| S6 | 依赖等待与死锁防护 | 已实现（本地协调器） | 结构化等待、事件唤醒、任务死亡即告、超时升级、依赖环主动打断和未声明等待检测。 |

Blueprint 桥接已生成远端可验证的完整 IR；`planningStatus` 是业务字段，不覆盖响应信封的 `status: succeeded`。

## 参考文档

- `references/org-chart.md` —— 三层组织、角色权限、worker 数量与并行宽度建议
- `references/task-lifecycle.md` —— 项目 JSON、依赖图、任务状态迁移与 Blueprint 桥接
- `references/traffic-light.md` —— TestEvidence 合同、通过条件与红黄绿判定
- `references/ops-heartbeat.md` —— 心跳、回收、接替、继承与调用方调度边界
- `references/security-guard.md` —— 显式安全检查、拦截结果与当前检测边界
- `references/autocoord.md` —— 任务卡、冲突规则、锁、基线、依赖等待、超时与死锁协议

## 安全规则

- 所有子智能体输入先过安全守卫（防注入/危险指令）
- 心跳/状态数据只由运维智能体修改，防伪造
- 任务回传结果进草稿/审计，不覆盖未验收数据
- 项目 JSON 中的敏感信息（密钥/凭据）不进入子智能体上下文

## 受限调用与自动评价闭环

- IDE / 智能体必须通过本包 `invoke` 或 JSON-stdin `broker` 调用，不得直接拼装技能 HTTP 请求，也不得读取 BrainClient token。
- broker 从 `CLITAX_BRAIN_CLIENT_TOKEN_FILE` 读取身份；macOS/Linux 文件必须为当前 broker 账户所有且权限 `0600`，Windows 文件必须位于受限 `%LOCALAPPDATA%\CLI.Tax\broker` 目录。
- broker 只需要 Brain Client HTTPS、受限身份文件和调用方显式传入的路径，本身不需要完整磁盘访问。若要保证 IDE 无法读取身份文件，必须把 broker 放进独立低权限系统账户或沙箱服务，并只暴露受限 IPC；broker 与 IDE 同账户运行时，`0600` 不能隔离二者，禁止声称令牌已隔离。
- broker 只用 `Authorization: BrainClient …` 发起一次 runtime 请求。HTTP 成功后必须保留响应顶层原始 `feedbackReceiptId`、`feedbackInvocationId` 和 `feedbackEvaluation.digest`，不得生成、猜测、复用或跨调用转移。
- Brain Client 服务端必须严格绑定请求/响应的 `requestId` 和 `schemaVersion`，再根据真实状态、验证结果、服务端耗时与 findings 生成并持久化权威评分、评语和摘要。broker 不得生成分数或评语。
- 同一次 runtime 请求在服务端事务内生成并持久化评价，再返回 `feedbackReceiptId`、`feedbackInvocationId` 和权威摘要；broker 只验证已提交回执，不发起第二次评价写入。`not-reported`、验证不完整、P0/P1 findings、`blocked` 或 `failed` 都不得生成好评。
- 缺少凭证或 ID、身份不匹配、摘要不匹配、响应非法以及任何 HTTP 失败都必须显式失败，不得静默、不重试成重复评价。
- 本地 CLI 不提供手工评分或评语提交命令，人类不得选择技能分数或填写技能评价；日常聊天不属于评价协议。

调用示例：`npx cli-swarm@latest invoke <operation> '<JSON对象>'`。IDE 集成可向 `npx cli-swarm@latest broker` 的 stdin 发送 `{"operation":"capabilities","input":{}}`。
