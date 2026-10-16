import { getWorkspaceAgentRepositories } from "@features/agent/public/workspace-api";
import { useNoteStore } from "@features/memo/store/note-store";
import type { ComposerFolderReference } from "./composer-folder-controller";

/** Read the folders configured for the notebook that owns the current note. */
export function getCurrentNotebookComposerFolders(): readonly ComposerFolderReference[] {
  const memoState = useNoteStore.getState();
  const notebook = memoState.selectedNotebook;
  if (!notebook) return [];

  return getWorkspaceAgentRepositories(notebook.id).map((repository) => ({
    path: repository.path,
    name: repository.name,
  }));
}
