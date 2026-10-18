import { getCurrentWindow } from '@tauri-apps/api/window';
import { subscribe } from '@platform/tauri/event-bus';
import { subscribeNotebookChanges } from '@platform/tauri/notebook-change-events';
import { useNoteStore } from '@features/memo/store/note-store';

const REFRESH_BATCH_WINDOW_MS = 24;

/** Owns application-level invalidation for the selected notebook's note views. */
export function mountMemoListRefreshService(): () => void {
  const pending = new Map<string, 'list' | 'notebook-views'>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let currentWindowLabel: string | null = null;
  try {
    currentWindowLabel = getCurrentWindow().label;
  } catch {
    // Browser preview has no Tauri window label.
  }

  const flush = () => {
    timer = null;
    if (disposed) return;
    const pendingNotebookIds = new Map(pending);
    pending.clear();
    const state = useNoteStore.getState();
    const selectedNotebookId = state.selectedNotebook?.id;
    if (!selectedNotebookId) return;
    const scope = pendingNotebookIds.get(selectedNotebookId);
    if (scope === 'notebook-views') state.triggerRefresh();
    else if (scope === 'list') state.triggerMemoListRefresh();
  };

  const schedule = (notebookId: string, scope: 'list' | 'notebook-views') => {
    if (disposed) return;
    const current = pending.get(notebookId);
    pending.set(notebookId, current === 'notebook-views' || scope === 'notebook-views'
      ? 'notebook-views'
      : 'list');
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, REFRESH_BATCH_WINDOW_MS);
  };

  const stopNotebookChanges = subscribeNotebookChanges((change) => {
    // The initiating window applies command-created notes from the command
    // result. Other windows refresh their own selected list projection.
    if (change.kind === 'resource-created'
      && currentWindowLabel
      && change.originWindowLabel === currentWindowLabel) return;
    schedule(change.notebookId, 'list');
  });
  const stopFileManagement = subscribe<{ notebookId: string; operationId?: string }>(
    'file-management-changed',
    ({ notebookId, operationId }) => {
      // Collection operations also publish a structured path change, which is
      // enough to refresh the list. Unscoped maintenance events affect all
      // notebook views, matching the previous broad refresh behavior.
      if (operationId) return;
      schedule(notebookId, 'notebook-views');
    },
  );

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    pending.clear();
    stopNotebookChanges();
    stopFileManagement();
  };
}
