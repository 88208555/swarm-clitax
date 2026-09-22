const string = { type: 'string', minLength: 1 }
const strings = { type: 'array', items: string }
const object = (required, properties) => ({ type: 'object', additionalProperties: false, required, properties })
const identity = { taskId: string, agentId: string, chainId: string }
const fields = (properties) => object(Object.keys(properties), properties)
const request = { ...identity, requestId: string }
export const TASK_ROUTING_SCHEMAS = Object.freeze({
  'task-describe': fields({ ...identity, ownerId: string, projectId: string, hostId: string, threadId: string,
    goal: string, keywords: strings, requirements: { type: 'array', items: fields({ id: string, text: string }) } }),
  'task-checkpoint': fields({ ...identity, expectedRevision: { type: 'integer', minimum: 1 },
    completedRequirementIds: strings, nextAction: string }),
  'task-resume': fields(identity),
  'peer-coordinate': fields({ ...identity, intentId: string, paths: { ...strings, minItems: 1 },
    baselineHash: string, priority: { enum: ['background', 'normal', 'high', 'urgent'] },
    intentTtlMs: { type: 'integer', minimum: 1, maximum: 3_600_000 },
    coordinationTimeoutMs: { type: 'integer', minimum: 1, maximum: 3_600_000 },
    leaseTtlSeconds: { type: 'integer', minimum: 1, maximum: 3_600 } }),
  'peer-status': fields({ ...identity, intentId: string }),
  'peer-spawn-bind': fields({ ...identity, intentId: string, spawnRequestId: string,
    spawnedTaskId: string, spawnedAgentId: string, spawnedChainId: string }),
  'peer-complete': fields({ ...identity, intentId: string, resultSummary: string }),
  'message-route': fields({ ...identity, messageId: string, origin: { const: 'user' }, text: string,
    items: { type: 'array', items: fields({ itemId: string, text: string, explicitTaskId: { type: ['string', 'null'] },
      forceCurrent: { type: 'boolean' }, targetPaths: strings }) } }),
  'message-status': fields(request),
  'message-delivery-start': fields(request),
  'message-delivery-report': fields({ ...request, errorCode: string, errorMessage: string }),
  'message-accept': fields(request),
  'message-complete': fields({ ...request, resultSummary: string }),
  'message-resolve': fields({ ...request, targetTaskId: string, userMessageId: string, userText: string }),
  'handoff-resume': fields(request),
  'handoff-release': fields({ ...request, checkpointSummary: string }),
})
