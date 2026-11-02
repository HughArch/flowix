import { ErrorCode, RpcError } from './json-rpc.js'

const thread = { id: 'threadId', schedule: 'thread' }
const session = { id: ['sessionId', 'threadId'], schedule: 'thread' }

/** Single protocol catalog used for validation, scheduling metadata and future documentation generation. */
export const METHOD_SCHEMAS = Object.freeze({
  'thread/start': { schedule: 'connection' },
  'thread/resume': thread,
  'thread/read': thread,
  'thread/list': { schedule: 'read', limits: { limit: 200 } },
  'thread/fork': thread,
  'thread/turns/list': { ...thread, limits: { limit: 200 }, enums: { itemsView: ['notLoaded', 'summary', 'full'] } },
  'thread/events/list': { ...thread, limits: { limit: 1000 } },
  'thread/close': thread,
  'thread/archive': thread,
  'turn/start': thread,
  'turn/steer': thread,
  'turn/interrupt': thread,
  'thread/command': { ...thread, strings: ['command'] },
  'thread/skills': thread,
  'skills/list': { schedule: 'read', limits: { limit: 200 } },
  'skills/config/write': { schedule: 'config' },
  'skills/extraRoots/set': { schedule: 'config' },
  'config/read': { schedule: 'read' },
  'config/value/write': { schedule: 'config' },
  'config/batchWrite': { schedule: 'config' },
  'configRequirements/read': { schedule: 'read' },
  'mcpServerStatus/list': { schedule: 'read', limits: { limit: 200 }, enums: { detail: ['full', 'toolsAndAuthOnly'] } },
  'mcpServer/refresh': { schedule: 'mcp' },
  'config/mcpServer/reload': { schedule: 'mcp' },
  'mcpServer/oauth/login': { schedule: 'mcp', strings: ['name'] },
  'mcpServer/tool/call': { id: 'threadId', schedule: 'thread', strings: ['server', 'tool'] },
  'mcpServer/resource/read': { schedule: 'read', strings: ['server', 'uri'] },
  'mcp/resource/read': { schedule: 'read', strings: ['server', 'uri'] },
  'thread/subagent/spawn': { id: 'parentThreadId', schedule: 'thread' },
  'thread/subagent/list': { id: 'parentThreadId', schedule: 'read' },
  'thread/subagent/send': { id: 'childThreadId', schedule: 'thread' },
  'thread/subagent/resume': { id: 'childThreadId', schedule: 'thread' },
  'thread/subagent/interrupt': { id: 'childThreadId', schedule: 'thread' },
  'thread/subagent/wait': { id: 'childThreadId', schedule: 'read' },
  'thread/subagent/close': { id: 'childThreadId', schedule: 'thread' },
  'thread/goal/get': thread,
  'thread/goal/set': thread,
  'thread/goal/clear': thread,
  'thread/approvalPolicy/read': thread,
  'thread/approvalPolicy/write': { ...thread, strings: ['policy'] },
  'session/flush': session,
  'session/ensure': session,
  'session/prompt': session,
  'session/history': { ...session, limits: { limit: 200 } },
  'session/dispose': session,
  'run/cancel': session,
  'model/catalog': { schedule: 'read' },
  'model/discover': { schedule: 'read' },
  'model/config/read': { schedule: 'read' },
  'model/config/upsert': { schedule: 'model-config', strings: ['route'], object: 'profile' },
  'model/config/remove': { schedule: 'model-config', strings: ['route'] },
  'credential/read': { schedule: 'credential', strings: ['reference'] },
  'credential/set': { schedule: 'credential', strings: ['reference', 'value'] },
  'credential/unset': { schedule: 'credential', strings: ['reference'] },
  'runtime/capabilities': { schedule: 'read' },
  'runtime/status': { schedule: 'read' },
  'flownote/jobs/list': thread,
  'flownote/session/usage': session,
  'flownote/plugins/list': { schedule: 'read' },
  'flownote/runtime/profile': { schedule: 'read' },
})

function invalid(message, field) { throw new RpcError(ErrorCode.invalidParams, message, { kind: 'invalid_input', field }) }
function first(params, field) {
  return Array.isArray(field) ? field.map(name => params[name]).find(Boolean) : params[field]
}

export function methodSchedule(method) { return METHOD_SCHEMAS[method]?.schedule || 'read' }

export function validateMethodParams(method, params) {
  const schema = METHOD_SCHEMAS[method]
  if (!schema) return params
  if (schema.id) {
    const value = first(params, schema.id)
    if (typeof value !== 'string' || !value) invalid(`${Array.isArray(schema.id) ? schema.id[0] : schema.id} must be a non-empty string`, Array.isArray(schema.id) ? schema.id[0] : schema.id)
  }
  for (const field of schema.strings || []) {
    if (typeof params[field] !== 'string' || !params[field]) invalid(`${field} must be a non-empty string`, field)
  }
  if (schema.object && (!params[schema.object] || typeof params[schema.object] !== 'object' || Array.isArray(params[schema.object]))) {
    invalid(`${schema.object} must be an object`, schema.object)
  }
  for (const [field, max] of Object.entries(schema.limits || {})) {
    const value = params[field]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > max)) invalid(`${field} must be an integer between 1 and ${max}`, field)
  }
  for (const [field, values] of Object.entries(schema.enums || {})) {
    if (params[field] !== undefined && !values.includes(params[field])) invalid(`${field} must be one of: ${values.join(', ')}`, field)
  }
  return params
}
