import { relativePath, withCoordinationState } from './swarm-coordinator-fs.mjs'
import { findTask, pathOverlap, requireString } from './swarm-coordinator-model.mjs'
import { addMessage, assertTaskRunnable, hasActiveWait, pendingDecision } from './swarm-coordinator-waits.mjs'
import { describedTask, digest, identity, routingError, strings, visibleTo } from './swarm-task-routing-model.mjs'

const INTENT_SCHEMA = 'swarm.peer-intent/1.0'
const RESULT_SCHEMA = 'swarm.peer-coordination-result/1.0'
const PEER_MESSAGE_TYPES = new Set([
  'peer-conflict', 'peer-request', 'peer-ready', 'peer-priority', 'peer-timeout', 'peer-spawned',
])
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const TERMINAL_INTENT_STATUSES = new Set(['completed', 'expired', 'spawned'])
const PRIORITY_RANK = Object.freeze({ background: 10, normal: 20, high: 30, urgent: 40 })

function peerIntents(state) {
  return state.messages.filter(message => message.schemaVersion === INTENT_SCHEMA)
}

function expireIntents(state, now) {
  const nowMs = Date.parse(now)
  for (const intent of peerIntents(state)) {
    if (intent.status === 'active' && Date.parse(intent.expiresAt) <= nowMs) {
      intent.status = 'expired'
      intent.completedAt = now
    }
  }
}

function requireIntentId(value) {
  const intentId = requireString(value, 'intentId')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(intentId)) {
    routingError('INTENT_ID_INVALID', 'intentId is invalid')
  }
  return intentId
}

function normalizeCoordinateInput(task, input) {
  const intentId = requireIntentId(input.intentId)
  const paths = strings(input.paths, 'paths').map(path => relativePath(path))
  if (new Set(paths).size !== paths.length) routingError('INPUT_INVALID', 'normalized paths contain duplicates')
  if (!paths.length || paths.some(path => !task.taskScope.some(scope => path === scope || path.startsWith(scope + '/')))) {
    routingError('SCOPE_REQUIRED', 'every peer intent path must be inside the registered task scope')
  }
  if (!SHA256_PATTERN.test(input.baselineHash)) {
    routingError('BASELINE_INVALID', 'baselineHash must be a lowercase SHA-256 digest')
  }
  if (!Object.hasOwn(PRIORITY_RANK, input.priority)) {
    routingError('PRIORITY_INVALID', 'priority must be background, normal, high, or urgent')
  }
  if (!Number.isSafeInteger(input.intentTtlMs) || input.intentTtlMs < 1 || input.intentTtlMs > 3_600_000) {
    routingError('INTENT_TTL_INVALID', 'intentTtlMs must be 1..3600000')
  }
  if (!Number.isSafeInteger(input.leaseTtlSeconds)
    || input.leaseTtlSeconds < 1 || input.leaseTtlSeconds > 3_600) {
    routingError('LEASE_TTL_INVALID', 'leaseTtlSeconds must be 1..3600')
  }
  if (!Number.isSafeInteger(input.coordinationTimeoutMs) || input.coordinationTimeoutMs < 1
    || input.coordinationTimeoutMs >= input.intentTtlMs) {
    routingError('COORDINATION_TIMEOUT_INVALID', 'coordinationTimeoutMs must be lower than intentTtlMs')
  }
  return { intentId, paths, baselineHash: input.baselineHash, priority: input.priority,
    intentTtlMs: input.intentTtlMs, coordinationTimeoutMs: input.coordinationTimeoutMs,
    leaseTtlSeconds: input.leaseTtlSeconds }
}

function taskForIntent(state, intent) {
  return state.tasks.find(task => task.taskId === intent.taskId && task.agentId === intent.agentId
    && task.chainId === intent.chainId)
}

function isEarlier(left, right) {
  return left.priorityRevision < right.priorityRevision
    || (left.priorityRevision === right.priorityRevision && left.intentId < right.intentId)
}

function claimsPath(intent, path) {
  return intent.claimedPaths.some(claimed => pathOverlap(path, claimed))
}

