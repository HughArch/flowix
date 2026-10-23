import { useCallback, useEffect, useRef, useState } from 'react';
import { findFileDisplayPath, pinFileDisplayId } from '@/lib/file-display-registry';
import { useI18n } from '@/lib/i18n';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import type { NoteColor } from '@/types/note-item';
import { NOTE_COLORS, useNoteStore } from '@features/memo/store/note-store';
import { notes } from '@platform/tauri/client';
import { setDocumentProperties } from '../public/path-properties';
import { extractFrontmatter } from '../properties/frontmatter-model';
import { getBuffer, subscribeDocumentBufferChanges } from '../store/buffer-registry';
import { documentIdentityFromFile } from '../store/document-identity';
import type { DocumentTitlebarTarget } from './document-titlebar-model';

const logger = createLogger('document-titlebar-colors');
// A file can be reopened while an earlier view is still saving it.
const writes = new Map<string, Promise<void>>();

function saveColors(target: DocumentTitlebarTarget, colors: NoteColor[]): Promise<void> {
  const key = target.fileIdentity.displayId;
  const release = pinFileDisplayId(key);
  const operation = (writes.get(key) ?? Promise.resolve()).then(async () => {
    const path = findFileDisplayPath(key);
    if (!path || !await setDocumentProperties(path, { flowix_colors: colors })) {
      throw new Error('Saving document colors failed');
    }
    useNoteStore.setState((state) => ({
      notes: state.notes.map((note) => note.notebookId === target.notebookId
        && note.relativePath === target.relativePath ? { ...note, colors } : note),
    }));
  }).finally(release);
  const settled = operation.then(() => {}, () => {});
  writes.set(key, settled);
  void settled.then(() => { if (writes.get(key) === settled) writes.delete(key); });
  return operation;
}

function readBufferColors(target: DocumentTitlebarTarget): NoteColor[] | undefined {
  const buffer = getBuffer(documentIdentityFromFile(target.fileIdentity));
  if (!buffer) return undefined;
  const value = extractFrontmatter(buffer.content).data.flowix_colors;
  return Array.isArray(value) ? NOTE_COLORS.filter((color) => value.includes(color)) : [];
}

function equalColors(left: NoteColor[], right: NoteColor[]) {
  return left.length === right.length && left.every((color, index) => color === right[index]);
}

/** Mounted by a target-keyed action group; queued writes retain that target. */
export function useDocumentTitlebarColors(target: DocumentTitlebarTarget) {
  const { t } = useI18n();
  const projectedColors = useNoteStore((state) => state.notes.find((note) =>
    note.notebookId === target.notebookId && note.relativePath === target.relativePath)?.colors);
  const [colors, setColors] = useState<NoteColor[]>(() => readBufferColors(target) ?? projectedColors ?? []);
  const pending = useRef(0);
  const revision = useRef(0);
  const mounted = useRef(false);
  const { path, displayId } = target.fileIdentity;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const syncBufferColors = useCallback(() => {
    const buffered = readBufferColors(target);
    if (buffered === undefined) return false;
    setColors((previous) => equalColors(previous, buffered) ? previous : buffered);
    return true;
  }, [target]);

  useEffect(() => subscribeDocumentBufferChanges((identity) => {
    if (identity.displayId === displayId && pending.current === 0) syncBufferColors();
  }), [displayId, syncBufferColors]);

  useEffect(() => {
    if (!target.indexable || pending.current > 0 || syncBufferColors()) return;
    if (projectedColors) {
      setColors((previous) => equalColors(previous, projectedColors) ? previous : projectedColors);
      return;
    }
    let cancelled = false;
    const requestRevision = revision.current;
    void notes.readDocument(path).then((content) => {
      if (cancelled || content === null || revision.current !== requestRevision || syncBufferColors()) return;
      const value = extractFrontmatter(content).data.flowix_colors;
      const loaded = Array.isArray(value) ? NOTE_COLORS.filter((color) => value.includes(color)) : [];
      setColors(loaded);
    }).catch((error) => logger.warn('read colors failed', { error, path }));
    return () => { cancelled = true; };
  }, [path, displayId, target.indexable, projectedColors, syncBufferColors]);

  const changeColors = (next: NoteColor[]) => {
    if (!target.indexable) return;
    ++revision.current;
    pending.current += 1;
    setColors(next);
    void saveColors(target, next).catch((error) => {
      logger.error('save colors failed', { error, path });
      if (mounted.current) {
        toast.error(t('media.properties.saveFailed'));
      }
    }).finally(() => {
      pending.current -= 1;
      if (mounted.current && pending.current === 0) syncBufferColors();
    });
  };

  return { colors, changeColors };
}
