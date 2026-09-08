import { TASK_ROUTING_SCHEMAS } from './swarm-task-routing-schemas.mjs'
import { TASK_ROUTING_HANDLERS } from './swarm-task-routing.mjs'
import { createHash, randomUUID, verify } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { LEASE_SCHEMA, coordinatorError, identifier, leasePayload, readCoordinationState,
  withCoordinationReadLock, withCoordinationState, writeSignedLease } from './swarm-coordinator-fs.mjs'
import { findTask, locksConflict, normalizeLockRequest, normalizeTaskCard, requireString,
  scanTaskConflicts, validateInputShape, decisionTargetsTask } from './swarm-coordinator-model.mjs'
import { addMessage, eventRecord, routeEvent, createDecision, applyCycles, applyTimeouts,
  assertTaskRunnable, pendingDecision, hasActiveWait, dependencyWait, publishEvent, taskStatus,
  resolveHuman, cancelWait, waitForEvent } from './swarm-coordinator-waits.mjs'

const LOCAL_SCHEMA = 'swarm.coordinator-local/1.0'
const OPERATIONS = Object.freeze([
  ...Object.keys(TASK_ROUTING_SCHEMAS),
  'capabilities', 'register-task', 'conflict-scan', 'lock-acquire', 'lock-renew',
  'lock-release', 'lock-queue-status', 'baseline-handshake', 'dependency-wait', 'event-publish',
  'task-status', 'tick', 'resolve-human', 'wait-for-event', 'wait-cancel', 'status',
])

const objectSchema = (required, properties) => ({
  type: 'object', additionalProperties: false, required, properties,
})
const string = { type: 'string', minLength: 1 }
const stringArray = { type: 'array', items: string }
const nullableString = { type: ['string', 'null'] }
const TASK_CARD_SCHEMA = objectSchema(
  ['taskId', 'agentId', 'chainId', 'taskScope', 'plannedActions', 'deployTarget', 'eta', 'baselineHash', 'archConstraints'],
  { taskId: string, agentId: string, chainId: string, taskScope: stringArray,
    plannedActions: stringArray, deployTarget: nullableString, eta: string,
    baselineHash: string, archConstraints: stringArray, supersedesTaskId: string },
)
const LOCK_SCHEMA = objectSchema(
  ['taskId', 'agentId', 'chainId', 'lockType', 'resource', 'paths', 'ttlSeconds', 'queueOnConflict', 'baselineHandshakeId'],
  { taskId: string, agentId: string, chainId: string,
    lockType: { enum: ['file', 'build', 'deploy'] }, resource: nullableString, paths: stringArray,
    ttlSeconds: { type: 'integer', minimum: 1, maximum: 3600 }, queueOnConflict: { type: 'boolean' },
    baselineHandshakeId: nullableString,
    queueTimeoutMs: { type: 'integer', minimum: 1, description: 'Explicit maximum time in the queue; required when queueOnConflict=true.' } },
)
LOCK_SCHEMA.allOf = [{ if: { properties: { queueOnConflict: { const: true } } },
  then: { required: ['queueTimeoutMs'] } }]
