# cli-swarm

**智能体蜂群编排 skill 多 IDE 安装器** —— 大脑调度 N 个子智能体，企业级组织架构规则 + 项目 JSON 任务派单/认领/回传 + 红绿灯状态 + 固定运维（心跳/回收/接替/继承）与安全守卫（注入检测/警报）。

- **CLI.Tax 源**: `https://cli.tax/zj7fTPVh4p`（`swarm.skill.request/1.0`）
- **多 IDE 安装器**: 检测本机已装 IDE（Codex/DSH/Claude/Cursor/…），把 skill 分发到各 IDE 用户级根
- **更新感知**: 每次 install 对比 cli.tax 最新版本并提示 ⤴；`check` 子命令主动检查

## 一键安装（npm）

```bash
npx cli-swarm@latest install
```

自动完成：从 cli.tax 拉取 swarm → 检测本机已装 IDE → 分发到每个 IDE。
更新：同一命令（`@latest` 自动拉新版），且每次 install 会对比 cli.tax 最新版本并提示 ⤴。

## 从本仓库安装

```bash
git clone https://github.com/88208555/swarm-clitax.git
cd swarm-clitax
node install.mjs install        # 自动检测本机已装 IDE 并分发
node install.mjs check          # 检查已安装 skill 是否有新版本
node install.mjs update         # 幂等覆盖更新
```

## 目录结构

```
swarm-clitax/
├── install.mjs       # 安装器（Node ≥18，零依赖）：install / check / update / pull / uninstall / list / ides
├── sources.json      # cli.tax skill 源（zj7fTPVh4p）
├── package.json      # npm 包元数据（cli-swarm）
├── README.md
└── skills/swarm/
    ├── SKILL.md               # 技能定义（蜂群编排完整流程）
    ├── skill.json             # 技能元数据
    ├── install-meta.json      # 版本锚点（来源/版本/时间）
    ├── swarm-runtime.mjs      # 确定性运行时（组织架构/任务/红绿灯/运维/安全）
    └── references/            # org-chart / task-lifecycle / traffic-light / ops-heartbeat / security-guard
```

## 更新感知（check）

安装器写入 `install-meta.json`（来源/版本/时间）到每个 skill 目录；SKILL.md 注入版本横幅，
IDE 每次读取即可见版本与更新入口。主动检查：

```bash
node install.mjs check               # 遍历本机已装 IDE，对比 cli.tax 最新版本
npx cli-swarm@latest check           # 单包检查
```
