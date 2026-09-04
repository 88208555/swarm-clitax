import { randomUUID } from 'node:crypto'
import { coordinatorError, identifier, readCoordinationState, withCoordinationState } from './swarm-coordinator-fs.mjs'
import { coordinationMessage, detectWaitCycles, findTask, normalizeWait, requireString, requireTaskStatus } from './swarm-coordinator-model.mjs'

const LOCAL_SCHEMA = 'swarm.coordinator-local/1.0'
const WAIT_POLL_MS = 250
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'reclaimed'])

function pendingDecision(state, task) {
  return state.decisions.some((decision) => decision.status === 'pending' && decision.agents.includes(task.agentId))
}

function hasActiveWait(state, task) {
  return state.waits.some((wait) => wait.taskId === task.taskId && wait.status === 'active')
}

function assertTaskRunnable(state, task) {
  if (task.status !== 'active' || hasActiveWait(state, task) || pendingDecision(state, task)) {
    coordinatorError('SWARM_COORD_TASK_BLOCKED', 'task must resolve its dependencies and human decisions before execution')
  }
}

function addMessage(state, type, from, to, payload, now) {
  const message = coordinationMessage(type, from, to, payload, now)
  state.messages.push(message)
  return message
}

function eventRecord(publisher, event, payload, now) {
  return { schemaVersion: 'swarm.coord-event/1.0', eventId: 'event-' + randomUUID(), publisher, event, payload, publishedAt: now }
}

function wakeWait(state, wait, resolution, event, now) {
  wait.status = resolution
  wait.resolvedAt = now
  wait.resolution = event
  const task = state.tasks.find((item) => item.taskId === wait.taskId)
  if (task && task.status === 'waiting' && !hasActiveWait(state, task) && !pendingDecision(state, task)) {
    task.status = 'active'
    task.updatedAt = now
  }
  if (resolution === 'event-received') {
    const entry = state.timeoutCounts.find((item) => item.waiter === wait.waiter)
    if (entry) entry.count = 0
  }
  const wakePackage = { schemaVersion: 'swarm.wake-package/1.0', waitId: wait.waitId, reason: resolution,
    event, refetchPaths: wait.refetchPaths, createdAt: now }
  addMessage(state, 'dependency-wait', 'coordinator', wait.waiter, wakePackage, now)
  return wakePackage
}

function routeEvent(state, event) {
  return state.waits.filter((wait) => wait.status === 'active' && wait.waitFor === event.publisher && wait.event === event.event)
    .map((wait) => wakeWait(state, wait, 'event-received', event, event.publishedAt))
}

function confirmationRequest(decision) {
  const options = decision.agents.map((agentId) => ({ id: 'resume:' + agentId, label: '先恢复 ' + agentId, hint: '唤醒该智能体先解除依赖' }))
  options.push({ id: 'abort', label: '终止等待', hint: '终止相关等待并保持任务阻塞' })
  return { schemaVersion: 'confirm-protocol.skill.request/1.0', requestId: 'confirm-' + decision.decisionId,
    operation: 'interaction-request', input: { interaction: {
      schemaVersion: 'confirm.interaction/1.0', requestId: decision.decisionId, type: 'choice', question: decision.question,
      options, default: null, timeout: null, timeoutAction: 'wait', risk: 'high', riskDescription: decision.riskDescription,
      rememberable: false, memoryKey: '', callback: { operation: 'resolve-human', payload: { decisionId: decision.decisionId } },
    } } }
}