function precedes(left, right, path) {
  const leftClaimed = claimsPath(left, path)
  const rightClaimed = claimsPath(right, path)
  if (leftClaimed && rightClaimed) return isEarlier(left, right)
  if (leftClaimed !== rightClaimed) return leftClaimed
  const rankDifference = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority]
  return rankDifference > 0 || (rankDifference === 0 && isEarlier(left, right))
}

function ownCoveredPaths(state, intent) {
  const locks = state.locks.filter(lock => lock.status === 'active' && lock.lockType === 'file'
    && lock.taskId === intent.taskId && lock.agentId === intent.agentId && lock.chainId === intent.chainId)
  return intent.paths.filter(path => locks.some(lock => lock.paths.some(locked => pathOverlap(path, locked))))
}

function blockersForPath(state, intent, path) {
  const peerBlockers = peerIntents(state).filter(other => other.status === 'active'
    && other.intentId !== intent.intentId && precedes(other, intent, path)
    && other.paths.some(otherPath => pathOverlap(path, otherPath)))
  const lockBlockers = state.locks.filter(lock => lock.status === 'active' && lock.lockType === 'file'
    && lock.taskId !== intent.taskId && lock.paths.some(locked => pathOverlap(path, locked)))
  return { peerBlockers, lockBlockers }
}

function partitionIntent(state, intent) {
  const coveredPaths = ownCoveredPaths(state, intent)
  const blocked = intent.paths.map(path => ({ path, ...blockersForPath(state, intent, path) }))
    .filter(item => item.peerBlockers.length || item.lockBlockers.length)
  const blockedPaths = blocked.map(item => item.path)
  const readyPaths = intent.paths.filter(path => !coveredPaths.includes(path) && !blockedPaths.includes(path))
  return { coveredPaths, blocked, blockedPaths, readyPaths }
}

function visibleBlockers(state, task, blocked) {
  const peers = new Map()
  for (const item of blocked) {
    for (const intent of item.peerBlockers) {
      const blockerTask = taskForIntent(state, intent)
      if (blockerTask && visibleTo(task, blockerTask)) {
        const current = peers.get(intent.intentId) ?? { intentId: intent.intentId,
          taskId: intent.taskId, agentId: intent.agentId, priority: intent.priority,
          claimed: false, paths: [] }
        current.paths.push(item.path)
        current.claimed ||= claimsPath(intent, item.path)
        peers.set(intent.intentId, current)
      }
    }
  }
  return [...peers.values()].map(peer => ({ ...peer, paths: [...new Set(peer.paths)] }))
}

function lockRequest(intent, paths) {
  if (!paths.length) return null
  return { ...identity(intent), lockType: 'file', resource: null, paths,
    ttlSeconds: intent.leaseTtlSeconds, queueOnConflict: false, baselineHandshakeId: null,
    peerIntentId: intent.intentId }
}

function intentView(state, task, intent, previousBlockedPaths = intent.blockedPaths) {
  const partition = partitionIntent(state, intent)
  const refetchPaths = previousBlockedPaths.filter(path => partition.readyPaths.includes(path))
  const status = partition.blockedPaths.length ? (partition.readyPaths.length ? 'partial' : 'blocked') : 'ready'
  const runnable = task.status === 'active' && !hasActiveWait(state, task) && !pendingDecision(state, task)
  return { schemaVersion: RESULT_SCHEMA, status, intentId: intent.intentId, priority: intent.priority,
    task: identity(task),
    readyPaths: partition.readyPaths, blockedPaths: partition.blockedPaths,
    coveredPaths: partition.coveredPaths, blockingPeers: visibleBlockers(state, task, partition.blocked),
    refetchPaths, freshAimlockSnapshotRequired: refetchPaths.length > 0,
    lockRequest: runnable ? lockRequest(intent, partition.readyPaths) : null,
    continuation: { mayContinue: runnable && (partition.readyPaths.length > 0 || partition.coveredPaths.length > 0),
      originalTaskRetained: true, delegationRequired: false, priority: intent.priority },
    safeCheckpointRequested: intent.priority === 'urgent' && partition.blockedPaths.length > 0,
    expiresAt: intent.expiresAt, coordinationDeadlineAt: intent.coordinationDeadlineAt,
    spawnRequest: intent.spawnRequest }
}

function remainingRequirements(task) {
  const completed = new Set(task.routing.completedRequirementIds)
  return task.routing.requirements.filter(item => !completed.has(item.id))
}

