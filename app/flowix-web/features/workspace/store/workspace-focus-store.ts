import { create } from 'zustand';
import type { WorkspaceHostId } from '@features/workspace/public/host-api';

export type { WorkspaceHostId } from '@features/workspace/public/host-api';

interface WorkspaceFocusState {
  focusedHostId: WorkspaceHostId;
  focusHost: (hostId: WorkspaceHostId) => void;
  reset: () => void;
}

export const useWorkspaceFocusStore = create<WorkspaceFocusState>((set) => ({
  focusedHostId: 'main-third',
  focusHost: (focusedHostId) => set((state) => (
    state.focusedHostId === focusedHostId ? state : { focusedHostId }
  )),
  reset: () => set({ focusedHostId: 'main-third' }),
}));
