import { useEffect, type RefObject } from 'react';

export function useTableScrollLoading({ enabled, scrollerRef, sentinelRef, page, pageCount, onLoadMore }: {
  enabled: boolean;
  scrollerRef: RefObject<HTMLDivElement | null>;
  sentinelRef: RefObject<HTMLDivElement | null>;
  page: number;
  pageCount: number;
  onLoadMore: () => void;
}) {
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const scroller = scrollerRef.current;
    if (!enabled || page >= pageCount - 1 || !sentinel || !scroller) return;
    if (typeof IntersectionObserver === 'undefined') return;
    let requested = false;
    const observer = new IntersectionObserver((entries) => {
      if (requested || !entries.some((entry) => entry.isIntersecting)) return;
      requested = true;
      observer.disconnect();
      onLoadMore();
    }, { root: scroller, rootMargin: '0px 0px 200px 0px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [enabled, scrollerRef, sentinelRef, page, pageCount, onLoadMore]);
}