const WAIT_SCHEMA = objectSchema(
  ['taskId', 'chainId', 'waiter', 'waitFor', 'event', 'purpose', 'expectedWithinMs', 'onEvent', 'onTimeout', 'refetchPaths'],
  { taskId: string, chainId: string, waiter: string, waitFor: string, event: string, purpose: string,
    expectedWithinMs: { type: 'integer', minimum: 1 }, onEvent: { const: 'wake-with-package' },
    onTimeout: { enum: ['escalate-need-human', 'abandon-wait', 'continue-after-timeout'] },
    refetchPaths: stringArray },
)
const OPERATION_SCHEMAS = Object.freeze({
  ...TASK_ROUTING_SCHEMAS,
  capabilities: objectSchema([], {}),
  'register-task': TASK_CARD_SCHEMA,
  'conflict-scan': objectSchema(['taskId'], { taskId: string }),
  'lock-acquire': LOCK_SCHEMA,
  'lock-queue-status': objectSchema(['queueId', 'taskId', 'agentId', 'chainId'],
    { queueId: string, taskId: string, agentId: string, chainId: string }),
  'lock-renew': objectSchema(['lockId', 'taskId', 'agentId', 'chainId', 'ttlSeconds'],
    { lockId: string, taskId: string, agentId: string, chainId: string,
      ttlSeconds: { type: 'integer', minimum: 1, maximum: 3600 } }),
  'lock-release': objectSchema(['lockId', 'taskId', 'agentId', 'chainId'],
    { lockId: string, taskId: string, agentId: string, chainId: string }),
  'baseline-handshake': objectSchema(['taskId', 'agentId', 'chainId', 'observedBaselineHash', 'refetchPaths'],
    { taskId: string, agentId: string, chainId: string, observedBaselineHash: string, refetchPaths: stringArray }),
  'dependency-wait': WAIT_SCHEMA,
  'event-publish': objectSchema(['publisher', 'event', 'payload'],
    { publisher: string, event: string, payload: { type: 'object' } }),
  'task-status': objectSchema(['taskId', 'agentId', 'chainId', 'status'],
    { taskId: string, agentId: string, chainId: string,
      status: { enum: ['active', 'waiting', 'completed', 'failed', 'reclaimed'] } }),
  tick: objectSchema(['now'], { now: { type: 'string', format: 'date-time',
    description: 'Caller observation only; deadlines and signed leases use the coordinator clock.' } }),
  'resolve-human': objectSchema(['decisionId', 'answer', 'actorId'],
    { decisionId: string, answer: string, actorId: string }),
  'wait-for-event': objectSchema(['taskId', 'agentId', 'chainId', 'waitId'],
    { taskId: string, agentId: string, chainId: string, waitId: string }),
  'wait-cancel': objectSchema(['taskId', 'agentId', 'chainId', 'waitId', 'reason'],
    { taskId: string, agentId: string, chainId: string, waitId: string, reason: string }),
  status: objectSchema([], {}),
})

function sha256(value) { return createHash('sha256').update(value).digest('hex') }

function validateReplacement(state, card) {
  if (card.supersedesTaskId === null) return
  const previous = state.tasks.find((task) => task.taskId === card.supersedesTaskId)
  const pending = previous && state.decisions.some((decision) => decision.status === 'pending'
    && decisionTargetsTask(decision, previous))
  const covered = previous && previous.taskScope.every((path) => card.taskScope.some((scope) => (
    path === scope || path.startsWith(scope + '/')
  )))
  if (!previous || previous.chainId !== card.chainId || !['failed', 'reclaimed'].includes(previous.status)
    || pending || !covered || previous.deployTarget !== card.deployTarget
    || previous.archConstraints.some((constraint) => !card.archConstraints.includes(constraint))
    || state.tasks.some((task) => task.supersedesTaskId === previous.taskId)) {
    coordinatorError('SWARM_COORD_REPLACEMENT_INVALID', 'replacement requires one failed/reclaimed task in this chain, preserved scope/constraints, and no pending decision')
  }
}

async function registerTask(repositoryRoot, input) {
  return withCoordinationState(repositoryRoot, async (state) => {
    const card = normalizeTaskCard(input)
    if (state.tasks.some((task) => task.taskId === card.taskId)) {
      coordinatorError('SWARM_COORD_TASK_EXISTS', `task ${card.taskId} is already registered`)
    }
    validateReplacement(state, card)
    state.tasks.push(card)
    return { state, output: { schemaVersion: LOCAL_SCHEMA, task: card },
      audit: [{ event: 'range-declare', taskId: card.taskId, agentId: card.agentId, taskScope: card.taskScope,
        supersedesTaskId: card.supersedesTaskId }] }
  })
}

