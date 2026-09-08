import { createHash } from 'node:crypto'
import { coordinatorError, identifier, relativePath } from './swarm-coordinator-fs.mjs'
import { findTask, requireString } from './swarm-coordinator-model.mjs'

export const ROUTING_SCHEMA = 'swarm.task-routing/1.0'
export const REQUEST_SCHEMA = 'swarm.task-request/1.0'
export const TASKS_SCHEMA = 'swarm.task-message-result/1.0'
export const MAX_MESSAGE_LENGTH = 100_000
export const MAX_MESSAGE_ITEMS = 50
export const TERMINAL_REQUESTS = new Set(['completed', 'rejected'])
const MATCH_SIGNAL_MINIMUM = 2
const IDENTITY_FIELDS = ['taskId', 'agentId', 'chainId']

export function routingError(code, message) { coordinatorError('SWARM_ROUTING_' + code, message) }
export function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
export function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || keys.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !keys.includes(key))) {
    routingError('INPUT_INVALID', label + ' has missing or unsupported fields')
  }
  return value
}
export function strings(value, label) {
  if (!Array.isArray(value) || value.length > MAX_MESSAGE_ITEMS) routingError('INPUT_INVALID', label + ' must be a bounded array')
  const values = value.map(item => requireString(item, label))
  if (new Set(values).size !== values.length) routingError('INPUT_INVALID', label + ' contains duplicates')
  return values
}
export function identity(task) { return Object.fromEntries(IDENTITY_FIELDS.map(key => [key, task[key]])) }
export function describedTask(state, input) {
  const task = findTask(state, input)
  if (!task.routing || task.routing.schemaVersion !== ROUTING_SCHEMA) {
    routingError('TASK_UNDESCRIBED', 'register the task goal and host identity before routing messages')
  }
  return task
}
export function requests(state) { return state.messages.filter(message => message.schemaVersion === REQUEST_SCHEMA) }
export function visibleTo(source, task) {
  return task.routing && task.routing.schemaVersion === ROUTING_SCHEMA
    && task.routing.ownerId === source.routing.ownerId && task.routing.projectId === source.routing.projectId
}
export function requestedTask(state, source, taskId) {
  const task = state.tasks.find(entry => entry.taskId === identifier(taskId, 'targetTaskId'))
  if (!task || !visibleTo(source, task)) routingError('TARGET_UNAVAILABLE', 'target task is outside this registered collaboration scope')
  return task
}
export function accessRequest(state, task, requestId) {
  const request = requests(state).find(entry => entry.requestId === identifier(requestId, 'requestId'))
  if (!request || request.ownerId !== task.routing.ownerId || request.projectId !== task.routing.projectId
    || ![request.sourceTaskId, request.targetTaskId, request.handoffTaskId].includes(task.taskId)) {
    routingError('REQUEST_UNAVAILABLE', 'request is not available to this task')
  }
  return request
}
export function sourceRequest(state, input) {
  const task = describedTask(state, input), request = accessRequest(state, task, input.requestId)
  if (request.sourceTaskId !== task.taskId) routingError('SOURCE_REQUIRED', 'only the source task can coordinate this delivery')
  return { task, request }
}
export function targetRequest(state, input) {
  const task = describedTask(state, input), request = accessRequest(state, task, input.requestId)
  if (request.targetTaskId !== task.taskId) routingError('TARGET_REQUIRED', 'only the assigned task can accept or complete this request')
  return { task, request }
}
export function event(request, type, details) {
  request.history.push({ type, details, recordedAt: new Date().toISOString() })
}
export function receipt(request) {
  return request.receiptId === null ? null : {
    requestId: request.requestId, receiptId: request.receiptId, targetTaskId: request.targetTaskId,
  }
}
export function requestView(request) {
  return { requestId: request.requestId, messageId: request.messageId, itemId: request.itemId,
    text: request.text, sourceTaskId: request.sourceTaskId, targetTaskId: request.targetTaskId,
    handoffTaskId: request.handoffTaskId, status: request.status, reason: request.reason,
    candidates: request.candidates, receipt: receipt(request), deliveryAttempt: request.deliveryAttempt,
    resultSummary: request.resultSummary }
}
export function deliveryView(state, request) {
  const target = state.tasks.find(task => task.taskId === request.targetTaskId)
  if (!target || !target.routing) routingError('TARGET_UNAVAILABLE', 'delivery target registration is missing')
  return { requestId: request.requestId, messageId: request.messageId, itemId: request.itemId,
    text: request.text, targetTaskId: target.taskId, targetAgentId: target.agentId, targetChainId: target.chainId,
    targetHostId: target.routing.hostId, targetThreadId: target.routing.threadId, status: request.status }
}
export function initialRouting(input) {
  const keys = ['ownerId', 'projectId', 'hostId', 'threadId', 'goal', 'keywords', 'requirements']
  const description = Object.fromEntries(keys.map(key => [key, input[key]]))
  for (const key of ['ownerId', 'projectId', 'hostId', 'threadId']) identifier(description[key], key)
  description.goal = requireString(description.goal, 'goal')
  description.keywords = strings(description.keywords, 'keywords')
  if (!Array.isArray(description.requirements) || !description.requirements.length
    || description.requirements.length > MAX_MESSAGE_ITEMS) routingError('INPUT_INVALID', 'original requirements are required')
  description.requirements = description.requirements.map(requirement => {
    exactObject(requirement, ['id', 'text'], 'requirement')
    return { id: identifier(requirement.id, 'requirementId'), text: requireString(requirement.text, 'requirement text') }
  })
  if (new Set(description.requirements.map(item => item.id)).size !== description.requirements.length) {
    routingError('INPUT_INVALID', 'original requirement IDs must be unique')
  }
  return { schemaVersion: ROUTING_SCHEMA, ...description, descriptionDigest: digest(description), revision: 1,
    completedRequirementIds: [], nextAction: description.goal, checkpointAt: new Date().toISOString(), handoff: null }
}
export function normalizeMessage(input) {
  identifier(input.messageId, 'messageId')
  if (input.origin !== 'user') routingError('USER_EVENT_REQUIRED', 'documents and tool outputs cannot issue task-routing instructions')
  const text = requireString(input.text, 'message text')
  if (text.length > MAX_MESSAGE_LENGTH || !Array.isArray(input.items) || !input.items.length
    || input.items.length > MAX_MESSAGE_ITEMS) routingError('INPUT_INVALID', 'message or item count exceeds the protocol limit')
  let coveredUntil = 0
  const items = input.items.map(item => {
    exactObject(item, ['itemId', 'text', 'explicitTaskId', 'forceCurrent', 'targetPaths'], 'message item')
    identifier(item.itemId, 'itemId')
    const content = requireString(item.text, 'item text')
    const start = text.indexOf(content, coveredUntil)
    if (start < 0) routingError('CONTENT_MISMATCH', 'items must quote the original message in order without overlap')
    if (/\S/u.test(text.slice(coveredUntil, start))) routingError('CONTENT_INCOMPLETE', 'extracted items must cover every non-whitespace part of the original message')
    coveredUntil = start + content.length
    if (typeof item.forceCurrent !== 'boolean') routingError('INPUT_INVALID', 'forceCurrent must be an explicit boolean')
    if (item.explicitTaskId !== null) identifier(item.explicitTaskId, 'explicitTaskId')
    return { ...item, text: content, targetPaths: strings(item.targetPaths, 'targetPaths').map(path => relativePath(path)) }
  })
  if (/\S/u.test(text.slice(coveredUntil))) routingError('CONTENT_INCOMPLETE', 'extracted items omit part of the original user message')
  if (new Set(items.map(item => item.itemId)).size !== items.length) routingError('INPUT_INVALID', 'item IDs must be unique')
  return { messageId: input.messageId, origin: input.origin, text, items }
}
function overlap(left, right) { return left === right || left.startsWith(right + '/') || right.startsWith(left + '/') }
function containsKeyword(text, keyword) {
  const normalized = text.toLocaleLowerCase(), term = keyword.toLocaleLowerCase()
  if (/[\u3400-\u9fff]/u.test(term)) return normalized.includes(term)
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp('(?:^|[^\\p{L}\\p{N}_])' + escaped + '(?:$|[^\\p{L}\\p{N}_])', 'u').test(normalized)
}
export function selectOwner(state, source, item) {
  if (item.explicitTaskId !== null) {
    const explicit = requestedTask(state, source, item.explicitTaskId)
    return { target: explicit, reason: 'explicit-task', candidates: [explicit.taskId] }
  }
  const candidates = state.tasks.filter(task => visibleTo(source, task)
    && !['completed', 'failed', 'reclaimed'].includes(task.status)).map(task => {
    const keywords = task.routing.keywords.filter(keyword => containsKeyword(item.text, keyword))
    const paths = item.targetPaths.filter(path => task.taskScope.some(scope => overlap(path, scope)))
    return { task, keywords, paths, signals: keywords.length + (paths.length ? 1 : 0) }
  }).filter(candidate => candidate.keywords.length > 0 && candidate.signals >= MATCH_SIGNAL_MINIMUM)
  if (candidates.length !== 1) return { target: null, reason: candidates.length ? 'ambiguous-ownership' : 'ownership-unresolved',
    candidates: candidates.map(candidate => candidate.task.taskId) }
  return { target: candidates[0].task, reason: 'unique-goal-and-scope-evidence', candidates: [candidates[0].task.taskId] }
}
export function completionPending(state, task) {
  const original = task.routing.requirements.filter(item => !task.routing.completedRequirementIds.includes(item.id))
  const pending = requests(state).filter(request => !TERMINAL_REQUESTS.has(request.status)
    && (request.targetTaskId === task.taskId || (request.sourceTaskId === task.taskId && request.receiptId === null)))
  return { original, pending }
}
export function assertTaskRequestsCompleted(state, task) {
  if (!task.routing) return
  if (task.routing.schemaVersion !== ROUTING_SCHEMA) routingError('STATE_INVALID', 'unknown task routing schema')
  const remaining = completionPending(state, task)
  if (remaining.original.length || remaining.pending.length || task.routing.handoff !== null) {
    routingError('TASK_INCOMPLETE', 'original requirements or routed requests remain unfinished')
  }
}
