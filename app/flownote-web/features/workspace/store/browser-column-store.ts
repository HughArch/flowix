import { resolveWorkspaceFileSurfaceKind, workspaceSurfaceSupportsHost } from '../surface-registry';
import { createWorkspaceWebRuntime, navigateWorkspaceWebRuntime, moveWorkspaceWebHistory, reloadWorkspaceWebRuntime } from '../model/web-navigation';
import type { FileBrowserContext, FileBrowserTarget } from './file-browser-target';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { canonicalPath, canonicalDirectoryPath, isPathInDirectory, parentDirectoryPath } from '@/lib/path';
import { displayTitleFromFilename } from '@/lib/utils';
import { canonicalUrl } from '../model/surface-identity';
import { useWorkspaceFocusStore } from './workspace-focus-store';
import { browserColumnPersistence, restoreBrowserColumnSession } from './browser-column-persistence';
import { BROWSER_COLUMN_DEFAULT_SPLIT_RATIO, clampFileTreeWidth, clampSplitRatio } from '../model/browser-column-layout';
import { browserColumnTargetKey, type BrowserColumnTarget } from '../model/browser-column-target';
import type { BrowserColumnTab, BrowserColumnSessionState } from '../model/browser-column-tab';
import type { WorkspaceWebRuntime as BrowserColumnWebRuntime } from '../model/surface-contract';
import type { BrowserSurfaceOpenDisposition } from '../model/surface-opening';

export { BROWSER_COLUMN_MIN_WIDTH, BROWSER_COLUMN_DEFAULT_SPLIT_RATIO, BROWSER_COLUMN_FILE_TREE_DEFAULT_WIDTH,
  BROWSER_COLUMN_FILE_TREE_MIN_WIDTH, BROWSER_COLUMN_FILE_TREE_MAX_WIDTH } from '../model/browser-column-layout';

export type { BrowserColumnTarget } from '../model/browser-column-target';
export { browserColumnTargetIdentity, browserColumnTargetKey } from '../model/browser-column-target';

/** Opening in Work uses the same public support declaration as normal navigation. */
export function canOpenBrowserColumnTargetInWorkColumn(target: BrowserColumnTarget): boolean {
  if (target.kind === 'file-browser') {
    if (!target.activeFilePath) return false;
    const fileKind = target.collectionType === 'table' ? 'table'
      : target.collectionType === 'media_library' ? 'media-library'
      : target.collectionType === 'work_documents' ? 'work-documents'
      : resolveWorkspaceFileSurfaceKind(target.activeFilePath);
    return workspaceSurfaceSupportsHost(`file-${fileKind}`, 'main-third');
  }
  return workspaceSurfaceSupportsHost(target.kind === 'agent_conversation' ? 'agent-conversation'
    : target.kind === 'folder-collection' ? 'collection' : target.kind, 'main-third');
}

/** Compatibility name for callers from before dual-host views were supported. */
export const canMoveBrowserColumnTargetToWorkColumn = canOpenBrowserColumnTargetInWorkColumn;

export type { BrowserColumnTab } from '../model/browser-column-tab';

/** Runtime-only state for a web tab. It is intentionally not persisted with tabs. */
export type { WorkspaceWebRuntime as BrowserColumnWebRuntime } from '../model/surface-contract';

export type BrowserColumnOpenDisposition = BrowserSurfaceOpenDisposition;

