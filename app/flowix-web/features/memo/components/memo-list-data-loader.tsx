import { useEffect, useRef } from 'react';
import {
  type ColorFilterValue,
  type ExtendedFilterType,
  type NoteLibraryStartupPhase,
  type NoteLibraryStore,
} from '@features/memo/store/note-store';
import type { SortType } from '@features/memo/services';
import { getMemoListQueryKey } from './memo-list-loading-state';

export interface MemoListDataLoaderProps {
  dataLoadingEnabled: boolean;
  startupPhase: NoteLibraryStartupPhase;
  initialMemoQueryKey: string | null;
  memoListQueryKey: string | null;
  selectedNotebookId: string | undefined;
  activeFilter: ExtendedFilterType;
  activeSort: SortType;
  activeTagId: string | null;
  colorFilter: ColorFilterValue;
  activePluginId: string | null;
  activeCustomFilterId?: string | null;
  refreshTrigger: number;
  loadNotes: NoteLibraryStore['loadNotes'];
  setLoadedMemoListQueryKey: (queryKey: string | null) => void;
  setIsMemoListLoading: (loading: boolean) => void;
  onLoadError: (error: unknown) => void;
  onLoadStart?: (queryKey: string) => void;
  onLoadSuccess?: (queryKey: string) => void;
  onStartupLoadSettled?: (queryKey: string, outcome: 'ready' | 'failed') => void;
}

/**
 * Owns the memo-list query effect separately from the large list view.
 * Keeping this as a small component makes the startup/no-duplicate-request
 * contract directly testable without mounting the whole navigation surface.
 */
export function MemoListDataLoader({
  dataLoadingEnabled,
  startupPhase,
  initialMemoQueryKey,
  memoListQueryKey,
  selectedNotebookId,
  activeFilter,
  activeSort,
  activeTagId,
  colorFilter,
  activePluginId,
  activeCustomFilterId,
  refreshTrigger,
  loadNotes,
  setLoadedMemoListQueryKey,
  setIsMemoListLoading,
  onLoadError,
  onLoadStart,
  onLoadSuccess,
  onStartupLoadSettled,
}: MemoListDataLoaderProps) {
  const startupQuerySkippedRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!dataLoadingEnabled) {
      setIsMemoListLoading(false);
      return () => {
        cancelled = true;
      };
    }
    if (startupPhase !== 'ready') {
      setIsMemoListLoading(startupPhase === 'loading');
      return () => {
        cancelled = true;
      };
    }
    if (!selectedNotebookId) {
      setIsMemoListLoading(false);
      setLoadedMemoListQueryKey(null);
      onStartupLoadSettled?.('', 'ready');
      return () => {
        cancelled = true;
      };
    }

    const queryKey = getMemoListQueryKey(
      selectedNotebookId,
      activeFilter,
      activeSort,
      activeTagId,
      colorFilter,
      activePluginId,
      activeCustomFilterId,
    );
    async function loadMemoListOnly() {
      onLoadStart?.(queryKey);
      // The startup orchestrator has already loaded this exact query. Mark it
      // as rendered locally without issuing a duplicate IPC request.
      if (
        initialMemoQueryKey === queryKey
        && memoListQueryKey === queryKey
        && refreshTrigger === 0
        && startupQuerySkippedRef.current !== queryKey
      ) {
        startupQuerySkippedRef.current = queryKey;
        setLoadedMemoListQueryKey(queryKey);
        setIsMemoListLoading(false);
        onLoadSuccess?.(queryKey);
        onStartupLoadSettled?.(queryKey, 'ready');
        return;
      }
      setIsMemoListLoading(true);
      try {
        const applied = await loadNotes({
          notebookId: selectedNotebookId,
          filter: activeFilter,
          sort: activeSort,
          tagId: activeTagId ?? undefined,
        });
        if (cancelled) return;
        if (!applied) {
          // Another request may have loaded the same query while this one was
          // superseded. Accept only that exact applied query; otherwise the
          // rerendered current query owns the next readiness report.
          if (memoListQueryKey === queryKey) {
            setLoadedMemoListQueryKey(queryKey);
            onStartupLoadSettled?.(queryKey, 'ready');
          }
          return;
        }
        setLoadedMemoListQueryKey(queryKey);
        onLoadSuccess?.(queryKey);
        onStartupLoadSettled?.(queryKey, 'ready');
      } catch (error) {
        if (!cancelled) {
          onLoadError(error);
          onStartupLoadSettled?.(queryKey, 'failed');
        }
      } finally {
        if (!cancelled) {
          setIsMemoListLoading(false);
        }
      }
    }

    void loadMemoListOnly();

    return () => {
      cancelled = true;
    };
  }, [
    activeFilter,
    activePluginId,
    activeCustomFilterId,
    activeSort,
    activeTagId,
    colorFilter,
    dataLoadingEnabled,
    initialMemoQueryKey,
    loadNotes,
    memoListQueryKey,
    onLoadError,
    onLoadStart,
    onLoadSuccess,
    onStartupLoadSettled,
    refreshTrigger,
    selectedNotebookId,
    setIsMemoListLoading,
    setLoadedMemoListQueryKey,
    startupPhase,
  ]);

  return null;
}
