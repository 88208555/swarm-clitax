# cli-swarm

swarm — 智能体蜂群编排 skill（CLI.Tax 发布）。

- 大脑调度创建 N 个子智能体，企业级组织架构规则
- 项目 JSON 任务派单/认领/回传 + 红绿灯状态 + 进度/错误汇报
- 固定运维智能体：心跳检测、回收卡死智能体、派新智能体继承任务续跑
- 固定安全守卫智能体：注入/危险指令检测、异常警报

```bash
npx cli-swarm@latest install
```


也可以直接从 CLI.Tax 对象存储安装（与站点「安装命令」一致）：

```bash
npx https://cli.tax/cli-downloads/clitax-zj7fTPVh4p.tgz install
```

Source: https://github.com/88208555/swarm-clitax.git

反馈：技能详情页「使用评价」支持 好评 / 差评 / 日常聊天。好评与差评计入市场口碑（跑马灯每日清理），日常消息保留 7 天。
