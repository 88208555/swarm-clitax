// swarm v7.0.10：自包含、无外部依赖的确定性蜂群编排运行时。
const REQUEST_SCHEMA = "swarm.skill.request/1.0";
const ALLOWED_EXTERNAL_ENDPOINTS = { blueprint: "https://cli.tax/wvz6zmRWmX" };
const RESPONSE_SCHEMA = "swarm.skill.response/1.0";
const ERROR_SCHEMA = "swarm.skill.error/1.0";
const ORG_SCHEMA = "swarm.org-chart/1.0";
const TASK_SCHEMA = "swarm.tasks/1.0";
const TEST_EVIDENCE_SCHEMA = "cli.tax.test-evidence/1.0";
const COMPILER_NAME = "swarm";
const COMPILER_VERSION = "v7.0.19";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PURE_OPERATIONS = new Set([
  "capabilities", "help", "intake", "org-chart", "blueprint-bridge", "dispatch", "claim",
  "report", "accept", "swarm-status", "traffic-light", "security-check", "validate-json", "heartbeat", "reclaim",
]);
function text(value) { return String(value ?? ""); }
function okResponse(requestId, payload) { return { schemaVersion: RESPONSE_SCHEMA, requestId, status: "succeeded", ...payload }; }
function blockedResponse(requestId, request, findings) {
  return { schemaVersion: RESPONSE_SCHEMA, requestId, status: "blocked", brainMode: null,
    requestedBrainMode: request?.requestedBrainMode ?? "ide", brainUsed: false, revision: null,
    validation: { valid: false, guarantee: "blocked", findings } };
}
function finding(severity, ruleId, entityRef, message, evidence = {}) { return { severity, ruleId, entityRef, message, evidence }; }
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function validId(value) { return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value); }
const ORG_LAYERS = ["board", "management", "execution"];
const ORG_ROLES = ["board", "dispatcher", "ops", "security-guard", "worker"];
const ORG_FIXED_ROLES = new Set(["board", "dispatcher", "ops", "security-guard"]);
const ORG_PERMISSIONS = {
  board: ["dispatch", "accept", "reject", "stop", "reclaim", "replace"],
  dispatcher: ["dispatch", "reassign", "prioritize"],
  ops: ["heartbeat", "reclaim", "replace"],
  "security-guard": ["block", "alert", "quarantine"],
  worker: ["claim", "report", "request-help"],
};
function analyzeTaskGraph(tasks) {
  const findings = [];
  const ids = new Set();
  for (const [index, task] of tasks.entries()) {
    const ref = `tasks[${index}]`;
    if (!isObject(task) || !validId(task.taskId)) { findings.push(finding("P0", "TASK_ID", `${ref}.taskId`, "taskId must be a stable identifier", { example: "task-1" })); continue; }
    if (ids.has(task.taskId)) findings.push(finding("P0", "TASK_ID_DUPLICATE", `${ref}.taskId`, `duplicate taskId ${task.taskId}`));
    ids.add(task.taskId);
  }
  for (const [index, task] of tasks.entries()) {
    if (!isObject(task) || !Array.isArray(task.dependsOn)) continue;
    for (const dependencyId of task.dependsOn) if (!ids.has(dependencyId)) findings.push(finding("P0", "DEPENDENCY_MISSING", `tasks[${index}].dependsOn`, `dependency ${dependencyId} does not exist`));
  }
  if (findings.length) return { findings, recommendedWorkerCount: null };
  const remaining = new Map(tasks.map((task) => [task.taskId, task]));
  const completed = new Set(), levels = [];
  while (remaining.size > 0) {
    const batch = [];
    for (const [taskId, task] of remaining) {
      const dependencies = Array.isArray(task.dependsOn) ? task.dependsOn : [];
      if (dependencies.every((dependencyId) => completed.has(dependencyId))) batch.push(taskId);
    }
    if (batch.length === 0) return { findings: [finding("P0", "DEPENDENCY_CYCLE", "tasks", `dependency cycle includes: ${[...remaining.keys()].join(", ")}`)], recommendedWorkerCount: null };
    levels.push(batch.length);
    for (const taskId of batch) { remaining.delete(taskId); completed.add(taskId); }
  }
  return { findings: [], recommendedWorkerCount: Math.min(50, Math.max(...levels)) };
}
function buildOrgChart(input = {}) {
  const workerCount = Math.min(50, Math.max(1, Math.floor(Number(input.workerCount) || 4)));
  const projectName = text(input.projectName || "swarm-run");
  let recommendedWorkerCount, recommendationFindings = [];
  if (Array.isArray(input.tasks) && input.tasks.length > 0) {
    const analysis = analyzeTaskGraph(input.tasks);
    recommendedWorkerCount = analysis.recommendedWorkerCount ?? undefined;
    recommendationFindings = analysis.findings;
  }
  const org = { schemaVersion: ORG_SCHEMA, projectName,
    layers: {
      board: [{ agentId: "board", role: "board", title: "决策层·老板/主智能体" }],
      management: [
        { agentId: "dispatcher", role: "dispatcher", title: "管理层·调度智能体", fixed: true },
        { agentId: "ops", role: "ops", title: "管理层·运维智能体", fixed: true },
        { agentId: "security-guard", role: "security-guard", title: "管理层·安全守卫智能体", fixed: true },
      ],
      execution: Array.from({ length: workerCount }, (_, i) => ({ agentId: `worker-${String(i + 1).padStart(3, "0")}`,
        role: "worker", title: `执行层·子智能体 ${i + 1}`, fixed: false })),
    }, permissions: ORG_PERMISSIONS };
  if (recommendedWorkerCount !== undefined) org.recommendedWorkerCount = recommendedWorkerCount;
  if (recommendationFindings.length) org.recommendationFindings = recommendationFindings;
  return org;
}
function validateOrgChart(org) {
  const findings = [];
  if (!isObject(org)) return [finding("P0", "ORG_OBJECT", "org", "org must be an object", { example: { schemaVersion: "swarm.org-chart/1.0" } })];
  if (org.schemaVersion !== ORG_SCHEMA) findings.push(finding("P0", "ORG_SCHEMA_VERSION", "org.schemaVersion", `Expected ${ORG_SCHEMA}`, { example: { schemaVersion: "swarm.org-chart/1.0" } }));
  for (const layer of ORG_LAYERS) if (!Array.isArray(org.layers?.[layer])) findings.push(finding("P0", "ORG_LAYER_ARRAY", `org.layers.${layer}`, "must be an array", { example: { layers: { board: [] } } }));
  if (Array.isArray(org.recommendationFindings)) findings.push(...org.recommendationFindings);
  return findings;
}
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /忽略\s*(之前|此前|先前)\s*(的)?(所有)?指令/i,
  /you\s+are\s+now|act\s+as\s+an?\s+(admin|system|root)/i,
  /现在你(是|要|必须)/,
  /(?:系统|system)\s*(提示词|提示|指令)\s*[:：]/,
];
const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\b|\bDROP\s+TABLE\b|\bDELETE\s+FROM\b/i,
  /\bsudo\b|\bchmod\s+777\b|提权|越权/i,
  /(?:导出|输出|给出|返回|泄露|外发|发送|上传|回传|读取|获取)[^。\n]{0,24}?(?:api[_-]?\s*key|token|password|secret|密钥|密码|凭据)/i,
  /(?:api[_-]?\s*key|token|password|secret|密钥|密码|凭据)\s*(?:[:：=]\s*[A-Za-z0-9_\-]{6,}|请\s*(?:输出|给出|返回|提供))/i,
  /(?:发送|上传|回传|外发)\s*(?:到|至)?\s*https?:\/\//i,
];
function securityCheck(content, context = {}) {
  const input = text(content), agentId = text(context.agentId || "unknown"), alerts = [];
  const injectionHits = INJECTION_PATTERNS.filter((p) => p.test(input)).map((p) => p.source);
  if (injectionHits.length) alerts.push({ alertId: `sec-${Math.random().toString(36).slice(2, 8)}`, severity: "high",
    rule: "prompt-injection", agentId, source: "task-input", matched: injectionHits, action: "block", at: new Date().toISOString() });
  const dangerHits = DANGEROUS_PATTERNS.filter((p) => p.test(input)).map((p) => p.source);
  if (dangerHits.length) alerts.push({ alertId: `sec-${Math.random().toString(36).slice(2, 8)}`, severity: "high",
    rule: "dangerous-command", agentId, source: "task-input", matched: dangerHits, action: "block", at: new Date().toISOString() });
  return { allowed: alerts.length === 0, blocked: alerts.length > 0, alerts };
}
const TASK_STATUSES = new Set(["backlog", "assigned", "claimed", "running", "reported", "accepted", "failed", "blocked", "cancelled"]);
function validateProjectJson(project) {
  const findings = [];
  if (!isObject(project)) return [finding("P0", "PROJECT_OBJECT", "project", "project must be an object", { example: { tasks: [{ taskId: "t1" }] } })];
  if (!Array.isArray(project.tasks) || project.tasks.length === 0) findings.push(finding("P0", "PROJECT_TASKS", "project.tasks", "tasks must be a non-empty array", { example: { tasks: [{ taskId: "t1", title: "example" }] } }));
  else findings.push(...analyzeTaskGraph(project.tasks).findings);
  return findings;
}
function buildTasks(project, org) {
  return (project.tasks ?? []).map((task, index) => ({
    taskId: validId(task.taskId) ? task.taskId : `task-${String(index + 1).padStart(4, "0")}`,
    title: text(task.title || task.name || `任务 ${index + 1}`), owner: null, status: "backlog",
    priority: text(task.priority || "normal"), dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn : [],
    assignedBy: null, claimedAt: null, reportedAt: null, report: null, progressPercent: 0,
    progressNote: "", inheritedFrom: null }));
}
function dispatchTask(tasks, taskId, workerId, actorRole) {
  if (!ORG_PERMISSIONS[actorRole]?.includes("dispatch")) return { ok: false, error: `role ${actorRole} cannot dispatch` };
  const task = tasks.find((t) => t.taskId === taskId);
  if (!task) return { ok: false, error: `task ${taskId} not found` };
  if (task.status !== "backlog") return { ok: false, error: `task ${taskId} is ${task.status}, not backlog` };
  for (const dependencyId of Array.isArray(task.dependsOn) ? task.dependsOn : []) {
    const dependency = tasks.find((candidate) => candidate.taskId === dependencyId);
    if (!dependency) return { ok: false, error: `dependency ${dependencyId} not found` };
    if (dependency.status !== "accepted") return { ok: false, error: `dependency ${dependencyId} is ${dependency.status}, not accepted` };
  }
  task.status = "assigned"; task.owner = workerId; task.assignedBy = actorRole;
  return { ok: true, task };
}
function claimTask(tasks, taskId, workerId) {
  const task = tasks.find((t) => t.taskId === taskId);
  if (!task) return { ok: false, error: `task ${taskId} not found` };
  if (task.status !== "assigned") return { ok: false, error: `task ${taskId} is ${task.status}, not assigned` };
  if (task.owner && task.owner !== workerId) return { ok: false, error: `task ${taskId} claimed by another worker` };
  task.status = "claimed"; task.owner = workerId; task.claimedAt = new Date().toISOString();
  return { ok: true, task };
}
function validateTestEvidence(value, entityRef) {
  const findings = [];
  if (!isObject(value)) return [finding("P0", "TEST_EVIDENCE_OBJECT", entityRef, "TestEvidence must be an object")];
  if (value.schemaVersion !== TEST_EVIDENCE_SCHEMA) findings.push(finding("P0", "TEST_EVIDENCE_SCHEMA", `${entityRef}.schemaVersion`, `Expected ${TEST_EVIDENCE_SCHEMA}`));
  if (!text(value.evidenceId).trim()) findings.push(finding("P0", "TEST_EVIDENCE_ID", `${entityRef}.evidenceId`, "evidenceId is required"));
  if (!["test", "build", "lint", "security", "benchmark"].includes(value.kind)) findings.push(finding("P0", "TEST_EVIDENCE_KIND", `${entityRef}.kind`, "kind is unsupported"));
  if (!["local", "trusted-runner"].includes(value.runner)) findings.push(finding("P0", "TEST_EVIDENCE_RUNNER", `${entityRef}.runner`, "runner must be local or trusted-runner"));
  if (!text(value.command).trim()) findings.push(finding("P0", "TEST_EVIDENCE_COMMAND", `${entityRef}.command`, "command is required"));
  if (!Number.isInteger(value.exitCode)) findings.push(finding("P0", "TEST_EVIDENCE_EXIT", `${entityRef}.exitCode`, "exitCode must be an integer"));
  if (typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0) findings.push(finding("P0", "TEST_EVIDENCE_DURATION", `${entityRef}.durationMs`, "durationMs must be a finite number >= 0"));
  if (!text(value.summary).trim()) findings.push(finding("P0", "TEST_EVIDENCE_SUMMARY", `${entityRef}.summary`, "summary is required"));
  if (value.artifactSha256 !== undefined && !SHA256_PATTERN.test(value.artifactSha256)) findings.push(finding("P0", "TEST_EVIDENCE_ARTIFACT", `${entityRef}.artifactSha256`, "artifactSha256 must be a lowercase SHA-256 digest"));
  return findings;
}
function normalizeTestEvidence(values) {
  if (!Array.isArray(values)) return { evidence: [], findings: [finding("P0", "TEST_EVIDENCE_ARRAY", "report.evidence", "evidence must be an array")] };
  const findings = values.flatMap((value, index) => validateTestEvidence(value, `report.evidence[${index}]`));
  return findings.length ? { evidence: [], findings } : { evidence: values.map((value) => ({ ...value })), findings: [] };
}
function hasPassingTestEvidence(task) {
  const evidence = task?.report?.evidence;
  return Array.isArray(evidence) && evidence.length > 0
    && evidence.every((value, index) => validateTestEvidence(value, `task.report.evidence[${index}]`).length === 0 && value.exitCode === 0);
}
function reportTask(tasks, taskId, workerId, report) {
  const task = tasks.find((t) => t.taskId === taskId);
  if (!task) return { ok: false, error: `task ${taskId} not found` };
  if (task.owner && task.owner !== workerId) return { ok: false, error: `task ${taskId} not owned by ${workerId}` };
  if (!["claimed", "running"].includes(task.status)) return { ok: false, error: `task ${taskId} is ${task.status}, cannot report` };
  if (!isObject(report)) return { ok: false, error: "report must be an object" };
  if (!text(report.output).trim() && report.evidence === undefined) return { ok: false, error: "report must have output or evidence" };
  const normalizedReport = { output: text(report.output) };
  if (report.evidence !== undefined) {
    const normalized = normalizeTestEvidence(report.evidence);
    if (normalized.findings.length) return { ok: false, error: "report evidence is invalid", findings: normalized.findings };
    normalizedReport.evidence = normalized.evidence;
  }
  task.status = "reported"; task.report = normalizedReport; task.reportedAt = new Date().toISOString();
  return { ok: true, task, hasEvidence: hasPassingTestEvidence(task) };
}
function acceptTask(tasks, taskId, accept, actorRole) {
  if (actorRole !== "board") return { ok: false, error: `role ${actorRole} cannot accept` };
  const task = tasks.find((t) => t.taskId === taskId);
  if (!task) return { ok: false, error: `task ${taskId} not found` };
  if (task.status !== "reported") return { ok: false, error: `task ${taskId} is ${task.status}, not reported` };
  if (accept && !hasPassingTestEvidence(task)) return { ok: false, error: `task ${taskId} has no passing TestEvidence` };
  task.status = accept ? "accepted" : "failed";
  return { ok: true, task };
}
function taskTrafficLight(task) {
  if (task.status === "accepted") return hasPassingTestEvidence(task) ? "green" : "red";
  if (task.status === "reported") return hasPassingTestEvidence(task) ? "green" : "yellow";
  if (task.status === "failed" || task.status === "blocked" || task.status === "cancelled") return "red";
  return "yellow";
}
const HEARTBEAT_MISS_LIMIT = 3;
function buildAgents(org, nowIso = null) {
  const now = nowIso || new Date().toISOString(), agents = [];
  for (const layer of ORG_LAYERS) for (const member of org.layers?.[layer] ?? []) {
    agents.push({ agentId: member.agentId, role: member.role, title: member.title,
        fixed: Boolean(member.fixed), status: "green", lastHeartbeatAt: now,
        heartbeatMisses: 0, currentTaskId: null, progressPercent: 0, progressNote: "" });
  }
  return agents;
}
function recordHeartbeat(agents, agentId) {
  const agent = agents.find((a) => a.agentId === agentId);
  if (!agent) return { ok: false, error: `agent ${agentId} not found` };
  agent.lastHeartbeatAt = new Date().toISOString();
  agent.heartbeatMisses = 0;
  if (agent.status === "dead" || agent.status === "red") agent.status = "green";
  return { ok: true, agent };
}
function scanHeartbeats(agents, nowIso = null) {
  const now = nowIso ? new Date(nowIso).getTime() : Date.now();
  const dead = [];
  for (const agent of agents) {
    if (agent.role !== "worker") continue;
    const misses = Math.floor((now - new Date(agent.lastHeartbeatAt).getTime()) / 30000);
    agent.heartbeatMisses = Math.max(agent.heartbeatMisses, Math.min(misses, 99));
    if (agent.heartbeatMisses >= HEARTBEAT_MISS_LIMIT && agent.status !== "dead") { agent.status = "dead"; dead.push(agent.agentId); }
    else if (agent.heartbeatMisses >= 1) agent.status = "yellow";
    else agent.status = "green";
  }
  return dead;
}
function reclaimTasks(tasks, workerId) {
  const reclaimed = [];
  for (const task of tasks) {
    if (task.owner === workerId && ["assigned", "claimed", "running"].includes(task.status)) {
      task.status = "backlog"; task.owner = null; task.inheritedFrom = workerId; reclaimed.push(task.taskId);
    }
  }
  return reclaimed;
}
function replaceWorker(org, agents, tasks, deadWorkerId, newWorkerId = null) {
  const dead = agents.find((a) => a.agentId === deadWorkerId);
  if (!dead) return { ok: false, error: `dead worker ${deadWorkerId} not found` };
  const replacement = newWorkerId ? agents.find((a) => a.agentId === newWorkerId && a.role === "worker")
    : agents.find((a) => a.role === "worker" && a.status === "green" && a.agentId !== deadWorkerId);
  if (!replacement) return { ok: false, error: "no healthy replacement worker available" };
  const inheritedTasks = reclaimTasks(tasks, deadWorkerId);
  for (const taskId of inheritedTasks) {
    const task = tasks.find((t) => t.taskId === taskId);
    if (task) { task.owner = replacement.agentId; task.status = "assigned"; task.assignedBy = "ops"; task.inheritedFrom = deadWorkerId; }
  }
  dead.status = "dead";
  replacement.currentTaskId = inheritedTasks[0] ?? null;
  return { ok: true, replacement: replacement.agentId, inheritedTasks };
}
const INTAKE_QUESTIONS = [
  { id: "goal", prompt: "What must the swarm accomplish? List the parallel/ordered work items or point to the project JSON.", required: true, example: "12 个模块迁移：A1..A12，依赖 A1→A2→A3，其余并行" },
  { id: "workerCount", prompt: "How many worker sub-agents should the brain create?", required: false, example: "6" },
  { id: "orgTier", prompt: "Any org-chart constraints? (default: board → dispatcher/ops/security-guard → workers)", required: false, example: "默认三层即可" },
  { id: "securityPolicy", prompt: "Security policy: strict (block injections) or observe (alert only)?", required: false, example: "strict" },
  { id: "blueprintEnabled", prompt: "Use Blueprint to plan tasks before dispatch? (yes: tasks are planned by the Blueprint skill for traceable acceptance; no: direct dispatch)", required: false, example: "no" },
];
const OPERATION_CATALOG = Object.freeze([...PURE_OPERATIONS].map((operation) => ({ operation, summary: operation })));
const stringSchema = (extra = {}) => ({ type: "string", ...extra });
const arraySchema = (items, extra = {}) => ({ type: "array", items, ...extra });
const objectSchema = (properties, required = [], extra = {}) => ({ type: "object", properties, required, additionalProperties: false, ...extra });
const anyObjectSchema = { type: "object" };
const nullableStringSchema = { type: ["string", "null"] };
const evidenceSchema = objectSchema({
  schemaVersion: { const: TEST_EVIDENCE_SCHEMA }, evidenceId: stringSchema({ minLength: 1 }),
  kind: { enum: ["test", "build", "lint", "security", "benchmark"] }, runner: { enum: ["local", "trusted-runner"] },
  command: stringSchema({ minLength: 1 }), exitCode: { type: "integer" }, durationMs: { type: "number", minimum: 0 },
  summary: stringSchema({ minLength: 1 }), artifactSha256: stringSchema({ pattern: SHA256_PATTERN.source }),
}, ["schemaVersion", "evidenceId", "kind", "runner", "command", "exitCode", "durationMs", "summary"], { additionalProperties: true });
const reportSchema = objectSchema({ output: stringSchema(), evidence: arraySchema(evidenceSchema) }, [], {
  anyOf: [{ properties: { output: stringSchema({ minLength: 1 }) }, required: ["output"] }, { required: ["evidence"] }],
});
const taskSchema = objectSchema({
  taskId: stringSchema({ minLength: 1 }), title: stringSchema(), owner: nullableStringSchema,
  status: { enum: [...TASK_STATUSES] }, priority: stringSchema(), dependsOn: arraySchema(stringSchema()),
  assignedBy: nullableStringSchema, claimedAt: nullableStringSchema, reportedAt: nullableStringSchema,
  report: { anyOf: [{ type: "null" }, reportSchema] }, progressPercent: { type: "number" }, progressNote: stringSchema(),
  inheritedFrom: nullableStringSchema, trafficLight: { enum: ["green", "yellow", "red"] },
}, ["taskId", "title", "status", "dependsOn"], { additionalProperties: true });
const projectTaskSchema = objectSchema({ taskId: stringSchema({ minLength: 1 }), title: stringSchema({ minLength: 1 }),
  name: stringSchema(), priority: stringSchema(), dependsOn: arraySchema(stringSchema()) }, ["taskId", "title"], { additionalProperties: true });
