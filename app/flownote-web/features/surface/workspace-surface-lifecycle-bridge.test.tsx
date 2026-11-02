import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useWorkspaceSurfaceLifecycleBridge } from './workspace-surface-lifecycle-bridge';
import { getWorkspaceSurfaceLifecycle, registerWorkspaceSurfaceLifecycle } from '@features/workspace/store/surface-lifecycle-store';

it('keeps one save lifecycle throughout editor loading, readiness and remounting', async () => {
  let bridge!: ReturnType<typeof useWorkspaceSurfaceLifecycleBridge>;
  const register = (lifecycle: Parameters<typeof registerWorkspaceSurfaceLifecycle>[1], owner?: object) => registerWorkspaceSurfaceLifecycle('bridge-test', lifecycle, owner);
  function Harness() { bridge = useWorkspaceSurfaceLifecycleBridge({}, register); return null; }
  const host = document.createElement('div'); const root = createRoot(host);
  try {
    await act(async () => root.render(<Harness />));
    const flush = vi.fn().mockResolvedValue(false); const discard = vi.fn(); const focus = vi.fn();
    await act(async () => bridge.onFlushReady?.(flush, discard));
    await expect(getWorkspaceSurfaceLifecycle('bridge-test')?.flush?.()).resolves.toBe(false);
    expect(getWorkspaceSurfaceLifecycle('bridge-test')?.focus).toBeUndefined();
    await act(async () => bridge.onSurfaceLifecycleReady?.({ status: 'ready', flush, discard, focus }));
    expect(getWorkspaceSurfaceLifecycle('bridge-test')?.focus).toBe(focus);
    // An editor subtree can remount without losing its document-level save barrier.
    await act(async () => bridge.onSurfaceLifecycleReady?.(null));
    expect(getWorkspaceSurfaceLifecycle('bridge-test')?.flush).toBe(flush);
    await act(async () => bridge.onFlushReady?.(null, null));
    expect(getWorkspaceSurfaceLifecycle('bridge-test')).toBeNull();
  } finally { await act(async () => root.unmount()); registerWorkspaceSurfaceLifecycle('bridge-test', null); }
});
