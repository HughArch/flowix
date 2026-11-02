import { useBrowserColumnStore } from '../store/browser-column-store';
import {
  discardActiveBrowserColumnDocument,
  enqueueBrowserColumnNavigation,
  flushActiveBrowserColumnDocument,
} from './browser-column-coordinator';

type CloseRequest =
  | { kind: 'tab' | 'others' | 'right'; tabId: string }
  | { kind: 'all' };
type CloseOptions = { discardChanges?: boolean };

/** Evaluate the close set and its save barrier in the same navigation transaction. */
function closeTabs(request: CloseRequest, options?: CloseOptions): Promise<boolean | null> {
  return enqueueBrowserColumnNavigation(async () => {
    const state = useBrowserColumnStore.getState();
    const targetIndex = request.kind === 'all' ? -1 : state.tabs.findIndex((tab) => tab.id === request.tabId);
    if (request.kind !== 'all' && targetIndex < 0) return true;
    const activeIndex = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
    const closesActive = activeIndex >= 0 && (
      request.kind === 'all'
      || (request.kind === 'tab' && activeIndex === targetIndex)
      || (request.kind === 'others' && activeIndex !== targetIndex)
      || (request.kind === 'right' && activeIndex > targetIndex)
    );
    if (closesActive) {
      const discarded = options?.discardChanges && discardActiveBrowserColumnDocument();
      if (!discarded && !await flushActiveBrowserColumnDocument({ silent: true })) return null;
    }
    switch (request.kind) {
      case 'tab': state.closeTab(request.tabId); break;
      case 'others': state.closeOtherTabs(request.tabId); break;
      case 'right': state.closeTabsToRight(request.tabId); break;
      case 'all': state.closeAllTabs(); break;
    }
    return true;
  }, { flush: false });
}

export function closeBrowserColumnTab(tabId: string, options?: CloseOptions) {
  return closeTabs({ kind: 'tab', tabId }, options);
}

export function closeOtherBrowserColumnTabs(tabId: string, options?: CloseOptions) {
  return closeTabs({ kind: 'others', tabId }, options);
}

export function closeBrowserColumnTabsToRight(tabId: string, options?: CloseOptions) {
  return closeTabs({ kind: 'right', tabId }, options);
}

export function closeAllBrowserColumnTabs(options?: CloseOptions) {
  return closeTabs({ kind: 'all' }, options);
}
