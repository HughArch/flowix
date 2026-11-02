import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

export const BROWSER_TAB_SIZE = { height: 32, fullMin: 96, fullMax: 150, trailing: 8 } as const;

export function shouldCompactBrowserTabs(width: number, count: number, gap: number, trailingSpace: number): boolean {
  return count > 0 && width < count * BROWSER_TAB_SIZE.fullMin + Math.max(0, count - 1) * gap + trailingSpace;
}

/** Observe pixels without storing them in React state: only a mode change rerenders the header. */
export function useBrowserTabLayout(
  tabs: ReadonlyArray<{ id: string }>,
  activeId: string | null,
  buttons: RefObject<Map<string, HTMLButtonElement>>,
) {
  const tabListRef = useRef<HTMLDivElement>(null);
  const [compactTabs, setCompactTabs] = useState(false);
  const compactRef = useRef(false);
  const order = JSON.stringify(tabs.map((tab) => tab.id));

  useLayoutEffect(() => {
    const list = tabListRef.current;
    if (!list) return;
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      const styles = getComputedStyle(list);
      const padding = (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0);
      const gap = parseFloat(styles.columnGap) || 0;
      // The strip also contains an 8px context-menu target after the final tab.
      const compact = shouldCompactBrowserTabs(list.clientWidth - padding, tabs.length, gap, BROWSER_TAB_SIZE.trailing + (tabs.length ? gap : 0));
      if (compactRef.current !== compact) {
        compactRef.current = compact;
        setCompactTabs(compact);
      }
      const button = activeId ? buttons.current.get(activeId) : undefined;
      if (button) {
        const item = button.parentElement;
        const viewport = list.getBoundingClientRect();
        const rect = item?.getBoundingClientRect();
        if (rect && (rect.left < viewport.left || rect.right > viewport.right)) {
          button.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        }
      }
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(measure);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(list);
    window.addEventListener('resize', schedule);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [order, activeId, compactTabs, buttons]);

  return { tabListRef, compactTabs };
}
