'use client';

import { useEffect } from 'react';
import { useWorkspaceStartupStore } from '@/lib/store/workspace-startup-store';
import { notebooks, type NotebookSetupJob } from '@platform/tauri/client';
import { subscribe } from '@platform/tauri/event-bus';
import {
  replaceNotebookSetupSnapshot,
  upsertNotebookSetupJob,
  useNotebookSetupJob,
} from '@features/memo/store/notebook-setup-store';
import { useNoteStore } from '@features/memo/store';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';

export function NotebookSetupCoordinator() {
  const workspaceReady = useWorkspaceStartupStore((state) =>
    (state.status === 'ready' || state.status === 'degraded') && state.workbenchMounted,
  );
  const selectedNotebookId = useNoteStore((state) => state.selectedNotebook?.id ?? null);
  const navigationReady = useWorkColumnStore((state) =>
    state.navigation.phase !== 'loading' && state.notebookSwitchesInFlight === 0,
  );
  const activeSetupJob = useNotebookSetupJob(selectedNotebookId);
  const activePendingJobKey = activeSetupJob?.status === 'pending'
    ? `${activeSetupJob.jobId}:${activeSetupJob.revision}`
    : null;

  useEffect(() => {
    let active = true;
    let retryTimer: number | undefined;
    let retryAttempt = 0;

    const refreshSnapshot = async () => {
      if (!active) return;
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      try {
        const snapshot = await notebooks.getTemplateSetupSnapshot();
        if (!active) return;
        retryAttempt = 0;
        replaceNotebookSetupSnapshot(snapshot);
      } catch (error) {
        if (!active) return;
        console.warn('[NotebookSetupCoordinator] Failed to refresh setup jobs:', error);
        const delay = Math.min(1_000 * (2 ** retryAttempt), 30_000);
        retryAttempt += 1;
        retryTimer = window.setTimeout(() => {
          retryTimer = undefined;
          void refreshSnapshot();
        }, delay);
      }
    };

    const unsubscribe = subscribe<NotebookSetupJob>(
      'notebook-setup-status',
      upsertNotebookSetupJob,
      { onListenerReady: () => { void refreshSnapshot(); } },
    );
    const unsubscribeNotebookChanges = subscribe<unknown>(
      'notebooks-changed',
      () => { void refreshSnapshot(); },
    );
    return () => {
      active = false;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      unsubscribe();
      unsubscribeNotebookChanges();
    };
  }, []);

  useEffect(() => {
    if (!workspaceReady || !navigationReady) return;
    let active = true;
    let retryTimer: number | undefined;
    let retryAttempt = 0;

    const startAndRecoverReadyJobs = async () => {
      if (!active) return;
      try {
        await notebooks.startOrResumeReadyTemplateSetups(selectedNotebookId);
        retryAttempt = 0;
      } catch (error) {
        if (!active) return;
        console.warn('[NotebookSetupCoordinator] Failed to start or resume setup jobs:', error);
        const delay = Math.min(1_000 * (2 ** retryAttempt), 30_000);
        retryAttempt += 1;
        retryTimer = window.setTimeout(() => {
          retryTimer = undefined;
          void startAndRecoverReadyJobs();
        }, delay);
      }
    };

    void startAndRecoverReadyJobs();
    return () => {
      active = false;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [activePendingJobKey, navigationReady, selectedNotebookId, workspaceReady]);

  return null;
}
