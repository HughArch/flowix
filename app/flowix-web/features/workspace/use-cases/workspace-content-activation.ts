import { setCollectionActiveView } from './collection-view-state';
import {
  useBrowserColumnStore,
  browserColumnTargetIdentity,
} from '@features/workspace/store/browser-column-store';
import {
  contentIdentityKey,
  type ContentIdentity,
} from '@features/workspace/store/workspace-content-identity';
import type { WorkColumnTarget } from '@features/workspace/store/work-column-target';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';
import { getWorkColumnContentState } from '@features/workspace/store/work-column-content-state';
import { activateBrowserColumnTab } from './browser-column-coordinator';

export type WorkspaceContentLocation =
  | { host: 'main-third'; state: 'active' | 'pending' }
  | { host: 'browser-column'; tabId: string };

export function workColumnTargetIdentity(target: WorkColumnTarget): ContentIdentity | null {
  switch (target.kind) {
    case 'media':
      return { kind: 'media', path: target.filePath };
    case 'external':
      return { kind: 'external', path: target.path };
    case 'collection':
      return { kind: 'collection', notebookId: target.notebookId, collectionId: target.collectionId, viewId: target.viewId };
    case 'table':
      return { kind: 'external', path: target.filePath };
    case 'media-library':
      return { kind: 'external', path: target.filePath };
    case 'agent-conversation':
      return { kind: 'agent-conversation', instanceId: target.instanceId };
    case 'web':
      return { kind: 'web', url: target.url };
    default:
      return null;
  }
}

export { browserColumnTargetIdentity };

function currentCollectionView(location: WorkspaceContentLocation): string | null {
  if (location.host === 'main-third') {
    const target = getWorkColumnContentState();
    if (target.status === 'empty' || target.status === 'transitioning') return null;
    return target.target.kind === 'collection' ? target.target.viewId : null;
  }
  const tab = useBrowserColumnStore.getState().tabs.find((candidate) => candidate.id === location.tabId);
  return tab?.target.kind === 'file-browser' ? tab.target.collectionDisplay?.viewId ?? null : null;
}

/**
 * Focus an already-open workspace target without opening a second surface.
 * The third column wins when legacy state already contains the target in both
 * columns; normal opens prevent that ambiguous state from being created.
 */
export function activateExistingWorkspaceContent(
  identity: ContentIdentity,
): WorkspaceContentLocation | null {
  const location = findExistingWorkspaceContent(identity);
  if (!location) return null;

  if (identity.kind === 'collection') {
    // Start a new transaction for pending requests; requestId makes the latest win.
    if (location.host === 'main-third' && location.state === 'pending') return null;
    if (!setCollectionActiveView(location, identity, identity.viewId ?? currentCollectionView(location))) return null;
  }
  if (location.host === 'main-third') {
    useWorkspaceFocusStore.getState().focusHost('main-third');
  } else {
    useBrowserColumnStore.getState().commitTab(location.tabId);
  }
  return location;
}

/**
 * Async counterpart for navigation use-cases. Browser-column activation may
 * unmount an isolated editor, so it goes through the shared flush barrier.
 */
export async function activateExistingWorkspaceContentAsync(
  identity: ContentIdentity,
): Promise<WorkspaceContentLocation | null> {
  const location = findExistingWorkspaceContent(identity);
  if (!location) return null;

  if (location.host === 'main-third') {
    if (identity.kind === 'collection') {
      if (location.state === 'pending') return null;
      if (!setCollectionActiveView(location, identity, identity.viewId ?? currentCollectionView(location))) return null;
    }
    useWorkspaceFocusStore.getState().focusHost('main-third');
    return location;
  }

  const activated = await activateBrowserColumnTab(location.tabId);
  if (activated === null) {
    throw new Error('BrowserColumn navigation cancelled because saving did not complete');
  }
  if (activated && identity.kind === 'collection'
    && !setCollectionActiveView(location, identity, identity.viewId ?? currentCollectionView(location))) return null;
  return activated ? location : null;
}

/** Read the existing location without changing focus or active tab. */
export function findExistingWorkspaceContent(
  identity: ContentIdentity,
): WorkspaceContentLocation | null {
  const key = contentIdentityKey(identity);
  if (!key) return null;

  const workColumn = getWorkColumnContentState();
  const pendingIdentity = workColumn.status === 'transitioning'
    ? workColumnTargetIdentity(workColumn.to)
    : null;
  if (pendingIdentity && contentIdentityKey(pendingIdentity) === key) {
    return { host: 'main-third', state: 'pending' };
  }

  const workTarget = workColumn.status === 'empty'
    ? null
    : workColumn.status === 'transitioning'
      ? workColumn.from
      : workColumn.target;
  const workIdentity = workTarget ? workColumnTargetIdentity(workTarget) : null;
  if (workIdentity && contentIdentityKey(workIdentity) === key) {
    return { host: 'main-third', state: 'active' };
  }

  const browserColumn = useBrowserColumnStore.getState();
  const matchingTabs = browserColumn.tabs.filter(
    (tab) => contentIdentityKey(browserColumnTargetIdentity(tab.target)) === key,
  );
  const tab = matchingTabs.find((candidate) => candidate.id === browserColumn.activeTabId)
    ?? matchingTabs[0];
  if (!tab) return null;
  return { host: 'browser-column', tabId: tab.id };
}
