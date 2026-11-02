import { create } from 'zustand';
import type { AgentWorkspaceSnapshot, AgentWorkspaceResource } from '@/lib/types/agent-workspace';
import { createAgentWorkspaceSlice, type AgentWorkspaceSliceStoreState } from './agent-workspace-slice';

export type {
  AgentAccessErrorCode,
  AgentWorkspaceActions,
  AgentWorkspaceLoadState,
  AgentWorkspaceLoadStatus,
  AgentWorkspaceNotebook,
  AgentWorkspaceState,
} from './agent-workspace-slice';

export interface AgentWorkspaceStoreState extends AgentWorkspaceSliceStoreState {}

export function projectAgentWorkspace(
  snapshot: AgentWorkspaceSnapshot,
): Pick<AgentWorkspaceStoreState['workspace'], 'resources' | 'byNotebookId' | 'validatedAt'> {
  const resourcesByPath = new Map<string, AgentWorkspaceResource>();
  const byNotebookId: AgentWorkspaceStoreState['workspace']['byNotebookId'] = {};
  for (const notebook of snapshot.notebooks) {
    const addDirs = (snapshot.notebookConfigs[notebook.id]?.addDirs ?? []).map((directory) => {
      const missing = !!directory.missing;
      if (!resourcesByPath.has(directory.path)) {
        resourcesByPath.set(directory.path, {
          id: directory.id,
          path: directory.path,
          name: directory.label,
          enabled: directory.enabled,
          missing,
        });
      }
      const resource = resourcesByPath.get(directory.path)!;
      resource.enabled ||= directory.enabled;
      return { ...directory, missing };
    });
    byNotebookId[notebook.id] = { notebook, addDirs };
  }
  return { resources: [...resourcesByPath.values()], byNotebookId, validatedAt: Date.now() };
}

export const useAgentWorkspaceStore = create<AgentWorkspaceStoreState>((set, get) => {
  const workspaceActions = createAgentWorkspaceSlice(
    get,
    (snapshot) => set((state) => ({
      workspace: { ...state.workspace, ...projectAgentWorkspace(snapshot) },
    })),
    (workspace) => set((state) => ({
      loadState: { ...state.loadState, workspace },
    })),
  );

  return {
    workspace: { resources: [], byNotebookId: {} },
    loadState: { workspace: { status: 'idle' } },
    workspaceActions,
  };
});

/** Agent submissions wait for the backend-owned notebook access snapshot. */
export async function ensureAgentWorkspaceReady(): Promise<void> {
  if (useAgentWorkspaceStore.getState().loadState.workspace.status === 'ready') return;
  await useAgentWorkspaceStore.getState().workspaceActions.loadInitial();
  if (useAgentWorkspaceStore.getState().loadState.workspace.status === 'loading') {
    await new Promise<void>((resolve) => {
      const unsubscribe = useAgentWorkspaceStore.subscribe((state) => {
        if (state.loadState.workspace.status !== 'loading') {
          unsubscribe();
          resolve();
        }
      });
    });
  }

  const loadState = useAgentWorkspaceStore.getState().loadState.workspace;
  if (loadState.status !== 'ready') {
    throw new Error(loadState.error ?? 'Workspace data is not ready');
  }
}
