# Swarm 组织架构

默认主代理执行。org-chart没有任务事实时返回0个worker，nextStep.operation为null，由主代理继续工作。

input可包含workerCount（0–50的整数上限）、projectName、tasks、blueprintEnabled。每个tasks[].facts采用[task-lifecycle.md](task-lifecycle.md)的业务必要性合同。简单、缺失理由、收益不高于协调成本和路径冲突的任务不计入可委派任务。实际数量不超过有依据的独立范围数、依赖图层宽和用户上限，禁止人为夸大估算以增加数量。

org.delegationDecisions逐任务记录delegate及拒绝理由；org.executionMode为single-agent或delegated。recommendedWorkerCount为本次规划的数量上限，宿主应只创建当前就绪任务需要的最少执行者，先复用已有负责人。

board是主代理；management包含dispatcher、ops、security-guard、coordinator逻辑职责，hostAgentId均为board。fixedAgents只含board，buildAgents不为这些管理职责添加独立智能体。

重复或非法taskId、缺失依赖和依赖环仍阻断。运行时只生成组织数据，不创建实际智能体，不提供对未接入IDE的物理拦截；宿主必须执行相同门禁。启用Aimlock或Swarm并不代表需要多智能体。
