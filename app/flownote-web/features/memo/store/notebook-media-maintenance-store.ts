import { create } from 'zustand';
import type { NotebookMediaMaintenanceStatus } from '@platform/tauri/client/memos';

const rank = { queued: 0, running: 1, ready: 2, failed: 2 };

export const useNotebookMediaMaintenanceStore = create<{
  statuses: Record<string, NotebookMediaMaintenanceStatus>;
  apply: (status: NotebookMediaMaintenanceStatus) => boolean;
}>()((set, get) => ({
  statuses: {},
  apply: (status) => {
    const previous = get().statuses[status.notebookId];
    if (previous && (previous.revision > status.revision
      || (previous.revision === status.revision && rank[previous.state] >= rank[status.state]))) return false;
    set((state) => ({ statuses: { ...state.statuses, [status.notebookId]: status } }));
    return true;
  },
}));
