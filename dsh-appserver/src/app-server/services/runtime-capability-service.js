import { APP_SERVER_API_VERSION, APP_SERVER_PROTOCOL_VERSION, PROTOCOL_FEATURES, PROTOCOL_LIMITS } from '../protocol/foundation.js'

function contextValue(ctx, name) {
  try {
    return ctx?.get?.(name) || ctx?.[name]
  } catch {
    return undefined
  }
}

export class RuntimeCapabilityService {
  constructor(ctx, runtimeRegistry) {
    this.ctx = ctx
    this.runtimeRegistry = runtimeRegistry
  }

  names() {
    const names = ['runtime-events', 'session-control', 'session-dispose', 'run-cancel', 'profile']
    if (this.has('workspaceController')) names.push('session-archive')
    if (this.has('credentials')) names.push('credentials-management')
    if (this.has('settings')) names.push('model-settings-management')
    if (this.has('llm')) names.push('model-discovery')
    if (this.has('attachments')) names.push('attachments')
    if (this.has('jobs')) names.push('jobs')
    if (this.has('settings')) names.push('configuration-management')
    if (this.mcpHas('list', 'statusList', 'listStatus', 'refresh', 'reload', 'oauthLogin', 'login', 'callTool', 'toolCall', 'call', 'readResource', 'resourceRead', 'read')) names.push('mcp-management')
    if (this.hasNativeSubagents() || this.has('agents')) names.push('subagent-coordination')
    return names
  }

  has(name) { return Boolean(contextValue(this.ctx, name)) }
  subagentProvider() { return contextValue(this.ctx, 'subagents') }
  hasNativeSubagents() {
    const provider = this.subagentProvider()
    return Boolean(provider && typeof provider.startContinuable === 'function' && typeof provider.listChildren === 'function')
  }
  mcpHas(...operations) {
    const providers = [
      contextValue(this.ctx, 'mcp'), contextValue(this.ctx, 'mcpServers'), contextValue(this.ctx, 'mcpService'),
    ]
    const provider = providers.find(value => value && operations.some(operation => typeof value[operation] === 'function'))
    return Boolean(provider && operations.some(operation => typeof provider[operation] === 'function'))
  }
  profile() {
    return {
      profile: process.env.DSH_PROFILE || null,
      appServer: 'dsh-appserver',
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      apiVersion: APP_SERVER_API_VERSION,
    }
  }
  status() { return { activeThreads: this.runtimeRegistry.size, threads: this.runtimeRegistry.size, initialized: true } }
  report() {
    return {
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      apiVersion: APP_SERVER_API_VERSION,
      features: PROTOCOL_FEATURES,
      limits: PROTOCOL_LIMITS,
      capabilities: this.names(),
    }
  }

  protocol() {
    const names = new Set(this.names())
    return {
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      apiVersion: APP_SERVER_API_VERSION,
      features: PROTOCOL_FEATURES,
      limits: PROTOCOL_LIMITS,
      threads: true, turns: true, fork: true, history: true, interrupt: true, steer: true,
      itemLifecycle: { typed: true, stateMachine: true, dedupe: true, itemsView: true },
      archive: names.has('session-archive'), commands: true, skills: true,
      skillCatalog: { list: true, changed: true, configWrite: names.has('configuration-management'), extraRoots: names.has('configuration-management') },
      config: { read: names.has('configuration-management'), valueWrite: names.has('configuration-management'), batchWrite: names.has('configuration-management'), requirements: names.has('configuration-management') },
      mcp: {
        statusList: this.mcpHas('list', 'statusList', 'listStatus'),
        refresh: this.mcpHas('refresh', 'reload') || this.mcpHas('list', 'statusList', 'listStatus'),
        configReload: this.mcpHas('refresh', 'reload'),
        oauthLogin: this.mcpHas('oauthLogin', 'login'),
        toolCall: this.mcpHas('callTool', 'toolCall', 'call'),
        resourceRead: this.mcpHas('readResource', 'resourceRead', 'read'),
      },
      models: {
        catalog: names.has('model-settings-management'), discover: names.has('model-discovery'),
        configure: names.has('model-settings-management'), delete: names.has('model-settings-management'),
      },
      credentials: { read: names.has('credentials-management'), write: names.has('credentials-management') },
      flownote: { jobs: names.has('jobs'), usage: true, plugins: true, profile: true },
      goals: { read: true, write: true, clear: true, tokenBudget: false },
      subagents: {
        spawn: names.has('subagent-coordination'), list: names.has('subagent-coordination'), send: names.has('subagent-coordination'),
        resume: names.has('subagent-coordination'), interrupt: names.has('subagent-coordination'), wait: names.has('subagent-coordination'), close: names.has('subagent-coordination'),
        native: this.hasNativeSubagents(), durableThreads: this.has('sessionPersistence'), coldResume: this.hasNativeSubagents() && this.has('sessionPersistence'),
      },
      approvals: { request: true, policy: ['ask', 'never'], decisions: ['accept', 'decline', 'cancel'] },
    }
  }
}