function createSpawnRequest(state, task, intent, blockedPaths, now) {
  if (intent.spawnRequest || !blockedPaths.length
    || Date.parse(now) < Date.parse(intent.coordinationDeadlineAt)) return intent.spawnRequest
  if (!intent.spawnAllowed) {
    if (!intent.timeoutReportedAt) {
      intent.timeoutReportedAt = now
      addMessage(state, 'peer-timeout', 'coordinator', task.agentId, {
        targetTaskId: task.taskId, intentId: intent.intentId, blockedPaths,
        coordinationDeadlineAt: intent.coordinationDeadlineAt, createNewTaskWindow: false,
        autoDispatch: false, loopGuard: 'spawn-depth-limit',
      }, now)
    }
    return null
  }
  const spawnRequestId = 'spawn-' + digest([intent.intentId, intent.coordinationDeadlineAt])
  intent.timeoutReportedAt = now
  intent.spawnRequest = {
    schemaVersion: 'swarm.peer-spawn-request/1.0', spawnRequestId,
    idempotencyKey: spawnRequestId, status: 'pending', source: identity(task),
    ownerId: task.routing.ownerId, projectId: task.routing.projectId, hostId: task.routing.hostId,
    goal: task.routing.goal, requirements: remainingRequirements(task), targetPaths: blockedPaths,
    priority: intent.priority, reason: 'coordination-timeout', createNewTaskWindow: true,
    autoDispatch: true, spawnDepth: intent.spawnDepth + 1, maxSpawnDepth: 1,
    parentIntentId: intent.intentId, createdAt: now, boundTask: null,
  }
  addMessage(state, 'peer-timeout', 'coordinator', task.agentId, {
    targetTaskId: task.taskId, intentId: intent.intentId, spawnRequestId,
    blockedPaths, coordinationDeadlineAt: intent.coordinationDeadlineAt,
    createNewTaskWindow: true, autoDispatch: true, loopGuard: 'single-spawn',
  }, now)
  return intent.spawnRequest
}

function requireOwnedIntent(state, task, value) {
  const intentId = requireIntentId(value)
  const intent = peerIntents(state).find(item => item.intentId === intentId)
  if (!intent || intent.taskId !== task.taskId || intent.agentId !== task.agentId
    || intent.chainId !== task.chainId) routingError('INTENT_UNAVAILABLE', 'peer intent is not owned by this task')
  return intent
}

function notifyInitialPeers(state, task, intent, view, now) {
  if (!view.blockedPaths.length) return
  addMessage(state, 'peer-conflict', 'coordinator', task.agentId, {
    targetTaskId: task.taskId, intentId: intent.intentId, blockedPaths: view.blockedPaths,
    priority: intent.priority, delegationRequired: false,
  }, now)
  for (const peer of view.blockingPeers) {
    addMessage(state, 'peer-request', task.agentId, peer.agentId, {
      targetTaskId: peer.taskId, requesterTaskId: task.taskId,
      requesterIntentId: intent.intentId, requesterPriority: intent.priority,
      overlapPaths: peer.paths, safeCheckpointRequested: intent.priority === 'urgent', delegationRequired: false,
    }, now)
  }
}

function notifyOvertakenPeers(state, task, intent, now) {
  const rank = PRIORITY_RANK[intent.priority]
  for (const other of peerIntents(state).filter(item => item.status === 'active'
    && item.intentId !== intent.intentId && PRIORITY_RANK[item.priority] < rank)) {
    const otherTask = taskForIntent(state, other)
    if (!otherTask || !visibleTo(task, otherTask)) continue
    const affectedPaths = other.paths.filter(path => !claimsPath(other, path)
      && intent.paths.some(intentPath => pathOverlap(path, intentPath)))
    if (!affectedPaths.length) continue
    addMessage(state, 'peer-priority', 'coordinator', other.agentId, {
      targetTaskId: other.taskId, intentId: other.intentId, queuedAheadTaskId: task.taskId,
      queuedAheadIntentId: intent.intentId, queuedAheadPriority: intent.priority,
      affectedPaths, delegationRequired: false,
    }, now)
  }
}

