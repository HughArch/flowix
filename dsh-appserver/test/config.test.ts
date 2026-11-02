import { describe, expect, it } from 'vitest'
import { AppServer } from '../src/index.js'

function createSettings() {
  let revision = 4
  const values: Record<string, any> = {
    'llm-pi-ai': { providers: { local: { model: 'local' } }, apiKey: 'must-not-leak' },
    'flownote-appserver': { skills: { enabled: {} }, runtime: { maxQueuedRequests: 10 } },
  }
  return {
    describe: () => Object.entries(values).map(([ns, user]) => ({ ns, revision, user, applies: ['user'] })),
    async mutate(namespace: string, operations: any[], expectedRevision?: number) {
      if (expectedRevision !== undefined && expectedRevision !== revision) throw new Error('revision conflict')
      for (const operation of operations) {
        const target = values[namespace]
        let cursor = target
        for (const segment of operation.path.slice(0, -1)) cursor = cursor[segment] ||= {}
        const leaf = operation.path.at(-1)
        if (operation.op === 'unset') delete cursor[leaf]
        else cursor[leaf] = operation.op === 'merge' && cursor[leaf] && typeof cursor[leaf] === 'object'
          ? { ...cursor[leaf], ...operation.value }
          : operation.value
      }
      revision += 1
    },
  }
}

describe('configuration protocol', () => {
  it('reads redacted layered configuration and performs atomic revisioned writes', async () => {
    const settings = createSettings()
    const adapter = { ctx: { get: (name: string) => name === 'settings' ? settings : undefined }, subscribe: () => () => {} }
    const server = new AppServer(null, { adapter })
    await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    const read = await server.dispatch({ jsonrpc: '2.0', id: 2, method: 'config/read', params: { namespace: 'llm-pi-ai' } })
    expect(read.result).toMatchObject({ namespace: 'llm-pi-ai', revision: 4, effective: { providers: { local: { model: 'local' } }, apiKey: '[redacted]' } })
    expect(JSON.stringify(read.result)).not.toContain('must-not-leak')

    const write = await server.dispatch({ jsonrpc: '2.0', id: 3, method: 'config/batchWrite', params: {
      namespace: 'flownote-appserver', expectedRevision: 4,
      edits: [{ path: 'skills.enabled.frontend', operation: 'set', value: true }, { path: ['runtime', 'maxQueuedRequests'], operation: 'set', value: 20 }],
    } })
    expect(write.result).toMatchObject({ namespace: 'flownote-appserver', revision: 5, effective: { skills: { enabled: { frontend: true } }, runtime: { maxQueuedRequests: 20 } } })

    const stale = await server.dispatch({ jsonrpc: '2.0', id: 4, method: 'config/value/write', params: { namespace: 'flownote-appserver', path: 'runtime.maxQueuedRequests', value: 30, expectedRevision: 4 } })
    expect(stale.error?.data).toMatchObject({ kind: 'revision_conflict', expected: 4, actual: 5 })
  })

  it('rejects secret and unapproved paths before touching the settings service', async () => {
    let writes = 0
    const settings = createSettings()
    const original = settings.mutate
    settings.mutate = async (...args: any[]) => { writes += 1; return original(...args) }
    const adapter = { ctx: { get: (name: string) => name === 'settings' ? settings : undefined }, subscribe: () => () => {} }
    const server = new AppServer(null, { adapter })
    await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    const secret = await server.dispatch({ jsonrpc: '2.0', id: 2, method: 'config/value/write', params: { namespace: 'llm-pi-ai', path: 'providers.local.apiKey', value: 'secret' } })
    const nestedSecret = await server.dispatch({ jsonrpc: '2.0', id: 3, method: 'config/value/write', params: { namespace: 'llm-pi-ai', path: 'providers.local', value: { apiKey: 'secret' } } })
    const unknown = await server.dispatch({ jsonrpc: '2.0', id: 4, method: 'config/value/write', params: { namespace: 'llm-pi-ai', path: 'runtime.debug', value: true } })
    expect(secret.error?.code).toBe(-32602)
    expect(nestedSecret.error?.code).toBe(-32602)
    expect(unknown.error?.code).toBe(-32602)
    expect(writes).toBe(0)
  })
})
