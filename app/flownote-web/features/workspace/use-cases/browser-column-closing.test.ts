import { afterEach, expect, it, vi } from 'vitest';
import { useBrowserColumnStore } from '../store/browser-column-store';
import { registerWorkspaceSurfaceLifecycle } from '../store/surface-lifecycle-store';
import { activateBrowserColumnTab, resetBrowserColumnCoordinator } from './browser-column-coordinator';
import { closeAllBrowserColumnTabs, closeBrowserColumnTab, closeBrowserColumnTabsToRight, closeOtherBrowserColumnTabs } from './browser-column-closing';

const tab = (id: string) => ({ id, title: id, icon: null, target: { kind: 'web' as const, url: `https://${id}.example/` } });
afterEach(() => {
  for (const id of ['a', 'b']) registerWorkspaceSurfaceLifecycle(id, null);
  resetBrowserColumnCoordinator();
  useBrowserColumnStore.getState().reset();
});

it.each([
  ['one', () => closeBrowserColumnTab('b')],
  ['others', () => closeOtherBrowserColumnTabs('a')],
  ['right', () => closeBrowserColumnTabsToRight('a')],
] as const)('rechecks the active tab inside a queued %s close and retains a failed document', async (_, close) => {
  const store = useBrowserColumnStore.getState();
  store.openTab(tab('a')); store.openTab(tab('b')); store.commitTab('a');
  const flush = vi.fn().mockResolvedValue(false);
  registerWorkspaceSurfaceLifecycle('b', { status: 'ready', flush });
  const activate = activateBrowserColumnTab('b');
  const closing = close();
  await expect(activate).resolves.toBe(true);
  await expect(closing).resolves.toBeNull();
  expect(flush).toHaveBeenCalledExactlyOnceWith({ silent: true });
  expect(useBrowserColumnStore.getState().tabs.map((tab) => tab.id)).toEqual(['a', 'b']);
});

it('discards the document active when close-all executes, rather than the old active document', async () => {
  const store = useBrowserColumnStore.getState();
  store.openTab(tab('a')); store.openTab(tab('b')); store.commitTab('a');
  const discardA = vi.fn(); const discardB = vi.fn();
  registerWorkspaceSurfaceLifecycle('a', { status: 'ready', flush: async () => true, discard: discardA });
  registerWorkspaceSurfaceLifecycle('b', { status: 'ready', flush: async () => false, discard: discardB });
  const activate = activateBrowserColumnTab('b');
  const closing = closeAllBrowserColumnTabs({ discardChanges: true });
  await activate; await closing;
  expect(discardA).not.toHaveBeenCalled();
  expect(discardB).toHaveBeenCalledOnce();
  expect(useBrowserColumnStore.getState().tabs).toHaveLength(0);
});

it('closes a background tab without flushing the untouched active document', async () => {
  const store = useBrowserColumnStore.getState();
  store.openTab(tab('a')); store.openTab(tab('b'));
  const flush = vi.fn().mockResolvedValue(false);
  registerWorkspaceSurfaceLifecycle('b', { status: 'ready', flush });
  await expect(closeBrowserColumnTab('a')).resolves.toBe(true);
  expect(flush).not.toHaveBeenCalled();
  expect(useBrowserColumnStore.getState().activeTabId).toBe('b');
});
