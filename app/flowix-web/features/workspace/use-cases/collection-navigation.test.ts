import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTableDocument, serializeTableDocument } from '@features/multidimensional-table/model';
import { createMediaLibrary, serializeMediaLibrary } from '@features/media-library/model';
import { ensureCollectionDisplay, reconcileCollectionDisplays } from '@/lib/collection-display-registry';
import { useWorkColumnStore } from '../store/work-column-store';
import { useBrowserColumnStore } from '../store/browser-column-store';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), read: vi.fn(), clear: vi.fn(async () => {}) }));
vi.mock('@platform/tauri/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@platform/tauri/client')>(),
  collections: { resolve: mocks.resolve }, externalDocuments: { read: mocks.read },
}));
vi.mock('@features/memo/public/workspace-api', () => ({ getWorkspaceMemoState: () => ({ notebooks: [{ id: 'book', path: '/book' }] }) }));
vi.mock('@features/document/public/workspace-api', () => ({
  getWorkspaceDocumentState: () => ({ activeExternalSession: null, activeAgentConversationId: null, clearDocument: mocks.clear }),
  recordWorkspaceDocumentNavigation: vi.fn(),
}));
import { openCollectionTarget } from './workspace-navigation';

beforeEach(() => {
  vi.clearAllMocks();
  useBrowserColumnStore.getState().reset();
  const store = useWorkColumnStore.getState();
  store.commitNavigation(store.beginNavigation({ kind: 'empty' }, null), { kind: 'empty' });
});
afterEach(() => reconcileCollectionDisplays([]));

it('opens a table with a deleted reference view so the table can apply its fallback policy', async () => {
  const document = createTableDocument();
  mocks.resolve.mockResolvedValue({ relativePath: 'table.yaml', parseState: 'valid', collectionType: 'table', name: 'Table', indexSequence: 1 });
  mocks.read.mockResolvedValue(serializeTableDocument(document));
  await openCollectionTarget({ notebookId: 'book', collectionId: document.collection.id, viewId: 'deleted-view' });
  const target = useWorkColumnStore.getState().navigation.target;
  expect(target).toMatchObject({ kind: 'collection', viewId: 'deleted-view', filePath: '/book/table.yaml' });
  expect(target).not.toHaveProperty('unavailableReason');
});

it('commits the latest view when a second request arrives during loading', async () => {
  const document = createTableDocument();
  const firstView = document.views.items[0];
  document.views.items.push({ ...firstView, id: 'view_11111111111111111111111111111111', name: 'Second' });
  mocks.read.mockResolvedValue(serializeTableDocument(document));
  const item = { relativePath: 'table.yaml', parseState: 'valid', collectionType: 'table', name: 'Table', indexSequence: 1 };
  let release!: (value: typeof item) => void;
  mocks.resolve.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; })).mockResolvedValue(item);
  const reference = { notebookId: 'book', collectionId: document.collection.id };
  const first = openCollectionTarget({ ...reference, viewId: firstView.id });
  await vi.waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(1));
  await openCollectionTarget({ ...reference, viewId: 'view_11111111111111111111111111111111' });
  const latest = useWorkColumnStore.getState().navigation.target;
  expect(latest).toMatchObject({ kind: 'collection', viewId: 'view_11111111111111111111111111111111' });
  release(item);
  await first;
  expect(useWorkColumnStore.getState().navigation.target).toEqual(latest);
});

it('re-resolves an explicit main-column open after collection type changes and resets its view', async () => {
  const media = createMediaLibrary('Media');
  const display = ensureCollectionDisplay({ notebookId: 'book', collectionId: media.collection.id, viewId: 'old-table-view' });
  const target = { kind: 'collection' as const, ...display, filePath: '/book/.index.yaml', notebookPath: '/book', collectionType: 'table' as const, name: 'Table' };
  const store = useWorkColumnStore.getState();
  store.commitNavigation(store.beginNavigation(target, null), target);
  mocks.resolve.mockResolvedValue({ relativePath: '.index.yaml', parseState: 'valid', collectionType: 'media_library', name: 'Media', indexSequence: 1 });
  mocks.read.mockResolvedValue(serializeMediaLibrary(media));
  await openCollectionTarget({ ...display, viewId: null }, { destination: 'main-third', history: 'skip' });
  expect(mocks.resolve).toHaveBeenCalledTimes(1);
  expect(useWorkColumnStore.getState().navigation.target).toMatchObject({ displayId: display.displayId, collectionType: 'media_library', viewId: null });
});

it('revalidates an unavailable collection without clearing an identity conflict', async () => {
  const display = ensureCollectionDisplay({ notebookId: 'book', collectionId: 'conflicted', viewId: 'old' });
  const target = { kind: 'collection' as const, ...display, filePath: '/book/table.yaml', notebookPath: '/book', collectionType: 'table' as const, name: 'Table', unavailableReason: '集合身份冲突或格式暂不可用' };
  const store = useWorkColumnStore.getState();
  store.commitNavigation(store.beginNavigation(target, null), target);
  mocks.resolve.mockResolvedValue({ relativePath: 'table.yaml', parseState: 'valid', identityConflict: true, collectionType: 'table', name: 'Table', indexSequence: 1 });
  await openCollectionTarget({ ...display, viewId: 'another' });
  expect(mocks.resolve).toHaveBeenCalledTimes(1);
  expect(mocks.read).not.toHaveBeenCalled();
  expect(useWorkColumnStore.getState().navigation.target).toMatchObject({ unavailableReason: '集合身份冲突，请先为副本生成新 ID' });
});
