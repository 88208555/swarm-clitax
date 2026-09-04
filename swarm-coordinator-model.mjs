import { randomUUID } from 'node:crypto'
import { coordinatorError, identifier, relativePath } from './swarm-coordinator-fs.mjs'

const ACTIONS = new Set(['inspect', 'modify', 'build', 'deploy', 'publish', 'wait'])
const LOCK_TYPES = new Set(['file', 'build', 'deploy'])
const MESSAGE_TYPES = new Set([
  'range-declare',
  'conflict-alert',
  'lock-granted',
  'lock-denied',
  'baseline-handshake',
  'need-human',
  'dependency-wait',
])
const WAIT_TIMEOUT_ACTIONS = new Set(['escalate-need-human', 'abandon-wait', 'continue-after-timeout'])
const WAIT_EVENT_ACTIONS = new Set(['wake-with-package'])
const TASK_STATUSES = new Set(['active', 'waiting', 'completed', 'failed', 'reclaimed'])
const SHA256_PATTERN = /^[0-9a-f]{64}$/

function findTask(state, input) {
  const taskId = identifier(input.taskId, 'taskId')
  const task = state.tasks.find((item) => item.taskId === taskId)
  if (!task) coordinatorError('SWARM_COORD_TASK_NOT_FOUND', `task ${taskId} is not registered`)
  if (task.agentId !== identifier(input.agentId, 'agentId')
    || task.chainId !== identifier(input.chainId, 'chainId')) {
    coordinatorError('SWARM_COORD_TASK_AUTHORITY_DENIED', 'task ownership does not match')
  }
  return task
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    coordinatorError('SWARM_COORD_FIELD_REQUIRED', `${label} is required`)
  }
  return value.trim()
}

function requireStringArray(value, label, options = {}) {
  if (!Array.isArray(value) || (options.nonEmpty && value.length === 0)
    || value.some((item) => typeof item !== 'string' || !item.trim())) {
    coordinatorError('SWARM_COORD_FIELD_INVALID', `${label} must be an array of non-empty strings`)
  }
  const normalized = value.map((item) => item.trim())
  if (new Set(normalized).size !== normalized.length) {
    coordinatorError('SWARM_COORD_FIELD_INVALID', `${label} must not contain duplicates`)
  }
  return normalized
}

function normalizeTaskCard(input, now = new Date().toISOString()) {
  const taskScope = requireStringArray(input.taskScope, 'taskScope', { nonEmpty: true })
    .map((path) => relativePath(path, 'taskScope path'))
  const plannedActions = requireStringArray(input.plannedActions, 'plannedActions', { nonEmpty: true })
  if (plannedActions.some((action) => !ACTIONS.has(action))) {
    coordinatorError('SWARM_COORD_ACTION_INVALID', 'plannedActions contains an unsupported action')
  }
  if (input.deployTarget !== null && (typeof input.deployTarget !== 'string' || !input.deployTarget.trim())) {
    coordinatorError('SWARM_COORD_DEPLOY_TARGET_INVALID', 'deployTarget must be null or a non-empty string')
  }
  const baselineHash = requireString(input.baselineHash, 'baselineHash')
  if (!SHA256_PATTERN.test(baselineHash)) {
    coordinatorError('SWARM_COORD_BASELINE_INVALID', 'baselineHash must be a lowercase SHA-256 digest')
  }
  return {
    schemaVersion: 'swarm.task-card/1.0',
    supersedesTaskId: Object.hasOwn(input, 'supersedesTaskId') ? identifier(input.supersedesTaskId, 'supersedesTaskId') : null,
    taskId: identifier(input.taskId, 'taskId'),
    agentId: identifier(input.agentId, 'agentId'),
    chainId: identifier(input.chainId, 'chainId'),
    taskScope,
    plannedActions,
    deployTarget: input.deployTarget === null ? null : input.deployTarget.trim(),
    eta: requireString(input.eta, 'eta'),
    baselineHash,
    archConstraints: requireStringArray(input.archConstraints, 'archConstraints'),
    status: 'active',
    baselineHandshake: null,
    registeredAt: now,
    updatedAt: now,
  }
}

function pathOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

function matchingScopes(left, right) {
  return left.taskScope.flatMap((leftPath) => right.taskScope
    .filter((rightPath) => pathOverlap(leftPath, rightPath))
    .map((rightPath) => ({ leftPath, rightPath })))
}

function constraintClaims(card, prefix) {
  return card.archConstraints
    .filter((value) => value.startsWith(prefix))
    .map((value) => value.slice(prefix.length).trim())
    .filter(Boolean)
}

