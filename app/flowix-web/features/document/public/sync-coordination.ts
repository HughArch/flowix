import { createLogger } from '@/lib/logger';
import { findFileDisplayPath } from '@/lib/file-display-registry';
import { toast } from '@/lib/toast';
import { translate, type I18nKey } from '@/lib/i18n';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';
import { fns, notes } from '@platform/tauri/client';
import type { FnsNotebookSyncOutcome } from '@platform/tauri/client';
import { getWorkspaceMemoState } from '@features/memo/public/workspace-api';
import { listWorkspaceSurfaceLifecycles } from '@features/workspace/store/surface-lifecycle-store';
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

function openDocumentTargets(notebookId: string): OpenDocumentTarget[] {
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
  const targets = openDocumentTargets(notebookId);
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
  const targets = openDocumentTargets(notebookId);
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

/** Notebook ids that own at least one open editor session, longest-prefix resolved. */
export function openDocumentNotebookIds(): string[] {
  const notebooks = getWorkspaceMemoState().notebooks;
  const ids = new Set<string>();
  for (const session of listDocumentSessions()) {
    if (!session.buffer) continue;
    const path = findFileDisplayPath(session.identity.displayId) ?? session.identity.path;
    const id = resolveNotebookIdForPath(path, notebooks);
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * One notebook: capture pending editor bytes -> FNS sync -> feed pulled
 * remote changes back into the open views. `null` means the sync engine
 * skipped the run (FNS disabled / unconfigured), not an error.
 */
export async function syncNotebookNow(notebookId: string): Promise<FnsNotebookSyncOutcome | null> {
  await flushOpenDocumentsForNotebook(notebookId);
  const outcome = await fns.syncNotebook(notebookId);
  if (outcome) await reloadOpenDocumentsAfterSync(notebookId);
  return outcome;
}

/** Toast line for one sync outcome; shared by the sync panel, the canvas
 *  save button and the Ctrl+S shortcut path. */
export function formatSyncOutcomeSummary(
  outcome: FnsNotebookSyncOutcome,
  t: (key: I18nKey) => string,
): string {
  let summary = `${t('sync.panel.done')} · ${outcome.vault} ↓${outcome.pulled} ↑${outcome.pushed} · 📎 ↓${outcome.filesPulled} ↑${outcome.filesPushed}`;
  if (outcome.conflicts.length > 0) {
    summary += ` · ⚠ ${t('sync.panel.conflicts').replace('{count}', String(outcome.conflicts.length))}`;
  } else if (outcome.conflictsAutoResolved > 0) {
    summary += ` · ✓ ${t('sync.conflict.autoResolved').replace('{count}', String(outcome.conflictsAutoResolved))}`;
  }
  return summary;
}

/**
 * Explicit "save and sync" (Ctrl+S outside a focused canvas board): flush
 * every open editor session plus every mounted canvas board, then FNS-sync
 * the notebooks that own open sessions. Notebooks without an FNS binding
 * skip silently (`syncNotebook` resolves to null); at least one real run
 * toasts the same summary line the sync panel uses.
 */
export async function saveOpenDocumentsAndSync(): Promise<void> {
  // Canvas boards keep session-less buffers, so flushing them goes through
  // the surface lifecycle (the same flush navigation/shutdown consumes).
  await Promise.all(listWorkspaceSurfaceLifecycles().map(async (lifecycle) => {
    try {
      await lifecycle.flush?.({ silent: true });
    } catch (error) {
      logger.warn('surface flush before sync failed', { error });
    }
  }));
  const notebookIds = openDocumentNotebookIds();
  if (notebookIds.length === 0) return;
  const t = (key: I18nKey) => translate(getCurrentAppLanguage(), key);
  const outcomes: FnsNotebookSyncOutcome[] = [];
  let failure: string | null = null;
  for (const notebookId of notebookIds) {
    try {
      const outcome = await syncNotebookNow(notebookId);
      if (outcome) outcomes.push(outcome);
    } catch (error) {
      failure ??= error instanceof Error ? error.message : String(error);
    }
  }
  if (failure !== null) {
    toast.error(`${t('sync.panel.failed')}: ${failure}`);
  } else if (outcomes.length === 1) {
    toast.success(formatSyncOutcomeSummary(outcomes[0], t));
  } else if (outcomes.length > 1) {
    const pulled = outcomes.reduce((total, outcome) => total + outcome.pulled, 0);
    const pushed = outcomes.reduce((total, outcome) => total + outcome.pushed, 0);
    toast.success(`${t('sync.panel.done')} · ↓${pulled} ↑${pushed}`);
  }
}
