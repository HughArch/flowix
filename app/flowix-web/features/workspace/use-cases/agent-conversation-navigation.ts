import {
  hasWorkspaceAgentConversation,
  hydrateWorkspaceAgentConversation,
} from '@features/agent/public/workspace-api';
import { useWorkspaceRestoreStore } from '@features/workspace/store/workspace-restore-store';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import { clearWorkspaceDocument, closeAgentTarget, openAgentTarget } from './workspace-navigation';

export async function selectAndOpenAgentConversation(
  instanceId: string,
  options?: { history?: 'push' | 'skip'; destination?: 'main-third'; blankIfMissing?: true },
): Promise<void> {
  const normalized = instanceId.trim();
  if (!normalized) return;

  if (options?.blankIfMissing && !hasWorkspaceAgentConversation(normalized)) {
    const requestId = useWorkColumnStore.getState().navigation.requestId;
    try {
      const restored = await hydrateWorkspaceAgentConversation(normalized);
      if (useWorkColumnStore.getState().navigation.requestId !== requestId) return;
      if (!restored) {
        await clearWorkspaceDocument();
        useWorkspaceRestoreStore.getState().clearAgentConversation(normalized);
        return;
      }
    } catch {
      if (useWorkColumnStore.getState().navigation.requestId !== requestId) return;
      // A backend error is not proof that an empty draft has vanished. Keep
      // the target so the detail can show its normal loading error and retry.
    }
  }

  const host = await openAgentTarget(normalized, options);
  useWorkspaceRestoreStore.getState().selectAgentConversation(
    normalized,
    host === 'main-third',
  );
}

export function closeAgentConversationDetail(): void {
  closeAgentTarget();
  useWorkspaceRestoreStore.getState().closeAgentConversationDetail();
}

export function clearRestoredAgentConversation(instanceId: string): void {
  useWorkspaceRestoreStore.getState().clearAgentConversation(instanceId);
}

export async function restoreAgentConversationWorkspace(): Promise<void> {
  const store = useWorkspaceRestoreStore.getState();
  const desiredTarget = store.desiredTarget;
  const instanceId = desiredTarget?.kind === 'agent-conversation'
    ? desiredTarget.instanceId.trim()
    : '';
  if (!instanceId) return;

  const blankIfMissing = desiredTarget?.kind === 'agent-conversation'
    && desiredTarget.blankIfMissing === true;
  let restored: Awaited<ReturnType<typeof hydrateWorkspaceAgentConversation>> = null;
  let restoreFailed = false;

  try {
    restored = await hydrateWorkspaceAgentConversation(instanceId);
  } catch (error) {
    restoreFailed = true;
    console.error('Failed to restore agent conversation:', error);
  }

  const currentTarget = useWorkspaceRestoreStore.getState().desiredTarget;
  if (
    currentTarget?.kind !== 'agent-conversation'
    || currentTarget.instanceId.trim() !== instanceId
    || useWorkColumnStore.getState().navigation.phase === 'loading'
  ) return;

  if (blankIfMissing && !restoreFailed && restored === null) {
    // Empty drafts are intentionally memory-only. Their stale restore target
    // should become the ordinary empty work column, not a missing-session page.
    try {
      await clearWorkspaceDocument();
      useWorkspaceRestoreStore.getState().clearAgentConversation(instanceId);
      return;
    } catch (error) {
      console.error('Failed to clear missing empty conversation target:', error);
    }
  }

  if (blankIfMissing && restored) {
    useWorkspaceRestoreStore.getState().setDesiredTarget({
      kind: 'agent-conversation',
      instanceId,
    });
  }

  // The detail owns missing/error presentation and retry. Keep the restored
  // target visible even when this eager lookup did not return an instance.
  await selectAndOpenAgentConversation(instanceId, {
    history: 'skip',
    ...(blankIfMissing && restoreFailed ? { blankIfMissing: true as const } : {}),
  });
}
