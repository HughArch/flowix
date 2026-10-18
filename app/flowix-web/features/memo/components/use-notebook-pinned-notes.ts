import { useCallback, useEffect, useRef, useState } from 'react';

import { createLogger } from '@/lib/logger';
import { joinNotebookMemoPath } from '@/lib/path';
import { noteRepository } from '@features/memo/services/note-repository';
import { registerMemoEventHandler } from '@/lib/memo-dispatcher';
import type { DocTreeItem, NoteEntry } from '@platform/tauri/client';
import { subscribeNotebookChanges } from '@platform/tauri/notebook-change-events';

const logger = createLogger('notebook-pinned-notes');
const PINNED_NOTES_PAGE_SIZE = 100;

interface UseNotebookPinnedNotesOptions {
  notebookId: string | null;
  notebookPath: string;
  isActive: boolean;
  refreshTrigger: number;
}

export function useNotebookPinnedNotes({
  notebookId,
  notebookPath,
  isActive,
  refreshTrigger,
}: UseNotebookPinnedNotesOptions) {
  const [pinnedItems, setPinnedItems] = useState<DocTreeItem[]>([]);
  const requestSequence = useRef(0);
  const loadedScope = useRef<{ notebookId: string; notebookPath: string } | null>(null);
  const [changeRevision, setChangeRevision] = useState(0);

  useEffect(() => subscribeNotebookChanges((change) => {
    if (change.notebookId === notebookId
      && (change.kind !== 'resource-created' || change.source === 'external_tool')) {
      setChangeRevision((revision) => revision + 1);
    }
  }), [notebookId]);

  useEffect(() => registerMemoEventHandler((event) => {
    if (event.notebookId !== notebookId || event.kind === 'tags_renamed' || event.kind === 'tags_deleted') return;
    if (event.kind === 'deleted' || event.source === 'cloud_sync') {
      setChangeRevision((revision) => revision + 1);
    }
  }), [notebookId]);

  useEffect(() => {
    if (!isActive) return;
    if (!notebookId) {
      loadedScope.current = null;
      setPinnedItems([]);
      return;
    }
    if (loadedScope.current?.notebookId !== notebookId || loadedScope.current.notebookPath !== notebookPath) {
      setPinnedItems([]);
    }
    let cancelled = false;
    const sequence = ++requestSequence.current;

    void (async () => {
      const notes: NoteEntry[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      while (!cancelled) {
        const page = await noteRepository.listByPath({
          notebookId,
          filter: 'favorited',
          sort: 'updatedAt',
          cursor,
          limit: PINNED_NOTES_PAGE_SIZE,
        });
        notes.push(...page.notes);
        const nextCursor = page.nextCursor ?? undefined;
        if (!page.hasMore || !nextCursor || seenCursors.has(nextCursor)) break;
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }

      if (cancelled || sequence !== requestSequence.current) return;
      setPinnedItems(notes.flatMap((note) => {
        const relativePath = note.relativePath.replace(/\\/g, '/');
        const fullPath = joinNotebookMemoPath(notebookPath, relativePath);
        if (!fullPath) return [];
        return [{
          id: `pinned:${relativePath}`,
          fullPath,
          name: relativePath.split('/').pop() || relativePath,
          type: 'document' as const,
          parentId: null,
          children: null,
          sizeBytes: note.sizeBytes ?? null,
          modifiedMs: note.updatedAt,
          createdMs: note.createdAt,
          memoCreatedMs: note.createdAt,
          resourceKind: 'note' as const,
          memoMeta: {
            icon: note.icon,
            colors: note.colors,
            favorited: true,
          },
        }];
      }));
      loadedScope.current = { notebookId, notebookPath };
    })().catch((error) => {
      if (!cancelled) logger.warn('failed to load pinned notes', { error, notebookPath });
    });

    return () => {
      cancelled = true;
      if (requestSequence.current === sequence) requestSequence.current += 1;
    };
  }, [isActive, notebookId, notebookPath, refreshTrigger, changeRevision]);

  const removePinnedItem = useCallback((itemId: string) => {
    setPinnedItems((items) => items.filter((item) => item.id !== itemId));
  }, []);

  return { pinnedItems, removePinnedItem };
}
