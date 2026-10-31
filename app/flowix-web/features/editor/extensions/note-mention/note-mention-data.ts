import { notes } from '@platform/tauri/client';
import { useNoteStore } from '@features/memo/store/note-store';
import type { NoteReferenceAttrs } from '@features/editor/extensions/note-link/view-note';

export interface MentionNoteItem {
  relativePath: string;
  filename: string;
  title: string;
  updatedAt: number;
  notebookId: string;
  notebookName: string;
  notebookPath: string;
  originalPath: string | null;
}

let cachedItems: MentionNoteItem[] | null = null;
let cachePromise: Promise<MentionNoteItem[]> | null = null;

async function fetchMentionNotes(query: string): Promise<MentionNoteItem[]> {
  const state = useNoteStore.getState();
  if (!state.notebooksInitialized) await state.loadNotebooks();
  const notebooks = useNoteStore.getState().notebooks;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const groups = await Promise.all(notebooks.map(async (notebook) => {
    const [entries, canvases] = await Promise.all([
      notes.list(notebook.id),
      notes.listCanvases(notebook.id).catch((error) => {
        console.warn('[note-mention] canvas list failed:', error);
        return [];
      }),
    ]);
    const noteItems = entries.map((note): MentionNoteItem => ({
      relativePath: note.relativePath,
      filename: note.relativePath.split('/').pop() || note.relativePath,
      title: note.title,
      updatedAt: note.updatedAt,
      notebookId: notebook.id,
      notebookName: notebook.name,
      notebookPath: notebook.path,
      originalPath: null,
    }));
    // Canvas documents live outside the note index; expose them so the
    // composer can @-mention a board (the canvas tool / CLI read them).
    const canvasItems = canvases.map((canvas): MentionNoteItem => {
      const stem = canvas.relativePath.split('/').pop()?.replace(/\.flowix-canvas$/i, '') || canvas.relativePath;
      return {
        relativePath: canvas.relativePath,
        filename: canvas.relativePath.split('/').pop() || canvas.relativePath,
        title: stem,
        updatedAt: canvas.updatedAt,
        notebookId: notebook.id,
        notebookName: notebook.name,
        notebookPath: notebook.path,
        originalPath: null,
      };
    });
    return [...noteItems, ...canvasItems];
  }));
  // Notes compete for the 200-entry window (bulk perf notes can otherwise
  // crowd out everything else); canvases are rare, so all matching ones stay.
  const filteredNotes = groups.flat().filter((item) => !isCanvasItem(item)
    && (!normalizedQuery
      || item.title.toLocaleLowerCase().includes(normalizedQuery)
      || item.relativePath.toLocaleLowerCase().includes(normalizedQuery)))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 200);
  const filteredCanvases = groups.flat().filter(isCanvasItem)
    .filter((item) => !normalizedQuery
      || item.title.toLocaleLowerCase().includes(normalizedQuery)
      || item.relativePath.toLocaleLowerCase().includes(normalizedQuery))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return [...filteredNotes, ...filteredCanvases];
}

function isCanvasItem(item: MentionNoteItem): boolean {
  return item.relativePath.toLowerCase().endsWith('.flowix-canvas');
}

function loadMentionNotes(): Promise<MentionNoteItem[]> {
  if (cachedItems) return Promise.resolve(cachedItems);
  if (!cachePromise) {
    cachePromise = fetchMentionNotes('')
      .then((items) => {
        cachedItems = items;
        return items;
      })
      .catch((err) => {
        console.warn('[note-mention] load failed:', err);
        cachePromise = null;
        return [];
      });
  }
  return cachePromise;
}

export function invalidateMentionNotes(): void {
  cachedItems = null;
  cachePromise = null;
}

export function queryMentionNotes(query: string): Promise<MentionNoteItem[]> {
  const normalizedQuery = query.trim().toLowerCase();
  return normalizedQuery ? fetchMentionNotes(normalizedQuery) : loadMentionNotes();
}

export function toNoteReferenceAttrs(item: MentionNoteItem): NoteReferenceAttrs {
  return {
    notebookId: item.notebookId,
    relativePath: item.relativePath,
    notebookName: item.notebookName,
    title: item.title,
    originalPath: item.originalPath,
    linkStyle: 'flowix',
    linkTarget: null,
    heading: null,
    stale: false,
  };
}
