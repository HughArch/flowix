import { ensureAgentPreferencesReady } from "@features/agent/store/agent-data-store";
import { useAgentWorkspaceStore } from "@features/agent/store/agent-workspace-store";
import { useEffect } from 'react';
import { listenToAgentWorkspaceChanges, boot } from '@platform/tauri/client';
import { runStartupStage3Task, waitForStartupStage3 } from '@/lib/startup-stage3';

interface AgentWorkspaceWindowLifecycleOptions {
  /** Defer main-window Agent data until its shell paints; the preferences window loads on mount. */
  deferUntilStage3?: boolean;
}

// Shared snapshot state outlives effect instances, just like the named task.
let startupSnapshotRequested = false;

/** Initialize per-Webview Agent data and keep its workspace snapshot in sync. */
export function useAgentWorkspaceWindowLifecycle(
  { deferUntilStage3 = false }: AgentWorkspaceWindowLifecycleOptions = {},
) {
  const loadInitial = useAgentWorkspaceStore((state) => state.workspaceActions.loadInitial);
  useEffect(() => {
    let active = true;
    let initialLoadStarted = false;
    let initialLoadSettled = false;
    let reloadQueued = false;
    let reloadInFlight = false;
    let unlisten: (() => void) | undefined;
    const runQueuedReload = () => {
      if (!active || !initialLoadSettled || !reloadQueued || reloadInFlight) return;
      reloadQueued = false;
      reloadInFlight = true;
      void loadInitial().catch((error) => {
        console.warn('Workspace reload failed:', error);
      }).finally(() => {
        reloadInFlight = false;
        runQueuedReload();
      });
    };
    const reload = () => {
      if (!active) return;
      if (!initialLoadSettled || reloadInFlight) {
        reloadQueued = true;
        return;
      }
      reloadQueued = true;
      runQueuedReload();
    };
    const initialize = async () => {
      if ('__TAURI_INTERNALS__' in window || '__TAURI__' in window) {
        await boot.waitForStartupReady();
      }
      if (!active) return;
      unlisten = listenToAgentWorkspaceChanges(reload, {
        onListenerReady: () => {
          // The initial snapshot covers first registration when it has not
          // started yet; reconnects after that need a fresh snapshot.
          if (initialLoadStarted || (deferUntilStage3 && startupSnapshotRequested)) reload();
        },
      });

      // Stage 3 owns scheduling; each store loads its own state independently.
      const markInitialLoadSettled = () => {
        if (!active) return;
        initialLoadSettled = true;
        runQueuedReload();
      };
      const initializeAgentPreferences = () => ensureAgentPreferencesReady().catch((error) => {
        console.warn('Pi mode initialization failed:', error);
      });

      const workspaceTask = deferUntilStage3
        ? runStartupStage3Task('agent-workspace-snapshot-load', async () => { await loadInitial(); })
        : loadInitial();
      const preferencesTask = deferUntilStage3
        ? runStartupStage3Task('agent-preferences-initialize', initializeAgentPreferences)
        : initializeAgentPreferences();
      void workspaceTask.finally(markInitialLoadSettled);

      if (deferUntilStage3) await waitForStartupStage3();
      if (!active) return;
      initialLoadStarted = true;
      if (deferUntilStage3) startupSnapshotRequested = true;
      await Promise.all([workspaceTask, preferencesTask]);
    };
    void initialize().catch((error) => console.warn('Workspace initialization deferred:', error));
    return () => { active = false; unlisten?.(); };
  }, [deferUntilStage3, loadInitial]);
}
