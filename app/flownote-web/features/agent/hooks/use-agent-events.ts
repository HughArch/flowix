import { useEffect } from 'react';

import {
  acquireAgentChunkBridge,
  useAgentSessionStore,
} from '@features/agent/store/agent-session-store';
import { isProjectionRunActive } from '@features/agent/store/session-reducer';
import { getInterestedThreadIds } from '@features/agent/store/thread-interest';
import { runStartupStage3Task } from '@/lib/startup-stage3';

export async function reconcileAgentRunsAndRefreshEndedHistory(): Promise<void> {
  // Canonical run state lives in AgentSessionStore projections.
  const before = useAgentSessionStore.getState();
  const locallyRunning = Object.entries(before.threadProjections)
    .filter(([, projection]) => isProjectionRunActive(projection))
    .map(([threadId]) => ({
      threadId,
      runId: before.threadProjections[threadId].runs.activeRunId,
      agentType:
        before.sessionMeta.threadTypes[threadId] ??
        before.sessionMeta.activeAgentTypeKey,
    }));

  // Runtime liveness is best-effort. A WebView can temporarily be unable to
  // use the Tauri IPC transport (for example while it is recovering focus),
  // but that must not prevent the durable history request below. Keep the
  // pre-reconcile state when the snapshot is unavailable so a failed snapshot
  // cannot be mistaken for an empty one and mark a live run as ended.
  let after = before;
  try {
    await useAgentSessionStore.getState().reconcileRunningRuns();
    after = useAgentSessionStore.getState();
  } catch (error) {
    console.warn('[useAgentEvents] agent_running_threads unavailable; continuing with history refresh:', error);
  }
  const endedWhileDisconnected = locallyRunning.filter(({ threadId }) => {
    const projection = after.threadProjections[threadId];
    return !projection || !isProjectionRunActive(projection);
  });

  // Tauri events are intentionally ephemeral. On startup/focus/listener
  // recovery, refresh the conversations this Webview currently owns so missed
  // user rows or stream chunks converge through the normal history API. This
  // is business-state reconciliation, not event replay.
  const refreshTargets = new Map<string, typeof after.sessionMeta.activeAgentTypeKey>();
  for (const [agentType, activeThreadId] of Object.entries(
    after.sessionMeta.activeThreadIds,
  )) {
    if (!activeThreadId) continue;
    refreshTargets.set(
      activeThreadId,
      after.sessionMeta.threadTypes[activeThreadId] ??
        (agentType as typeof after.sessionMeta.activeAgentTypeKey),
    );
  }
  for (const { threadId, agentType } of endedWhileDisconnected) {
    refreshTargets.set(threadId, agentType);
  }

  const interestedThreadIds = getInterestedThreadIds();
  const priorityThreadIds = new Set(interestedThreadIds);
  for (const interestedThreadId of interestedThreadIds) {
    refreshTargets.set(
      interestedThreadId,
      after.sessionMeta.threadTypes[interestedThreadId] ??
        after.sessionMeta.activeAgentTypeKey,
    );
  }

  const completedTargets = new Map(
    endedWhileDisconnected
      .filter((target): target is typeof target & { runId: string } => !!target.runId)
      .map((target) => [target.threadId, target]),
  );

  const targets = [...refreshTargets];
  const priorityTargets = targets.filter(([threadId]) => priorityThreadIds.has(threadId));
  const backgroundTargets = targets.filter(([threadId]) => !priorityThreadIds.has(threadId));
  const refreshTarget = ([threadId, agentType]: [string, typeof after.sessionMeta.activeAgentTypeKey]) => {
    const completed = completedTargets.get(threadId);
    return completed
      ? useAgentSessionStore
          .getState()
          .reconcileCompletedRun(agentType, threadId, completed.runId)
      : useAgentSessionStore.getState().loadMessages(agentType, threadId);
  };

  // Refresh visible conversations first; catch up hidden sessions two at a time.
  await Promise.allSettled(priorityTargets.map(refreshTarget));
  for (let index = 0; index < backgroundTargets.length; index += 2) {
    await Promise.allSettled(backgroundTargets.slice(index, index + 2).map(refreshTarget));
  }
}

/**
 * Installs the agent stream bridge for content Webviews that need live chat updates.
 *
 * This is mounted by AgentWindowEffects in content Webviews, but not
 * preferences. The bridge itself is idempotent within each Webview realm.
 */
export function useAgentEvents(waitForWorkspaceRestore?: () => Promise<void>): void {
  useEffect(() => {
    let disposed = false;
    let startupRecoveryReady = false;
    let reconcileAfterStartupRecovery = false;
    let lastReconcileAt = 0;

    const reconcileRunningRuns = async (force = false) => {
      if (disposed || !startupRecoveryReady) return;
      const now = Date.now();
      if (!force && now - lastReconcileAt < 1000) return;
      lastReconcileAt = now;
      await reconcileAgentRunsAndRefreshEndedHistory();
    };

    const releaseAgentChunkBridge = acquireAgentChunkBridge(() => {
      // Listener readiness is a recovery boundary. Force a snapshot even if
      // the normal focus/visibility throttle ran recently, because stream_end
      // may have been missed while Tauri registration was unavailable.
      if (!startupRecoveryReady) {
        reconcileAfterStartupRecovery = true;
        return;
      }
      void reconcileRunningRuns(true).catch((err) => {
        console.warn('[useAgentEvents] post-listen reconciliation failed:', err);
      });
    });

    void runStartupStage3Task('agent-session-recovery', async () => {
      await waitForWorkspaceRestore?.();
      await reconcileAgentRunsAndRefreshEndedHistory();
    })
      .then(() => {
        if (disposed) return;
        startupRecoveryReady = true;
        if (reconcileAfterStartupRecovery) {
          reconcileAfterStartupRecovery = false;
          void reconcileRunningRuns(true).catch((err) => {
            console.warn('[useAgentEvents] deferred post-listen reconciliation failed:', err);
          });
        }
      });

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      void reconcileRunningRuns().catch((err) => {
        console.warn('[useAgentEvents] agent_running_threads failed:', err);
      });
    };
    const handleFocus = () => {
      void reconcileRunningRuns().catch((err) => {
        console.warn('[useAgentEvents] agent_running_threads failed:', err);
      });
    };
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      disposed = true;
      releaseAgentChunkBridge();
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [waitForWorkspaceRestore]);
}
