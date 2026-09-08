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
