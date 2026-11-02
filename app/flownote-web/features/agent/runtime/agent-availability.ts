import type { AgentRuntimeSnapshot, AgentType, AgentTypeKey } from '@/types/agent';
import { AGENT_TYPES, isAgentTypeSelectable } from '@/lib/agent-types';
import { normalizeAgentRuntimeStatus } from './agent-runtime-status';

type RuntimeStatusByType = Partial<Record<AgentTypeKey, AgentRuntimeSnapshot>>;

/** Agent choices shared by menus require a ready runtime and an enabled preference. */
export function getAvailableAgentTypes(
  statusByType: RuntimeStatusByType,
  isChecking: boolean,
  isEnabled: (typeKey: AgentTypeKey) => boolean,
): AgentType[] {
  return AGENT_TYPES.filter((type) => (
    isAgentTypeSelectable(type.id)
      && isEnabled(type.id)
      && normalizeAgentRuntimeStatus(statusByType[type.id], isChecking).state === 'ready'
  ));
}
