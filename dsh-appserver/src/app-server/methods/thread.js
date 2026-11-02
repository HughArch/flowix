import { requiredString } from '../protocol/json-rpc.js'
import { randomUUID } from 'node:crypto'
import { selectItemsView } from '../projections/turn-projector.js'

const newSessionId = () => `session-${randomUUID().replaceAll('-', '')}`

export function threadMethods(adapter, notify) {
  return {
    'thread/start': async p => {
      // Flownote's card/local id is correlation data, not a provider id.
      // Mint a durable DSH session id instead of accepting it as threadId.
      const thread = await adapter.startThread(newSessionId(), launchConfig(p))
      notify('thread/started', { thread })
      return { thread }
    },
    'thread/resume': async p => {
      const thread = await adapter.resumeThread(requiredString(p.threadId, 'threadId'), launchConfig(p))
      notify('thread/resumed', { thread })
      return { thread }
    },
    'thread/read': async p => {
      const threadId = requiredString(p.threadId, 'threadId')
      const thread = await adapter.readThread(threadId, p.includeTurns === true)
      const subagents = await adapter.subagentService?.list?.(threadId)
      return {
        thread,
        ...(subagents?.data?.length ? { subagents: subagents.data } : {}),
        ...(subagents?.diagnostics?.length ? { subagentDiagnostics: subagents.diagnostics } : {}),
      }
    },
    'thread/list': async () => ({ threads: await adapter.listThreads() }),
    'thread/fork': async p => {
      const thread = await adapter.forkThread(requiredString(p.threadId, 'threadId'), p.boundarySeq, typeof p.newThreadId === 'string' ? p.newThreadId : newSessionId())
      notify('thread/started', { thread })
      return { thread }
    },
    'thread/turns/list': async p => {
      const page = await adapter.listTurns(requiredString(p.threadId, 'threadId'), p.cursor, p.limit, p.snapshotSequence, p.itemsView)
      return { page: { ...page, data: selectItemsView(page?.data || [], p.itemsView || 'full') } }
    },
    'thread/events/list': async p => ({ page: await adapter.listEvents(requiredString(p.threadId, 'threadId'), p.afterSeq ?? -1, p.limit) }),
    'thread/close': async p => adapter.closeThread(requiredString(p.threadId, 'threadId')),
    'thread/archive': async p => adapter.archiveThread(requiredString(p.threadId, 'threadId')),
  }
}

function launchConfig(params) {
  const config = {}
  if (typeof params.cwd === 'string' && params.cwd) config.cwd = params.cwd
  if (typeof params.provider === 'string' && params.provider) config.provider = params.provider
  if (typeof params.model === 'string' && params.model) config.model = params.model
  if (Number.isSafeInteger(params.maxTokens) && params.maxTokens > 0) config.maxTokens = params.maxTokens
  if (typeof params.agentPreset === 'string' && params.agentPreset) config.agentPreset = params.agentPreset
  if (typeof params.permissionMode === 'string' && params.permissionMode) config.permissionMode = params.permissionMode
  return config
}
