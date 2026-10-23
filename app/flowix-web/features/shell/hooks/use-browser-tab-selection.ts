import { useEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';

export type BrowserTabSelectionHandler = (tabId: string) => boolean | Promise<boolean>;

/** Keep optimistic selection and failed-navigation focus recovery in one place. */
export function useBrowserTabSelection({ tabs, activeTabId, buttons, onSelectTab, onFailure }: {
  tabs: readonly { id: string }[];
  activeTabId: string | null;
  buttons: RefObject<Map<string, HTMLButtonElement>>;
  onSelectTab: BrowserTabSelectionHandler;
  onFailure: () => void;
}) {
  const requestId = useRef(0);
  const activeId = useRef(activeTabId);
  activeId.current = activeTabId;
  const [pendingId, setPendingId] = useState<string | null>(null);

  useEffect(() => {
    if (pendingId === activeTabId || (pendingId && !tabs.some((tab) => tab.id === pendingId))) setPendingId(null);
  }, [activeTabId, pendingId, tabs]);
  useEffect(() => () => { requestId.current++; }, []);

  const selectTab = async (tabId: string) => {
    const request = ++requestId.current;
    // Paint the requested tab before the caller mounts/parses heavy content.
    flushSync(() => setPendingId(tabId));
    let succeeded = false;
    try { succeeded = await onSelectTab(tabId) === true; }
    catch { /* A failed save leaves the active document in place. */ }
    if (succeeded || request !== requestId.current || buttons.current.size === 0) return;
    setPendingId(null);
    if (document.activeElement === buttons.current.get(tabId)) {
      const activeButton = activeId.current ? buttons.current.get(activeId.current) : undefined;
      activeButton?.focus();
      activeButton?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
    onFailure();
  };
  return { displayedActiveTabId: pendingId ?? activeTabId, selectTab };
}