const agentSchema = objectSchema({ agentId: stringSchema({ minLength: 1 }), role: { enum: ORG_ROLES }, title: stringSchema(),
  fixed: { type: "boolean" }, status: { enum: ["green", "yellow", "red", "dead"] }, lastHeartbeatAt: stringSchema({ format: "date-time" }),
  heartbeatMisses: { type: "integer", minimum: 0 }, currentTaskId: nullableStringSchema,
  progressPercent: { type: "number" }, progressNote: stringSchema() }, ["agentId", "role", "status"], { additionalProperties: true });
const nextSchema = objectSchema({ operation: { type: ["string", "null"] }, instruction: stringSchema() }, ["operation", "instruction"]);
const responseBase = { schemaVersion: { const: RESPONSE_SCHEMA }, requestId: stringSchema({ minLength: 1 }) };
const succeededSchema = (properties, required = []) => objectSchema({ ...responseBase, status: { const: "succeeded" }, ...properties }, ["schemaVersion", "requestId", "status", ...required]);
const blockedSchema = objectSchema({ ...responseBase, status: { const: "blocked" }, brainMode: { type: "null" }, requestedBrainMode: stringSchema(),
  brainUsed: { const: false }, revision: { type: "null" }, validation: anyObjectSchema, errorSchema: { const: ERROR_SCHEMA } },
["schemaVersion", "requestId", "status", "brainMode", "requestedBrainMode", "brainUsed", "revision", "validation"]);
const failedSchema = objectSchema({ ...responseBase, status: { const: "failed" }, errorSchema: { const: ERROR_SCHEMA }, error: anyObjectSchema },
  ["schemaVersion", "requestId", "status", "errorSchema", "error"]);
