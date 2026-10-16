import { useAgentDataStore } from '@features/agent/store/agent-data-store';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';

export interface WorkspaceAgentRepository {
  path: string;
  name: string;
  missing: boolean;
}

/** Restore a persisted conversation through the Agent-owned session lifecycle. */
export async function hydrateWorkspaceAgentConversation(instanceId: string) {
  return useAgentSessionStore.getState().hydrateInstance(instanceId);
}

/** Whether the current process already has this conversation instance in memory. */
export function hasWorkspaceAgentConversation(instanceId: string): boolean {
  return useAgentSessionStore.getState().getInstance(instanceId) !== null;
}

/** Resolve resource roots without exposing Agent access configuration stores. */
export function getWorkspaceAgentResourceFolders(notebookId: string | null): string[] {
  if (!notebookId) return [];
  return useAgentDataStore.getState().workspace.byNotebookId[notebookId]
    ?.addDirs.filter((directory) => directory.enabled && !directory.missing)
    .map((directory) => directory.path) ?? [];
}

/** Resolve the same notebook-scoped repository list used by Agent access settings. */
export function getWorkspaceAgentRepositories(
  notebookId: string | null,
): WorkspaceAgentRepository[] {
  if (!notebookId) return [];
  const notebook = useAgentDataStore.getState().workspace.byNotebookId[notebookId];
  return (notebook?.addDirs ?? [])
    .filter((directory) => directory.enabled && !directory.missing)
    .map((directory) => ({
      path: directory.path,
      name: directory.label,
      missing: directory.missing,
    }));
}
