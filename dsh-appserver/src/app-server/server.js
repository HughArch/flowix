import { NativeDshAdapter } from './adapters/native-dsh-adapter.js'
import { createMethodRegistry } from './methods/index.js'
import { assertRequest, ErrorCode, failure, paramsOf, RpcError, success } from './protocol/json-rpc.js'
import { serveStdio } from './transports/stdio.js'
import { ApprovalManager } from './approvals/approval-manager.js'
import { createRequire } from 'node:module'
import { DomainError, rpcErrorData } from './protocol/domain-errors.js'
import { RequestScheduler } from './runtime/request-scheduler.js'
import { validateMethodParams } from './protocol/method-schema.js'
import { APP_SERVER_API_VERSION, APP_SERVER_PROTOCOL_VERSION, protocolDescriptor } from './protocol/foundation.js'

const SERVER_INFO = Object.freeze({ name: 'dsh-appserver', version: '0.2.0' })
const require = createRequire(import.meta.url)
const HARNESS_INFO = (() => {
  try {
    const packageJson = require.resolve('@deepseek-ai/dsh/package.json')
    const packageInfo = require(packageJson)
    return Object.freeze({ name: packageInfo.name, version: packageInfo.version })
  } catch {
    return null
  }
})()
export class DshAppServer {
  constructor(ctx, { maxQueuedRequests = 1024, connectionTtlMs = 24 * 60 * 60_000, history, projection, workers, exports, adapter, observer } = {}) {
    this.adapter = adapter || new NativeDshAdapter(ctx, { history, projection, workers, exports })
    this.approvals = new ApprovalManager({
      inspectToolCall: (threadId, callId) => this.adapter.findToolCall?.(threadId, callId),
      activeTurnId: threadId => this.adapter.activeTurnId?.(threadId),
    })
    this.disposers = new Set()
    this.connections = new Map()
    this.connectionCleanupTimers = new Map()
    this.connectionTtlMs = connectionTtlMs
    this.lastConnectionPruneAt = 0
    this.scheduler = new RequestScheduler({ maxQueuedRequests })
    this.observer = typeof observer === 'function' ? observer : () => {}
    this.listeners = new Set()
    this.methods = createMethodRegistry(this.adapter, (method, params) => this.emit({ jsonrpc: '2.0', method, params }))
  }

