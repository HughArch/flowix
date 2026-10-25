import { createLogger } from '@/lib/logger';
import { findFileDisplayPath } from '@/lib/file-display-registry';
import { notes } from '@platform/tauri/client';
import { getWorkspaceMemoState } from '@features/memo/public/workspace-api';
import { listDocumentSessions } from '../store/document-runtime-session';
import type { DocumentIdentity } from '../store/document-identity';
import {
  applyLoadedDocumentContent,
  hasDocumentUnsavedChanges,
  saveDocumentPath,
} from '../store/document-session-service';
import { getBuffer } from '../store/buffer-registry';
import { isDocumentContentEqual } from '../store/buffer-equality';
import { resolveNotebookIdForPath } from '../use-cases/resolve-notebook-id-for-path';

const logger = createLogger('sync-coordination');

interface OpenDocumentTarget {
  identity: DocumentIdentity;
  path: string;
  adapterPath: string;
  scopePath: string | null;
}

function openDocumentsForNotebook(notebookId: string): OpenDocumentTarget[] {
  const notebooks = getWorkspaceMemoState().notebooks;
  return listDocumentSessions().flatMap((session) => {
    if (!session.buffer) return [];
    const path = findFileDisplayPath(session.identity.displayId) ?? session.identity.path;
    if (resolveNotebookIdForPath(path, notebooks) !== notebookId) return [];
    const adapter = [...session.adapters].slice(-1)[0] ?? session.retainedAdapter;
    return [{
      identity: session.identity,
      path,
      adapterPath: adapter?.path() ?? path,
      scopePath: adapter?.scopePath ?? null,
    }];
  });
}

/**
 * Capture the latest editor bytes of every open document in the notebook and
 * wait until they are on disk. Sync reads and writes notebook files, and
 * editor saves are normally blur/debounce-triggered, so a manual sync fired
 * right after typing would otherwise push stale bytes and let a pull race the
 * pending save.
 */
export async function flushOpenDocumentsForNotebook(notebookId: string): Promise<void> {
  const targets = openDocumentsForNotebook(notebookId);
  await Promise.all(targets.map(({ identity, adapterPath, scopePath, path }) =>
    saveDocumentPath(identity, adapterPath, scopePath).catch((error) => {
      // A failed flush must not block syncing the rest of the notebook; the
      // save queue keeps retrying and the buffer stays authoritative.
      logger.warn('flush before sync failed', { path, error });
    })));
}

/**
 * Re-read every open, clean document in the notebook from disk and feed
 * pulled remote changes into the live views. Without this, a note stays on
 * its in-memory content until the user navigates away and back.
 */
export async function reloadOpenDocumentsAfterSync(notebookId: string): Promise<void> {
  const targets = openDocumentsForNotebook(notebookId);
  await Promise.all(targets.map(async ({ identity, path }) => {
    // A draft that failed to flush, or a conflicted buffer, owns the visible
    // content — a pulled replacement must never clobber it.
    if (hasDocumentUnsavedChanges(identity)) return;
    const buffer = getBuffer(identity);
    if (!buffer || buffer.conflicted) return;
    let diskContent: string | null;
    try {
      diskContent = await notes.readDocument(path);
    } catch (error) {
      logger.warn('reload after sync failed', { path, error });
      return;
    }
    if (diskContent === null) return;
    // The read is async: the user may have started typing into the draft
    // while the bytes were in flight.
    if (hasDocumentUnsavedChanges(identity)) return;
    if (isDocumentContentEqual(identity, diskContent, buffer.content)) return;
    applyLoadedDocumentContent(identity, path, diskContent, { setAsCurrent: false });
  }));
}
