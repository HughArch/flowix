import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { createTableDocument, serializeTableDocument } from '@features/multidimensional-table/model';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), read: vi.fn() }));
vi.mock('@platform/tauri/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@platform/tauri/client')>(),
  collections: { resolve: mocks.resolve }, externalDocuments: { read: mocks.read },
}));
vi.mock('@platform/tauri/event-bus', () => ({ subscribe: () => () => {} }));
import { useCollectionReference } from './use-collection-reference';

it('loads an embedded table with a deleted view, while still rejecting a changed collection identity', async () => {
  const table = createTableDocument();
  mocks.resolve.mockResolvedValue({ relativePath: 'table.table.yaml', parseState: 'valid', collectionType: 'table', indexSequence: 1 });
  mocks.read.mockResolvedValue(serializeTableDocument(table));
  let reference!: ReturnType<typeof useCollectionReference>;
  function Probe({ viewId }: { viewId: string }) {
    reference = useCollectionReference({ id: 'book', path: '/book' }, table.collection.id, 'table', viewId);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe viewId="deleted-view" />));
    expect(reference.error).toBeNull();
    expect(reference.content).toBe(serializeTableDocument(table));
    expect(reference.fileIdentity?.path).toBe('/book/table.table.yaml');
    mocks.read.mockResolvedValue(serializeTableDocument(createTableDocument()));
    await act(async () => root.render(<Probe viewId="another-deleted-view" />));
    expect(reference.error).toBe('集合身份已变化');
  } finally { act(() => root.unmount()); }
});
