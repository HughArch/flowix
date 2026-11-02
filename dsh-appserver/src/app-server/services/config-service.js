import { CapabilityUnavailableError, InvalidInputError, RevisionConflictError } from '../protocol/domain-errors.js'

const READ_ONLY_LAYERS = new Set(['defaults', 'system', 'managed'])
const SECRET_PARTS = /(?:secret|token|password|api[-_]?key|authorization|credential)/iu
const ALLOWED_PATHS = Object.freeze({
  'llm-pi-ai': [['providers']],
  'flownote-appserver': [['skills'], ['mcp'], ['runtime'], ['agent']],
})

function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {} }
function clone(value) {
  try { return structuredClone(value) } catch { return value }
}
function pathParts(value, field = 'path') {
  const parts = Array.isArray(value) ? value : typeof value === 'string' ? value.split('.') : null
  if (!parts || parts.length === 0 || !parts.every(part => typeof part === 'string' && part.trim())) throw new InvalidInputError(field, 'must be a non-empty dot path or string array')
  const normalized = parts.map(part => part.trim())
  if (normalized.some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) throw new InvalidInputError(field, 'contains a reserved path segment')
  return normalized
}
function isPlainObject(value) { return value && typeof value === 'object' && !Array.isArray(value) }
function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub)
  if (!isPlainObject(value)) return value
  const result = {}
  for (const [key, entry] of Object.entries(value)) result[key] = SECRET_PARTS.test(key) ? '[redacted]' : scrub(entry)
  return result
}
function containsSecret(value) {
  if (Array.isArray(value)) return value.some(containsSecret)
  if (!isPlainObject(value)) return false
  return Object.entries(value).some(([key, entry]) => SECRET_PARTS.test(key) || containsSecret(entry))
}

function descriptorOf(descriptors, namespace) {
  return (Array.isArray(descriptors) ? descriptors : []).find(item => item?.ns === namespace || item?.namespace === namespace)
}

function layer(name, value, source, readOnly = READ_ONLY_LAYERS.has(name)) {
  return {
    name,
    source: source || name,
    values: scrub(object(value)),
    readOnly,
  }
}

export function normalizeConfigDescriptor(descriptor, namespace) {
  const item = object(descriptor)
  // DSH settings owns resolution. Its current descriptor is `value` (the
  // resolved value), with `base` and `user` as the only meaningful source
  // layers. Do not rebuild an effective value in App Server: layer precedence,
  // schema defaults and provider-specific validation belong to dsh-settings.
  // Keep the older named layers only as a read-only compatibility projection
  // for hosts that explicitly provide them.
  const layers = [
    layer('defaults', item.defaults, item.defaultsSource),
    layer('system', item.system, item.systemSource),
    layer('managed', item.managed, item.managedSource),
    layer('base', item.base, item.baseSource, true),
    layer('workspace', item.workspace, item.workspaceSource, false),
    layer('user', item.user, item.userSource, false),
    layer('session', item.session, item.sessionSource, false),
    layer('runtime', item.runtime, item.runtimeSource, false),
  ].filter(entry => Object.keys(entry.values).length > 0 || entry.source !== entry.name)
  const effective = item.effective !== undefined
    ? item.effective
    : item.value !== undefined
      ? item.value
      // Legacy test/host descriptors sometimes expose only the user layer.
      // Returning that layer is a compatibility view; App Server still does
      // not merge it with any other layer or persist a copy.
      : item.user
  return {
    namespace,
    revision: Number.isSafeInteger(Number(item.revision)) ? Number(item.revision) : 0,
    ...(effective === undefined ? {} : { effective: scrub(effective) }),
    layers,
    ...(item.schema === undefined ? {} : { schema: clone(item.schema) }),
    ...(item.applies === undefined ? {} : { applies: clone(item.applies) }),
    ...(Array.isArray(item.secrets) ? { secrets: clone(item.secrets) } : {}),
    ...(Array.isArray(item.overridden) ? { overridden: clone(item.overridden) } : {}),
    warnings: Array.isArray(item.warnings) ? item.warnings.map(String) : [],
  }
}

export function normalizeConfigChange(payload) {
  const value = object(payload)
  return {
    ...(typeof value.namespace === 'string' ? { namespace: value.namespace } : typeof value.ns === 'string' ? { namespace: value.ns } : {}),
    ...(Number.isSafeInteger(Number(value.revision)) ? { revision: Number(value.revision) } : {}),
    ...(Array.isArray(value.changedPaths) ? { changedPaths: value.changedPaths.filter(path => typeof path === 'string') } : Array.isArray(value.paths) ? { changedPaths: value.paths.filter(path => typeof path === 'string') } : {}),
    ...(typeof value.layer === 'string' ? { layer: value.layer } : {}),
  }
}