interface BrowserColumnState extends BrowserColumnSessionState {
  webRuntimes: Record<string, BrowserColumnWebRuntime>;
  setVisible: (visible: boolean) => void;
  setSplitRatio: (ratio: number) => void;
  updateFileBrowserContext: (tabId: string, patch: Partial<FileBrowserContext>) => void;
  selectFileBrowserFile: (tabId: string, filePath: string | null, collectionDisplay?: FileBrowserTarget['collectionDisplay'], collectionType?: FileBrowserTarget['collectionType'], collectionUnavailableReason?: string) => void;
  switchFileBrowserFolder: (tabId: string, folderPath: string) => void;
  setFileBrowserTreeVisible: (tabId: string, visible: boolean) => void;
  setFileBrowserTreeWidth: (tabId: string, width: number) => void;
  openTab: (tab: BrowserColumnTab, disposition?: BrowserColumnOpenDisposition) => string;
  commitTab: (tabId: string) => void;
  closeTab: (tabId: string) => string | null;
  closeOtherTabs: (tabId: string) => string | null;
  closeTabsToRight: (tabId: string) => string | null;
  closeAllTabs: () => void;
  replaceExternalPath: (previousPath: string, path: string) => void;
  clearExternalPath: (path: string) => void;
  clearTargetsUnderDirectory: (directoryPath: string) => void;
  removeTabsByFilePath: (path: string) => string[];
  reorderTab: (tabId: string, beforeTabId: string | null) => void;
  updateTabMetadata: (tabId: string, metadata: Partial<Pick<BrowserColumnTab, 'title' | 'icon'>>) => void;
  setWebRuntime: (tabId: string, runtime: BrowserColumnWebRuntime) => void;
  navigateWebTab: (tabId: string, url: string) => boolean;
  goBackWebTab: (tabId: string) => boolean;
  goForwardWebTab: (tabId: string) => boolean;
  reloadWebTab: (tabId: string) => boolean;
  reset: () => void;
}

function adjacentTabId(tabs: BrowserColumnTab[], closingTabId: string): string | null {
  const index = tabs.findIndex((tab) => tab.id === closingTabId);
  if (index < 0) return null;
  return tabs[index - 1]?.id ?? tabs[index + 1]?.id ?? null;
}

function isWebTab(tab: BrowserColumnTab | undefined): tab is BrowserColumnTab & {
  target: Extract<BrowserColumnTarget, { kind: 'web' }>;
} {
  return tab?.target.kind === 'web';
}

function withWebRuntime(
  runtimes: Record<string, BrowserColumnWebRuntime>,
  tab: BrowserColumnTab | undefined,
): BrowserColumnWebRuntime | null {
  if (!isWebTab(tab)) return null;
  return runtimes[tab.id] ?? createWorkspaceWebRuntime(tab.target.url);
}

function updateWebTabTarget(
  tabs: BrowserColumnTab[],
  tabId: string,
  url: string,
): BrowserColumnTab[] {
  if (!tabs.some((tab) => tab.id === tabId && isWebTab(tab) && tab.target.url !== url)) return tabs;
  return tabs.map((tab) => tab.id === tabId && isWebTab(tab)
    ? { ...tab, target: { ...tab.target, url } }
    : tab);
}

function updateFileBrowserTabTarget(
  tabs: BrowserColumnTab[],
  tabId: string,
  filePath: string | null,
  collectionDisplay?: FileBrowserTarget['collectionDisplay'],
  collectionType?: FileBrowserTarget['collectionType'],
  collectionUnavailableReason?: string,
): BrowserColumnTab[] {
  return tabs.map((tab) => {
    if (tab.id !== tabId || tab.target.kind !== 'file-browser') return tab;
    const folderName = tab.target.folderPath?.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    const title = filePath
      ? displayTitleFromFilename(filePath.split(/[\\/]/).pop() ?? filePath)
      : folderName || tab.title;
    return { ...tab, title, target: { ...tab.target, activeFilePath: filePath,
      collectionDisplay, collectionType, collectionUnavailableReason } };
  });
}

function updateFileBrowserTabFolder(
  tabs: BrowserColumnTab[],
  tabId: string,
  folderPath: string,
): BrowserColumnTab[] {
  const folderName = folderPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? folderPath;
  return tabs.map((tab) => tab.id === tabId && tab.target.kind === 'file-browser'
    ? {
        ...tab,
        title: folderName || tab.title,
        target: {
          ...tab.target,
          folderPath,
          scopePath: folderPath,
          activeFilePath: null,
          collectionDisplay: undefined,
          collectionType: undefined,
          collectionUnavailableReason: undefined,
        },
      }
    : tab);
}