async function conflictScan(repositoryRoot, input) {
  return withCoordinationState(repositoryRoot, async (state) => {
    const taskId = identifier(input.taskId, 'taskId')
    const task = state.tasks.find((item) => item.taskId === taskId)
    if (!task) coordinatorError('SWARM_COORD_TASK_NOT_FOUND', `task ${taskId} is not registered`)
    const conflicts = scanTaskConflicts(task, state.tasks)
    const messages = conflicts.filter((conflict) => conflict.type !== 'requirement')
      .map((conflict) => addMessage(state, 'conflict-alert', 'coordinator', task.agentId, conflict))
    const decisions = conflicts.filter((conflict) => conflict.type === 'requirement').map((conflict) => {
      const other = state.tasks.find((item) => item.taskId === conflict.taskId)
      if (!other) coordinatorError('SWARM_COORD_TASK_NOT_FOUND', `task ${conflict.taskId} is not registered`)
      task.status = 'waiting'
      other.status = 'waiting'
      return createDecision(state, 'requirement-conflict', [task.agentId, other.agentId], [],
        `任务 ${task.taskId} 与 ${conflict.taskId} 的需求声明冲突，请选择先恢复的智能体。`,
        '矛盾需求同时执行会产生不可预测的覆盖，必须由真人裁决。', new Date().toISOString(), [task.taskId, other.taskId])
    })
    return { state, output: { schemaVersion: LOCAL_SCHEMA, taskId, conflicts, messages,
      decisions, zeroConflict: conflicts.length === 0 }, audit: [{ event: 'conflict-scan', taskId, conflictCount: conflicts.length }] }
  })
}

async function grantLock(state, root, request, now) {
  const issuedAt = now
  const lockId = `lock-${randomUUID()}`
  const leaseId = `lease-${randomUUID()}`
  const expiresAt = new Date(Date.parse(now) + request.ttlSeconds * 1_000).toISOString()
  const lease = await writeSignedLease(root, {
    leaseId, lockId, chainId: request.chainId, agentId: request.agentId,
    lockType: request.lockType, resource: request.resource, paths: request.paths,
    issuedAt, expiresAt, nonce: randomUUID(),
  }, sha256)
  const lock = { schemaVersion: 'swarm.coord-lock/1.0', lockId, leaseId,
    leasePath: lease.relativeLeasePath, taskId: request.taskId, chainId: request.chainId,
    agentId: request.agentId, lockType: request.lockType, resource: request.resource,
    paths: request.paths, status: 'active', issuedAt, expiresAt, releasedAt: null }
  state.locks.push(lock)
  addMessage(state, 'lock-granted', 'coordinator', request.agentId, { lockId, leaseId, expiresAt }, now)
  return { lock, leasePath: lease.relativeLeasePath, lease: lease.signedLease }
}

function validHandshake(task, request) {
  if (request.lockType === 'file') return request.baselineHandshakeId === null
  return task.baselineHandshake !== null
    && request.baselineHandshakeId === task.baselineHandshake.handshakeId
}

async function acquireLock(repositoryRoot, input) {
  return withCoordinationState(repositoryRoot, async (state, root) => {
    const request = normalizeLockRequest(input)
    const task = findTask(state, request)
    assertTaskRunnable(state, task)
    if (!validHandshake(task, request)) {
      coordinatorError('SWARM_COORD_BASELINE_HANDSHAKE_REQUIRED', 'build and deploy locks require the current baseline handshake')
    }
    const conflicts = state.locks.filter((lock) => locksConflict(request, lock))
    if (!conflicts.length) {
      const granted = await grantLock(state, root, request, new Date().toISOString())
      return { state, output: { schemaVersion: LOCAL_SCHEMA, status: 'granted', ...granted },
        audit: [{ event: 'lock-granted', lockId: granted.lock.lockId, taskId: request.taskId }] }
    }
    if (!request.queueOnConflict) coordinatorError('SWARM_COORD_LOCK_DENIED', 'the requested lock conflicts with an active lock')
    const enqueuedAt = new Date().toISOString()
    const queued = { schemaVersion: 'swarm.coord-queue/1.0', queueId: `queue-${randomUUID()}`,
      request, blockingLockIds: conflicts.map((lock) => lock.lockId), status: 'queued',
      enqueuedAt, deadlineAt: new Date(Date.parse(enqueuedAt) + request.queueTimeoutMs).toISOString(),
      resolvedAt: null, grant: null, decisionId: null, confirmProtocolRequest: null }
    state.queue.push(queued)
    addMessage(state, 'lock-denied', 'coordinator', request.agentId,
      { queueId: queued.queueId, blockingLockIds: queued.blockingLockIds }, queued.enqueuedAt)
    return { state, output: { schemaVersion: LOCAL_SCHEMA, status: 'queued', queued },
      audit: [{ event: 'lock-queued', queueId: queued.queueId, taskId: request.taskId }] }
  })
}

