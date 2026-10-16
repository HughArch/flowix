import {
  DEFAULT_AGENT_TYPE_KEY,
  isAgentTypeSelectable,
  normalizeAgentId,
  normalizeAgentTypeKey,
} from '@/lib/agent-types';
import type { AgentId } from '@/types/agent';
import { normalizeCodexPermissionMode } from '@features/agent/runtime/agent-runtime-spec';
import {
  DEFAULT_AGENT_SESSION_META,
  type AgentSessionMeta,
} from '@features/agent/store/session-state';

/** Restore only the current session metadata shape. Runtime data is rebuilt. */
export function rehydrateSessionMeta(persisted: unknown): AgentSessionMeta {
  const own = (persisted as { sessionMeta?: AgentSessionMeta } | null | undefined)?.sessionMeta;
  const defaults = DEFAULT_AGENT_SESSION_META;
  const base: AgentSessionMeta = own && typeof own === 'object'
    ? {
        ...defaults,
        ...own,
        threadLists: defaults.threadLists,
        lastRunningRunsReconciledAt: defaults.lastRunningRunsReconciledAt,
        settings: { ...defaults.settings, ...(own.settings ?? {}) },
      }
    : { ...defaults, settings: { ...defaults.settings } };

  const typeKey = normalizeAgentTypeKey(base.activeAgentTypeKey);
  base.activeAgentTypeKey = isAgentTypeSelectable(typeKey)
    ? typeKey
    : DEFAULT_AGENT_TYPE_KEY;
  base.currentThreadTitles ??= {};
  base.threadTypes = Object.fromEntries(
    Object.entries(base.threadTypes ?? {}).flatMap(([threadId, legacyId]) => {
      const id = normalizeAgentId(legacyId);
      return id ? [[threadId, id]] : [];
    }),
  );
  base.activeThreadIds = normalizeAgentKeyedRecord(base.activeThreadIds);
  base.threadLists = normalizeAgentKeyedRecord(base.threadLists);
  base.settings.agentPermissionMode = normalizeCodexPermissionMode(
    base.settings.agentPermissionMode,
  );
  return base;
}

function normalizeAgentKeyedRecord<T>(value: unknown): Partial<Record<AgentId, T>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, T>;
  const result: Partial<Record<AgentId, T>> = {};
  for (const [key, item] of Object.entries(source)) {
    const id = normalizeAgentId(key);
    if (id && key === id) result[id] = item;
  }
  for (const [key, item] of Object.entries(source)) {
    const id = normalizeAgentId(key);
    if (id && result[id] === undefined) result[id] = item;
  }
  return result;
}