const operationSchema = (input, inputRequired, output, outputRequired) => ({ input: objectSchema(input, inputRequired),
  output: { type: "object", oneOf: [succeededSchema(output, outputRequired), blockedSchema, failedSchema] } });
const tasksInput = { tasks: arraySchema(taskSchema), taskId: stringSchema({ minLength: 1 }) };
const taskStateOutput = { task: taskSchema, tasks: arraySchema(taskSchema), stateNote: stringSchema() };
const OPERATION_SCHEMAS = Object.freeze({
  capabilities: operationSchema({}, [], { capabilities: anyObjectSchema, operationSchemas: anyObjectSchema, skill: anyObjectSchema, nextStep: nextSchema }, ["capabilities", "operationSchemas", "skill", "nextStep"]),
  help: operationSchema({}, [], { help: anyObjectSchema, nextStep: nextSchema }, ["help", "nextStep"]),
  intake: operationSchema({}, [], { questions: arraySchema(anyObjectSchema), nextStep: nextSchema }, ["questions", "nextStep"]),
  "org-chart": operationSchema({ workerCount: { type: "number", minimum: 1, maximum: 50 }, projectName: stringSchema(), blueprintEnabled: { type: ["boolean", "string"] }, tasks: arraySchema(projectTaskSchema) }, [], { org: anyObjectSchema, blueprintEnabled: { type: "boolean" }, fixedAgents: arraySchema(stringSchema()), workerCount: { type: "integer" }, nextStep: nextSchema }, ["org", "blueprintEnabled", "fixedAgents", "workerCount", "nextStep"]),
  "blueprint-bridge": operationSchema({ projectName: stringSchema({ minLength: 1 }), tasks: arraySchema(projectTaskSchema, { minItems: 1 }) }, ["projectName", "tasks"], { planningStatus: { const: "planned" }, blueprintEnabled: { const: true }, blueprintEndpoint: stringSchema({ format: "uri" }), blueprintRequest: anyObjectSchema, projectFormat: { const: "swarm.project/1.0" }, nextStep: nextSchema }, ["planningStatus", "blueprintEnabled", "blueprintEndpoint", "blueprintRequest", "projectFormat", "nextStep"]),
  dispatch: operationSchema({ ...tasksInput, workerId: stringSchema({ minLength: 1 }), actorRole: { enum: ["dispatcher", "board"] } }, ["tasks", "taskId", "workerId", "actorRole"], { ...taskStateOutput, nextStep: nextSchema }, ["task", "tasks", "stateNote", "nextStep"]),
  claim: operationSchema({ ...tasksInput, workerId: stringSchema({ minLength: 1 }) }, ["tasks", "taskId", "workerId"], { ...taskStateOutput, trafficLight: { enum: ["green", "yellow", "red"] }, nextStep: nextSchema }, ["task", "tasks", "trafficLight", "stateNote", "nextStep"]),
  report: operationSchema({ ...tasksInput, workerId: stringSchema({ minLength: 1 }), report: reportSchema }, ["tasks", "taskId", "workerId", "report"], { ...taskStateOutput, trafficLight: { enum: ["green", "yellow", "red"] }, evidenceRequired: { type: "boolean" }, nextStep: nextSchema }, ["task", "tasks", "trafficLight", "stateNote", "nextStep"]),
  accept: operationSchema({ ...tasksInput, actorRole: { const: "board" }, accept: { type: "boolean" } }, ["tasks", "taskId", "actorRole", "accept"], { ...taskStateOutput, trafficLight: { enum: ["green", "yellow", "red"] }, nextStep: nextSchema }, ["task", "tasks", "trafficLight", "stateNote", "nextStep"]),
  "swarm-status": operationSchema({ tasks: arraySchema(taskSchema), agents: arraySchema(agentSchema) }, ["tasks", "agents"], { tasks: arraySchema(taskSchema), agents: arraySchema(agentSchema), summary: anyObjectSchema, stateNote: stringSchema(), nextStep: nextSchema }, ["tasks", "agents", "summary", "stateNote", "nextStep"]),
  "traffic-light": operationSchema({ task: taskSchema }, ["task"], { trafficLight: { enum: ["green", "yellow", "red"] }, rules: anyObjectSchema }, ["trafficLight", "rules"]),
  "security-check": operationSchema({ content: stringSchema(), agentId: stringSchema() }, ["content"], { allowed: { type: "boolean" }, blocked: { type: "boolean" }, alerts: arraySchema(anyObjectSchema), nextStep: nextSchema }, ["allowed", "blocked", "alerts", "nextStep"]),
  "validate-json": operationSchema({ project: objectSchema({ tasks: arraySchema(projectTaskSchema, { minItems: 1 }) }, ["tasks"], { additionalProperties: true }) }, ["project"], { valid: { const: true }, taskCount: { type: "integer", minimum: 1 }, nextStep: nextSchema }, ["valid", "taskCount", "nextStep"]),
  heartbeat: operationSchema({ tasks: arraySchema(taskSchema), workerId: stringSchema({ minLength: 1 }) }, ["tasks", "workerId"], { active: { const: true }, lastSeenAt: stringSchema({ format: "date-time" }), workerId: stringSchema(), assignedTaskIds: arraySchema(stringSchema()), stateNote: stringSchema() }, ["active", "lastSeenAt", "workerId", "assignedTaskIds", "stateNote"]),
  reclaim: operationSchema({ ...tasksInput, reason: stringSchema() }, ["tasks", "taskId"], { reclaimed: { const: true }, taskId: stringSchema(), reason: stringSchema(), ...taskStateOutput }, ["reclaimed", "taskId", "reason", "task", "tasks", "stateNote"]),
});
function validateRequest(request) {
  const findings = [];
  if (!isObject(request)) return [finding("P0", "REQUEST_OBJECT", "request", "request must be an object", { example: { schemaVersion: REQUEST_SCHEMA, requestId: "req-1", operation: "capabilities" } })];
  if (request.schemaVersion !== REQUEST_SCHEMA) {
    findings.push(finding("P0", "REQUEST_SCHEMA", "request.schemaVersion", `Expected ${REQUEST_SCHEMA}`, { example: { schemaVersion: REQUEST_SCHEMA } }));
  }
  if (!text(request.requestId)) findings.push(finding("P0", "REQUEST_REQUIRED_FIELD", "request.requestId", "requestId is required", { example: { requestId: "req-1" } }));
  if (!text(request.operation)) findings.push(finding("P0", "REQUEST_REQUIRED_FIELD", "request.operation", "operation is required", { example: { operation: "capabilities" } }));
  return findings;
}
function blueprintIdFromName(projectName) {
  const encoded = Array.from(projectName.trim().toLowerCase()).map((character) => {
    if (/^[a-z0-9]$/.test(character)) return character;
    if (/^[\s_-]$/.test(character)) return "-";
    return `u${character.codePointAt(0).toString(16)}`;
  }).join("-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `swarm-${encoded}`.slice(0, 64).replace(/-$/g, "");
}
function buildBlueprintBridge(input, requestId) {
  const projectName = text(input.projectName).trim(), tasks = Array.isArray(input.tasks) ? input.tasks : [], findings = [];
  if (!projectName) findings.push(finding("P0", "BLUEPRINT_PROJECT_NAME", "input.projectName", "projectName is required"));
  if (tasks.length === 0) findings.push(finding("P0", "BLUEPRINT_TASKS", "input.tasks", "tasks must be a non-empty array"));
  for (const [index, task] of tasks.entries()) if (!text(task?.title).trim()) findings.push(finding("P0", "BLUEPRINT_TASK_TITLE", `input.tasks[${index}].title`, "task title is required"));
  if (tasks.length) findings.push(...analyzeTaskGraph(tasks).findings);
  if (findings.length) return { findings };
  const nodeIds = new Map(tasks.map((task, index) => [task.taskId, `task-node-${index + 1}`]));
  const taskNodes = tasks.map((task, index) => ({ id: nodeIds.get(task.taskId), moduleId: "swarm-tasks",
    title: text(task.title).trim(), inputs: [], outputs: [], requirementRefs: [`fact-task-${index + 1}`] }));
  const roots = tasks.filter((task) => !Array.isArray(task.dependsOn) || task.dependsOn.length === 0);
  const rootEdges = roots.map((task, index) => ({ id: `edge-entry-${index + 1}`, fromNodeId: "swarm-entry", toNodeId: nodeIds.get(task.taskId), type: "control" }));
  const dependencyEdges = tasks.flatMap((task, taskIndex) => (task.dependsOn ?? []).map((dependencyId, dependencyIndex) =>
    ({ id: `edge-dependency-${taskIndex + 1}-${dependencyIndex + 1}`, fromNodeId: nodeIds.get(dependencyId), toNodeId: nodeIds.get(task.taskId), type: "control" })));
  const blueprint = {
    schemaVersion: "blueprint.ir/1.0", blueprintId: blueprintIdFromName(projectName), title: projectName,
    revision: 0, entryNodeId: "swarm-entry",
    baseline: { summary: `Swarm plan for ${projectName}`, facts: [
        { id: "fact-goal", status: "confirmed", statement: `Swarm goal: ${projectName}` },
        ...tasks.map((task, index) => ({ id: `fact-task-${index + 1}`, status: "confirmed", statement: `Task ${task.taskId}: ${text(task.title).trim()}` })),
      ] },
    domains: [{ id: "swarm-domain", name: "Swarm orchestration" }],
    modules: [{ id: "swarm-tasks", domainId: "swarm-domain", name: "Dispatched tasks" }],
    nodes: [{ id: "swarm-entry", entry: true, moduleId: "swarm-tasks", title: "Start swarm", inputs: [], outputs: [], requirementRefs: ["fact-goal"] }, ...taskNodes],
    edges: [...rootEdges, ...dependencyEdges],
    acceptanceCriteria: [
      { id: "accept-entry", statement: "Swarm dispatch starts from the validated project", nodeRefs: ["swarm-entry"] },
      ...tasks.map((task, index) => ({ id: `accept-task-${index + 1}`, statement: `Task ${task.taskId} is reported with passing evidence and accepted`, nodeRefs: [nodeIds.get(task.taskId)] })),
    ],
  };
  return { blueprintRequest: { input: { schemaVersion: "blueprint.skill.request/1.0", requestId: `${requestId}-blueprint`,
    operation: "compile-inline", input: { blueprint } } } };
}
const STATE_NOTE = "The caller owns state and must pass this full tasks array to the next operation.";
function runMeta(operation, requestId) {
  if (operation === "capabilities") {
    return okResponse(requestId, {
      capabilities: { pure: true, stateless: true, networkRequired: false, filesystemRequired: false,
        operations: [...PURE_OPERATIONS], orgSchema: ORG_SCHEMA, taskSchema: TASK_SCHEMA,
        testEvidenceSchema: TEST_EVIDENCE_SCHEMA, fixedAgents: ["board", "dispatcher", "ops", "security-guard"],
        trafficLights: ["green", "yellow", "red"], stateHolder: "caller",
        workerRecommendation: "maximum acyclic dependency level width, capped at 50" },
      operationSchemas: OPERATION_SCHEMAS,
      skill: { name: COMPILER_NAME, version: COMPILER_VERSION },
      nextStep: { operation: "intake", instruction: "Ask the intake questions, then build the org-chart and dispatch tasks." } });
  }
  if (operation === "help") return okResponse(requestId, { help: { name: COMPILER_NAME, version: COMPILER_VERSION, operations: OPERATION_CATALOG }, nextStep: { operation: "intake", instruction: "Ask the intake questions one at a time." } });
  return okResponse(requestId, { questions: INTAKE_QUESTIONS, nextStep: { operation: "org-chart", instruction: "Turn the answers into an org-chart; optionally plan tasks with Blueprint (input.blueprintEnabled), then dispatch the project tasks." } });
}
function runPlanning(operation, requestId, input, request) {
  if (operation === "org-chart") {
    const org = buildOrgChart(input);
    const findings = validateOrgChart(org);
    if (findings.length) return blockedResponse(requestId, request, findings);
    const blueprintEnabled = input.blueprintEnabled === true || text(input.blueprintEnabled).toLowerCase() === "yes";
    return okResponse(requestId, { org, blueprintEnabled, fixedAgents: ["board", "dispatcher", "ops", "security-guard"], workerCount: org.layers.execution.length,
      nextStep: blueprintEnabled
        ? { operation: "blueprint-bridge", instruction: "Blueprint is enabled: call blueprint-bridge to plan the project JSON into a traceable blueprint, then dispatch its tasks to the swarm." }
        : { operation: "dispatch", instruction: "Feed the project JSON; dispatch backlog tasks to workers by dependency order." } });
  }
  const bridge = buildBlueprintBridge(input, requestId);
  if (bridge.findings) return blockedResponse(requestId, request, bridge.findings);
  return okResponse(requestId, { planningStatus: "planned", blueprintEnabled: true, blueprintEndpoint: ALLOWED_EXTERNAL_ENDPOINTS.blueprint,
    blueprintRequest: bridge.blueprintRequest, projectFormat: "swarm.project/1.0",
    nextStep: { operation: "dispatch", instruction: `POST blueprintRequest to ${ALLOWED_EXTERNAL_ENDPOINTS.blueprint}; dispatch only after Blueprint compile-inline succeeds.` } });
}
function runTaskMutation(operation, requestId, input, request) {
  const tasks = Array.isArray(input.tasks) ? input.tasks : [], taskId = text(input.taskId);
  if (operation === "dispatch") {
    const result = dispatchTask(tasks, taskId, text(input.workerId), text(input.actorRole || "dispatcher"));
    if (!result.ok) return blockedResponse(requestId, request, [finding("P0", "DISPATCH_FAILED", input.taskId, result.error, { example: { taskId: "task-0001", workerId: "worker-001" } })]);
    return okResponse(requestId, { task: result.task, tasks, stateNote: STATE_NOTE, nextStep: { operation: "claim", instruction: "The worker can now claim the task." } });
  }
  if (operation === "claim") {
    const result = claimTask(tasks, taskId, text(input.workerId));
    if (!result.ok) return blockedResponse(requestId, request, [finding("P0", "CLAIM_FAILED", input.taskId, result.error, { example: { taskId: "task-0001", workerId: "worker-001" } })]);
    return okResponse(requestId, { task: result.task, tasks, trafficLight: taskTrafficLight(result.task), stateNote: STATE_NOTE, nextStep: { operation: "report", instruction: "Execute and report the result." } });
  }
  if (operation === "report") {
    const result = reportTask(tasks, taskId, text(input.workerId), input.report);
    if (!result.ok) return blockedResponse(requestId, request, result.findings ?? [finding("P0", "REPORT_FAILED", input.taskId, result.error, { example: { taskId: "task-0001", workerId: "worker-001", report: { output: "done" } } })]);
    const extra = result.hasEvidence ? {} : { evidenceRequired: true };
    return okResponse(requestId, { task: result.task, tasks, trafficLight: result.hasEvidence ? taskTrafficLight(result.task) : "yellow",
      ...extra, stateNote: STATE_NOTE, nextStep: { operation: "accept", instruction: "The board may accept only after passing TestEvidence is present." } });
  }
  if (typeof input.accept !== "boolean") return blockedResponse(requestId, request, [finding("P0", "ACCEPT_BOOLEAN", "input.accept", "accept must be a boolean")]);
  const result = acceptTask(tasks, taskId, input.accept, text(input.actorRole));
  if (!result.ok) return blockedResponse(requestId, request, [finding("P0", "ACCEPT_FAILED", input.taskId, result.error)]);
  return okResponse(requestId, { task: result.task, tasks, trafficLight: taskTrafficLight(result.task), stateNote: STATE_NOTE, nextStep: { operation: "swarm-status", instruction: "Review the complete task board." } });
}
function runObservation(operation, requestId, input, request) {
  if (operation === "swarm-status") {
    const tasks = Array.isArray(input.tasks) ? input.tasks : [], agents = Array.isArray(input.agents) ? input.agents : [];
    return okResponse(requestId, { tasks: tasks.map((task) => ({ ...task, trafficLight: taskTrafficLight(task) })), agents: agents.map((agent) => ({ ...agent })),
      summary: { tasks: tasks.length,
        green: tasks.filter((t) => taskTrafficLight(t) === "green").length,
        yellow: tasks.filter((t) => taskTrafficLight(t) === "yellow").length,
        red: tasks.filter((t) => taskTrafficLight(t) === "red").length,
        workersDead: agents.filter((a) => a.role === "worker" && a.status === "dead").length },
      stateNote: "Tasks must be passed as-is from the previous response; state flows through mutations.",
      nextStep: { operation: "ops", instruction: "Ops monitors heartbeats; security-guard scans inputs." } });
  }
  if (operation === "traffic-light") return okResponse(requestId, { trafficLight: taskTrafficLight(input.task ?? {}),
      rules: {
        green: "status is reported or accepted and every TestEvidence item is valid with exitCode 0",
        yellow: "backlog, assigned, claimed, running, or reported without passing TestEvidence",
        red: "status is \"failed\", \"blocked\", or \"cancelled\"" } });
  if (operation === "security-check") {
    const result = securityCheck(input.content, { agentId: input.agentId });
    return okResponse(requestId, { ...result,
      nextStep: result.allowed
        ? { operation: "claim", instruction: "Input is safe; proceed with the task." }
        : { operation: "security-alert", instruction: "Input blocked; review security-audit.json." } });
  }
  if (operation === "validate-json") {
    const findings = validateProjectJson(input.project);
    if (findings.length) return blockedResponse(requestId, request, findings);
    return okResponse(requestId, { valid: true, taskCount: input.project.tasks.length,
      nextStep: { operation: "org-chart", instruction: "Project valid; build the org-chart and dispatch." } });
  }
  if (operation === "heartbeat") {
    const tasks = Array.isArray(input.tasks) ? input.tasks : [], workerId = text(input.workerId), now = new Date().toISOString();
    const assigned = tasks.filter((t) => t.owner === workerId);
    return okResponse(requestId, { active: true, lastSeenAt: now, workerId, assignedTaskIds: assigned.map((t) => t.taskId), stateNote: "Tasks must be passed as-is from the previous response; state flows through mutations." });
  }
  const tasks = Array.isArray(input.tasks) ? input.tasks : [], taskId = text(input.taskId), reason = text(input.reason || "timeout");
  const task = tasks.find((candidate) => candidate.taskId === taskId);
  if (!task) return blockedResponse(requestId, request, [finding("P0", "RECLAIM_FAILED", taskId, `task ${taskId} not found`, { example: { taskId: "task-0001" } })]);
  if (task.status === "backlog") return blockedResponse(requestId, request, [finding("P1", "RECLAIM_NOOP", taskId, `task ${taskId} is already backlog`, { example: { taskId: "task-0001" } })]);
  task.status = "backlog"; task.owner = null;
  return okResponse(requestId, { reclaimed: true, taskId, reason, task, tasks, stateNote: STATE_NOTE });
}
export async function run(request) {
  const findings = validateRequest(request);
  if (findings.length) return { ...blockedResponse(request?.requestId ?? "unknown", request, findings), errorSchema: ERROR_SCHEMA };
  const { requestId, operation } = request, input = request.input ?? {};
  if (["capabilities", "help", "intake"].includes(operation)) return runMeta(operation, requestId);
  if (["org-chart", "blueprint-bridge"].includes(operation)) return runPlanning(operation, requestId, input, request);
  if (["dispatch", "claim", "report", "accept"].includes(operation)) return runTaskMutation(operation, requestId, input, request);
  if (["swarm-status", "traffic-light", "security-check", "validate-json", "heartbeat", "reclaim"].includes(operation)) return runObservation(operation, requestId, input, request);
  return { schemaVersion: RESPONSE_SCHEMA, requestId, status: "failed", errorSchema: ERROR_SCHEMA, error: { code: "UNSUPPORTED_OPERATION", message: `Unsupported operation: ${operation}` } };
}
export {
  COMPILER_VERSION, ORG_SCHEMA, TASK_SCHEMA, TEST_EVIDENCE_SCHEMA, PURE_OPERATIONS, OPERATION_CATALOG,
  INTAKE_QUESTIONS, ORG_PERMISSIONS, buildOrgChart, validateOrgChart, securityCheck,
  analyzeTaskGraph, buildTasks, dispatchTask, claimTask, reportTask, acceptTask, taskTrafficLight,
  validateTestEvidence, normalizeTestEvidence, hasPassingTestEvidence, buildBlueprintBridge,
  buildAgents, recordHeartbeat, scanHeartbeats, reclaimTasks, replaceWorker,
  okResponse, blockedResponse, finding,
};
