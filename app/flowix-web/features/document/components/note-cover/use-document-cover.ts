import { useCallback, useEffect, useRef, useState } from 'react';
import { findFileDisplayPath, pinFileDisplayId } from '@/lib/file-display-registry';
import { createLogger } from '@/lib/logger';
import { notes } from '@platform/tauri/client';
import { extractFrontmatter } from '../../properties/frontmatter-model';
import { removeDocumentProperty, setDocumentProperties } from '../../public/path-properties';
import { documentIdentityFromFile } from '../../store/document-identity';
import { getBuffer, subscribeDocumentBufferChanges } from '../../store/buffer-registry';

const logger = createLogger('document-cover');

function readBufferCover(path: string, displayId: string): string | null | undefined {
  const buffer = getBuffer(documentIdentityFromFile({ path, displayId }));
  if (!buffer) return undefined;
  const value = extractFrontmatter(buffer.content).data.flowix_cover;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export interface DocumentCoverActions {
  /** Live `flowix_cover` value; null when the note has no manual cover. */
  cover: string | null;
  setCover: (storageKey: string) => Promise<boolean>;
  removeCover: () => Promise<boolean>;
}

/**
 * Read the note's manual cover from the live editor buffer (falling back to
 * disk) and persist changes through the shared property pipeline. Mirrors
 * `useDocumentTitlebarColors`: queued writes keep their display identity so a
 * concurrent rename cannot land the edit on the wrong path.
 */
export function useDocumentCover(path: string, displayId: string): DocumentCoverActions {
  const [cover, setCoverState] = useState<string | null>(() => readBufferCover(path, displayId) ?? null);
  const pending = useRef(0);

  const syncBufferCover = useCallback(() => {
    const buffered = readBufferCover(path, displayId);
    if (buffered === undefined) return false;
    setCoverState((previous) => (previous === buffered ? previous : buffered));
    return true;
  }, [path, displayId]);

  useEffect(() => subscribeDocumentBufferChanges((identity) => {
    if (identity.displayId === displayId && pending.current === 0) syncBufferCover();
  }), [displayId, syncBufferCover]);

  useEffect(() => {
    if (syncBufferCover()) return;
    let cancelled = false;
    void notes.readDocument(path).then((content) => {
      if (cancelled || content === null || syncBufferCover()) return;
      const value = extractFrontmatter(content).data.flowix_cover;
      setCoverState(typeof value === 'string' && value.trim() ? value.trim() : null);
    }).catch((error) => logger.warn('read cover failed', { error, path }));
    return () => { cancelled = true; };
  }, [path, displayId, syncBufferCover]);

  const setCover = useCallback(async (storageKey: string) => {
    pending.current += 1;
    const release = pinFileDisplayId(displayId);
    try {
      const currentPath = findFileDisplayPath(displayId) ?? path;
      const saved = await setDocumentProperties(currentPath, { flowix_cover: storageKey });
      if (saved) setCoverState(storageKey);
      return saved;
    } finally {
      release();
      pending.current -= 1;
    }
  }, [displayId, path]);

  const removeCover = useCallback(async () => {
    pending.current += 1;
    const release = pinFileDisplayId(displayId);
    try {
      const currentPath = findFileDisplayPath(displayId) ?? path;
      const saved = await removeDocumentProperty(currentPath, 'flowix_cover');
      if (saved) setCoverState(null);
      return saved;
    } finally {
      release();
      pending.current -= 1;
    }
  }, [displayId, path]);

  return { cover, setCover, removeCover };
}