function architectureConflicts(left, right) {
  const leftForbidden = constraintClaims(left, 'forbid-scope:')
  const rightForbidden = constraintClaims(right, 'forbid-scope:')
  return [
    ...leftForbidden.flatMap((blocked) => right.taskScope
      .filter((path) => pathOverlap(relativePath(blocked, 'forbid-scope'), path))
      .map((path) => ({ owner: left.taskId, blocked: path }))),
    ...rightForbidden.flatMap((blocked) => left.taskScope
      .filter((path) => pathOverlap(relativePath(blocked, 'forbid-scope'), path))
      .map((path) => ({ owner: right.taskId, blocked: path }))),
  ]
}

function requirementConflicts(left, right) {
  const parse = (card) => new Map(constraintClaims(card, 'requirement:').map((claim) => {
    const separator = claim.indexOf('=')
    if (separator < 1 || separator === claim.length - 1) {
      coordinatorError('SWARM_COORD_REQUIREMENT_INVALID', 'requirement claims must use requirement:key=value')
    }
    return [claim.slice(0, separator).trim(), claim.slice(separator + 1).trim()]
  }))
  const leftClaims = parse(left)
  const rightClaims = parse(right)
  return [...leftClaims.entries()].filter(([key, value]) => (
    rightClaims.has(key) && rightClaims.get(key) !== value
  )).map(([key, value]) => ({ key, left: value, right: rightClaims.get(key) }))
}

function scanTaskConflicts(candidate, tasks) {
  const conflicts = []
  for (const task of tasks) {
    if (task.taskId === candidate.taskId || ['completed', 'failed', 'reclaimed'].includes(task.status)) continue
    const scopes = matchingScopes(candidate, task)
    if (scopes.length) conflicts.push({ type: 'file-range', risk: 'medium', taskId: task.taskId, evidence: scopes })
    const sameTarget = candidate.deployTarget !== null && candidate.deployTarget === task.deployTarget
    const releaseActions = (card) => card.plannedActions.some((action) => action === 'build'
      || action === 'deploy' || action === 'publish')
    if (sameTarget && releaseActions(candidate) && releaseActions(task)) {
      conflicts.push({ type: 'release-sequence', risk: 'high', taskId: task.taskId,
        evidence: { deployTarget: candidate.deployTarget } })
    }
    const architecture = architectureConflicts(candidate, task)
    if (architecture.length) conflicts.push({ type: 'architecture', risk: 'medium', taskId: task.taskId, evidence: architecture })
    const requirements = requirementConflicts(candidate, task)
    if (requirements.length) conflicts.push({ type: 'requirement', risk: 'high', taskId: task.taskId, evidence: requirements })
  }
  return conflicts
}

function normalizeLockRequest(input) {
  const lockType = requireString(input.lockType, 'lockType')
  if (!LOCK_TYPES.has(lockType)) coordinatorError('SWARM_COORD_LOCK_TYPE_INVALID', 'lockType is invalid')
  if (typeof input.queueOnConflict !== 'boolean') {
    coordinatorError('SWARM_COORD_QUEUE_POLICY_REQUIRED', 'queueOnConflict must be a boolean')
  }
  if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > 3_600) {
    coordinatorError('SWARM_COORD_LOCK_TTL_INVALID', 'ttlSeconds must be 1..3600')
  }
  const hasQueueTimeout = Object.hasOwn(input, 'queueTimeoutMs')
  if ((input.queueOnConflict || hasQueueTimeout)
    && (!Number.isSafeInteger(input.queueTimeoutMs) || input.queueTimeoutMs < 1
      || !Number.isFinite(new Date(Date.now() + input.queueTimeoutMs).getTime()))) {
    coordinatorError('SWARM_COORD_QUEUE_TIMEOUT_REQUIRED', 'queueOnConflict requires an explicit positive queueTimeoutMs')
  }
  const paths = lockType === 'file'
    ? requireStringArray(input.paths, 'paths', { nonEmpty: true }).map((path) => relativePath(path))
    : []
  const resource = lockType === 'file' ? 'repository-files' : requireString(input.resource, 'resource')
  if (input.baselineHandshakeId !== null
    && (typeof input.baselineHandshakeId !== 'string' || !input.baselineHandshakeId.trim())) {
    coordinatorError('SWARM_COORD_HANDSHAKE_INVALID', 'baselineHandshakeId must be null or a non-empty string')
  }
  return {
    taskId: identifier(input.taskId, 'taskId'),
    agentId: identifier(input.agentId, 'agentId'),
    chainId: identifier(input.chainId, 'chainId'),
    lockType,
    resource,
    paths,
    ttlSeconds: input.ttlSeconds,
    queueOnConflict: input.queueOnConflict,
    ...(hasQueueTimeout ? { queueTimeoutMs: input.queueTimeoutMs } : {}),
    baselineHandshakeId: input.baselineHandshakeId,
  }
}

