import { lstat, opendir, readFile, realpath } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { withCoordinationState } from './swarm-coordinator-fs.mjs'
import { requireString } from './swarm-coordinator-model.mjs'
import { hasActiveWait, pendingDecision, eventRecord, routeEvent } from './swarm-coordinator-waits.mjs'
import { TASKS_SCHEMA, describedTask, accessRequest, requestedTask, targetRequest, routingError,
  event, requestView, receipt, requests, digest } from './swarm-task-routing-model.mjs'

function revokeTaskLocks(state, taskId, now) {
  for (const lock of state.locks.filter(item => item.taskId === taskId && item.status === 'active')) {
    lock.status = 'released'
    lock.releasedAt = now
    const released = eventRecord(lock.agentId, 'lock-released', { lockId: lock.lockId, resource: lock.resource, reason: 'task-handoff' }, now)
    state.events.push(released)
    routeEvent(state, released)
  }
  for (const queued of state.queue.filter(item => item.request.taskId === taskId && item.status === 'queued')) {
    queued.status = 'rejected'
    queued.reason = 'explicit-task-handoff'
    queued.resolvedAt = now
  }
}
function handoffScope(task, request) {
  const paths = request.targetPaths.length ? request.targetPaths : task.taskScope
  if (!paths.every(path => task.taskScope.some(scope => path === scope || path.startsWith(scope + '/')))) {
    routingError('SCOPE_REQUIRED', 'handoff cannot grant paths outside the original owner scope')
  }
  return paths
}
async function releaseHandoff(root, input) {
  return withCoordinationState(root, state => {
    const original = describedTask(state, input), request = accessRequest(state, original, input.requestId)
    if (request.handoffTaskId !== original.taskId || !request.forceCurrent) routingError('HANDOFF_OWNER_REQUIRED', 'only the existing owner can release an explicitly requested handoff')
    const summary = requireString(input.checkpointSummary, 'checkpointSummary')
    if (original.routing.handoff !== null && original.routing.handoff.requestId === request.requestId) {
      return { state, output: { schemaVersion: TASKS_SCHEMA, request: requestView(request), released: true }, audit: [] }
    }
    if (request.status !== 'pending-handoff' || original.status !== 'active'
      || original.routing.handoff !== null || pendingDecision(state, original) || hasActiveWait(state, original)) {
      routingError('HANDOFF_NOT_READY', 'the owner must reach an active safe checkpoint before releasing this work')
    }
    const target = requestedTask(state, original, request.targetTaskId)
    if (target.status !== 'active' || target.routing.handoff !== null || pendingDecision(state, target) || hasActiveWait(state, target)) {
      routingError('TARGET_SUSPENDED', 'the receiving task is not ready for handoff')
    }
    if (requests(state).some(other => other.requestId !== request.requestId && other.targetTaskId === target.taskId
      && other.handoffTaskId !== null && ['pending-delivery', 'accepted'].includes(other.status))) {
      routingError('HANDOFF_BUSY', 'finish the existing scoped handoff before receiving another')
    }
    const paths = handoffScope(original, request), now = new Date().toISOString()
    original.routing.handoff = { requestId: request.requestId, checkpointSummary: summary,
      checkpoint: { nextAction: original.routing.nextAction, completedRequirementIds: [...original.routing.completedRequirementIds] },
      releasedAt: now }
    original.status = 'waiting'
    revokeTaskLocks(state, original.taskId, now)
    request.handoffPaths = paths
    request.previousTargetScope = [...target.taskScope]
    target.taskScope = [...new Set([...target.taskScope, ...paths])]
    target.baselineHandshake = null
    request.status = 'pending-delivery'
    event(request, 'handoff-released', { ownerTaskId: original.taskId, targetTaskId: target.taskId,
      checkpointSummary: summary, paths, freshAimlockSnapshotRequired: true })
    return { state, output: { schemaVersion: TASKS_SCHEMA, request: requestView(request), released: true,
      freshAimlockSnapshotRequired: true }, audit: [{ event: 'handoff-released', requestId: request.requestId,
      taskId: original.taskId, targetTaskId: target.taskId, paths }] }
  })
}
async function completeMessage(root, input) {
  return withCoordinationState(root, state => {
    const { task, request } = targetRequest(state, input)
    const resultSummary = requireString(input.resultSummary, 'resultSummary')
    if (request.status === 'completed') {
      if (request.resultSummary !== resultSummary) routingError('RESULT_CONFLICT', 'completed request already has a different result')
      return { state, output: { schemaVersion: TASKS_SCHEMA, request: requestView(request), receipt: receipt(request) }, audit: [] }
    }
    if (request.status !== 'accepted' || request.receiptId === null) routingError('ACCEPT_REQUIRED', 'only accepted requests can complete')
    if (task.status !== 'active' || task.routing.handoff !== null || hasActiveWait(state, task) || pendingDecision(state, task)) {
      routingError('TASK_SUSPENDED', 'a suspended task cannot complete work')
    }
    const now = new Date().toISOString()
    request.status = 'completed'
    request.resultSummary = resultSummary
    request.completedAt = now
    if (request.handoffTaskId !== null) {
      const original = requestedTask(state, task, request.handoffTaskId)
      if (original.status !== 'waiting' || original.routing.handoff === null || original.routing.handoff.requestId !== request.requestId) {
        routingError('HANDOFF_STATE_INVALID', 'the original task no longer owns this handoff checkpoint')
      }
      original.routing.handoff = null
      original.status = 'blocked'
      original.blockedReason = 'baseline-mismatch'
      original.baselineHandshake = null
      revokeTaskLocks(state, task.taskId, now)
      task.taskScope = request.previousTargetScope
      task.baselineHandshake = null
      event(request, 'handoff-returned', { originalTaskId: original.taskId, refetchPaths: request.targetPaths,
        requiredAction: 'refetch-and-verify-baseline-before-resume' })
    }
    event(request, 'message-completed', { resultSummary })
    return { state, output: { schemaVersion: TASKS_SCHEMA, request: requestView(request), receipt: receipt(request) },
      audit: [{ event: 'message-completed', taskId: task.taskId, requestId: request.requestId }] }
  })
}
export const TASK_HANDOFF_HANDLERS = Object.freeze({ 'handoff-release': releaseHandoff, 'message-complete': completeMessage, 'handoff-resume': resumeHandoff })

