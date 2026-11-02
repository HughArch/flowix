import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { notes, type NoteEntry } from '@platform/tauri/client';
import type { NotebookChange } from '@platform/tauri/notebook-change-events';
import { useNoteStore } from '../store/note-store';
import { useNotebookNoteIcons, type NotebookNoteIconRequest } from './use-notebook-note-icons';

const handlers = vi.hoisted(() => new Set<(change: NotebookChange) => void>());
vi.mock('@platform/tauri/notebook-change-events', () => ({
  subscribeNotebookChanges: (handler: (change: NotebookChange) => void) => {
    handlers.add(handler); return () => handlers.delete(handler);
  },
}));
const entry = (icon: string | null) => ({ relativePath: 'a.md', icon } as NoteEntry);
const requests = [
  { key: 'one', notebookId: 'book', filePath: '/book/a.md' },
  { key: 'two', notebookId: 'book', filePath: '/book/a.md' },
];
let root: Root;
let host: HTMLDivElement;
let result: Record<string, string | null>;
function Harness({ items = requests }: { items?: NotebookNoteIconRequest[] }) {
  result = useNotebookNoteIcons(items); return null;
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useNoteStore.setState({ notes: [], notebooks: [{ id: 'book', name: 'Book', path: '/book', createdAt: 0, updatedAt: 0, isDefault: false }] });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); handlers.clear(); vi.restoreAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});
async function emit(change: NotebookChange) {
  await act(async () => { for (const handler of handlers) handler(change); });
}

it('shares one indexed read across consumers and keeps it across equivalent renders', async () => {
  const read = vi.spyOn(notes, 'getIndexed').mockResolvedValue(entry('flashlight'));
  await act(async () => root.render(<Harness />));
  expect(read).toHaveBeenCalledExactlyOnceWith('book', 'a.md');
  expect(result).toEqual({ one: 'flashlight', two: 'flashlight' });
  await act(async () => root.render(<Harness items={requests.map((item) => ({ ...item }))} />));
  expect(read).toHaveBeenCalledOnce();
});

it('refreshes background notebook icons on invalidation and applies updated/deleted entries directly', async () => {
  const read = vi.spyOn(notes, 'getIndexed').mockResolvedValue(entry('flashlight'));
  await act(async () => root.render(<Harness />));
  read.mockResolvedValue(entry('avocado'));
  await emit({ kind: 'query-invalidated', notebookId: 'other', relativePath: null });
  expect(read).toHaveBeenCalledOnce();
  await emit({ kind: 'query-invalidated', notebookId: 'book', relativePath: null });
  expect(result.one).toBe('avocado');
  await emit({ kind: 'resource-updated', notebookId: 'book', relativePath: 'a.md', entry: entry('dog-face') });
  expect(result.two).toBe('dog-face');
  expect(read).toHaveBeenCalledTimes(2);
  await emit({ kind: 'resource-deleted', notebookId: 'book', relativePath: 'a.md' });
  expect(result.one).toBeNull();
});

it('ignores a stale indexed response after a newer notebook update', async () => {
  let resolve!: (value: NoteEntry) => void;
  vi.spyOn(notes, 'getIndexed').mockReturnValue(new Promise((finish) => { resolve = finish; }));
  await act(async () => root.render(<Harness />));
  await emit({ kind: 'resource-updated', notebookId: 'book', relativePath: 'a.md', entry: entry('dog-face') });
  await act(async () => resolve(entry('flashlight')));
  expect(result.one).toBe('dog-face');
});

it('uses loaded projections without an IPC read and tracks subsequent projection updates', async () => {
  const projected = { ...entry('flashlight'), kind: 'path-note' as const, notebookId: 'book', filename: 'a.md' };
  useNoteStore.setState({ notes: [projected] });
  const read = vi.spyOn(notes, 'getIndexed');
  await act(async () => root.render(<Harness />));
  expect(result.one).toBe('flashlight');
  expect(read).not.toHaveBeenCalled();
  await act(async () => useNoteStore.setState({ notes: [{ ...projected, icon: 'avocado' }] }));
  expect(result.two).toBe('avocado');
});

it('does not let an older read override a newly loaded list projection', async () => {
  let resolve!: (value: NoteEntry) => void;
  vi.spyOn(notes, 'getIndexed').mockReturnValue(new Promise((finish) => { resolve = finish; }));
  await act(async () => root.render(<Harness />));
  await act(async () => useNoteStore.setState({ notes: [{ ...entry('dog-face'), kind: 'path-note', notebookId: 'book', filename: 'a.md' }] }));
  await act(async () => resolve(entry('flashlight')));
  expect(result.one).toBe('dog-face');
});

it('retains resolved icons when tabs are added or reordered and reloads closed notes when reopened', async () => {
  const read = vi.spyOn(notes, 'getIndexed').mockImplementation(async (_, path) => ({ ...entry(path === 'a.md' ? 'flashlight' : 'avocado'), relativePath: path }));
  await act(async () => root.render(<Harness items={[requests[0]]} />));
  const expanded = [requests[0], { key: 'second', notebookId: 'book', filePath: '/book/b.md' }];
  await act(async () => root.render(<Harness items={expanded} />));
  expect(read).toHaveBeenCalledTimes(2);
  expect(result).toEqual({ one: 'flashlight', second: 'avocado' });
  await act(async () => root.render(<Harness items={[...expanded].reverse()} />));
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => root.render(<Harness items={[expanded[1]]} />));
  await act(async () => root.render(<Harness items={expanded} />));
  expect(read).toHaveBeenCalledTimes(3);
});
