import { create } from 'zustand';
import type { NotebookBackgroundStatus } from '@platform/tauri/client/memos';

const rank = { queued: 0, running: 1, ready: 2, failed: 2 };
export const useNotebookBackgroundStore = create<{
  statuses: Record<string, NotebookBackgroundStatus>;
  apply: (status: NotebookBackgroundStatus) => boolean;
  pending: (notebookId: string, force?: boolean) => void;
}>()((set, get) => ({
  statuses: {},
  apply: (status) => {
    const previous = get().statuses[status.notebookId];
    if (previous && (previous.revision > status.revision
      || (previous.revision === status.revision && rank[previous.state] >= rank[status.state]))) return false;
    set((state) => ({ statuses: { ...state.statuses, [status.notebookId]: status } }));
    return true;
  },
  pending: (notebookId, force = false) => {
    const previous = get().statuses[notebookId]?.state;
    if (!force && (previous === 'running' || previous === 'ready' || previous === 'failed')) return;
    set((state) => ({ statuses: { ...state.statuses, [notebookId]: {
      notebookId, state: 'queued', revision: state.statuses[notebookId]?.revision ?? 0, message: null,
    } } }));
  },
}));
