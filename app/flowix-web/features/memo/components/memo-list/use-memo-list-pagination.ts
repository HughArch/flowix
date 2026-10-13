import { useCallback, useLayoutEffect, useMemo, type RefObject, type UIEvent } from 'react';

import type { ColorFilterValue } from '@features/memo/store/note-store';
import type { NoteListItem } from '@/types/note-item';

const LOAD_MORE_THRESHOLD_PX = 720;

interface MemoListPaginationOptions {
  memos: NoteListItem[];
  activeFilter: string;
  colorFilter: ColorFilterValue;
  loading: boolean;
  hasMorePages: boolean;
  loadingMorePages: boolean;
  loadMorePages: () => void;
  scrollerRef: RefObject<HTMLDivElement | null>;
  isActive: boolean;
}

/** Filters loaded pages and requests the next backend page near the list end. */
export function useMemoListPagination({
  memos,
  activeFilter,
  colorFilter,
  loading,
  hasMorePages,
  loadingMorePages,
  loadMorePages,
  scrollerRef,
  isActive,
}: MemoListPaginationOptions) {
  const filteredMemos = useMemo(() => {
    if (activeFilter !== 'color') return memos;
    if (colorFilter === 'any') return memos.filter((memo) => memo.colors.length > 0);
    if (colorFilter === 'none') return memos.filter((memo) => memo.colors.length === 0);
    return memos.filter((memo) => memo.colors.includes(colorFilter));
  }, [activeFilter, colorFilter, memos]);

  const loadWhenNearEnd = useCallback((scroller: HTMLDivElement | null) => {
    if (!isActive || loading || loadingMorePages || !hasMorePages || !scroller) return;
    const distanceToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (distanceToBottom <= LOAD_MORE_THRESHOLD_PX) loadMorePages();
  }, [hasMorePages, isActive, loadMorePages, loading, loadingMorePages]);

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    loadWhenNearEnd(event.currentTarget);
  }, [loadWhenNearEnd]);

  // Continue filling short viewports and heavily filtered pages until there
  // is enough content to scroll or the backend has no more pages.
  useLayoutEffect(() => {
    loadWhenNearEnd(scrollerRef.current);
  }, [filteredMemos.length, hasMorePages, isActive, loading, loadingMorePages, loadWhenNearEnd, scrollerRef]);

  return { filteredMemos, onScroll };
}
