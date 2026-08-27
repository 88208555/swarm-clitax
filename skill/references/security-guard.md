# Swarm 安全守卫
## 显式检查

`security-check` 接收 `input.content` 和可选 `input.agentId`，对本次文本执行规则匹配。成功响应包含 `allowed`、`blocked`、`alerts` 和 `nextStep`；“成功响应”只表示检查已执行，内容仍可能是 `blocked: true`。

## 当前规则

安全守卫当前使用有限正则表达式，检测：

- 要求忽略之前指令、伪装 system/admin/root 角色等常见提示词注入语句；
- `rm -rf`、`DROP TABLE`、`DELETE FROM`、`sudo`、`chmod 777` 及中文提权/越权表述；
- 要求读取、输出或外发 API key、token、password、secret、密钥、密码、凭据的常见语句；
- 要求把内容发送到 HTTP(S) 地址的常见外发语句。

任一规则命中都会设置 `blocked: true`，并生成 high 级别 alert。alert 含 `alertId`、`rule`、`agentId`、`source`、命中模式、`action: block` 和时间。

## 调用流程

1. 调用方在把任务内容交给 worker 前显式调用 `security-check`。
2. `allowed: true` 时才继续 claim/执行。
3. `blocked: true` 时停止该内容的流转，并由调用方将 alerts 保存到审计系统。返回的 `security-alert` nextStep 是调用方指引，不是当前 Swarm 公开 operation。

## 当前边界

- `dispatch`、`claim` 和 `report` 不会自动调用安全检查；调用方必须显式接入。
- intake 会询问 `strict` 或 `observe`，但当前 `securityCheck` 命中后总是拦截，没有 observe-only 分支。
- 当前没有高频重试、行为基线、语义检测、持久化审计或主动报警。正则未命中不等于内容已获得完整安全保证。
- 检查会对输入文本做正则匹配，但 alerts 只返回规则模式而不回显命中的凭据文本；项目 JSON 仍不应包含密钥和凭据。

## 实现依据

`swarm-runtime.mjs` 的 `INJECTION_PATTERNS`、`DANGEROUS_PATTERNS`、`securityCheck` 和 `security-check` 路由是本文的权威来源。
