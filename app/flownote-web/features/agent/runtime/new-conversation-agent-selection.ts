import type { AgentRuntimeSnapshot, AgentType, AgentTypeKey } from '@/types/agent';
import { getAgentType } from '@/lib/agent-types';
import { isMobileDevice } from '@shared/platform';
import { getAvailableAgentTypes } from './agent-availability';

type RuntimeStatusByType = Partial<Record<AgentTypeKey, AgentRuntimeSnapshot>>;

export type NewConversationAgentSelection =
  | { kind: 'create'; agentType: AgentTypeKey; options: AgentType[] }
  | { kind: 'choose'; options: AgentType[] }
  | { kind: 'none'; options: [] };

/** Prefer ready, enabled runtimes; use Pi as a fallback unless the user disabled it. */
export function getNewConversationAgentSelection(
  statusByType: RuntimeStatusByType,
  isChecking: boolean,
  isEnabled: (typeKey: AgentTypeKey) => boolean,
): NewConversationAgentSelection {
  const availableAgents = getAvailableAgentTypes(statusByType, isChecking, isEnabled);
  // Pi 兜底仅限桌面：移动端外部 CLI 不可执行，没有可用项就是没有入口。
  const piFallbackAllowed = !isMobileDevice() && isEnabled('pi');
  const options = availableAgents.length > 0
    ? availableAgents
    : piFallbackAllowed ? [getAgentType('pi')] : [];

  if (options.length === 0) return { kind: 'none', options: [] };

  if (options.length === 1) {
    return { kind: 'create', agentType: options[0]!.id, options };
  }
  return { kind: 'choose', options };
}