async function renewLock(repositoryRoot, input) {
  return withCoordinationState(repositoryRoot, async (state, root) => {
    const task = findTask(state, input)
    assertTaskRunnable(state, task)
    const lockId = identifier(input.lockId, 'lockId')
    const lock = state.locks.find((item) => item.lockId === lockId)
    if (!lock || lock.status !== 'active' || lock.taskId !== task.taskId) {
      coordinatorError('SWARM_COORD_LOCK_NOT_ACTIVE', 'lock is not active for this task')
    }
    if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > 3_600) {
      coordinatorError('SWARM_COORD_LOCK_TTL_INVALID', 'ttlSeconds must be 1..3600')
    }
    lock.status = 'renewed'
    const request = { ...lock, ttlSeconds: input.ttlSeconds }
    const granted = await grantLock(state, root, request, new Date().toISOString())
    return { state, output: { schemaVersion: LOCAL_SCHEMA, status: 'renewed', ...granted },
      audit: [{ event: 'lock-renewed', previousLockId: lockId, lockId: granted.lock.lockId }] }
  })
}

function rejectQueuedLock(state, queued, reason, now) {
  queued.status = reason === 'queue-timeout' ? 'timed-out' : 'rejected'
  queued.reason = reason
  queued.resolvedAt = now
  addMessage(state, 'lock-denied', 'coordinator', queued.request.agentId,
    { queueId: queued.queueId, reason, request: queued.request, deadlineAt: queued.deadlineAt }, now)
  if (reason !== 'queue-timeout') return
  const result = createDecision(state, 'lock-queue-timeout', [queued.request.agentId], [],
    '锁队列 ' + queued.queueId + ' 已于 ' + queued.deadlineAt + ' 超时；资源 '
      + queued.request.resource + '，路径 ' + queued.request.paths.join(', ') + '。请核查占锁方后决定恢复或终止任务。',
    '原队列不会再次授锁。恢复后必须提交带新明确等待上限的申请，不能把超时当作已取得锁。', now, [queued.request.taskId])
  queued.decisionId = result.decision.decisionId
  queued.confirmProtocolRequest = result.confirmProtocolRequest
  return result
}

async function promoteQueue(state, root, now) {
  const promoted = [], decisions = []
  for (const queued of state.queue.filter((item) => item.status === 'queued')) {
    if (!Number.isFinite(Date.parse(queued.deadlineAt))) {
      rejectQueuedLock(state, queued, 'queue-deadline-missing-or-invalid', now)
      continue
    }
    if (Date.parse(queued.deadlineAt) <= Date.parse(now)) {
      decisions.push(rejectQueuedLock(state, queued, 'queue-timeout', now))
      continue
    }
    const task = findTask(state, queued.request)
    if (['completed', 'failed', 'reclaimed'].includes(task.status) || !validHandshake(task, queued.request)) {
      rejectQueuedLock(state, queued, 'task-terminated-or-baseline-handshake-changed', now)
      continue
    }
    if (task.status !== 'active' || pendingDecision(state, task) || hasActiveWait(state, task)) continue
    const conflicts = state.locks.filter((lock) => locksConflict(queued.request, lock))
    if (conflicts.length) continue
    queued.status = 'granted'
    queued.resolvedAt = now
    const granted = await grantLock(state, root, queued.request, now)
    queued.grant = { lockId: granted.lock.lockId, leasePath: granted.leasePath, lease: granted.lease }
    promoted.push(granted)
  }
  return { promoted, decisions }
}

