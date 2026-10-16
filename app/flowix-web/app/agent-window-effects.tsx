'use client';

import { useEffect } from 'react';
import { useAgentEvents } from '@features/agent/hooks/use-agent-events';
import { useAgentRuntimeStore } from '@features/agent/store/agent-runtime-store';
import { prefetchAvailableAgentModels, prefetchNotebookSkills } from '@features/agent/services/agent-catalog-service';
import { invalidateNotebookCache, prewarmNotebookCache } from '@features/editor/extensions/note-link';
import { invalidateMentionNotes } from '@features/editor/extensions/note-mention';
import { invalidateMentionTags } from '@features/editor/extensions/tag-mention';
import { listenToAgentWorkspaceChanges } from '@platform/tauri/client';
import { acquireMemoEventBridge } from '@/lib/memo-dispatcher';
import { useNoteStore } from '@features/memo/store/note-store';

/**
 * Agent infrastructure shared by every content-capable Webview.
 *
 * Tauri content Webviews own their live Agent projection and backend hydration.
 * The browser column lives in the main Webview and therefore reuses this
 * infrastructure; preferences intentionally does not mount this component.
 */
export function AgentWindowEffects() {
  useAgentEvents();
  useEffect(() => acquireMemoEventBridge(), []);
  const refreshAgentRuntime = useAgentRuntimeStore((state) => state.refresh);
  const runtimeStatusByType = useAgentRuntimeStore((state) => state.statusByType);
  const selectedNotebook = useNoteStore((state) => state.selectedNotebook);
  useEffect(() => {
    void refreshAgentRuntime({ force: true });
  }, [refreshAgentRuntime]);

  useEffect(() => {
    const available = Object.fromEntries(
      Object.entries(runtimeStatusByType ?? {}).map(([agentType, status]) => [agentType, status?.readiness === 'ready']),
    );
    prefetchAvailableAgentModels(available);
  }, [runtimeStatusByType]);

  useEffect(() => {
    const notebookId = selectedNotebook?.id;
    const notebookPath = selectedNotebook?.path;
    if (!notebookId || !notebookPath) return;
    if (runtimeStatusByType?.codex?.readiness === 'ready') {
      prefetchNotebookSkills('codex', notebookId, notebookPath);
    }
    if (runtimeStatusByType?.pi?.readiness === 'ready') {
      prefetchNotebookSkills('pi', notebookId, notebookPath);
    }
  }, [runtimeStatusByType, selectedNotebook?.id, selectedNotebook?.path]);

  useEffect(() => {
    return listenToAgentWorkspaceChanges(() => {
      invalidateNotebookCache();
      invalidateMentionNotes();
      invalidateMentionTags();
      void prewarmNotebookCache();
    });
  }, []);

  useEffect(() => {
    void prewarmNotebookCache();
  }, []);

  return null;
}