  subscribe(listener) {
    this.listeners.add(listener)
    const unsubscribeAdapter = this.adapter.subscribe?.(listener)
    return () => { this.listeners.delete(listener); unsubscribeAdapter?.() }
  }
  emit(event) {
    if (typeof this.adapter.emit === 'function') this.adapter.emit(event)
    else for (const listener of this.listeners) listener(event)
  }
  subscribeConnection(connectionId, listener) {
    const unsubscribeAdapter = this.subscribe(event => {
      const state = this.connections.get(connectionId)
      if (!state?.optOut?.has(event.method)) listener(event)
    })
    const unsubscribeApprovals = this.approvals.subscribe((target, event) => {
      if (target === connectionId && !this.connections.get(connectionId)?.optOut?.has(event.method)) listener(event)
    })
    return () => { unsubscribeAdapter(); unsubscribeApprovals() }
  }
  shouldNotify(connectionId, event) { return !this.connections.get(connectionId)?.optOut?.has(event.method) }
  reconnectConnection(connectionId) {
    const timer = this.connectionCleanupTimers.get(connectionId)
    if (timer) { clearTimeout(timer); this.connectionCleanupTimers.delete(connectionId) }
    const state = this.connections.get(connectionId)
    if (state) state.lastSeenAt = Date.now()
    return this.approvals.reconnect(connectionId)
  }
  disconnectConnection(connectionId, graceMs = 5000) {
    this.approvals.disconnect(connectionId, graceMs)
    const existing = this.connectionCleanupTimers.get(connectionId)
    if (existing) clearTimeout(existing)
    if (graceMs <= 0) { this.releaseConnection(connectionId); return }
    const timer = setTimeout(() => this.releaseConnection(connectionId), graceMs)
    timer.unref?.()
    this.connectionCleanupTimers.set(connectionId, timer)
  }
  releaseConnection(connectionId) {
    const timer = this.connectionCleanupTimers.get(connectionId)
    if (timer) clearTimeout(timer)
    this.connectionCleanupTimers.delete(connectionId)
    this.connections.delete(connectionId)
    this.approvals.forget(connectionId)
  }
  pruneConnections(now = Date.now()) {
    if (now - this.lastConnectionPruneAt < 60_000) return
    this.lastConnectionPruneAt = now
    for (const [connectionId, state] of this.connections) {
      if (now - Number(state.lastSeenAt || 0) > this.connectionTtlMs) this.releaseConnection(connectionId)
    }
  }
  pendingServerRequests(connectionId, threadId) { return this.approvals.listPending(connectionId, threadId) }
  readExport(receiptId) { return this.adapter.readExport?.(receiptId) || null }
  createConnection(connectionId = `connection-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`) {
    return {
      id: connectionId,
      dispatch: request => this.dispatch(request, connectionId),
      receive: response => this.receiveResponse(response, connectionId),
      subscribe: listener => this.subscribeConnection(connectionId, listener),
      pending: threadId => this.approvals.listPending(connectionId, threadId),
      close: ({ graceMs = 0 } = {}) => this.disconnectConnection(connectionId, graceMs),
    }
  }
  listEvents(threadId, afterSeq = -1, limit = 200) { return this.adapter.listEvents(threadId, afterSeq, limit) }
  replayNotifications(threadId, afterSeq = -1, limit = 200) { return this.adapter.replayNotifications(threadId, afterSeq, limit) }

  dispatch(request, connectionId = 'default', { signal } = {}) {
    const now = Date.now()
    this.pruneConnections(now)
    const connection = this.connections.get(connectionId)
    if (connection) connection.lastSeenAt = now
    const startedAt = performance.now()
    const scheduled = this.scheduler.run({ ...request, connectionId }, scheduledSignal => this.dispatchNow(request, connectionId, scheduledSignal), signal)
    if (!scheduled) return Promise.resolve(failure(request?.id ?? null, 'Server overloaded; retry later.', -32001, { kind: 'server_overloaded' }))
    return scheduled.then(response => {
      this.observeRequest(request, connectionId, startedAt, response?.error ? 'error' : 'ok', response?.error?.data?.kind)
      return response
    }).catch(error => {
      const response = error instanceof DomainError
        ? failure(request?.id ?? null, error.message, error.code, rpcErrorData(error))
        : failure(request?.id ?? null, error instanceof Error ? error.message : String(error))
      this.observeRequest(request, connectionId, startedAt, 'error', response.error?.data?.kind)
      return response
    })
  }

  observeRequest(request, connectionId, startedAt, status, errorKind) {
    const params = request?.params
    try {
      this.observer({
        type: 'rpc.completed', method: request?.method, requestId: request?.id, connectionId,
        threadId: params?.threadId || params?.sessionId,
        status, errorKind, durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        scheduler: this.scheduler.snapshot(),
      })
    } catch { /* telemetry must never affect protocol behavior */ }
  }

