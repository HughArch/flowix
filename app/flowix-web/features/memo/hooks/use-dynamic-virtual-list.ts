import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type RefObject,
} from 'react';
import {
  defaultRangeExtractor,
  observeElementRect,
  useVirtualizer,
  type Range,
  type Rect,
  type Virtualizer,
} from '@tanstack/react-virtual';

const DEFAULT_OVERSCAN = 8;
const MIN_ITEM_SIZE = 1;

interface DynamicVirtualItem<T> {
  key: string;
  index: number;
  item: T;
  start: number;
  size: number;
}

interface DynamicVirtualListOptions<T> {
  items: readonly T[];
  getKey: (item: T) => string;
  estimateSize: (item: T, index: number) => number;
  scrollerRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  /** Reset scroll position and measurements when the query changes. */
  resetKey?: string;
  overscan?: number;
  keepAliveKeys?: readonly string[];
  /** Height of non-virtual content before this list in the same scroller. */
  scrollMargin?: number;
}

function observeUsableRect(
  lastUsableRect: { current: Rect | null },
) {
  return (
    instance: Virtualizer<HTMLDivElement, HTMLDivElement>,
    onChange: (rect: Rect) => void,
  ) => observeElementRect(instance, (observedRect) => {
    const element = instance.scrollElement;
    const rect = {
      width: observedRect.width || element?.clientWidth || 0,
      height: observedRect.height || element?.clientHeight || 0,
    };
    if (rect.width > 0 && rect.height > 0) {
      lastUsableRect.current = rect;
      onChange(rect);
      return;
    }

    // Hidden workspace columns temporarily report zero geometry. Keep the
    // last usable viewport so the list stays virtualized while hidden.
    if (!lastUsableRect.current) onChange(rect);
  });
}

/** Shared TanStack Virtual adapter for memo cards and notebook tree rows. */
export function useDynamicVirtualList<T>({
  items,
  getKey,
  estimateSize,
  scrollerRef,
  enabled,
  resetKey,
  overscan = DEFAULT_OVERSCAN,
  keepAliveKeys = [],
  scrollMargin = 0,
}: DynamicVirtualListOptions<T>) {
  const lastUsableRectRef = useRef<Rect | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const itemIndexesRef = useRef(new Map<string, number>());
  const measureRefCacheRef = useRef(
    new Map<string, (element: HTMLDivElement | null) => void>(),
  );

  const keys = useMemo(() => items.map(getKey), [getKey, items]);
  itemIndexesRef.current = new Map(keys.map((key, index) => [key, index]));

  const getScrollElement = useCallback(() => scrollerRef.current, [scrollerRef]);
  const getItemKey = useCallback((index: number) => keys[index] ?? index, [keys]);
  const rangeExtractor = useCallback((range: Range) => {
    const indexes = new Set(defaultRangeExtractor(range));
    for (const key of keepAliveKeys) {
      const index = itemIndexesRef.current.get(key);
      if (index !== undefined) indexes.add(index);
    }
    return [...indexes].sort((a, b) => a - b);
  }, [keepAliveKeys]);
  const getEstimatedSize = useCallback(
    (index: number) => Math.max(MIN_ITEM_SIZE, estimateSize(items[index], index)),
    [estimateSize, items],
  );
  const measureElement = useCallback((element: HTMLDivElement) => Math.max(
    MIN_ITEM_SIZE,
    Math.ceil(element.getBoundingClientRect().height),
  ), []);
  const observeRect = useMemo(
    () => observeUsableRect(lastUsableRectRef),
    [],
  );
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: items.length,
    getScrollElement,
    getItemKey,
    estimateSize: getEstimatedSize,
    measureElement,
    observeElementRect: observeRect,
    rangeExtractor,
    overscan: Math.max(0, Math.floor(overscan)),
    scrollMargin,
    initialRect: { width: 0, height: 0 },
    enabled,
  });
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;

  const lastResetKeyRef = useRef(resetKey);
  useLayoutEffect(() => {
    if (lastResetKeyRef.current === resetKey) return;
    lastResetKeyRef.current = resetKey;
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
    virtualizer.measure();
  }, [resetKey, scrollerRef, virtualizer]);

  const previousWidthRef = useRef(0);
  const viewportWidth = virtualizer.scrollRect?.width ?? 0;
  useLayoutEffect(() => {
    if (!enabled || viewportWidth <= 0) return;
    const previousWidth = previousWidthRef.current;
    previousWidthRef.current = viewportWidth;
    if (previousWidth === 0 || previousWidth === viewportWidth) return;

    // Width changes invalidate cached heights. Reset and synchronously
    // remeasure only the mounted virtual window; TanStack keeps the scroll
    // anchor stable as changed rows above the viewport are measured.
    virtualizer.measure();
    scrollerRef.current?.querySelectorAll<HTMLDivElement>('[data-index]').forEach((element) => {
      virtualizer.measureElement(element);
    });
  }, [enabled, scrollerRef, viewportWidth, virtualizer]);

  const totalSize = virtualizer.getTotalSize();
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!enabled || !scroller) return;
    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (scroller.scrollTop > maxScrollTop) virtualizer.scrollToOffset(maxScrollTop);
  }, [enabled, scrollerRef, totalSize, virtualizer]);

  const getMeasureRef = useCallback((key: string) => {
    const cached = measureRefCacheRef.current.get(key);
    if (cached) return cached;

    const ref = (element: HTMLDivElement | null) => {
      if (element) {
        const index = itemIndexesRef.current.get(key);
        if (index !== undefined) element.dataset.index = String(index);
      }
      if (enabledRef.current) virtualizerRef.current.measureElement(element);
      if (!element) measureRefCacheRef.current.delete(key);
    };

    measureRefCacheRef.current.set(key, ref);
    return ref;
  }, []);

  const measuredItems = virtualizer.getVirtualItems();
  const virtualItems = useMemo<DynamicVirtualItem<T>[]>(() => {
    if (!enabled) return [];
    if (!lastUsableRectRef.current) {
      let start = 0;
      return items.map((item, index) => {
        const size = Math.max(MIN_ITEM_SIZE, estimateSize(item, index));
        const virtualItem = { key: keys[index], index, item, start, size };
        start += size;
        return virtualItem;
      });
    }

    return measuredItems.map((virtualItem) => ({
      key: String(virtualItem.key),
      index: virtualItem.index,
      item: items[virtualItem.index],
      start: virtualItem.start - scrollMargin,
      size: virtualItem.size,
    }));
  }, [enabled, estimateSize, items, keys, measuredItems, scrollMargin]);

  return {
    totalSize: enabled ? totalSize : 0,
    virtualItems,
    isVirtualizationReady: enabled && lastUsableRectRef.current !== null,
    getMeasureRef,
  };
}
