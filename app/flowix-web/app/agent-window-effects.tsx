'use client';

import { useEffect } from 'react';
import { useAgentEvents } from '@features/agent/hooks/use-agent-events';
import { useAgentRuntimeStore } from '@features/agent/store/agent-runtime-store';
// Import the data modules directly. The `note-link` / `note-mention` /
// `tag-mention` barrels also re-export their TipTap Node views, which dragged
// ProseMirror into the desktop startup graph for two cache helpers.
import { invalidateNotebookCache, prewarmNotebookCache } from '@features/editor/extensions/note-link/memo-resolver';
import { invalidateMentionNotes } from '@features/editor/extensions/note-mention/note-mention-data';
import { invalidateMentionTags } from '@features/editor/extensions/tag-mention/tag-mention-data';
import { cloud, listenToAgentWorkspaceChanges, listenToCloudStateChanges, type CloudState } from '@platform/tauri/client';
import { syncPiCloudModelCatalog } from '@features/agent/services/pi-cloud-model-service';
import { acquireMemoEventBridge } from '@/lib/memo-dispatcher';
import { runStartupStage3Task } from '@/lib/startup-stage3';
import { waitForWorkspaceRestoration } from './main-window-startup';

/**
 * Agent infrastructure shared by every content-capable Webview.
 *
 * Tauri content Webviews own their live Agent projection and backend hydration.
 * The browser column lives in the main Webview and therefore reuses this
 * infrastructure; preferences intentionally does not mount this component.
 */
export function AgentWindowEffects() {
  useAgentEvents(waitForWorkspaceRestoration);
  useEffect(() => acquireMemoEventBridge(), []);
  const refreshAgentRuntime = useAgentRuntimeStore((state) => state.refresh);
  useEffect(() => {
    void runStartupStage3Task('agent-runtime-status-refresh', () => {
      // The native status command owns the CLI-discovery dependency for every
      // consumer, including refreshes initiated by feature-specific views.
      return refreshAgentRuntime({ force: true });
    });
  }, [refreshAgentRuntime]);

  useEffect(() => {
    let active = true;
    const receiveCloudState = (state: CloudState) => {
      if (!active) return;
      void syncPiCloudModelCatalog(state).catch((error) => {
        console.warn('[agent-catalog] failed to load Flowix Cloud Pi models after sign-in', error);
      });
    };
    const refreshSnapshot = () => {
      void cloud.getState().then(receiveCloudState).catch((error) => {
        console.warn('[agent-catalog] failed to read Flowix Cloud session state', error);
      });
    };
    const unlisten = listenToCloudStateChanges(receiveCloudState, { onListenerReady: refreshSnapshot });
    refreshSnapshot();
    return () => {
      active = false;
      unlisten();
    };
  }, []);

  useEffect(() => {
    void runStartupStage3Task('agent-note-link-cache-prewarm', prewarmNotebookCache);
  }, []);

  useEffect(() => {
    return listenToAgentWorkspaceChanges(() => {
      invalidateNotebookCache();
      invalidateMentionNotes();
      invalidateMentionTags();
      void prewarmNotebookCache();
    });
  }, []);

  return null;
}
