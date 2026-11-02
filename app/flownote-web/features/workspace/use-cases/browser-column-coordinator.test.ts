import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBrowserColumnStore } from '../store/browser-column-store';
import { registerWorkspaceSurfaceLifecycle } from '../store/surface-lifecycle-store';
import { closeBrowserColumnTab } from '../public/browser-column-api';
import {
  discardActiveBrowserColumnDocument,
  flushActiveBrowserColumnDocument,
  resetBrowserColumnCoordinator,
} from './browser-column-coordinator';

afterEach(() => {
  resetBrowserColumnCoordinator();
  useBrowserColumnStore.getState().reset();
});

describe('Browser Column surface lifecycle', () => {
  it('keeps a failed surface open when discard was requested but is unsupported', async () => {
    const tabId = useBrowserColumnStore.getState().openTab({
      id: 'tab:csv', title: 'CSV', icon: null, target: { kind: 'web', url: 'https://example.com' },
    });
    const flush = vi.fn().mockResolvedValue(false);
    registerWorkspaceSurfaceLifecycle(tabId, { status: 'ready', flush });
    try {
      expect(discardActiveBrowserColumnDocument()).toBe(false);
      await expect(closeBrowserColumnTab(tabId, { discardChanges: true })).resolves.toBeNull();
      expect(flush).toHaveBeenCalledOnce();
      expect(useBrowserColumnStore.getState().tabs).toHaveLength(1);
    } finally {
      registerWorkspaceSurfaceLifecycle(tabId, null);
    }
  });
  it('uses the common view lifecycle for flush and discard', async () => {
    const lifecycleFlush = vi.fn().mockResolvedValue(false);
    const lifecycleDiscard = vi.fn();
    const lifecycleDispose = vi.fn();
    useBrowserColumnStore.setState({ activeTabId: 'tab:one' });
    registerWorkspaceSurfaceLifecycle('tab:one', {
      status: 'ready', flush: lifecycleFlush, discard: lifecycleDiscard,
      dispose: lifecycleDispose,
    });

    await expect(flushActiveBrowserColumnDocument({ silent: true })).resolves.toBe(false);
    expect(lifecycleFlush).toHaveBeenCalledWith({ silent: true });

    discardActiveBrowserColumnDocument();
    expect(lifecycleDiscard).toHaveBeenCalledOnce();

    registerWorkspaceSurfaceLifecycle('tab:one', null);
    expect(lifecycleDispose).toHaveBeenCalledOnce();
  });
});