function allowedPath(namespace, parts) {
  const prefixes = ALLOWED_PATHS[namespace]
  if (!prefixes) return false
  return prefixes.some(prefix => prefix.every((part, index) => parts[index] === part))
}

function validateEdit(namespace, edit, index) {
  if (!edit || typeof edit !== 'object' || Array.isArray(edit)) throw new InvalidInputError(`edits[${index}]`, 'must be an object')
  const path = pathParts(edit.path, `edits[${index}].path`)
  if (!allowedPath(namespace, path)) throw new InvalidInputError(`edits[${index}].path`, `is not writable in namespace ${namespace}`)
  const operation = edit.operation || edit.op || 'set'
  if (!['set', 'unset', 'merge'].includes(operation)) throw new InvalidInputError(`edits[${index}].operation`, 'must be set, unset or merge')
  if ((operation === 'set' || operation === 'merge') && edit.value === undefined) throw new InvalidInputError(`edits[${index}].value`, 'is required')
  if (SECRET_PARTS.test(path.join('.'))) throw new InvalidInputError(`edits[${index}].path`, 'must use credential/* for secrets')
  if (operation !== 'unset' && containsSecret(edit.value)) throw new InvalidInputError(`edits[${index}].value`, 'contains a secret; use credential/* for credentials')
  return { op: operation, path, ...(operation === 'unset' ? {} : { value: clone(edit.value) }) }
}

export class ConfigService {
  constructor(ctx) { this.ctx = ctx }

  settings() {
    const settings = this.ctx?.get?.('settings') || this.ctx?.settings
    if (!settings?.describe) throw new CapabilityUnavailableError('configuration-management')
    return settings
  }

  describe() {
    const result = this.settings().describe({ redactSecrets: true })
    return Array.isArray(result) ? result : []
  }

  read(namespace) {
    const descriptors = this.describe()
    if (namespace !== undefined) {
      if (typeof namespace !== 'string' || !namespace.trim()) throw new InvalidInputError('namespace', 'must be a non-empty string')
      const descriptor = descriptorOf(descriptors, namespace)
      if (!descriptor) throw new CapabilityUnavailableError(`configuration:${namespace}`)
      return normalizeConfigDescriptor(descriptor, namespace)
    }
    return { revision: Math.max(0, ...descriptors.map(item => Number(item?.revision) || 0)), namespaces: descriptors.map(item => normalizeConfigDescriptor(item, String(item.ns || item.namespace))) }
  }

  async mutate(namespace, edits, expectedRevision) {
    if (typeof namespace !== 'string' || !namespace.trim()) throw new InvalidInputError('namespace', 'must be a non-empty string')
    if (!Array.isArray(edits) || edits.length === 0) throw new InvalidInputError('edits', 'must be a non-empty array')
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw new InvalidInputError('expectedRevision', 'must be a non-negative integer')
    const operations = edits.map((edit, index) => validateEdit(namespace, edit, index))
    const settings = this.settings()
    if (typeof settings.mutate !== 'function') throw new CapabilityUnavailableError('configuration-write')
    try {
      await settings.mutate(namespace, operations, expectedRevision)
    } catch (error) {
      if (expectedRevision !== undefined && /revision|conflict|stale/iu.test(String(error?.message || error))) {
        let actual
        try { actual = this.read(namespace).revision } catch { /* preserve conflict semantics without a second failure */ }
        throw new RevisionConflictError(namespace, expectedRevision, actual)
      }
      throw error
    }
    return this.read(namespace)
  }

  async writeValue(params = {}) {
    const namespace = params.namespace || 'flownote-appserver'
    return this.mutate(namespace, [{ path: params.path, operation: params.operation || params.op || 'set', value: params.value }], params.expectedRevision)
  }

  async batchWrite(params = {}) {
    return this.mutate(params.namespace || 'flownote-appserver', params.edits, params.expectedRevision)
  }

  requirements(namespace) {
    const descriptors = this.describe()
    const descriptor = descriptorOf(descriptors, namespace || 'llm-pi-ai')
    if (!descriptor) throw new CapabilityUnavailableError(`configuration:${namespace || 'llm-pi-ai'}`)
    return {
      namespace: String(descriptor.ns || descriptor.namespace),
      revision: Number(descriptor.revision) || 0,
      requirements: clone(descriptor.requirements || descriptor.requires || []),
      managed: clone(descriptor.managedRequirements || descriptor.managed || null),
    }
  }
}