function updateFileBrowserTabTree(
  tabs: BrowserColumnTab[],
  tabId: string,
  patch: Partial<Extract<BrowserColumnTarget, { kind: 'file-browser' }>>,
): BrowserColumnTab[] {
  return tabs.map((tab) => tab.id === tabId && tab.target.kind === 'file-browser'
    ? { ...tab, target: { ...tab.target, ...patch } }
    : tab);
}

function releaseBrowserFocusWhenEmpty(tabCount: number): void {
  const focus = useWorkspaceFocusStore.getState();
  if (tabCount === 0 && focus.focusedHostId === 'browser-column') focus.focusHost('main-third');
}

export const useBrowserColumnStore = create<BrowserColumnState>()(
  persist<BrowserColumnState, [], [], BrowserColumnSessionState>(
  (set, get) => ({
      visible: false,
      splitRatio: BROWSER_COLUMN_DEFAULT_SPLIT_RATIO,
      tabs: [],
      activeTabId: null,
      webRuntimes: {},
      setVisible: (visible) => {
        const focus = useWorkspaceFocusStore.getState();
        if (visible) focus.focusHost('browser-column');
        else if (focus.focusedHostId === 'browser-column') focus.focusHost('main-third');
        set({ visible });
      },
      setSplitRatio: (splitRatio) => set({ splitRatio: clampSplitRatio(splitRatio) }),
      updateFileBrowserContext: (tabId, patch) => {
        set({ tabs: updateFileBrowserTabTree(get().tabs, tabId, patch) });
      },
      selectFileBrowserFile: (tabId, filePath, collectionDisplay, collectionType, collectionUnavailableReason) => {
        const tab = get().tabs.find((candidate) => candidate.id === tabId);
        if (!tab || tab.target.kind !== 'file-browser') return;
        set({ tabs: updateFileBrowserTabTarget(get().tabs, tabId, filePath, collectionDisplay, collectionType, collectionUnavailableReason) });
      },
      switchFileBrowserFolder: (tabId, folderPath) => {
        if (!folderPath.trim()) return;
        const tab = get().tabs.find((candidate) => candidate.id === tabId);
        if (!tab || tab.target.kind !== 'file-browser') return;
        set({ tabs: updateFileBrowserTabFolder(get().tabs, tabId, folderPath) });
      },
      setFileBrowserTreeVisible: (tabId, visible) => {
        set({ tabs: updateFileBrowserTabTree(get().tabs, tabId, { fileTreeVisible: visible }) });
      },
      setFileBrowserTreeWidth: (tabId, width) => {
        set({ tabs: updateFileBrowserTabTree(get().tabs, tabId, { fileTreeWidth: clampFileTreeWidth(width) }) });
      },
      openTab: (incoming, disposition = 'focus-existing') => {
        const state = get();
        const incomingKey = browserColumnTargetKey(incoming.target);
        const existing = incomingKey
          ? state.tabs.find((tab) => browserColumnTargetKey(tab.target) === incomingKey)
          : undefined;
        if (existing) {
          const updatedTabs = state.tabs.map((candidate) => candidate.id === existing.id
            ? { ...candidate, ...incoming, id: existing.id }
            : candidate);
          const tabs = disposition === 'replace-active'
            && state.activeTabId
            && state.activeTabId !== existing.id
            ? updatedTabs.filter((tab) => tab.id !== state.activeTabId)
            : updatedTabs;
          const webRuntimes = { ...state.webRuntimes };
          if (isWebTab(existing)) {
            webRuntimes[existing.id] ??= createWorkspaceWebRuntime(existing.target.url);
          } else {
            delete webRuntimes[existing.id];
          }
          useWorkspaceFocusStore.getState().focusHost('browser-column');
          set({ visible: true, tabs, activeTabId: existing.id, webRuntimes });
          return existing.id;
        }

        // A tab keeps its ID when its selected file changes. A later open of
        // the original file must not reuse that occupied ID.
        const id = state.tabs.some((tab) => tab.id === incoming.id)
          ? `${incoming.id}:${crypto.randomUUID()}`
          : incoming.id;
        const tab = { ...incoming, id };
        const tabs = disposition === 'replace-active' && state.activeTabId
          ? state.tabs.map((candidate) => candidate.id === state.activeTabId ? tab : candidate)
          : [...state.tabs, tab];
        const webRuntimes = { ...state.webRuntimes };
        if (state.activeTabId && disposition === 'replace-active') {
          delete webRuntimes[state.activeTabId];
        }
        if (isWebTab(tab)) {
          webRuntimes[id] = createWorkspaceWebRuntime(tab.target.url);
        }
        useWorkspaceFocusStore.getState().focusHost('browser-column');
        set({
          visible: true,
          tabs,
          activeTabId: id,
          webRuntimes,
        });
        return id;
      },
      commitTab: (tabId) => {
        if (!get().tabs.some((tab) => tab.id === tabId)) return;
        useWorkspaceFocusStore.getState().focusHost('browser-column');
        set({ visible: true, activeTabId: tabId });
      },
      closeTab: (tabId) => {
        const state = get();
        if (!state.tabs.some((tab) => tab.id === tabId)) return state.activeTabId;
        const nextActiveTabId = state.activeTabId === tabId
          ? adjacentTabId(state.tabs, tabId)
          : state.activeTabId;
        const tabs = state.tabs.filter((tab) => tab.id !== tabId);
        const webRuntimes = { ...state.webRuntimes };
        delete webRuntimes[tabId];
        releaseBrowserFocusWhenEmpty(tabs.length);
        set({
          tabs,
          activeTabId: nextActiveTabId,
          visible: state.visible && tabs.length > 0,
          webRuntimes,
        });
        return nextActiveTabId;
      },
      closeOtherTabs: (tabId) => {
        const state = get();
        if (!state.tabs.some((tab) => tab.id === tabId)) return state.activeTabId;
        const tabs = state.tabs.filter((tab) => tab.id === tabId);
        const webRuntimes = state.webRuntimes[tabId]
          ? { [tabId]: state.webRuntimes[tabId] }
          : {};
        set({
          tabs,
          activeTabId: tabId,
          visible: state.visible,
          webRuntimes,
        });
        return tabId;
      },
      closeTabsToRight: (tabId) => {
        const state = get();
        const tabIndex = state.tabs.findIndex((tab) => tab.id === tabId);
        if (tabIndex < 0) return state.activeTabId;
        const tabs = state.tabs.slice(0, tabIndex + 1);
        const activeTabIndex = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
        const activeTabId = activeTabIndex < 0 || activeTabIndex > tabIndex
          ? tabId
          : state.activeTabId;
        const webRuntimes = Object.fromEntries(
          tabs
            .filter((tab) => state.webRuntimes[tab.id])
            .map((tab) => [tab.id, state.webRuntimes[tab.id]]),
        );
        set({
          tabs,
          activeTabId,
          visible: state.visible,
          webRuntimes,
        });
        return activeTabId;
      },
      closeAllTabs: () => {
        releaseBrowserFocusWhenEmpty(0);
        set({
          tabs: [],
          activeTabId: null,
          visible: false,
          webRuntimes: {},
        });
      },
      replaceExternalPath: (previousPath, path) => {
        const previous = canonicalPath(previousPath);
        const next = canonicalPath(path);
        const previousParent = previous.replace(/\/[^/]*$/, '');
        const nextParent = next.replace(/\/[^/]*$/, '');
        const filename = next.split(/[\\/]/).pop() ?? next;
        set((state) => ({
          tabs: state.tabs.map((tab) => tab.target.kind === 'file-browser'
            && tab.target.activeFilePath
            && canonicalPath(tab.target.activeFilePath) === previous
            ? {
                ...tab,
                title: displayTitleFromFilename(filename),
                target: { ...tab.target, activeFilePath: next,
                  folderPath: tab.target.folderPath && canonicalPath(tab.target.folderPath) === previousParent
                    ? nextParent : tab.target.folderPath },
              }
            : tab),
        }));
      },
      clearExternalPath: (path) => {
        const targetPath = canonicalPath(path);
        set((state) => ({
          tabs: state.tabs.map((tab) => tab.target.kind === 'file-browser'
            && tab.target.activeFilePath
            && canonicalPath(tab.target.activeFilePath) === targetPath
            ? {
                ...tab,
                title: displayTitleFromFilename(
                  tab.target.folderPath?.split(/[\\/]/).filter(Boolean).pop() ?? '',
                ),
                target: { ...tab.target, activeFilePath: null },
              }
            : tab),
        }));
      },
      clearTargetsUnderDirectory: (directoryPath) => {
        const directory = canonicalDirectoryPath(directoryPath);
        const state = get();
        const removedIds = new Set<string>();
        let changed = false;
        const tabs = state.tabs.flatMap((tab) => {
          const target = tab.target;
          if (target.kind === 'media' && isPathInDirectory(target.filePath, directory)) {
            changed = true;
            removedIds.add(tab.id);
            return [];
          }
          if (target.kind === 'folder-collection' && isPathInDirectory(target.folderPath, directory)) {
            changed = true;
            removedIds.add(tab.id);
            return [];
          }
          if (target.kind !== 'file-browser') return [tab];

          const activeFileRemoved = Boolean(
            target.activeFilePath && isPathInDirectory(target.activeFilePath, directory),
          );
          const folderRemoved = Boolean(
            target.folderPath && isPathInDirectory(target.folderPath, directory),
          );
          if (!activeFileRemoved && !folderRemoved) return [tab];

          changed = true;
          const folderPath = folderRemoved
            ? parentDirectoryPath(directory, directory)
            : target.folderPath;
          const folderName = folderPath?.split(/[\\/]/).filter(Boolean).pop() ?? '';
          return [{
            ...tab,
            title: displayTitleFromFilename(folderName),
            target: {
              ...target,
              folderPath,
              activeFilePath: activeFileRemoved ? null : target.activeFilePath,
              collectionDisplay: activeFileRemoved ? undefined : target.collectionDisplay,
              collectionType: activeFileRemoved ? undefined : target.collectionType,
              collectionUnavailableReason: activeFileRemoved ? undefined : target.collectionUnavailableReason,
            },
          }];
        });
        if (!changed) return;

        const activeWasRemoved = state.activeTabId !== null && removedIds.has(state.activeTabId);
        const activeIndex = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
        const activeTabId = activeWasRemoved
          ? tabs[activeIndex - 1]?.id ?? tabs[activeIndex]?.id ?? null
          : state.activeTabId;
        const webRuntimes = Object.fromEntries(
          tabs
            .filter((tab) => state.webRuntimes[tab.id])
            .map((tab) => [tab.id, state.webRuntimes[tab.id]]),
        );
        if (activeWasRemoved) releaseBrowserFocusWhenEmpty(tabs.length);
        set({ tabs, activeTabId, visible: tabs.length > 0 && state.visible, webRuntimes });
      },
      removeTabsByFilePath: (path) => {
        const targetPath = canonicalPath(path);
        if (!targetPath) return [];
        const state = get();
        const removedIds = state.tabs
          .filter((tab) => tab.target.kind === 'file-browser'
            && tab.target.activeFilePath
            && canonicalPath(tab.target.activeFilePath) === targetPath)
          .map((tab) => tab.id);
        if (removedIds.length === 0) return [];

        const removed = new Set(removedIds);
        const activeIndex = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
        const tabs = state.tabs.filter((tab) => !removed.has(tab.id));
        const activeWasRemoved = state.activeTabId !== null && removed.has(state.activeTabId);
        const activeTabId = activeWasRemoved
          ? tabs[activeIndex - 1]?.id ?? tabs[activeIndex]?.id ?? null
          : state.activeTabId;
        const webRuntimes = Object.fromEntries(
          tabs
            .filter((tab) => state.webRuntimes[tab.id])
            .map((tab) => [tab.id, state.webRuntimes[tab.id]]),
        );
        releaseBrowserFocusWhenEmpty(tabs.length);
        set({
          tabs,
          activeTabId,
          visible: state.visible && tabs.length > 0,
          webRuntimes,
        });
        return removedIds;
      },
      reorderTab: (tabId, beforeTabId) => set((state) => {
        const sourceIndex = state.tabs.findIndex((tab) => tab.id === tabId);
        if (sourceIndex < 0 || beforeTabId === tabId) return state;
        const tabs = [...state.tabs];
        const [tab] = tabs.splice(sourceIndex, 1);
        const targetIndex = beforeTabId
          ? tabs.findIndex((candidate) => candidate.id === beforeTabId)
          : tabs.length;
        tabs.splice(targetIndex < 0 ? tabs.length : targetIndex, 0, tab);
        return { tabs };
      }),
      updateTabMetadata: (tabId, metadata) => set((state) => {
        const tab = state.tabs.find((tab) => tab.id === tabId);
        if (!tab || Object.entries(metadata).every(([key, value]) => tab[key as keyof typeof metadata] === value)) return state;
        return {
          tabs: state.tabs.map((tab) => tab.id === tabId ? { ...tab, ...metadata } : tab),
        };
      }),
      setWebRuntime: (tabId, runtime) => set((state) => {
        if (!isWebTab(state.tabs.find((tab) => tab.id === tabId))) return state;
        return {
          tabs: updateWebTabTarget(state.tabs, tabId, runtime.currentUrl),
          webRuntimes: { ...state.webRuntimes, [tabId]: runtime },
        };
      }),
      navigateWebTab: (tabId, url) => {
        const normalized = canonicalUrl(url);
        if (!normalized) return false;
        const state = get();
        const tab = state.tabs.find((candidate) => candidate.id === tabId);
        const current = withWebRuntime(state.webRuntimes, tab);
        if (!current || !isWebTab(tab)) return false;
        const runtime = navigateWorkspaceWebRuntime(current, normalized);
        set({
          tabs: updateWebTabTarget(state.tabs, tabId, runtime.currentUrl),
          webRuntimes: { ...state.webRuntimes, [tabId]: runtime },
        });
        return true;
      },
      goBackWebTab: (tabId) => {
        const state = get();
        const tab = state.tabs.find((candidate) => candidate.id === tabId);
        const current = withWebRuntime(state.webRuntimes, tab);
        const runtime = current ? moveWorkspaceWebHistory(current, -1) : null;
        if (!runtime) return false;
        set({
          tabs: updateWebTabTarget(state.tabs, tabId, runtime.currentUrl),
          webRuntimes: { ...state.webRuntimes, [tabId]: runtime },
        });
        return true;
      },
      goForwardWebTab: (tabId) => {
        const state = get();
        const tab = state.tabs.find((candidate) => candidate.id === tabId);
        const current = withWebRuntime(state.webRuntimes, tab);
        const runtime = current ? moveWorkspaceWebHistory(current, 1) : null;
        if (!runtime) return false;
        set({
          tabs: updateWebTabTarget(state.tabs, tabId, runtime.currentUrl),
          webRuntimes: { ...state.webRuntimes, [tabId]: runtime },
        });
        return true;
      },
      reloadWebTab: (tabId) => {
        const state = get();
        const tab = state.tabs.find((candidate) => candidate.id === tabId);
        const current = withWebRuntime(state.webRuntimes, tab);
        if (!current) return false;
        set({ webRuntimes: { ...state.webRuntimes, [tabId]: reloadWorkspaceWebRuntime(current) } });
        return true;
      },
      reset: () => {
        useWorkspaceFocusStore.getState().reset();
        set({
          visible: false,
          splitRatio: BROWSER_COLUMN_DEFAULT_SPLIT_RATIO,
          tabs: [],
          activeTabId: null,
          webRuntimes: {},
        });
      },
    }),
    {
      ...browserColumnPersistence,
      // Web history and live WebView state are process-local.
      merge: (persisted, current) => ({ ...restoreBrowserColumnSession(persisted, current), webRuntimes: {} }),
    },
  ),
);
