import { useAgentRuntimeStore } from '@features/agent/store/agent-runtime-store';
import type { AgentRuntimeSnapshot, AgentTypeKey } from '@/types/agent';

export {
  isAgentRuntimeInstalledState,
  normalizeAgentRuntimeStatus,
  normalizeAgentRuntimeStatusByType,
  type AgentRuntimeState,
  type AgentRuntimeStatusView,
  type AgentRuntimeStatusViewByType,
} from '@features/agent/runtime/agent-runtime-status';
export { getAvailableAgentTypes } from '@features/agent/runtime/agent-availability';

export interface AgentRuntimeStatusSnapshot {
  statusByType: Partial<Record<AgentTypeKey, AgentRuntimeSnapshot>>;
  isChecking: boolean;
  /** True after at least one runtime status check has succeeded. */
  hasChecked: boolean;
}

export function getAgentRuntimeStatusSnapshot(): AgentRuntimeStatusSnapshot {
  const { statusByType, isChecking, lastCheckedAt } = useAgentRuntimeStore.getState();
  return { statusByType, isChecking, hasChecked: lastCheckedAt !== null };
}

/** Notify consumers when reported status or check progress changes. */
export function subscribeAgentRuntimeStatus(listener: () => void): () => void {
  return useAgentRuntimeStore.subscribe((state, previous) => {
    if (state.statusByType !== previous.statusByType
      || state.isChecking !== previous.isChecking
      || state.lastCheckedAt !== previous.lastCheckedAt) {
      listener();
    }
  });
}

/** Start a background status refresh only when the cached report is stale. */
export function refreshAgentRuntimeStatusIfStale(): Promise<void> {
  return useAgentRuntimeStore.getState().refreshIfStale();
}
