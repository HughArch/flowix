import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { findFileDisplayPath, type FileDisplayIdentity } from '@/lib/file-display-registry';
import { useI18n } from '@/lib/i18n';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { removeDocumentProperty, setDocumentProperties } from '../public/path-properties';
import { DOCUMENT_LOCK_KEY, readDocumentLock } from '../properties/document-lock';
import { getBuffer, subscribeDocumentBufferChanges } from '../store/buffer-registry';
import { documentIdentityFromFile } from '../store/document-identity';

const logger = createLogger('document-lock');

/**
 * Lock state of one open document, derived from the shared buffer so a lock
 * written by any surface (or reloaded from disk) reaches every view at once.
 */
export function useDocumentLocked(fileIdentity: FileDisplayIdentity): boolean {
  const { path, displayId } = fileIdentity;
  const subscribe = useCallback((onChange: () => void) => subscribeDocumentBufferChanges((identity) => {
    if (identity.displayId === displayId) onChange();
  }), [displayId]);
  const getSnapshot = useCallback(() => {
    const content = getBuffer(documentIdentityFromFile({ path, displayId }))?.content;
    return content === undefined ? false : readDocumentLock(content);
  }, [path, displayId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export interface DocumentLock {
  locked: boolean;
  busy: boolean;
  setLocked: (next: boolean) => Promise<void>;
  toggle: () => Promise<void>;
}

/** Read and toggle the lock. The lock is persisted in the note frontmatter. */
export function useDocumentLock(fileIdentity: FileDisplayIdentity): DocumentLock {
  const locked = useDocumentLocked(fileIdentity);
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const setLocked = useCallback(async (next: boolean) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      // A rename can land while the menu is open; write to the current path.
      const path = findFileDisplayPath(fileIdentity.displayId) ?? fileIdentity.path;
      const saved = next
        ? await setDocumentProperties(path, { [DOCUMENT_LOCK_KEY]: true })
        : await removeDocumentProperty(path, DOCUMENT_LOCK_KEY);
      if (!saved) throw new Error('Lock state was not written');
      toast.success(t(next ? 'document.lock.locked' : 'document.lock.unlocked'));
    } catch (error) {
      logger.error('toggle document lock failed', { error, path: fileIdentity.path, next });
      toast.error(t('document.lock.failed'));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [fileIdentity.displayId, fileIdentity.path, t]);

  const toggle = useCallback(() => setLocked(!locked), [locked, setLocked]);

  return { locked, busy, setLocked, toggle };
}
