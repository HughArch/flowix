import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  canOpenBrowserColumnTargetInWorkColumn,
  useBrowserColumnStore,
  type BrowserColumnTab,
} from '@features/workspace/store/browser-column-store';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';
import {
  activateBrowserColumnTab,
  discardActiveBrowserColumnDocument,
  enqueueBrowserColumnNavigation,
  registerBrowserColumnDocumentFlush,
} from '@features/workspace/use-cases/browser-column-coordinator';
import {
  createFileBrowserTarget,
  removeBrowserColumnTabsByPath,
  selectBrowserColumnFile,
} from '@features/workspace/use-cases/browser-column-navigation';
import { openBrowserColumnTabInWorkColumn } from '@features/workspace/use-cases/surface-opening';

export { openWorkspaceSurface } from './open-surface-api';
export type { OpenWorkspaceSurfaceRequest, BrowserWorkspaceSurfaceRequest } from './open-surface-api';

export {
  createFileBrowserTarget,
  removeBrowserColumnTabsByPath,
  selectBrowserColumnFile,
};
export { openBrowserColumnTabInWorkColumn };

export {
  canOpenBrowserColumnTargetInWorkColumn,
  type BrowserColumnTab,
};
export type { BrowserColumnTarget } from '@features/workspace/store/browser-column-store';

export function useBrowserColumnViewModel() {
  return useBrowserColumnStore(useShallow((state) => {
    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
    const activePath = activeTab?.target.kind === 'file-browser' ? activeTab.target.activeFilePath : null;
    return {
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      activeTab,
      activeWebRuntime: state.activeTabId && activeTab?.target.kind === 'web'
        ? state.webRuntimes[state.activeTabId] ?? null
        : null,
      activePathHasDuplicateTab: activePath !== null
        && state.tabs.filter(
          (tab) => tab.target.kind === 'file-browser' && tab.target.activeFilePath === activePath,
        ).length > 1,
    };
  }));
}

export function useBrowserColumnFocusViewModel() {
  const isFocused = useWorkspaceFocusStore(
    (state) => state.focusedHostId === 'browser-column',
  );
  const focusHost = useWorkspaceFocusStore((state) => state.focusHost);
  const focusBrowserColumn = useCallback(() => focusHost('browser-column'), [focusHost]);
  return { isFocused, focusBrowserColumn };
}

export const selectBrowserColumnTab = activateBrowserColumnTab;
export const registerBrowserColumnFlush = registerBrowserColumnDocumentFlush;

export function hideBrowserColumn(): void {
  useBrowserColumnStore.getState().setVisible(false);
}

export function reorderBrowserColumnTab(tabId: string, beforeTabId: string | null): void {
  useBrowserColumnStore.getState().reorderTab(tabId, beforeTabId);
}

function browserColumnTabExists(tabId: string): boolean {
  return useBrowserColumnStore.getState().tabs.some((tab) => tab.id === tabId);
}

export function closeBrowserColumnTab(
  tabId: string,
  options?: { discardChanges?: boolean },
): Promise<boolean | null> {
  const closesActiveTab = useBrowserColumnStore.getState().activeTabId === tabId;
  const discarded = Boolean(options?.discardChanges && closesActiveTab && discardActiveBrowserColumnDocument());
  return enqueueBrowserColumnNavigation(() => {
    if (browserColumnTabExists(tabId)) useBrowserColumnStore.getState().closeTab(tabId);
    return true;
  }, {
    flush: closesActiveTab && !discarded,
    silentFlush: true,
  });
}

export function closeOtherBrowserColumnTabs(
  tabId: string,
  options?: { discardChanges?: boolean },
): Promise<boolean | null> {
  const closesActiveTab = useBrowserColumnStore.getState().activeTabId !== tabId;
  const discarded = Boolean(options?.discardChanges && closesActiveTab && discardActiveBrowserColumnDocument());
  return enqueueBrowserColumnNavigation(() => {
    if (browserColumnTabExists(tabId)) useBrowserColumnStore.getState().closeOtherTabs(tabId);
    return true;
  }, {
    flush: closesActiveTab && !discarded,
    silentFlush: true,
  });
}

export function closeBrowserColumnTabsToRight(
  tabId: string,
  options?: { discardChanges?: boolean },
): Promise<boolean | null> {
  const state = useBrowserColumnStore.getState();
  const targetIndex = state.tabs.findIndex((tab) => tab.id === tabId);
  const activeIndex = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
  const closesActiveTab = targetIndex >= 0 && activeIndex > targetIndex;
  const discarded = Boolean(options?.discardChanges && closesActiveTab && discardActiveBrowserColumnDocument());
  return enqueueBrowserColumnNavigation(() => {
    if (browserColumnTabExists(tabId)) useBrowserColumnStore.getState().closeTabsToRight(tabId);
    return true;
  }, {
    flush: closesActiveTab && !discarded,
    silentFlush: true,
  });
}

export function closeAllBrowserColumnTabs(
  options?: { discardChanges?: boolean },
): Promise<boolean | null> {
  const discarded = Boolean(options?.discardChanges && discardActiveBrowserColumnDocument());
  return enqueueBrowserColumnNavigation(() => {
    useBrowserColumnStore.getState().closeAllTabs();
    return true;
  }, { flush: !discarded, silentFlush: true });
}