async function coordinatePeer(root, input) {
  return withCoordinationState(root, state => {
    const task = describedTask(state, input)
    assertTaskRunnable(state, task)
    const normalized = normalizeCoordinateInput(task, input)
    const now = new Date().toISOString()
    expireIntents(state, now)
    const inputDigest = digest(normalized)
    const existing = peerIntents(state).find(intent => intent.intentId === normalized.intentId)
    if (existing) {
      if (existing.taskId !== task.taskId || existing.agentId !== task.agentId
        || existing.chainId !== task.chainId || existing.inputDigest !== inputDigest) {
        routingError('INTENT_CONFLICT', 'intentId already identifies different peer coordination input')
      }
      if (existing.status === 'completed') return { state, output: { ...existing.completion, replayed: true }, audit: [] }
      if (existing.status === 'expired') routingError('INTENT_TERMINAL', 'expired peer intent cannot be replayed')
      const view = intentView(state, task, existing)
      return { state, output: { ...view, replayed: true }, audit: [] }
    }
    const intent = { schemaVersion: INTENT_SCHEMA, ...identity(task), ...normalized, inputDigest,
      priorityRevision: state.revision + 1, status: 'active', blockedPaths: [], createdAt: now,
      expiresAt: new Date(Date.parse(now) + normalized.intentTtlMs).toISOString(), claimedPaths: [],
      coordinationDeadlineAt: new Date(Date.parse(now) + normalized.coordinationTimeoutMs).toISOString(),
      spawnAllowed: true, spawnDepth: 0, spawnRequest: null,
      timeoutReportedAt: null,
      completedAt: null, resultSummary: null, completion: null }
    state.messages.push(intent)
    const view = intentView(state, task, intent, [])
    intent.blockedPaths = view.blockedPaths
    notifyInitialPeers(state, task, intent, view, now)
    notifyOvertakenPeers(state, task, intent, now)
    return { state, output: { ...view, replayed: false },
      audit: [{ event: 'peer-coordinate', taskId: task.taskId, intentId: intent.intentId,
        readyPaths: view.readyPaths, blockedPaths: view.blockedPaths }] }
  })
}

async function peerStatus(root, input) {
  return withCoordinationState(root, state => {
    const task = describedTask(state, input)
    const now = new Date().toISOString()
    expireIntents(state, now)
    const intent = requireOwnedIntent(state, task, input.intentId)
    if (TERMINAL_INTENT_STATUSES.has(intent.status)) {
      routingError('INTENT_TERMINAL', 'peer intent is no longer active; register a new intent before writing')
    }
    const previousBlockedPaths = [...intent.blockedPaths]
    const view = intentView(state, task, intent, previousBlockedPaths)
    intent.blockedPaths = view.blockedPaths
    const spawnRequest = createSpawnRequest(state, task, intent, view.blockedPaths, now)
    const coordinationTimedOut = view.blockedPaths.length > 0
      && Date.parse(now) >= Date.parse(intent.coordinationDeadlineAt)
    return { state, output: { ...view, spawnRequest, coordinationTimedOut }, audit: [{ event: 'peer-status', taskId: task.taskId,
      intentId: intent.intentId, readyPaths: view.readyPaths, blockedPaths: view.blockedPaths }] }
  })
}

function assertSpawnTarget(sourceTask, spawnedTask, request) {
  if (spawnedTask.taskId === sourceTask.taskId || spawnedTask.status !== 'active' || !spawnedTask.routing) {
    routingError('SPAWN_TARGET_INVALID', 'spawn target must be a distinct active described task')
  }
  if (spawnedTask.routing.ownerId !== request.ownerId || spawnedTask.routing.projectId !== request.projectId
    || spawnedTask.routing.hostId !== request.hostId) {
    routingError('SPAWN_TARGET_INVALID', 'spawn target must preserve owner, project, and host identity')
  }
  if (request.targetPaths.some(path => !spawnedTask.taskScope.some(scope => (
    path === scope || path.startsWith(scope + '/'))))) {
    routingError('SPAWN_TARGET_SCOPE_INVALID', 'spawn target scope must cover every timed-out path')
  }
}

