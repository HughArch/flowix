import { expect, it, vi } from 'vitest';
import { registerWorkspaceSurfaceLifecycle } from '../store/surface-lifecycle-store';
import { flushWorkspaceSurfacesForShutdown } from './shutdown-api';

it('starts all surface barriers together and reports a failure without skipping other views', async () => {
  let finish!: (value: boolean) => void;
  const table = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const media = vi.fn().mockRejectedValue(new Error('write failed'));
  registerWorkspaceSurfaceLifecycle('shutdown-table', { status: 'ready', flush: table });
  registerWorkspaceSurfaceLifecycle('shutdown-media', { status: 'ready', flush: media });
  try {
    let settled = false;
    const saving = flushWorkspaceSurfacesForShutdown().then(result => { settled = true; return result; });
    await Promise.resolve(); await Promise.resolve();
    expect(table).toHaveBeenCalledWith({ silent: true });
    expect(media).toHaveBeenCalledWith({ silent: true });
    expect(settled).toBe(false);
    finish(true);
    expect(await saving).toBe(false);
  } finally {
    registerWorkspaceSurfaceLifecycle('shutdown-table', null);
    registerWorkspaceSurfaceLifecycle('shutdown-media', null);
  }
});
