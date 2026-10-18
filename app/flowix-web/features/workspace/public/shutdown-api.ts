import { listWorkspaceSurfaceLifecycles } from '../store/surface-lifecycle-store';

/** Reuse each surface's save barrier (tables, media libraries, CSV, etc.). */
export async function flushWorkspaceSurfacesForShutdown(): Promise<boolean> {
  const results = await Promise.allSettled(listWorkspaceSurfaceLifecycles().map(surface =>
    Promise.resolve().then(() => surface.flush?.({ silent: true })),
  ));
  return results.every(result => result.status === 'fulfilled' && result.value !== false);
}