async function checkStoredQueueLease(root, grant) {
  const lease = grant.lease
  const expectedPath = '.coord/leases/' + identifier(lease.leaseId, 'leaseId') + '.json'
  if (grant.leasePath !== expectedPath || lease.schemaVersion !== LEASE_SCHEMA
    || !Number.isFinite(Date.parse(lease.issuedAt)) || Date.parse(lease.issuedAt) > Date.now()) {
    coordinatorError('SWARM_COORD_QUEUE_GRANT_INVALID', 'queued lease path, schema or issue time is invalid')
  }
  const leaseFile = resolve(root, expectedPath)
  const publicFile = resolve(root, '.coord/authority/public.pem')
  for (const file of [leaseFile, publicFile]) {
    const status = await lstat(file)
    if (!status.isFile() || status.isSymbolicLink()) {
      coordinatorError('SWARM_COORD_QUEUE_GRANT_INVALID', 'queued lease and public key must be regular files')
    }
  }
  const storedLease = JSON.parse(await readFile(leaseFile, 'utf8'))
  const publicKey = await readFile(publicFile, 'utf8')
  if (JSON.stringify(storedLease) !== JSON.stringify(lease) || lease.authorityKeyId !== sha256(publicKey)
    || typeof lease.signature !== 'string'
    || !verify(null, Buffer.from(JSON.stringify(leasePayload(lease))), publicKey, Buffer.from(lease.signature, 'base64url'))) {
    coordinatorError('SWARM_COORD_QUEUE_GRANT_INVALID', 'queued lease does not match the stored signed grant')
  }
}

async function checkedQueueGrant(state, queued, root) {
  const grant = queued.grant
  const lock = grant && state.locks.find((entry) => entry.lockId === grant.lockId)
  const request = queued.request
  const fields = ['taskId', 'chainId', 'agentId', 'lockType', 'resource']
  if (!lock || fields.some((field) => lock[field] !== request[field])
    || JSON.stringify(lock.paths) !== JSON.stringify(request.paths)
    || lock.leasePath !== grant.leasePath || !grant.lease
    || ['lockId', 'leaseId', 'chainId', 'agentId', 'lockType', 'resource', 'issuedAt', 'expiresAt']
      .some((field) => lock[field] !== grant.lease[field])
    || JSON.stringify(lock.paths) !== JSON.stringify(grant.lease.paths)) {
    coordinatorError('SWARM_COORD_QUEUE_GRANT_INVALID', 'queued grant does not match its original request and current lease')
  }
  if (lock.status !== 'active' || !Number.isFinite(Date.parse(lock.expiresAt)) || Date.parse(lock.expiresAt) <= Date.now()) {
    coordinatorError('SWARM_COORD_QUEUE_GRANT_EXPIRED', 'queued grant is no longer an active unexpired lock')
  }
  await checkStoredQueueLease(root, grant)
  return { lock, leasePath: grant.leasePath, lease: grant.lease }
}

