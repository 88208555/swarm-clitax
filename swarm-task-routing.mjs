import { randomUUID } from 'node:crypto'
import { withCoordinationState, withCoordinationReadLock } from './swarm-coordinator-fs.mjs'
import { findTask, requireString } from './swarm-coordinator-model.mjs'
import { pendingDecision, hasActiveWait } from './swarm-coordinator-waits.mjs'
import { TASK_HANDOFF_HANDLERS } from './swarm-task-handoff.mjs'
import { TASKS_SCHEMA, REQUEST_SCHEMA, TERMINAL_REQUESTS, routingError, digest, strings, identity,
  describedTask, requests, requestedTask, accessRequest, sourceRequest, targetRequest, event,
  receipt, requestView, deliveryView, initialRouting, normalizeMessage, selectOwner, completionPending } from './swarm-task-routing-model.mjs'

function changed(state, output, type, taskId, requestId = null) {
  return { state, output: { schemaVersion: TASKS_SCHEMA, ...output }, audit: [{ event: type, taskId, requestId }] }
}
export function resumeView(state, task) {
  const routing = task.routing
  const relevant = requests(state)
  const remaining = completionPending(state, task)
  return { ...identity(task), schemaVersion: TASKS_SCHEMA, goal: routing.goal,
    goalDigest: routing.descriptionDigest, goalRevision: routing.revision,
    remainingRequirements: remaining.original, nextAction: routing.nextAction,
    checkpointAt: routing.checkpointAt, status: task.status,
    canContinue: task.status === 'active' && routing.handoff === null
      && !pendingDecision(state, task) && !hasActiveWait(state, task),
    completionAllowed: !remaining.original.length && !remaining.pending.length && routing.handoff === null,
    inbox: relevant.filter(item => item.targetTaskId === task.taskId && !TERMINAL_REQUESTS.has(item.status)).map(requestView),
    outbox: relevant.filter(item => item.sourceTaskId === task.taskId && !TERMINAL_REQUESTS.has(item.status)).map(requestView),
    handoffs: relevant.filter(item => item.handoffTaskId === task.taskId && !TERMINAL_REQUESTS.has(item.status)).map(requestView) }
}
async function describeTask(root, input) {
  return withCoordinationState(root, state => {
    const task = findTask(state, input), routing = initialRouting(input)
    if (task.routing) {
      describedTask(state, input)
      if (task.routing.descriptionDigest !== routing.descriptionDigest) {
        routingError('GOAL_IMMUTABLE', 'a new message cannot replace this task goal, host identity or original requirements')
      }
    } else {
      if (['completed', 'failed', 'reclaimed'].includes(task.status)) routingError('TASK_TERMINAL', 'a terminal task cannot register new work')
      task.routing = routing
    }
    return changed(state, { task: resumeView(state, task) }, 'task-described', task.taskId)
  })
}
async function checkpointTask(root, input) {
  return withCoordinationState(root, state => {
    const task = describedTask(state, input), routing = task.routing
    if (!Number.isSafeInteger(input.expectedRevision) || routing.revision !== input.expectedRevision) {
      routingError('REVISION_CONFLICT', 'reload the current checkpoint before updating it')
    }
    if (task.status !== 'active' || routing.handoff !== null || pendingDecision(state, task) || hasActiveWait(state, task)) {
      routingError('TASK_SUSPENDED', 'a suspended task cannot advance its checkpoint')
    }
    const completed = strings(input.completedRequirementIds, 'completedRequirementIds')
    if (completed.some(id => !routing.requirements.some(item => item.id === id))
      || routing.completedRequirementIds.some(id => !completed.includes(id))) {
      routingError('CHECKPOINT_INVALID', 'completed requirements must belong to the original goal and cannot be silently discarded')
    }
    routing.completedRequirementIds = completed
    routing.nextAction = requireString(input.nextAction, 'nextAction')
    routing.checkpointAt = new Date().toISOString()
    routing.revision += 1
    return changed(state, { task: resumeView(state, task) }, 'task-checkpoint', task.taskId)
  })
}
async function resumeTask(root, input) {
  return withCoordinationReadLock(root, state => resumeView(state, describedTask(state, input)))
}
function newRequest(state, source, message, item) {
  const selected = selectOwner(state, source, item)
  const target = item.forceCurrent ? source : selected.target
  const handoff = item.forceCurrent && selected.target && selected.target.taskId !== source.taskId ? selected.target : null
  const unavailable = target && ['completed', 'failed', 'reclaimed'].includes(target.status)
  const requestId = 'request-' + digest([source.taskId, message.messageId, item.itemId])
  const request = { schemaVersion: REQUEST_SCHEMA, requestId, messageId: message.messageId, itemId: item.itemId,
    messageDigest: digest(message), sourceTaskId: source.taskId, sourceAgentId: source.agentId, sourceChainId: source.chainId,
    ownerId: source.routing.ownerId, projectId: source.routing.projectId, text: item.text, targetPaths: item.targetPaths,
    targetTaskId: target ? target.taskId : null, handoffTaskId: handoff ? handoff.taskId : null,
    forceCurrent: item.forceCurrent, status: unavailable || !target ? 'pending-routing' : handoff ? 'pending-handoff' : 'pending-delivery',
    reason: unavailable ? 'target-task-terminal' : item.forceCurrent ? 'explicit-current-task' : selected.reason,
    candidates: selected.candidates, receiptId: null, deliveryAttempt: null, resultSummary: null,
    createdAt: new Date().toISOString(), acceptedAt: null, completedAt: null, history: [] }
  event(request, 'message-recorded', { source: identity(source), selectedTaskId: request.targetTaskId, reason: request.reason })
  return request
}
async function routeMessage(root, input) {
  return withCoordinationState(root, state => {
    const source = describedTask(state, input), message = normalizeMessage(input)
    if (['completed', 'failed', 'reclaimed'].includes(source.status)) routingError('TASK_TERMINAL', 'resume or register a follow-up before submitting new work')
    const existing = requests(state).filter(item => item.sourceTaskId === source.taskId && item.messageId === message.messageId)
    if (existing.length && (existing.length !== message.items.length || existing.some(item => item.messageDigest !== digest(message)))) {
      routingError('MESSAGE_CONFLICT', 'this message ID already has different content or routing instructions; use explicit resolution')
    }
    const recorded = existing.length ? existing : message.items.map(item => newRequest(state, source, message, item))
    if (!existing.length) state.messages.push(...recorded)
    const deliveries = recorded.filter(item => item.status === 'pending-delivery').map(item => deliveryView(state, item))
    return changed(state, { messageId: message.messageId, source: identity(source), replayed: existing.length > 0,
      requests: recorded.map(requestView), deliveries, continuation: resumeView(state, source) }, 'message-routed', source.taskId)
  })
}
async function messageStatus(root, input) {
  return withCoordinationReadLock(root, state => {
    const task = describedTask(state, input), request = accessRequest(state, task, input.requestId)
    return { schemaVersion: TASKS_SCHEMA, request: requestView(request), receipt: receipt(request) }
  })
}
async function startDelivery(root, input) {
  return withCoordinationState(root, state => {
    const { task, request } = sourceRequest(state, input)
    let claimed = false
    if (request.status === 'pending-delivery' && request.deliveryAttempt === null) {
      request.deliveryAttempt = { attemptId: 'delivery-' + randomUUID(), startedAt: new Date().toISOString(),
        status: 'started', errorCode: null, errorMessage: null }
      event(request, 'delivery-started', { attemptId: request.deliveryAttempt.attemptId })
      claimed = true
    }
    return changed(state, { claimed, attemptId: request.deliveryAttempt === null ? null : request.deliveryAttempt.attemptId,
      request: requestView(request) }, 'delivery-claim', task.taskId, request.requestId)
  })
}
async function reportDelivery(root, input) {
  return withCoordinationState(root, state => {
    const { task, request } = sourceRequest(state, input)
    const errorCode = requireString(input.errorCode, 'errorCode'), errorMessage = requireString(input.errorMessage, 'errorMessage')
    if (request.deliveryAttempt === null) routingError('DELIVERY_NOT_STARTED', 'cannot report an unclaimed delivery')
    request.deliveryAttempt.status = request.receiptId === null ? 'uncertain' : 'received'
    request.deliveryAttempt.errorCode = errorCode
    request.deliveryAttempt.errorMessage = errorMessage
    event(request, 'delivery-reported', { attemptId: request.deliveryAttempt.attemptId, errorCode, errorMessage })
    return changed(state, { request: requestView(request), receipt: receipt(request) }, 'delivery-reported', task.taskId, request.requestId)
  })
}
function checkTargetScope(task, request) {
  if (!request.targetPaths.every(path => task.taskScope.some(scope => path === scope || path.startsWith(scope + '/')))) {
    routingError('SCOPE_REQUIRED', 'the target must approve an updated task scope before accepting these paths')
  }
}
async function acceptMessage(root, input) {
  return withCoordinationState(root, state => {
    const { task, request } = targetRequest(state, input)
    if (request.receiptId !== null) return changed(state, { ...receipt(request), status: request.status }, 'message-accept-replayed', task.taskId, request.requestId)
    if (request.status !== 'pending-delivery') routingError('DELIVERY_NOT_READY', 'resolve ownership and complete any handoff before accepting')
    if (!resumeView(state, task).canContinue) routingError('TASK_SUSPENDED', 'target task is not ready to accept work')
    checkTargetScope(task, request)
    request.receiptId = 'receipt-' + randomUUID()
    request.acceptedAt = new Date().toISOString()
    request.status = 'accepted'
    if (request.deliveryAttempt !== null) request.deliveryAttempt.status = 'received'
    event(request, 'message-accepted', { ...identity(task), receiptId: request.receiptId })
    return changed(state, { ...receipt(request), status: 'accepted' }, 'message-accepted', task.taskId, request.requestId)
  })
}
async function resolveMessage(root, input) {
  return withCoordinationState(root, state => {
    const { task, request } = sourceRequest(state, input)
    const target = requestedTask(state, task, input.targetTaskId)
    const userMessageId = requireString(input.userMessageId, 'userMessageId'), userText = requireString(input.userText, 'userText')
    const previous = request.history.find(entry => entry.type === 'user-resolution' && entry.details.userMessageId === userMessageId)
    if (previous) {
      if (previous.details.targetTaskId !== target.taskId || previous.details.userText !== userText) routingError('MESSAGE_CONFLICT', 'resolution ID was already used with different content')
      return changed(state, { request: requestView(request) }, 'message-resolution-replayed', task.taskId, request.requestId)
    }
    if (request.status !== 'pending-routing' || request.receiptId !== null || request.deliveryAttempt !== null) routingError('ALREADY_ROUTED', 'an active delivery cannot be silently redirected')
    if (['completed', 'failed', 'reclaimed'].includes(target.status)) routingError('TASK_TERMINAL', 'select an active follow-up task')
    request.targetTaskId = target.taskId
    request.status = 'pending-delivery'
    request.reason = 'explicit-user-resolution'
    event(request, 'user-resolution', { userMessageId, userText, targetTaskId: target.taskId })
    return changed(state, { request: requestView(request), delivery: deliveryView(state, request) }, 'message-resolved', task.taskId, request.requestId)
  })
}
export const TASK_ROUTING_HANDLERS = Object.freeze({
  'task-describe': describeTask, 'task-checkpoint': checkpointTask, 'task-resume': resumeTask,
  'message-route': routeMessage, 'message-status': messageStatus, 'message-delivery-start': startDelivery,
  'message-delivery-report': reportDelivery, 'message-accept': acceptMessage, 'message-resolve': resolveMessage,
  ...TASK_HANDOFF_HANDLERS,
})
