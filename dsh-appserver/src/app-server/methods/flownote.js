import { requiredString } from '../protocol/json-rpc.js'

/** Flownote-owned extensions which are intentionally outside the generic
 * Thread/Turn App Server surface. Keeping these under flownote/* lets Desktop
 * keep Flownote-owned extensions separate from the generic App Server surface
 * to product-specific UI concerns. */
export function flownoteMethods(adapter) {
  const query = adapter.sessionQueryService
  return {
    'flownote/jobs/list': p => adapter.listJobs(requiredString(p.threadId, 'threadId')),
    'flownote/session/usage': p => query?.usage(requiredString(p.sessionId || p.threadId, 'sessionId')) ?? adapter.sessionUsage(requiredString(p.sessionId || p.threadId, 'sessionId')),
    'flownote/plugins/list': () => adapter.listPlugins(),
    'flownote/runtime/profile': () => adapter.profileInfo(),
  }
}