function createDecision(state, kind, agents, waitIds, question, riskDescription, now) {
  const decision = { schemaVersion: 'swarm.coord-decision/1.0', decisionId: 'decision-' + randomUUID(),
    kind, agents: [...new Set(agents)], waitIds: [...new Set(waitIds)], question, riskDescription,
    status: 'pending', answer: null, actorId: null, createdAt: now, resolvedAt: null }
  state.decisions.push(decision)
  for (const task of state.tasks.filter((item) => agents.includes(item.agentId) && !TERMINAL_STATUSES.has(item.status))) {
    task.status = 'blocked'
    task.blockedReason = 'human-decision'
    task.updatedAt = now
  }
  const waits = state.waits.filter((wait) => waitIds.includes(wait.waitId))
    .map(({ waitId, waiter, waitFor, event, purpose, deadlineAt }) => ({ waitId, waiter, waitFor, event, purpose, deadlineAt }))
  addMessage(state, 'need-human', 'coordinator', 'human', { decisionId: decision.decisionId, kind, agents, waits }, now)
  return { decision, status: 'blocked', confirmationRequired: true, confirmProtocolRequest: confirmationRequest(decision),
    nextStep: { operation: 'confirm-protocol', instruction: 'Invoke Confirm Protocol and wait for the human answer.' } }
}

function applyCycles(state, now) {
  const requests = []
  for (const cycle of detectWaitCycles(state.waits)) {
    const agents = cycle.slice(0, -1)
    const waits = state.waits.filter((wait) => wait.status === 'active' && agents.includes(wait.waiter) && agents.includes(wait.waitFor))
    if (!waits.length) continue
    requests.push(createDecision(state, 'dependency-cycle', agents, waits.map((wait) => wait.waitId),
      '检测到依赖等待成环：' + agents.join(' → ') + '。请选择先恢复的智能体。',
      '依赖成环会导致全部相关任务无限等待，必须由真人决定执行顺序。', now))
    const dependencies = waits.map(({ waiter, waitFor, event, purpose }) => ({ waiter, waitFor, event, purpose }))
    for (const wait of waits) wakeWait(state, wait, 'deadlock-interrupted', { cycle, dependencies }, now)
  }
  return requests
}

function replayDependency(state, task, wait) {
  const consumed = new Set(state.waits.filter((item) => item.taskId === task.taskId && item.resolution?.eventId)
    .map((item) => item.resolution.eventId))
  const event = state.events.findLast((item) => item.publisher === wait.waitFor && item.event === wait.event
    && Date.parse(item.publishedAt) >= Date.parse(task.registeredAt) && !consumed.has(item.eventId))
  if (event) return [wakeWait(state, wait, 'event-received', event, wait.startedAt)]
  const targets = state.tasks.filter((item) => item.agentId === wait.waitFor)
  if (targets.every((item) => TERMINAL_STATUSES.has(item.status))) {
    return [wakeWait(state, wait, 'dependency-terminated', {
      event: 'task-terminated', publisher: wait.waitFor, payload: { tasks: targets.map(({ taskId, status }) => ({ taskId, status })) },
      publishedAt: wait.startedAt,
    }, wait.startedAt)]
  }
  return []
}

async function dependencyWait(repositoryRoot, input) {
  return withCoordinationState(repositoryRoot, async (state) => {
    const task = findTask(state, { taskId: input.taskId, agentId: input.waiter, chainId: input.chainId })
    if (TERMINAL_STATUSES.has(task.status) || pendingDecision(state, task)) {
      coordinatorError('SWARM_COORD_TASK_BLOCKED', 'terminated tasks and pending human decisions cannot declare new dependencies')
    }
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
    const wakePackages = replayDependency(state, task, wait)
    const decisions = applyCycles(state, wait.startedAt)
    return { state, output: { schemaVersion: LOCAL_SCHEMA, wait, suspended: wait.status === 'active', decisions, wakePackages,
      nextStep: wait.status === 'active' ? { operation: 'wait-for-event', input: { taskId: task.taskId,
        agentId: task.agentId, chainId: task.chainId, waitId: wait.waitId } } : null },
      audit: [{ event: 'dependency-wait', waitId: wait.waitId, waiter: wait.waiter, waitFor: wait.waitFor }] }
  })
}