const MAX_BASELINE_ENTRIES = 1_000
const MAX_BASELINE_BYTES = 16 * 1_024 * 1_024
async function baselineFingerprint(rootValue, paths) {
  const root = await realpath(rootValue), entries = new Map(), visited = new Set()
  let bytes = 0
  async function inspect(target) {
    if (visited.has(target)) return
    if (visited.size >= MAX_BASELINE_ENTRIES) routingError('BASELINE_LIMIT', 'handoff baseline needs a narrower approved scope')
    visited.add(target)
    let status
    try { status = await lstat(target) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      entries.set(relative(root, target), 'missing')
      return
    }
    if (status.isSymbolicLink() || await realpath(target) !== target) routingError('BASELINE_INVALID', 'handoff baseline cannot traverse symbolic links')
    if (status.isDirectory()) {
      const directory = await opendir(target)
      for await (const entry of directory) await inspect(resolve(target, entry.name))
      return
    }
    if (!status.isFile()) routingError('BASELINE_INVALID', 'handoff baseline contains a non-regular file')
    const key = relative(root, target)
    if (entries.has(key)) return
    bytes += status.size
    if (bytes > MAX_BASELINE_BYTES) routingError('BASELINE_LIMIT', 'handoff baseline needs a narrower approved scope')
    entries.set(key, createHash('sha256').update(await readFile(target)).digest('hex'))
  }
  for (const path of paths) {
    const target = resolve(root, path)
    if (target === root || !target.startsWith(root + '/')) routingError('BASELINE_INVALID', 'handoff path escapes its workspace')
    await inspect(target)
  }
  const files = [...entries].sort(([left], [right]) => left.localeCompare(right))
  return { baselineHash: digest(files), files }
}
async function resumeHandoff(root, input) {
  return withCoordinationState(root, async state => {
    const task = describedTask(state, input), request = accessRequest(state, task, input.requestId)
    if (request.handoffTaskId !== task.taskId || request.status !== 'completed') routingError('HANDOFF_NOT_COMPLETE', 'only the original task can resume a completed handoff')
    const resumed = request.history.find(item => item.type === 'handoff-resumed')
    if (resumed) return { state, output: { schemaVersion: TASKS_SCHEMA, ...resumed.details, replayed: true }, audit: [] }
    if (task.status !== 'blocked' || task.blockedReason !== 'baseline-mismatch' || task.routing.handoff !== null
      || hasActiveWait(state, task) || pendingDecision(state, task)) routingError('TASK_SUSPENDED', 'other task dependencies still prevent resumption')
    const baseline = await baselineFingerprint(root, request.handoffPaths)
    const previousBaselineHash = task.baselineHash
    task.baselineHash = baseline.baselineHash
    task.baselineHandshake = null
    task.status = 'active'
    task.blockedReason = null
    task.routing.revision += 1
    const result = { taskId: task.taskId, baselineHash: baseline.baselineHash, previousBaselineHash,
      refetchedFiles: baseline.files, freshAimlockSnapshotRequired: true }
    event(request, 'handoff-resumed', result)
    return { state, output: { schemaVersion: TASKS_SCHEMA, ...result, replayed: false },
      audit: [{ event: 'handoff-resumed', taskId: task.taskId, requestId: request.requestId, baselineHash: baseline.baselineHash }] }
  })
}
