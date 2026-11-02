import { useMemo } from 'react';
import { useAgentRuntimeStore } from '@features/agent/store/agent-runtime-store';
import { useAgentVisibilityPreferences } from '@features/preferences/public/runtime-api';
import { getNewConversationAgentSelection } from '@features/agent/runtime/new-conversation-agent-selection';

export function useNewConversationAgentSelection() {
  const statusByType = useAgentRuntimeStore((state) => state.statusByType);
  const isChecking = useAgentRuntimeStore((state) => state.isChecking);
  const { enabledByType } = useAgentVisibilityPreferences();

  return useMemo(
    () => getNewConversationAgentSelection(
      statusByType,
      isChecking,
      (typeKey) => enabledByType[typeKey] ?? true,
    ),
    [enabledByType, isChecking, statusByType],
  );
}
