import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';

export async function removeAgentConversation(instance: AgentConversationInstance, action: 'archive' | 'delete') {
  const session = useAgentSessionStore.getState();
  if (!instance.threadId) {
    session.removeInstance(instance.instanceId);
    return;
  }
  await (action === 'archive' ? session.archiveThread(instance.threadId) : session.deleteThread(instance.threadId));
}
