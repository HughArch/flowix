import { useBrowserColumnStore } from '@features/workspace/store/browser-column-store';
import { getWorkspaceSurfaceLifecycle } from '@features/workspace/public/surface-lifecycle-api';

let navigationChain: Promise<unknown> = Promise.resolve();

export async function flushActiveBrowserColumnDocument(
  options?: { silent?: boolean },
): Promise<boolean> {
  const activeTabId = useBrowserColumnStore.getState().activeTabId;
  const lifecycle = activeTabId ? getWorkspaceSurfaceLifecycle(activeTabId) : null;
  if (lifecycle?.status === 'ready' && lifecycle.flush) {
    try {
      return await lifecycle.flush(options);
    } catch (error) {
      console.error('[BrowserColumn] Failed to flush active surface lifecycle', error);
      return false;
    }
  }
  return true;
}

/** False means this editor cannot discard and must still cross its flush barrier. */
export function discardActiveBrowserColumnDocument(): boolean {
  const activeTabId = useBrowserColumnStore.getState().activeTabId;
  const lifecycle = activeTabId ? getWorkspaceSurfaceLifecycle(activeTabId) : null;
  if (lifecycle?.status === 'ready' && lifecycle.discard) {
    lifecycle.discard();
    return true;
  }
  if (lifecycle?.flush) return false;
  return true;
}

/**
 * Serialize every operation which can replace or unmount the active tab.
 * `null` means the operation was rejected because the active editor could not
 * be flushed; callers must leave the current tab intact in that case.
 */
export function enqueueBrowserColumnNavigation<T>(
  operation: () => T | Promise<T>,
  options: { flush?: boolean; silentFlush?: boolean } = {},
): Promise<T | null> {
  const run = navigationChain
    .catch(() => undefined)
    .then(async () => {
      if (options.flush !== false
        && !await flushActiveBrowserColumnDocument({ silent: options.silentFlush })) return null;
      return await operation();
    });
  navigationChain = run.catch(() => undefined);
  return run;
}

export function activateBrowserColumnTab(tabId: string): Promise<boolean | null> {
  return enqueueBrowserColumnNavigation(() => {
    const state = useBrowserColumnStore.getState();
    if (!state.tabs.some((tab) => tab.id === tabId)) return false;
    state.commitTab(tabId);
    return true;
  });
}

export function resetBrowserColumnCoordinator(): void {
  navigationChain = Promise.resolve();
}
