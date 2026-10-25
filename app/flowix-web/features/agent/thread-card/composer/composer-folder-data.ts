import { getWorkspaceAgentRepositories } from "@features/agent/public/workspace-api";
import { useNoteStore } from "@features/memo/store/note-store";
import { isMobileDevice } from "@shared/platform";
import type { ComposerFolderReference } from "./composer-folder-controller";

/**
 * Read the folders configured for the notebook that owns the current note.
 *
 * 移动端仓库（资料库/add-dir）功能是隐藏的：composer 的 @ 菜单不应出现
 * 「引用仓库」分组，也不提供添加仓库的入口。
 */
export function getCurrentNotebookComposerFolders(): readonly ComposerFolderReference[] {
  if (isMobileDevice()) return [];
  const memoState = useNoteStore.getState();
  const notebook = memoState.selectedNotebook;
  if (!notebook) return [];

  return getWorkspaceAgentRepositories(notebook.id).map((repository) => ({
    path: repository.path,
    name: repository.name,
  }));
}
