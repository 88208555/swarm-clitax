import { createHash, randomUUID } from 'node:crypto'
import { coordinatorError, identifier, readCoordinationState,
  withCoordinationState, writeSignedLease } from './swarm-coordinator-fs.mjs'
import { coordinationMessage, detectWaitCycles, locksConflict, normalizeLockRequest,
  normalizeTaskCard, normalizeWait, requireString, requireTaskStatus,
  scanTaskConflicts, validateInputShape } from './swarm-coordinator-model.mjs'

const LOCAL_SCHEMA = 'swarm.coordinator-local/1.0'
const OPERATIONS = Object.freeze([
  'capabilities', 'register-task', 'conflict-scan', 'lock-acquire', 'lock-renew',
  'lock-release', 'baseline-handshake', 'dependency-wait', 'event-publish',
  'task-status', 'tick', 'resolve-human', 'status',
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
    baselineHash: string, archConstraints: stringArray },
)
const LOCK_SCHEMA = objectSchema(
  ['taskId', 'agentId', 'chainId', 'lockType', 'resource', 'paths', 'ttlSeconds', 'queueOnConflict', 'baselineHandshakeId'],
  { taskId: string, agentId: string, chainId: string,
    lockType: { enum: ['file', 'build', 'deploy'] }, resource: nullableString, paths: stringArray,
    ttlSeconds: { type: 'integer', minimum: 1, maximum: 3600 }, queueOnConflict: { type: 'boolean' },
    baselineHandshakeId: nullableString },
)
const WAIT_SCHEMA = objectSchema(
  ['taskId', 'chainId', 'waiter', 'waitFor', 'event', 'purpose', 'expectedWithinMs', 'onEvent', 'onTimeout', 'refetchPaths'],
  { taskId: string, chainId: string, waiter: string, waitFor: string, event: string, purpose: string,
    expectedWithinMs: { type: 'integer', minimum: 1 }, onEvent: { const: 'wake-with-package' },
    onTimeout: { enum: ['escalate-need-human', 'abandon-wait', 'continue-after-timeout'] },
    refetchPaths: stringArray },
)
const OPERATION_SCHEMAS = Object.freeze({
  capabilities: objectSchema([], {}),
  'register-task': TASK_CARD_SCHEMA,
  'conflict-scan': objectSchema(['taskId'], { taskId: string }),
  'lock-acquire': LOCK_SCHEMA,
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
  tick: objectSchema(['now'], { now: { type: 'string', format: 'date-time' } }),
  'resolve-human': objectSchema(['decisionId', 'answer', 'actorId'],
    { decisionId: string, answer: string, actorId: string }),
  status: objectSchema([], {}),
})

function sha256(value) { return createHash('sha256').update(value).digest('hex') }

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

function addMessage(state, type, from, to, payload, now) {
  const message = coordinationMessage(type, from, to, payload, now)
  state.messages.push(message)
  return message
}

function eventRecord(publisher, event, payload, now) {
  return {
    schemaVersion: 'swarm.coord-event/1.0', eventId: `event-${randomUUID()}`,
    publisher, event, payload, publishedAt: now,
  }
}

function wakeWait(state, wait, resolution, event, now) {
  wait.status = resolution
  wait.resolvedAt = now
  wait.resolution = event
  const task = state.tasks.find((item) => item.taskId === wait.taskId)
  if (task && task.status === 'waiting') {
    task.status = 'active'
    task.updatedAt = now
  }
  const wakePackage = {
    schemaVersion: 'swarm.wake-package/1.0', waitId: wait.waitId, reason: resolution,
    event, refetchPaths: wait.refetchPaths, createdAt: now,
  }
  addMessage(state, 'dependency-wait', 'coordinator', wait.waiter, wakePackage, now)
  return wakePackage
}

function routeEvent(state, event) {
  return state.waits.filter((wait) => wait.status === 'active'
    && wait.waitFor === event.publisher && wait.event === event.event)
    .map((wait) => wakeWait(state, wait, 'event-received', event, event.publishedAt))
}