async function publishEvent(repositoryRoot, input) {
  return withCoordinationState(repositoryRoot, async (state) => {
    const publisher = identifier(input.publisher, 'publisher')
    if (!state.tasks.some((task) => task.agentId === publisher)) coordinatorError('SWARM_COORD_WAIT_TARGET_UNKNOWN', 'publisher must be registered')
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
  const others = state.tasks.some((item) => item.agentId === task.agentId && !TERMINAL_STATUSES.has(item.status))
  if (others) return []
  return state.waits.filter((wait) => wait.status === 'active' && wait.waitFor === task.agentId)
    .map((wait) => wakeWait(state, wait, 'dependency-terminated', {
      event: 'task-terminated', publisher: task.agentId, payload: { taskId: task.taskId, status: task.status }, publishedAt: now,
    }, now))
}

async function taskStatus(repositoryRoot, input) {
  return withCoordinationState(repositoryRoot, async (state) => {
    const task = findTask(state, input)
    const status = requireTaskStatus(input.status)
    if (TERMINAL_STATUSES.has(task.status) && task.status !== status) {
      coordinatorError('SWARM_COORD_TASK_TERMINATED', 'terminal task cannot be restarted; register a new task')
    }
    if (status === 'active' && (pendingDecision(state, task) || hasActiveWait(state, task) || task.status === 'blocked')) {
      coordinatorError('SWARM_COORD_TASK_BLOCKED', 'resolve dependencies or the human decision before activation')
    }
    const now = new Date().toISOString()
    const undeclaredWait = status === 'waiting' && !hasActiveWait(state, task)
    task.status = undeclaredWait ? 'blocked' : status
    if (undeclaredWait) task.blockedReason = 'undeclared-wait'
    task.updatedAt = now
    const declarationMessage = undeclaredWait
      ? addMessage(state, 'dependency-wait', 'coordinator', task.agentId, { status: 'declaration-required', taskId: task.taskId }, now) : null
    const wakePackages = []
    if (TERMINAL_STATUSES.has(status)) {
      for (const wait of state.waits.filter((item) => item.taskId === task.taskId && item.status === 'active')) {
        wakePackages.push(wakeWait(state, wait, 'waiter-terminated', { taskId: task.taskId, status }, now))
      }
      if (status === 'completed') {
        const event = eventRecord(task.agentId, 'task-completed', { taskId: task.taskId, status }, now)
        state.events.push(event)
        wakePackages.push(...routeEvent(state, event))
      }
      wakePackages.push(...notifyDeadTask(state, task, now))
    }
    return { state, output: { schemaVersion: LOCAL_SCHEMA, task, undeclaredWait, declarationMessage, wakePackages },
      audit: [{ event: 'task-status', taskId: task.taskId, status: task.status }] }
  })
}

function updateTimeoutCount(state, waiter) {
  let entry = state.timeoutCounts.find((item) => item.waiter === waiter)
  if (!entry) { entry = { waiter, count: 0 }; state.timeoutCounts.push(entry) }
  entry.count += 1
  return entry.count
}

function applyTimeouts(state, now) {
  const timedOut = state.waits.filter((wait) => wait.status === 'active' && Date.parse(wait.deadlineAt) <= Date.parse(now))
  const decisions = [], wakePackages = []
  for (const wait of timedOut) {
    const count = updateTimeoutCount(state, wait.waiter)
    if (wait.onTimeout === 'escalate-need-human' || count >= 2) {
      decisions.push(createDecision(state, 'dependency-timeout', [wait.waiter, wait.waitFor], [wait.waitId],
        wait.waiter + ' 等待 ' + wait.waitFor + ' 的 ' + wait.event + ' 已超时，请选择后续动作。',
        '依赖事件未在声明期限内到达，继续静默等待可能导致任务停滞。', now))
      wakePackages.push(wakeWait(state, wait, 'timeout-interrupted', { timeoutCount: count }, now))
    } else {
      const resolution = wait.onTimeout === 'abandon-wait' ? 'timeout-abandoned' : 'timeout-continued'
      wakePackages.push(wakeWait(state, wait, resolution, { timeoutCount: count }, now))
    }
  }
  return { timedOut, decisions, wakePackages }
}

async function resolveHuman(repositoryRoot, input) {
  return withCoordinationState(repositoryRoot, async (state) => {
    const decisionId = identifier(input.decisionId, 'decisionId')
    const decision = state.decisions.find((item) => item.decisionId === decisionId)
    if (!decision || decision.status !== 'pending') coordinatorError('SWARM_COORD_DECISION_NOT_PENDING', 'decision is not pending')
    const answer = requireString(input.answer, 'answer')
    if (![...decision.agents.map((agent) => 'resume:' + agent), 'abort'].includes(answer)) {
      coordinatorError('SWARM_COORD_DECISION_ANSWER_INVALID', 'answer is not a declared option')
    }
    const now = new Date().toISOString()
    decision.status = 'resolved'
    decision.answer = answer
    decision.actorId = identifier(input.actorId, 'actorId')
    decision.resolvedAt = now
    for (const task of state.tasks.filter((item) => answer === 'resume:' + item.agentId && !TERMINAL_STATUSES.has(item.status))) {
      if (!pendingDecision(state, task)) {
        task.status = hasActiveWait(state, task) ? 'waiting' : 'active'
        task.blockedReason = null
        task.updatedAt = now
      }
    }
    return { state, output: { schemaVersion: LOCAL_SCHEMA, decision },
      audit: [{ event: 'decision-resolved', decisionId, answer, actorId: decision.actorId }] }
  })
}

async function cancelWait(repositoryRoot, input) {
  return withCoordinationState(repositoryRoot, async (state) => {
    const task = findTask(state, input)
    const wait = state.waits.find((item) => item.waitId === identifier(input.waitId, 'waitId') && item.taskId === task.taskId)
    if (!wait || wait.status !== 'active') coordinatorError('SWARM_COORD_WAIT_NOT_ACTIVE', 'wait is not active for this task')
    const reason = requireString(input.reason, 'reason')
    const wakePackage = wakeWait(state, wait, 'cancelled', { reason, actorId: task.agentId }, new Date().toISOString())
    return { state, output: { schemaVersion: LOCAL_SCHEMA, wait, wakePackage }, audit: [{ event: 'wait-cancelled', waitId: wait.waitId, reason }] }
  })
}

async function waitForEvent(repositoryRoot, input, tick) {
  const waitId = identifier(input.waitId, 'waitId')
  while (true) {
    const before = await readCoordinationState(repositoryRoot)
    const task = findTask(before, input)
    const wait = before.waits.find((item) => item.waitId === waitId && item.taskId === task.taskId)
    if (!wait) coordinatorError('SWARM_COORD_WAIT_NOT_FOUND', 'wait is not registered for this task')
    const pending = before.decisions.filter((item) => item.status === 'pending' && item.agents.includes(task.agentId))
    if (wait.status === 'active' && pending.length) return { schemaVersion: LOCAL_SCHEMA, status: 'blocked',
      wait, wakePackage: null, decisions: pending, confirmProtocolRequests: pending.map(confirmationRequest) }
    if (wait.status !== 'active') {
      const message = before.messages.findLast((item) => item.payload.waitId === waitId && item.payload.schemaVersion === 'swarm.wake-package/1.0')
      if (!message) coordinatorError('SWARM_COORD_WAKE_PACKAGE_MISSING', 'resolved wait has no wake package')
      const decisions = before.decisions.filter((item) => item.status === 'pending' && item.agents.includes(task.agentId))
      return { schemaVersion: LOCAL_SCHEMA, status: decisions.length || task.status !== 'active' ? 'blocked' : 'resolved',
        wait, wakePackage: message.payload, decisions, confirmProtocolRequests: decisions.map(confirmationRequest) }
    }
    await tick(repositoryRoot, { now: new Date().toISOString() })
    await new Promise((accept) => setTimeout(accept, Math.min(WAIT_POLL_MS, Math.max(1, Date.parse(wait.deadlineAt) - Date.now()))))
  }
}

export { addMessage, eventRecord, routeEvent, createDecision, applyCycles, applyTimeouts, assertTaskRunnable,
  pendingDecision, hasActiveWait, dependencyWait, publishEvent, taskStatus, resolveHuman, cancelWait, waitForEvent }
