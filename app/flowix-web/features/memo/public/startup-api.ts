import { useNoteStore } from '@features/memo/store/note-store';
import { getMemoListViewPreference } from '@features/preferences/public/runtime-api';
import { useSettingsStore } from '@/lib/store/settings-store';

/** The single list data source required by the restored first screen. */
export function getStartupListTask(): 'memo-list' | 'folder-list' | 'conversation-list' | null {
  const noteState = useNoteStore.getState();
  if (!noteState.selectedNotebook || !useSettingsStore.getState().memoListVisible) return null;
  if (noteState.middleColumnView === 'conversations') return 'conversation-list';
  return getMemoListViewPreference() === 'folders'
    ? 'folder-list'
    : 'memo-list';
}