function confirmationRequest(decision) {
  const options = decision.agents.map((agentId) => ({
    id: `resume:${agentId}`, label: `先恢复 ${agentId}`, hint: '唤醒该智能体先解除依赖',
  }))
  options.push({ id: 'abort', label: '终止等待', hint: '终止相关等待并保持任务阻塞' })
  return {
    schemaVersion: 'confirm-protocol.skill.request/1.0',
    requestId: `confirm-${decision.decisionId}`,
    operation: 'interaction-request',
    input: { interaction: {
      schemaVersion: 'confirm.interaction/1.0', requestId: decision.decisionId,
      type: 'choice', question: decision.question, options, default: null, timeout: null,
      timeoutAction: 'wait', risk: 'high', riskDescription: decision.riskDescription,
      rememberable: false, memoryKey: '',
      callback: { operation: 'resolve-human', payload: { decisionId: decision.decisionId } },
    } },
  }
}

function createDecision(state, kind, agents, waitIds, question, riskDescription, now) {
  const decision = {
    schemaVersion: 'swarm.coord-decision/1.0', decisionId: `decision-${randomUUID()}`,
    kind, agents: [...new Set(agents)], waitIds: [...new Set(waitIds)], question,
    riskDescription, status: 'pending', answer: null, actorId: null,
    createdAt: now, resolvedAt: null,
  }
  state.decisions.push(decision)
  addMessage(state, 'need-human', 'coordinator', 'human', { decisionId: decision.decisionId, kind, agents, waitIds }, now)
  return { decision, status: 'blocked', confirmationRequired: true, confirmProtocolRequest: confirmationRequest(decision), nextStep: { operation: 'confirm-protocol', instruction: 'Invoke Confirm Protocol and wait for the human answer.' } }
}

