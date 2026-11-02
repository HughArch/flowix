import { useEffect, useRef, useState } from 'react';
import { canonicalDirectoryPath, canonicalPath } from '@/lib/path';
import { notes as notesClient } from '@platform/tauri/client';
import { subscribeNotebookChanges } from '@platform/tauri/notebook-change-events';
import { noteIndexFor, noteLookupKey, useNoteStore } from '../store/note-store';

export interface NotebookNoteIconRequest {
  key: string;
  notebookId: string | null;
  filePath: string;
}
interface NoteLookup { notebookId: string; relativePath: string }

function resolveLookup(request: NotebookNoteIconRequest, notebooks: readonly { id: string; path: string }[]): NoteLookup | null {
  const notebook = notebooks.find((item) => item.id === request.notebookId);
  if (!notebook) return null;
  const root = canonicalDirectoryPath(notebook.path);
  const prefix = root === '/' ? root : `${root}/`;
  const path = canonicalPath(request.filePath);
  return path.startsWith(prefix) ? { notebookId: notebook.id, relativePath: path.slice(prefix.length) } : null;
}

/** Share indexed reads and notebook invalidation across all consumers of a tab header. */
export function useNotebookNoteIcons(requests: readonly NotebookNoteIconRequest[]): Record<string, string | null> {
  const notebooks = useNoteStore((state) => state.notebooks);
  const lookups = new Map<string, NoteLookup>();
  const requestKeys = new Map<string, string>();
  for (const request of requests) {
    const lookup = resolveLookup(request, notebooks);
    if (!lookup) continue;
    const key = noteLookupKey(lookup.notebookId, lookup.relativePath);
    lookups.set(key, lookup);
    requestKeys.set(request.key, key);
  }
  // Metadata/title updates must not restart subscriptions or repeat indexed reads.
  const lookupSignature = JSON.stringify([...lookups.values()].sort((left, right) =>
    noteLookupKey(left.notebookId, left.relativePath).localeCompare(noteLookupKey(right.notebookId, right.relativePath))));
  const [icons, setIcons] = useState<Record<string, string | null>>({});
  const resolvedIcons = useRef(new Map<string, string | null>());

  useEffect(() => {
    const targets: NoteLookup[] = JSON.parse(lookupSignature);
    let active = true;
    const revisions = new Map<string, number>();
    const update = (key: string, icon: string | null) => {
      if (!active) return;
      resolvedIcons.current.set(key, icon);
      setIcons((previous) => previous[key] === icon ? previous : { ...previous, [key]: icon });
    };
    const accept = (key: string, icon: string | null) => {
      revisions.set(key, (revisions.get(key) ?? 0) + 1);
      update(key, icon);
    };
    const load = (target: NoteLookup) => {
      const key = noteLookupKey(target.notebookId, target.relativePath);
      const revision = (revisions.get(key) ?? 0) + 1;
      revisions.set(key, revision);
      void notesClient.getIndexed(target.notebookId, target.relativePath).then((note) => {
        if (revisions.get(key) === revision) update(key, note?.icon?.trim() || null);
      }).catch(() => {
        if (revisions.get(key) === revision) update(key, null);
      });
    };
    const projected = noteIndexFor(useNoteStore.getState().notes);
    const targetKeys = new Set(targets.map((target) => noteLookupKey(target.notebookId, target.relativePath)));
    for (const key of resolvedIcons.current.keys()) {
      if (!targetKeys.has(key)) resolvedIcons.current.delete(key);
    }
    const initial: Record<string, string | null> = {};
    for (const target of targets) {
      const key = noteLookupKey(target.notebookId, target.relativePath);
      const note = projected.get(key);
      if (note) resolvedIcons.current.set(key, note.icon?.trim() || null);
      initial[key] = resolvedIcons.current.get(key) ?? null;
    }
    setIcons(initial);
    const unsubscribeProjection = useNoteStore.subscribe((state, previous) => {
      if (state.notes === previous.notes) return;
      const next = noteIndexFor(state.notes);
      const before = noteIndexFor(previous.notes);
      for (const target of targets) {
        const key = noteLookupKey(target.notebookId, target.relativePath);
        const note = next.get(key);
        if (note && note !== before.get(key)) accept(key, note.icon?.trim() || null);
      }
    });
    const unsubscribe = subscribeNotebookChanges((change) => {
      for (const target of targets) {
        if (target.notebookId !== change.notebookId) continue;
        const matches = change.relativePath === null || target.relativePath === canonicalPath(change.relativePath)
          || change.kind === 'path-moved'
          || (change.kind === 'resource-deleted' && target.relativePath.startsWith(`${canonicalPath(change.relativePath)}/`));
        if (!matches) continue;
        const key = noteLookupKey(target.notebookId, target.relativePath);
        if (change.kind === 'resource-updated') accept(key, change.entry.icon?.trim() || null);
        else if (change.kind === 'resource-deleted') accept(key, null);
        else load(target);
      }
    });
    for (const target of targets) {
      if (!resolvedIcons.current.has(noteLookupKey(target.notebookId, target.relativePath))) load(target);
    }
    return () => { active = false; unsubscribe(); unsubscribeProjection(); };
  }, [lookupSignature]);

  return Object.fromEntries(requests.map((request) => [request.key, icons[requestKeys.get(request.key) ?? ''] ?? null]));
}