async function bindSpawnedPeer(root, input) {
  return withCoordinationState(root, state => {
    const sourceTask = describedTask(state, input)
    const now = new Date().toISOString()
    expireIntents(state, now)
    const intent = requireOwnedIntent(state, sourceTask, input.intentId)
    const request = intent.spawnRequest
    if (!request || request.spawnRequestId !== requireString(input.spawnRequestId, 'spawnRequestId')) {
      routingError('SPAWN_REQUEST_UNAVAILABLE', 'peer intent has no matching timeout spawn request')
    }
    const spawnedIdentity = { taskId: requireString(input.spawnedTaskId, 'spawnedTaskId'),
      agentId: requireString(input.spawnedAgentId, 'spawnedAgentId'),
      chainId: requireString(input.spawnedChainId, 'spawnedChainId') }
    if (request.status === 'bound') {
      if (Object.keys(spawnedIdentity).some(key => request.boundTask[key] !== spawnedIdentity[key])) {
        routingError('SPAWN_REQUEST_CONFLICT', 'spawn request is already bound to another task')
      }
      return { state, output: { schemaVersion: RESULT_SCHEMA, status: 'spawned',
        spawnRequest: request, replayed: true }, audit: [] }
    }
    if (intent.status !== 'active') routingError('INTENT_TERMINAL', 'only an active intent can bind a spawn request')
    const spawnedTask = findTask(state, spawnedIdentity)
    assertSpawnTarget(sourceTask, spawnedTask, request)
    const spawnedIntentId = intent.intentId + ':spawn:' + request.spawnDepth
    if (peerIntents(state).some(item => item.intentId === spawnedIntentId)) {
      routingError('SPAWN_REQUEST_CONFLICT', 'spawned peer intent already exists without a bound request')
    }
    const spawnedIntent = {
      schemaVersion: INTENT_SCHEMA, ...identity(spawnedTask), intentId: spawnedIntentId,
      paths: [...request.targetPaths], baselineHash: spawnedTask.baselineHash, priority: intent.priority,
      intentTtlMs: intent.intentTtlMs, coordinationTimeoutMs: intent.coordinationTimeoutMs,
      leaseTtlSeconds: intent.leaseTtlSeconds, inputDigest: digest([request.spawnRequestId, spawnedIdentity]),
      priorityRevision: state.revision + 1, status: 'active', blockedPaths: [...request.targetPaths],
      createdAt: now, expiresAt: new Date(Date.parse(now) + intent.intentTtlMs).toISOString(),
      coordinationDeadlineAt: new Date(Date.parse(now) + intent.coordinationTimeoutMs).toISOString(),
      claimedPaths: [], spawnAllowed: false, spawnDepth: request.spawnDepth, spawnRequest: null,
      timeoutReportedAt: null,
      completedAt: null, resultSummary: null, completion: null,
    }
    state.messages.push(spawnedIntent)
    intent.paths = intent.paths.filter(path => !request.targetPaths.includes(path))
    intent.blockedPaths = intent.blockedPaths.filter(path => !request.targetPaths.includes(path))
    intent.claimedPaths = intent.claimedPaths.filter(path => !request.targetPaths.includes(path))
    if (!intent.paths.length) {
      intent.status = 'spawned'
      intent.completedAt = now
      intent.resultSummary = 'Timed-out paths moved to a new task window'
    }
    request.status = 'bound'
    request.boundTask = identity(spawnedTask)
    request.boundAt = now
    addMessage(state, 'peer-spawned', 'coordinator', sourceTask.agentId, {
      targetTaskId: sourceTask.taskId, intentId: intent.intentId,
      spawnRequestId: request.spawnRequestId, spawnedTask: identity(spawnedTask),
    }, now)
    addMessage(state, 'peer-spawned', 'coordinator', spawnedTask.agentId, {
      targetTaskId: spawnedTask.taskId, intentId: spawnedIntentId,
      spawnRequestId: request.spawnRequestId, sourceTask: identity(sourceTask),
      spawnDepth: request.spawnDepth, furtherSpawnAllowed: false,
    }, now)
    const plan = intentView(state, spawnedTask, spawnedIntent, request.targetPaths)
    spawnedIntent.blockedPaths = plan.blockedPaths
    return { state, output: { schemaVersion: RESULT_SCHEMA, status: 'spawned',
      spawnRequest: request, spawnedIntent: plan, replayed: false },
      audit: [{ event: 'peer-spawn-bind', taskId: sourceTask.taskId,
        spawnedTaskId: spawnedTask.taskId, spawnRequestId: request.spawnRequestId }] }
  })
}

