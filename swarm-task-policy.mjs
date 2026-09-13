import { evidenceState, readValidationSubject, validatorReceiptSubject } from "cli-validator/runtime";
import { text, isObject, validId, finding, ORG_PERMISSIONS, TEST_EVIDENCE_SCHEMA, SHA256_PATTERN } from "./swarm-task-contract.mjs";

const MIN_DISPATCH_LINES = 200;
const MIN_DISPATCH_FILES = 3;
const ACTIVE_TASK_STATES = new Set(["assigned", "claimed", "running"]);
function dispatchEligibility(tasks, task, facts) {
  if (!isObject(facts) || !Number.isSafeInteger(facts.estimatedChangedLines) || facts.estimatedChangedLines < 0
    || !Number.isSafeInteger(facts.fileCount) || facts.fileCount < 1 || typeof facts.crossModule !== "boolean"
    || typeof facts.parallelSafe !== "boolean" || !validId(facts.ownerId)
    || !Array.isArray(facts.targetPaths) || facts.targetPaths.length !== facts.fileCount
    || new Set(facts.targetPaths).size !== facts.fileCount
    || facts.targetPaths.some(path => typeof path !== "string" || !path.trim() || path.startsWith("/")
      || path.split("/").some(part => !part || part === "." || part === "..") || /[\\*?\[\]{}]/.test(path))) return "dispatch-facts-required";
  const delegation = facts.delegation;
  if (!isObject(delegation) || ["businessNeed", "deliverable", "acceptanceCriteria", "mainAgentWork"]
    .some(key => typeof delegation[key] !== "string" || !delegation[key].trim())
    || typeof delegation.independent !== "boolean" || typeof delegation.substantial !== "boolean"
    || !Number.isFinite(delegation.estimatedSavedMinutes) || delegation.estimatedSavedMinutes < 0
    || !Number.isFinite(delegation.coordinationMinutes) || delegation.coordinationMinutes < 0) return "dispatch-business-case-required";
  if (!delegation.substantial) return "dispatch-simple-work-stays-local";
  if (!delegation.independent) return "dispatch-not-independent";
  if (delegation.estimatedSavedMinutes <= delegation.coordinationMinutes) return "dispatch-overhead-exceeds-benefit";
  if (facts.estimatedChangedLines < MIN_DISPATCH_LINES && facts.fileCount < MIN_DISPATCH_FILES
    && !facts.crossModule) return "dispatch-under-threshold";
  if (!facts.parallelSafe) return "dispatch-not-parallel-safe";
  if (task.originOwnerId !== undefined && task.originOwnerId !== facts.ownerId) return "dispatch-owner-mismatch";
  const overlaps = (left, right) => left === right || left.startsWith(right + "/") || right.startsWith(left + "/");
  for (const other of tasks.filter(item => item !== task && ACTIVE_TASK_STATES.has(item.status))) {
    if (!Array.isArray(other.dispatch?.targetPaths)) return "dispatch-peer-scope-missing";
    if (facts.targetPaths.some(path => other.dispatch.targetPaths.some(otherPath => overlaps(path, otherPath)))) return "dispatch-write-conflict";
  }
  return null;
}
function hasTrustedTestEvidence(task) {
  if (!hasPassingTestEvidence(task) || !isObject(task.validationContext)
    || task.validationContext.validationRunId !== task.taskId) return false;
  const subject = readValidationSubject(task.validationContext, "task.validationContext");
  if (!subject.value) return false;
  const digest = validatorReceiptSubject(subject.value);
  return task.report.evidence.every(evidence => evidenceState(evidence, subject.value, digest) === "valid");
}
function reclaimTask(task, workerId) {
  if (task.status === "assigned") {
    task.status = "backlog"; task.owner = null; task.inheritedFrom = workerId;
    return true;
  }
  if (["claimed", "running"].includes(task.status)) {
    task.status = "blocked"; task.blockedReason = "execution-outcome-unknown";
    task.progressNote = "Reconcile the original execution before authorizing another attempt";
  }
  return false;
}
function buildTasks(project, org) {
  return (project.tasks ?? []).map((task, index) => ({
    taskId: validId(task.taskId) ? task.taskId : `task-${String(index + 1).padStart(4, "0")}`, title: text(task.title || task.name || `任务 ${index + 1}`), owner: null, status: "backlog",
    priority: text(task.priority || "normal"), dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn : [], assignedBy: null, claimedAt: null, reportedAt: null, report: null, progressPercent: 0,
    progressNote: "", inheritedFrom: null, ...(task.validationContext === undefined ? {} : { validationContext: structuredClone(task.validationContext) }) }));
}
function dispatchTask(tasks, taskId, workerId, actorRole, facts) {
  if (!ORG_PERMISSIONS[actorRole]?.includes("dispatch")) return { ok: false, error: `role ${actorRole} cannot dispatch` };
  const task = tasks.find((t) => t.taskId === taskId);
  if (!task) return { ok: false, error: `task ${taskId} not found` };
  if (task.status !== "backlog") return { ok: false, error: `task ${taskId} is ${task.status}, not backlog` };
  for (const dependencyId of Array.isArray(task.dependsOn) ? task.dependsOn : []) {
    const dependency = tasks.find((candidate) => candidate.taskId === dependencyId);
    if (!dependency) return { ok: false, error: `dependency ${dependencyId} not found` };
    if (dependency.status === "accepted" && !hasTrustedTestEvidence(dependency)) return { ok: false, error: `dependency ${dependencyId} has no verified evidence` };
    if (dependency.status !== "accepted") return { ok: false, error: `dependency ${dependencyId} is ${dependency.status}, not accepted` };
  }
  const error = dispatchEligibility(tasks, task, facts);
  if (error) return { ok: false, error };
  task.dispatch = structuredClone(facts);
  if (task.originOwnerId === undefined) task.originOwnerId = facts.ownerId;
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
  task.selfReported = !hasTrustedTestEvidence(task);
  return { ok: true, task, hasEvidence: hasPassingTestEvidence(task) };
}
function acceptTask(tasks, taskId, accept, actorRole) {
  if (actorRole !== "board") return { ok: false, error: `role ${actorRole} cannot accept` };
  const task = tasks.find((t) => t.taskId === taskId);
  if (!task) return { ok: false, error: `task ${taskId} not found` };
  if (task.status !== "reported") return { ok: false, error: `task ${taskId} is ${task.status}, not reported` };
  if (accept && !hasTrustedTestEvidence(task)) return { ok: false, error: `task ${taskId} has no verified task-bound TestEvidence` };
  task.status = accept ? "accepted" : "failed";
  return { ok: true, task };
}
function taskTrafficLight(task) {
  if (task.status === "accepted") return hasTrustedTestEvidence(task) ? "green" : "red";
  if (task.status === "reported") return "yellow";
  if (task.status === "failed" || task.status === "blocked" || task.status === "cancelled") return "red";
  return "yellow";
}
export { dispatchEligibility, buildTasks, dispatchTask, claimTask, reportTask, acceptTask, taskTrafficLight, validateTestEvidence, normalizeTestEvidence, hasPassingTestEvidence, hasTrustedTestEvidence, reclaimTask };
