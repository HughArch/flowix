import { credentialMethods } from './credential.js'
import { modelMethods } from './model.js'
import { runtimeMethods } from './runtime.js'
import { sessionMethods } from './session.js'
import { threadMethods } from './thread.js'
import { turnMethods } from './turn.js'
import { approvalMethods } from './approval.js'
import { flownoteMethods } from './flownote.js'
import { commandMethods } from './command.js'
import { goalMethods } from './goal.js'
import { configMethods } from './config.js'
import { mcpMethods } from './mcp.js'
import { subagentMethods } from './subagent.js'

export function createMethodRegistry(adapter, notify) {
  return new Map(Object.entries({
    ...threadMethods(adapter, notify),
    ...turnMethods(adapter),
    ...modelMethods(adapter),
    ...credentialMethods(adapter),
    ...runtimeMethods(adapter),
    ...sessionMethods(adapter),
    ...approvalMethods(adapter),
    ...flownoteMethods(adapter),
    ...commandMethods(adapter),
    ...goalMethods(adapter),
    ...configMethods(adapter),
    ...mcpMethods(adapter),
    ...subagentMethods(adapter, notify),
  }))
}