async function lockQueueStatus(repositoryRoot, input) {
  return withCoordinationReadLock(repositoryRoot, async (state, root) => {
    const task = findTask(state, input)
    const queueId = identifier(input.queueId, 'queueId')
    const queued = state.queue.find((entry) => entry.queueId === queueId)
    if (!queued || ['taskId', 'agentId', 'chainId'].some((field) => queued.request[field] !== input[field])) {
      coordinatorError('SWARM_COORD_QUEUE_NOT_FOUND', 'queue does not belong to the requested task, agent and chain')
    }
    if (['completed', 'failed', 'reclaimed'].includes(task.status) || ['rejected', 'timed-out'].includes(queued.status)) {
      return { schemaVersion: LOCAL_SCHEMA, status: 'blocked', queued, reason: 'queue-no-longer-runnable',
        confirmationRequired: queued.status === 'timed-out',
        decisionId: queued.decisionId, confirmProtocolRequest: queued.confirmProtocolRequest,
        requiredAction: 'Resolve any human decision and submit a new explicit request; this queue cannot grant a lock.' }
    }
    if (queued.status === 'queued') {
      if (!Number.isFinite(Date.parse(queued.deadlineAt)) || Date.parse(queued.deadlineAt) <= Date.now()) {
        return { schemaVersion: LOCAL_SCHEMA, status: 'blocked', queued, reason: 'queue-deadline-expired-or-missing',
          requiredAction: 'Run tick to record the terminal queue outcome; do not repeat lock-acquire.' }
      }
      return { schemaVersion: LOCAL_SCHEMA, status: 'queued', queued }
    }
    if (queued.status !== 'granted') coordinatorError('SWARM_COORD_QUEUE_STATE_INVALID', 'unknown queued lock state')
    assertTaskRunnable(state, task)
    if (!validHandshake(task, queued.request)) {
      coordinatorError('SWARM_COORD_BASELINE_HANDSHAKE_REQUIRED', 'queued grant requires the original current baseline handshake')
    }
    return { schemaVersion: LOCAL_SCHEMA, status: 'granted', queueId, ...await checkedQueueGrant(state, queued, root) }
  })
}

async function releaseLock(repositoryRoot, input) {
  return withCoordinationState(repositoryRoot, async (state, root) => {
    const task = findTask(state, input)
    const lockId = identifier(input.lockId, 'lockId')
    const lock = state.locks.find((item) => item.lockId === lockId)
    if (!lock || lock.status !== 'active' || lock.taskId !== task.taskId) {
      coordinatorError('SWARM_COORD_LOCK_NOT_ACTIVE', 'lock is not active for this task')
    }
    const now = new Date().toISOString()
    lock.status = 'released'
    lock.releasedAt = now
    const event = eventRecord(lock.agentId, 'lock-released', { lockId, resource: lock.resource }, now)
    state.events.push(event)
    const wakePackages = routeEvent(state, event)
    const { promoted, decisions } = await promoteQueue(state, root, now)
    return { state, output: { schemaVersion: LOCAL_SCHEMA, released: lock, promoted, wakePackages, decisions },
      audit: [{ event: 'lock-released', lockId, taskId: task.taskId, queueTimeouts: decisions.length }] }
  })
}

async function baselineHandshake(repositoryRoot, input) {
  return withCoordinationState(repositoryRoot, async (state) => {
    const task = findTask(state, input)
    const observed = requireString(input.observedBaselineHash, 'observedBaselineHash')
    if (!/^[0-9a-f]{64}$/.test(observed)) coordinatorError('SWARM_COORD_BASELINE_INVALID', 'observedBaselineHash must be SHA-256')
    if (!Array.isArray(input.refetchPaths)) coordinatorError('SWARM_COORD_REFETCH_REQUIRED', 'refetchPaths must be an array')
    const now = new Date().toISOString()
    const matched = observed === task.baselineHash
    task.baselineHandshake = matched ? {
      handshakeId: `handshake-${randomUUID()}`, baselineHash: observed, checkedAt: now,
    } : null
    if (!matched) { task.status = 'blocked'; task.blockedReason = 'baseline-mismatch' }
    else if (!hasActiveWait(state, task) && !pendingDecision(state, task)
      && task.status === 'blocked' && task.blockedReason === 'baseline-mismatch') {
      task.status = 'active'
      task.blockedReason = null
    }
    const message = addMessage(state, 'baseline-handshake', 'coordinator', task.agentId, {
      matched, expectedBaselineHash: task.baselineHash, observedBaselineHash: observed,
      refetchPaths: input.refetchPaths,
    }, now)
    return { state, output: { schemaVersion: LOCAL_SCHEMA, allowed: matched,
      handshake: task.baselineHandshake, message,
      requiredAction: matched ? null : 'refetch-baseline' },
    audit: [{ event: 'baseline-handshake', taskId: task.taskId, matched }] }
  })
}

