import { usePropertyPresetStore } from '@features/properties/property-preset-store';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { createTableDocument, serializeTableDocument } from './model';

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('@platform/tauri/client', () => ({
  externalDocuments: { read: mocks.read, write: mocks.write },
  notes: { list: vi.fn(async () => []) },
}));
vi.mock('@platform/tauri/event-bus', () => ({ subscribe: () => () => {} }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('./parse-table-document', async () => {
  const { parseTableDocument } = await import('./model');
  return { parseTableDocumentAsync: async (source: string) => parseTableDocument(source) };
});
import { useTableSession } from './use-table-session';
beforeEach(() => usePropertyPresetStore.setState({ loaded: true, registry: { fields: [] } }));

it('reports external write failures, clears them for retry, and ignores stale session failures', async () => {
  const source = serializeTableDocument(createTableDocument());
  mocks.read.mockResolvedValue(source);
  mocks.write.mockImplementation(async ({ content }: { content: string }) => ({ status: 'saved', content }));
  let session!: ReturnType<typeof useTableSession>;
  function Probe() {
    session = useTableSession({ filePath: '/notebook/table.table.yaml', notebookPath: '/notebook', notebookId: 'nb' });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe />));
    expect(session.document).toBeTruthy();
    const sequence = session.loadSequenceRef.current;
    act(() => session.setSaving(true));
    act(() => session.reportSaveFailure(sequence));
    act(() => session.setSaving(false));
    expect(session.saveFailed).toBe(true);
    expect(session.saving).toBe(false);

    act(() => session.setSaving(true));
    expect(session.saveFailed).toBe(false);
    expect(session.saving).toBe(true);
    act(() => session.setSaving(false));
    await act(async () => { expect(await session.save(session.document!)).toBe(true); });
    expect(session.saveFailed).toBe(false);
    expect(session.saving).toBe(false);

    await act(async () => session.load());
    act(() => session.reportSaveFailure(sequence));
    expect(session.saveFailed).toBe(false);
    act(() => session.reportSaveFailure(session.loadSequenceRef.current));
    expect(session.saveFailed).toBe(true);
  } finally { act(() => root.unmount()); }
});

it('retains data and pending writes across views, but reloads for another collection', async () => {
  mocks.read.mockClear();
  mocks.read.mockResolvedValue(serializeTableDocument(createTableDocument()));
  let session!: ReturnType<typeof useTableSession>;
  function Probe({ displayId, collectionId }: { displayId: string; collectionId: string }) {
    session = useTableSession({ filePath: '/notebook/table.table.yaml', fileIdentity: { path: '/notebook/table.table.yaml', displayId }, notebookPath: '/notebook', notebookId: 'nb', expectedCollectionId: collectionId });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe displayId="table-view" collectionId="collection-a" />));
    const loaded = session.document;
    const generation = session.loadSequenceRef.current;
    act(() => session.setSaving(true));
    await act(async () => root.render(<Probe displayId="gallery-view" collectionId="collection-a" />));
    expect(session.document).toBe(loaded);
    expect(session.loadSequenceRef.current).toBe(generation);
    expect(session.saving).toBe(true);
    expect(mocks.read).toHaveBeenCalledTimes(1);
    act(() => session.reportSaveFailure(generation));
    expect(session.saveFailed).toBe(true);
    await act(async () => root.render(<Probe displayId="other-view" collectionId="collection-b" />));
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(session.loadSequenceRef.current).toBeGreaterThan(generation);
    expect(session.saveFailed).toBe(false);
  } finally { act(() => root.unmount()); }
});