async function registerTask(repositoryRoot, input) {
  return withCoordinationState(repositoryRoot, async (state) => {
    const card = normalizeTaskCard(input)
    if (state.tasks.some((task) => task.taskId === card.taskId)) {
      coordinatorError('SWARM_COORD_TASK_EXISTS', `task ${card.taskId} is already registered`)
    }
    state.tasks.push(card)
    return { state, output: { schemaVersion: LOCAL_SCHEMA, task: card },
      audit: [{ event: 'range-declare', taskId: card.taskId, agentId: card.agentId, taskScope: card.taskScope }] }
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
        '矛盾需求同时执行会产生不可预测的覆盖，必须由真人裁决。', new Date().toISOString())
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
    const queued = { schemaVersion: 'swarm.coord-queue/1.0', queueId: `queue-${randomUUID()}`,
      request, blockingLockIds: conflicts.map((lock) => lock.lockId), status: 'queued',
      enqueuedAt: new Date().toISOString(), resolvedAt: null }
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

async function promoteQueue(state, root, now) {
  const promoted = []
  for (const queued of state.queue.filter((item) => item.status === 'queued')) {
    const conflicts = state.locks.filter((lock) => locksConflict(queued.request, lock))
    if (conflicts.length) continue
    queued.status = 'granted'
    queued.resolvedAt = now
    promoted.push(await grantLock(state, root, queued.request, now))
  }
  return promoted
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
    const promoted = await promoteQueue(state, root, now)
    return { state, output: { schemaVersion: LOCAL_SCHEMA, released: lock, promoted, wakePackages },
      audit: [{ event: 'lock-released', lockId, taskId: task.taskId }] }
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
    if (!matched) task.status = 'waiting'
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

function applyCycles(state, now) {
  const cycles = detectWaitCycles(state.waits)
  const requests = []
  for (const cycle of cycles) {
    const agents = cycle.slice(0, -1)
    const waits = state.waits.filter((wait) => wait.status === 'active'
      && agents.includes(wait.waiter) && agents.includes(wait.waitFor))
    for (const wait of waits) wakeWait(state, wait, 'deadlock-interrupted', { cycle }, now)
    requests.push(createDecision(state, 'dependency-cycle', agents, waits.map((wait) => wait.waitId),
      `检测到依赖等待成环：${agents.join(' → ')}。请选择先恢复的智能体。`,
      '依赖成环会导致全部相关任务无限等待，必须由真人决定执行顺序。', now))
  }
  return requests
}

async function dependencyWait(repositoryRoot, input) {
  return withCoordinationState(repositoryRoot, async (state) => {
    const task = findTask(state, { taskId: input.taskId, agentId: input.waiter, chainId: input.chainId })
    const wait = normalizeWait(input)
    if (!state.tasks.some((item) => item.agentId === wait.waitFor)) {
      coordinatorError('SWARM_COORD_WAIT_TARGET_UNKNOWN', 'waitFor must identify a registered agent')
    }
    task.status = 'waiting'
    task.updatedAt = wait.startedAt
    state.waits.push(wait)
    addMessage(state, 'dependency-wait', wait.waiter, wait.waitFor, {
      waitId: wait.waitId, event: wait.event, deadlineAt: wait.deadlineAt, purpose: wait.purpose,
    }, wait.startedAt)
    const decisions = applyCycles(state, wait.startedAt)
    return { state, output: { schemaVersion: LOCAL_SCHEMA, wait, suspended: wait.status === 'active', decisions },
      audit: [{ event: 'dependency-wait', waitId: wait.waitId, waiter: wait.waiter, waitFor: wait.waitFor }] }
  })
}

async function publishEvent(repositoryRoot, input) {
  return withCoordinationState(repositoryRoot, async (state) => {
    const publisher = identifier(input.publisher, 'publisher')
    const eventName = identifier(input.event, 'event')
    if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
      coordinatorError('SWARM_COORD_EVENT_PAYLOAD_INVALID', 'payload must be an object')
    }
    const event = eventRecord(publisher, eventName, input.payload, new Date().toISOString())
    state.events.push(event)
    const wakePackages = routeEvent(state, event)
    return { state, output: { schemaVersion: LOCAL_SCHEMA, event, wakePackages },
      audit: [{ event: 'event-published', eventId: event.eventId, publisher, eventName }] }
  })
}

function notifyDeadTask(state, task, now) {
  return state.waits.filter((wait) => wait.status === 'active' && wait.waitFor === task.agentId)
    .map((wait) => wakeWait(state, wait, 'dependency-terminated', {
      event: 'task-terminated', publisher: task.agentId, payload: { taskId: task.taskId, status: task.status },
      publishedAt: now,
    }, now))
}

async function taskStatus(repositoryRoot, input) {
  return withCoordinationState(repositoryRoot, async (state) => {
    const task = findTask(state, input)
    const status = requireTaskStatus(input.status)
    const now = new Date().toISOString()
    task.status = status
    task.updatedAt = now
    const undeclaredWait = status === 'waiting' && !state.waits.some((wait) => (
      wait.status === 'active' && wait.taskId === task.taskId
    ))
    let declarationMessage = null
    if (undeclaredWait) declarationMessage = addMessage(state, 'dependency-wait', 'coordinator', task.agentId,
      { status: 'declaration-required', taskId: task.taskId }, now)
    const wakePackages = status === 'failed' || status === 'reclaimed'
      ? notifyDeadTask(state, task, now) : []
    return { state, output: { schemaVersion: LOCAL_SCHEMA, task, undeclaredWait,
      declarationMessage, wakePackages }, audit: [{ event: 'task-status', taskId: task.taskId, status }] }
  })
}

function updateTimeoutCount(state, waiter) {
  let entry = state.timeoutCounts.find((item) => item.waiter === waiter)
  if (!entry) {
    entry = { waiter, count: 0 }
    state.timeoutCounts.push(entry)
  }
  entry.count += 1
  return entry.count
}

function applyTimeouts(state, now) {
  const timedOut = state.waits.filter((wait) => wait.status === 'active'
    && Date.parse(wait.deadlineAt) <= Date.parse(now))
  const decisions = []
  const wakePackages = []
  for (const wait of timedOut) {
    const count = updateTimeoutCount(state, wait.waiter)
    if (wait.onTimeout === 'escalate-need-human' || count >= 2) {
      wakePackages.push(wakeWait(state, wait, 'timeout-interrupted', { timeoutCount: count }, now))
      decisions.push(createDecision(state, 'dependency-timeout', [wait.waiter, wait.waitFor], [wait.waitId],
        `${wait.waiter} 等待 ${wait.waitFor} 的 ${wait.event} 已超时，请选择后续动作。`,
        '依赖事件未在声明期限内到达，继续静默等待可能导致任务停滞。', now))
    } else {
      const resolution = wait.onTimeout === 'abandon-wait' ? 'timeout-abandoned' : 'timeout-continued'
      wakePackages.push(wakeWait(state, wait, resolution, { timeoutCount: count }, now))
    }
  }
  return { timedOut, decisions, wakePackages }
}

async function tick(repositoryRoot, input) {
  return withCoordinationState(repositoryRoot, async (state, root) => {
    const nowMs = Date.parse(input.now)
    if (!Number.isFinite(nowMs)) coordinatorError('SWARM_COORD_NOW_INVALID', 'now must be an ISO date-time')
    const now = new Date(nowMs).toISOString()
    const expiredLocks = state.locks.filter((lock) => lock.status === 'active'
      && Date.parse(lock.expiresAt) <= nowMs)
    for (const lock of expiredLocks) {
      lock.status = 'expired'
      lock.releasedAt = now
    }
    const promoted = await promoteQueue(state, root, now)
    const timeouts = applyTimeouts(state, now)
    const cycles = applyCycles(state, now)
    return { state, output: { schemaVersion: LOCAL_SCHEMA, expiredLocks, promoted,
      timedOutWaits: timeouts.timedOut, wakePackages: timeouts.wakePackages,
      decisions: [...timeouts.decisions, ...cycles] },
    audit: [{ event: 'coordination-tick', expiredLocks: expiredLocks.length,
      timedOutWaits: timeouts.timedOut.length, deadlocks: cycles.length }] }
  })
}

async function resolveHuman(repositoryRoot, input) {
  return withCoordinationState(repositoryRoot, async (state) => {
    const decisionId = identifier(input.decisionId, 'decisionId')
    const decision = state.decisions.find((item) => item.decisionId === decisionId)
    if (!decision || decision.status !== 'pending') {
      coordinatorError('SWARM_COORD_DECISION_NOT_PENDING', 'decision is not pending')
    }
    const answer = requireString(input.answer, 'answer')
    const allowed = new Set([...decision.agents.map((agent) => `resume:${agent}`), 'abort'])
    if (!allowed.has(answer)) coordinatorError('SWARM_COORD_DECISION_ANSWER_INVALID', 'answer is not a declared option')
    const now = new Date().toISOString()
    decision.status = 'resolved'
    decision.answer = answer
    decision.actorId = identifier(input.actorId, 'actorId')
    decision.resolvedAt = now
    if (answer.startsWith('resume:')) {
      const agent = answer.slice('resume:'.length)
      for (const task of state.tasks.filter((item) => item.agentId === agent && item.status === 'waiting')) {
        task.status = 'active'
        task.updatedAt = now
      }
    }
    return { state, output: { schemaVersion: LOCAL_SCHEMA, decision },
      audit: [{ event: 'decision-resolved', decisionId, answer, actorId: decision.actorId }] }
  })
}

async function coordinatorStatus(repositoryRoot) {
  const state = await readCoordinationState(repositoryRoot)
  return { schemaVersion: LOCAL_SCHEMA, state }
}

const HANDLERS = Object.freeze({
  'register-task': registerTask,
  'conflict-scan': conflictScan,
  'lock-acquire': acquireLock,
  'lock-renew': renewLock,
  'lock-release': releaseLock,
  'baseline-handshake': baselineHandshake,
  'dependency-wait': dependencyWait,
  'event-publish': publishEvent,
  'task-status': taskStatus,
  tick,
  'resolve-human': resolveHuman,
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
