import { useShallow } from 'zustand/react/shallow';
import { useNoteStore } from '@features/memo/store/note-store';
import { noteRepository, notebookRepository } from '@features/memo/services/note-repository';

export { MemoList } from '@features/memo/components/memo-list';
export { useNotebookNoteIcons } from '@features/memo/hooks/use-notebook-note-icons';
export { NotebookNoteTabIcon } from '@features/memo/components/notebook-note-tab-icon';
export { NotebookTreeFileIcon } from '@features/memo/components/notebook-tree-file-icon';
export { useMemoListHoverPreview } from '@features/memo/components/use-memo-list-hover-preview';
export { MemoListTitlebarWin } from '@features/memo/components/memo-list-titlebar-win';
export { MemoListTitlebarMac } from '@features/memo/components/memo-list-titlebar-mac';
export { NoteNavigationPanel } from '@features/memo/components/note-navigation-panel';
export {
  NoteNavigationDrawer,
  type NoteNavigationDrawerPhase,
} from '@features/memo/components/note-navigation-drawer';
export { MemoListServicesHost } from '@features/memo/components/memo-list-services-host';
export { useNotebookTodoCount } from '@features/memo/components/use-notebook-todo-count';
export {
  type MemoItem,
  type Notebook,
} from '@features/memo/store';
export { startNotebookImportWithMonitoring } from '@features/memo/services/notebook-creation-service';

/** Persist a notebook template task; the application coordinator starts it when the workspace is ready. */
export async function ensureShellNotebookTemplateSetup(
  notebookId: string,
  templateId: string,
  overwriteExisting = false,
) {
  return notebookRepository.ensureTemplateSetup(notebookId, templateId, overwriteExisting);
}

export function confirmShellNotebookTemplateOverwrite(message: string) {
  return notebookRepository.confirmPresetOverwrite(message);
}

export function useShellSelectedNotebook() {
  return useNoteStore((state) => state.selectedNotebook);
}

export async function createShellNote(notebookId: string) {
  const created = await noteRepository.create(undefined, notebookId);
  useNoteStore.getState().upsertCreatedNote(created);
  return created;
}

export function useShellMemoViewModel() {
  return useNoteStore(useShallow((state) => ({
    notebooks: state.notebooks,
    selectedNotebook: state.selectedNotebook,
    startupPhase: state.startupPhase,
    middleColumnView: state.middleColumnView,
    activeFilter: state.activeFilter,
    activePluginId: state.activePluginId,
    activeSort: state.activeSort,
    setActiveFilter: state.setActiveFilter,
    setMiddleColumnView: state.setMiddleColumnView,
    loadNotes: state.loadNotes,
    triggerRefresh: state.triggerRefresh,
  })));
}

export function showAgentConversationsView(): void {
  useNoteStore.getState().setMiddleColumnView('conversations');
}

/** The one list data source that must be ready before the workspace is shown. */
