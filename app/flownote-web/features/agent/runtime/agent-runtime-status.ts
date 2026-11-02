import type { AgentTypeKey, AgentRuntimeSnapshot } from '@/types/agent';

/**
 * Small, UI-facing state model for one local Agent runtime.
 *
 * Runtime status is split into installation presence and launch readiness.
 * UI state is derived here so consumers don't reinterpret those facts.
 */
export type AgentRuntimeState =
  | 'unknown'
  | 'checking'
  | 'not-installed'
  | 'not-ready'
  | 'ready';

export interface AgentRuntimeStatusView {
  state: AgentRuntimeState;
  reason: string | null;
}

export type AgentRuntimeStatusViewByType = Partial<Record<AgentTypeKey, AgentRuntimeStatusView>>;

export function isAgentRuntimeInstalledState(status: AgentRuntimeStatusView): boolean {
  return status.state === 'ready' || status.state === 'not-ready';
}

/** Convert the backend installation/readiness protocol into shared UI states. */
export function normalizeAgentRuntimeStatus(
  status: AgentRuntimeSnapshot | undefined,
  isChecking = false,
): AgentRuntimeStatusView {
  if (!status) {
    return {
      state: isChecking ? 'checking' : 'unknown',
      reason: null,
    };
  }

  if (status.installation === 'missing') {
    return { state: 'not-installed', reason: status.reason ?? null };
  }

  if (status.installation === 'unknown' || status.readiness === 'unknown') {
    return { state: isChecking ? 'checking' : 'unknown', reason: status.reason ?? null };
  }

  return {
    state: status.readiness === 'ready' ? 'ready' : 'not-ready',
    reason: status.reason ?? null,
  };
}

export function normalizeAgentRuntimeStatusByType(
  statusByType: Partial<Record<AgentTypeKey, AgentRuntimeSnapshot>>,
  isChecking = false,
): AgentRuntimeStatusViewByType {
  return Object.fromEntries(
    (Object.keys(statusByType) as AgentTypeKey[]).map((typeKey) => [
      typeKey,
      normalizeAgentRuntimeStatus(statusByType[typeKey], isChecking),
    ]),
  ) as AgentRuntimeStatusViewByType;
}