  async dispatchNow(request, connectionId, signal) {
    try {
      assertRequest(request)
      if (request.method === 'initialize') {
        if (this.connections.has(connectionId)) throw new RpcError(ErrorCode.alreadyInitialized, 'Already initialized')
        const requestedVersion = request.params?.protocolVersion
        if (requestedVersion !== undefined && requestedVersion !== APP_SERVER_PROTOCOL_VERSION) {
          throw new RpcError(ErrorCode.invalidParams, `Unsupported App Server protocol version: ${String(requestedVersion)}`)
        }
        const optOut = request.params?.capabilities?.optOutNotificationMethods
        const generation = this.approvals.connect(connectionId)
        this.connections.set(connectionId, { generation, lastSeenAt: Date.now(), optOut: new Set(Array.isArray(optOut) ? optOut.filter(value => typeof value === 'string') : []) })
        return success(request.id, {
          ...protocolDescriptor(this.adapter.protocolCapabilities?.() || {
            threads: true, turns: true, fork: true, history: true, interrupt: true, steer: true, archive: true, commands: true, skills: true,
            itemLifecycle: { typed: true, stateMachine: true, dedupe: true, itemsView: true },
            skillCatalog: { list: true, changed: true, configWrite: false, extraRoots: false },
            config: { read: true, valueWrite: true, batchWrite: true, requirements: true },
            mcp: { statusList: false, refresh: false, configReload: false, oauthLogin: false, toolCall: false, resourceRead: false },
            models: { catalog: true, discover: true, configure: true, delete: true },
            credentials: { read: true, write: true },
            flownote: { jobs: true, usage: true, plugins: true, profile: true },
            approvals: { request: true, policy: ['ask', 'never'], decisions: ['accept', 'decline', 'cancel'] },
            goals: { read: true, write: true, clear: true, tokenBudget: false },
            subagents: { spawn: false, list: false, send: false, resume: false, interrupt: false, wait: false, close: false },
          }),
          serverInfo: SERVER_INFO,
          ...(HARNESS_INFO === null ? {} : { harness: HARNESS_INFO }),
        })
      }
      if (request.method === 'shutdown') return success(request.id, {})
      if (!this.connections.has(connectionId)) throw new RpcError(ErrorCode.notInitialized, 'Not initialized')
      if (request.method === 'serverRequest/respond') {
        const params = paramsOf(request)
        if (typeof params.requestId !== 'string' || !params.requestId) throw new RpcError(ErrorCode.invalidParams, 'requestId must be a non-empty string')
        const result = this.approvals.resolve(connectionId, params.requestId, params.decision)
        if (!result.resolved) throw new RpcError(ErrorCode.invalidParams, `Approval request cannot be resolved: ${result.reason}`)
        return success(request.id, result)
      }
      const handler = this.methods.get(request.method)
      if (!handler) throw new RpcError(ErrorCode.methodNotFound, `Unknown method: ${request.method}`)
      const params = paramsOf(request)
      validateMethodParams(request.method, params)
      const threadId = params.threadId || params.sessionId
      if (typeof threadId === 'string' && ['thread/start', 'thread/resume', 'turn/start'].includes(request.method)) this.approvals.acquire(threadId, connectionId)
      return success(request.id, await handler(params, { connectionId, signal }))
    } catch (error) {
      if (error instanceof RpcError) return failure(request?.id ?? null, error.message, error.code, error.data)
      if (error instanceof DomainError) return failure(request?.id ?? null, error.message, error.code, rpcErrorData(error))
      return failure(request?.id ?? null, error instanceof Error ? error.message : String(error))
    }
  }

  receiveResponse(response, connectionId = 'default') {
    if (!response || typeof response !== 'object' || response.id === undefined || response.method !== undefined) return { resolved: false, reason: 'invalid-response' }
    return this.approvals.resolveResponse(connectionId, response)
  }

  addDisposer(disposer) { if (typeof disposer === 'function') this.disposers.add(disposer); return disposer }

  handleApproval(request, next) { return this.approvals.handle(request, next) }

  serveStdio(input = process.stdin, output = process.stdout) { return serveStdio(this, input, output) }
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const disposer of this.disposers) disposer()
    this.disposers.clear()
    this.approvals.dispose()
    for (const timer of this.connectionCleanupTimers.values()) clearTimeout(timer)
    this.connectionCleanupTimers.clear()
    this.connections.clear()
    this.listeners.clear()
    this.scheduler.clear()
    this.adapter.subagentService?.dispose?.()
    await this.adapter.dispose()
  }
}

// Backward-compatible class name for existing consumers.
export { DshAppServer as NativeJsonRpcServer }
