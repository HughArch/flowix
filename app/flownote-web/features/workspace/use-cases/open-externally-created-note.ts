import { findWorkspaceContentLocations } from './workspace-content-activation';
import { openWorkspaceSurface } from './surface-opening';

/** Background notifications must not reactivate or duplicate an open document. */
export async function openExternallyCreatedNote(
  path: string,
  notebookPath: string,
  notebookId: string,
): Promise<void> {
  const locations = findWorkspaceContentLocations({ kind: 'external', path });
  if (locations.workColumn || locations.browserColumn) return;

  await openWorkspaceSurface({
    host: 'browser-column',
    target: { kind: 'external', path, scopePath: notebookPath, transitionId: null },
    options: { notebookId },
  });
}
