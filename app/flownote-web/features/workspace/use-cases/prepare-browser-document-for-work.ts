import type { ContentIdentity } from '../model/surface-identity';
import { getWorkspaceSurfaceLifecycle } from '../store/surface-lifecycle-store';
import { findWorkspaceContentLocations } from './workspace-content-activation';

export async function flushBrowserViewBeforeOpeningWork(identity: ContentIdentity): Promise<boolean> {
  const browserLocation = findWorkspaceContentLocations(identity).browserColumn;
  if (!browserLocation) return true;
  const lifecycle = getWorkspaceSurfaceLifecycle(browserLocation.tabId);
  if (lifecycle?.status === 'ready' && lifecycle.flush) {
    try { return await lifecycle.flush(); }
    catch { return false; }
  }
  // Inactive tabs have already crossed the coordinator's flush barrier when
  // they were hidden; their renderer is not mounted and cannot hold a live edit.
  return true;
}
