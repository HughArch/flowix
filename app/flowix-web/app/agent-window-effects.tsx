'use client';

import { useEffect } from 'react';
import { useAgentEvents } from '@features/agent/hooks/use-agent-events';
import { useAgentRuntimeStore } from '@features/agent/store/agent-runtime-store';
import { invalidateNotebookCache, prewarmNotebookCache } from '@features/editor/extensions/note-link';
import { invalidateMentionNotes } from '@features/editor/extensions/note-mention';
import { invalidateMentionTags } from '@features/editor/extensions/tag-mention';
import { listenToAgentAccessChanges } from '@platform/tauri/client';
import { acquireMemoEventBridge } from '@/lib/memo-dispatcher';

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
  useEffect(() => {
    void refreshAgentRuntime({ force: true });
  }, [refreshAgentRuntime]);

  useEffect(() => {
    return listenToAgentAccessChanges(() => {
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