async function tick(repositoryRoot, input) {
  return withCoordinationState(repositoryRoot, async (state, root) => {
    const observedMs = Date.parse(input.now)
    if (typeof input.now !== 'string' || !Number.isFinite(observedMs)) {
      coordinatorError('SWARM_COORD_NOW_INVALID', 'now must be an ISO date-time observation')
    }
    const observedAt = new Date(observedMs).toISOString()
    const nowMs = Date.now()
    const now = new Date(nowMs).toISOString()
    const expiredLocks = state.locks.filter((lock) => lock.status === 'active'
      && Date.parse(lock.expiresAt) <= nowMs)
    const lockWakePackages = []
    for (const lock of expiredLocks) {
      lock.status = 'expired'
      lock.releasedAt = now
      const event = eventRecord(lock.agentId, 'lock-released', { lockId: lock.lockId, resource: lock.resource, reason: 'expired' }, now)
      state.events.push(event)
      lockWakePackages.push(...routeEvent(state, event))
    }
    const { promoted, decisions } = await promoteQueue(state, root, now)
    const timeouts = applyTimeouts(state, now)
    const cycles = applyCycles(state, now)
    return { state, output: { schemaVersion: LOCAL_SCHEMA, observedAt, scannedAt: now, expiredLocks, promoted,
      timedOutWaits: timeouts.timedOut, wakePackages: [...lockWakePackages, ...timeouts.wakePackages],
      decisions: [...decisions, ...timeouts.decisions, ...cycles] },
    audit: [{ event: 'coordination-tick', observedAt, scannedAt: now, queueTimeouts: decisions.length, expiredLocks: expiredLocks.length,
      timedOutWaits: timeouts.timedOut.length, deadlocks: cycles.length }] }
  })
}

async function coordinatorStatus(repositoryRoot) {
  const state = await readCoordinationState(repositoryRoot)
  return { schemaVersion: LOCAL_SCHEMA, state }
}

const HANDLERS = Object.freeze({
  ...TASK_ROUTING_HANDLERS,
  'register-task': registerTask,
  'conflict-scan': conflictScan,
  'lock-acquire': acquireLock,
  'lock-queue-status': lockQueueStatus,
  'lock-renew': renewLock,
  'lock-release': releaseLock,
  'baseline-handshake': baselineHandshake,
  'dependency-wait': dependencyWait,
  'event-publish': publishEvent,
  'task-status': taskStatus,
  tick,
  'resolve-human': resolveHuman,
  'wait-for-event': (root, input) => waitForEvent(root, input, tick),
  'wait-cancel': cancelWait,
  status: coordinatorStatus,
})

async function executeCoordinatorOperation(operation, repositoryRoot, input) {
  if (operation === 'capabilities') return {
    schemaVersion: LOCAL_SCHEMA, operations: OPERATIONS, operationSchemas: OPERATION_SCHEMAS,
    roles: ['board', 'dispatcher', 'ops', 'security-guard', 'coordinator'],
    stateBoundary: '.coord persistent ledger; conversation context is never authoritative',
    writeBoundary: 'Aimlock guarded-write verifies the signed active coordination lease',
  }
  const handler = HANDLERS[operation]
  if (!handler) coordinatorError('SWARM_COORD_OPERATION_UNSUPPORTED', `unsupported operation: ${operation}`)
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    coordinatorError('SWARM_COORD_INPUT_INVALID', 'input must be an object')
  }
  validateInputShape(input, OPERATION_SCHEMAS[operation])
  return handler(repositoryRoot, input)
}

export {
  LOCAL_SCHEMA,
  OPERATION_SCHEMAS,
  OPERATIONS,
  executeCoordinatorOperation,
}

export { decisionTargetsTask, decisionResumesTask } from './swarm-coordinator-model.mjs'