function resumedPeers(state, completed, now) {
  const resumed = []
  const completedTask = taskForIntent(state, completed)
  for (const intent of peerIntents(state).filter(item => item.status === 'active')) {
    const task = taskForIntent(state, intent)
    const previous = [...intent.blockedPaths]
    if (!task || !completedTask || !visibleTo(task, completedTask)) continue
    const view = intentView(state, task, intent, previous)
    const paths = previous.filter(path => view.readyPaths.includes(path))
    if (!paths.length) continue
    addMessage(state, 'peer-ready', 'coordinator', intent.agentId, {
      targetTaskId: intent.taskId, intentId: intent.intentId,
      completedPeerTaskId: completed.taskId, refetchPaths: paths,
      priority: intent.priority, freshAimlockSnapshotRequired: true, delegationRequired: false,
    }, now)
    resumed.push({ taskId: intent.taskId, agentId: intent.agentId, intentId: intent.intentId, refetchPaths: paths })
  }
  return resumed
}

async function completePeer(root, input) {
  return withCoordinationState(root, state => {
    const task = describedTask(state, input)
    const now = new Date().toISOString()
    expireIntents(state, now)
    const intent = requireOwnedIntent(state, task, input.intentId)
    const resultSummary = requireString(input.resultSummary, 'resultSummary')
    if (intent.status === 'completed') {
      if (intent.resultSummary !== resultSummary) routingError('INTENT_CONFLICT', 'completed intent has a different result summary')
      return { state, output: { ...intent.completion, replayed: true }, audit: [] }
    }
    if (intent.status !== 'active') routingError('INTENT_TERMINAL', 'expired peer intent cannot be completed')
    const activeLocks = state.locks.filter(lock => lock.status === 'active' && lock.lockType === 'file'
      && lock.taskId === task.taskId && lock.paths.some(path => intent.paths.some(intentPath => pathOverlap(path, intentPath))))
    if (activeLocks.length) routingError('LOCK_RELEASE_REQUIRED', 'release overlapping file locks before completing the peer intent')
    intent.status = 'completed'
    intent.completedAt = now
    intent.resultSummary = resultSummary
    const resumed = resumedPeers(state, intent, now)
    intent.completion = { schemaVersion: RESULT_SCHEMA, status: 'completed', intentId: intent.intentId,
      task: identity(task), resultSummary, resumedPeers: resumed, delegationRequired: false }
    return { state, output: { ...intent.completion, replayed: false },
      audit: [{ event: 'peer-complete', taskId: task.taskId, intentId: intent.intentId,
        resumedTaskIds: resumed.map(peer => peer.taskId) }] }
  })
}

export function peerNotifications(state, task) {
  return state.messages.filter(message => message.schemaVersion === 'swarm.coord-message/1.0'
    && PEER_MESSAGE_TYPES.has(message.type) && message.to === task.agentId
    && message.payload.targetTaskId === task.taskId)
}

export function authorizePeerLock(state, request) {
  if (!request.peerIntentId) return
  const intent = peerIntents(state).find(item => item.intentId === request.peerIntentId)
  if (!intent || intent.status !== 'active' || intent.taskId !== request.taskId
    || intent.agentId !== request.agentId || intent.chainId !== request.chainId) {
    routingError('PEER_LOCK_UNAVAILABLE', 'peer-bound file lock requires an active intent owned by this task')
  }
  const partition = partitionIntent(state, intent)
  const allowedPaths = new Set([...partition.readyPaths, ...partition.coveredPaths])
  if (request.paths.some(path => !intent.paths.includes(path) || !allowedPaths.has(path))) {
    routingError('PEER_LOCK_NOT_READY', 'peer-bound file lock contains a blocked or undeclared path; reload peer status')
  }
  intent.claimedPaths = [...new Set([...intent.claimedPaths, ...request.paths])]
}

export const PEER_COORDINATION_HANDLERS = Object.freeze({
  'peer-coordinate': coordinatePeer,
  'peer-status': peerStatus,
  'peer-spawn-bind': bindSpawnedPeer,
  'peer-complete': completePeer,
})