function locksConflict(request, lock) {
  if (lock.status !== 'active' || request.lockType !== lock.lockType) return false
  if (request.lockType === 'file') {
    return request.paths.some((path) => lock.paths.some((lockedPath) => pathOverlap(path, lockedPath)))
  }
  return request.resource === lock.resource
}

function normalizeWait(input, now = new Date().toISOString()) {
  if (!Number.isSafeInteger(input.expectedWithinMs) || input.expectedWithinMs < 1
    || !Number.isFinite(new Date(Date.parse(now) + input.expectedWithinMs).getTime())) {
    coordinatorError('SWARM_COORD_WAIT_DURATION_INVALID', 'expectedWithinMs must be a positive integer')
  }
  if (!WAIT_EVENT_ACTIONS.has(input.onEvent) || !WAIT_TIMEOUT_ACTIONS.has(input.onTimeout)) {
    coordinatorError('SWARM_COORD_WAIT_POLICY_INVALID', 'onEvent or onTimeout is invalid')
  }
  const startedAtMs = Date.parse(now)
  return {
    schemaVersion: 'swarm.dependency-wait/1.0',
    waitId: `wait-${randomUUID()}`,
    taskId: identifier(input.taskId, 'taskId'),
    chainId: identifier(input.chainId, 'chainId'),
    waiter: identifier(input.waiter, 'waiter'),
    waitFor: identifier(input.waitFor, 'waitFor'),
    event: identifier(input.event, 'event'),
    purpose: requireString(input.purpose, 'purpose'),
    expectedWithinMs: input.expectedWithinMs,
    deadlineAt: new Date(startedAtMs + input.expectedWithinMs).toISOString(),
    onEvent: input.onEvent,
    onTimeout: input.onTimeout,
    refetchPaths: requireStringArray(input.refetchPaths, 'refetchPaths')
      .map((path) => relativePath(path, 'refetchPaths path')),
    status: 'active',
    startedAt: now,
    resolvedAt: null,
    resolution: null,
  }
}

function detectWaitCycles(waits) {
  const graph = new Map()
  for (const wait of waits.filter((item) => item.status === 'active')) {
    if (!graph.has(wait.waiter)) graph.set(wait.waiter, new Set())
    graph.get(wait.waiter).add(wait.waitFor)
  }
  const visiting = new Set()
  const visited = new Set()
  const path = []
  const cycles = []
  function visit(agent) {
    if (visiting.has(agent)) {
      const start = path.indexOf(agent)
      cycles.push([...path.slice(start), agent])
      return
    }
    if (visited.has(agent)) return
    visiting.add(agent)
    path.push(agent)
    for (const dependency of graph.get(agent) ?? []) visit(dependency)
    path.pop()
    visiting.delete(agent)
    visited.add(agent)
  }
  for (const agent of graph.keys()) visit(agent)
  return cycles
}

function coordinationMessage(type, from, to, payload, now = new Date().toISOString()) {
  if (!MESSAGE_TYPES.has(type)) coordinatorError('SWARM_COORD_MESSAGE_TYPE_INVALID', 'message type is invalid')
  return {
    schemaVersion: 'swarm.coord-message/1.0',
    messageId: `message-${randomUUID()}`,
    type,
    from,
    to,
    payload,
    createdAt: now,
  }
}

function requireTaskStatus(value) {
  if (!TASK_STATUSES.has(value)) coordinatorError('SWARM_COORD_TASK_STATUS_INVALID', 'task status is invalid')
  return value
}

function validateInputShape(input, schema) {
  const missing = schema.required.filter((key) => !(key in input))
  const unknown = Object.keys(input).filter((key) => !(key in schema.properties))
  if (missing.length || unknown.length) {
    coordinatorError('SWARM_COORD_INPUT_SCHEMA_INVALID',
      `input shape is invalid; missing=${missing.join(',')}; unknown=${unknown.join(',')}`)
  }
}

export {
  findTask,
  coordinationMessage,
  detectWaitCycles,
  locksConflict,
  normalizeLockRequest,
  normalizeTaskCard,
  normalizeWait,
  pathOverlap,
  requireString,
  requireTaskStatus,
  scanTaskConflicts,
  validateInputShape,
}
