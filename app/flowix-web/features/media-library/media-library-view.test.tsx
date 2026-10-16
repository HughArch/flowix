import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SurfaceLifecycle } from '@features/workspace/public/surface-api';
import { createMediaLibrary, serializeMediaLibrary } from './model';
import { MediaLibraryView } from './media-library-view';

type ListActions = {
  onMediaLibraryFilterChange: (filter: { file_type: 'image' }) => Promise<boolean>;
  onAddMedia: () => Promise<boolean>;
};
const mocks = vi.hoisted(() => ({
  read: vi.fn(), write: vi.fn(), importFiles: vi.fn(),
  actions: null as ListActions | null,
}));
vi.mock('@platform/tauri/client', () => ({
  files: { read: mocks.read }, externalDocuments: { read: mocks.read, write: mocks.write },
  dialogs: { selectFiles: async () => ['/source/image.png'] }, mediaResources: {}, notebookAssets: {},
}));
vi.mock('@platform/tauri/event-bus', () => ({ subscribe: () => () => {} }));
vi.mock('@features/collection/public/folder-api', () => ({ FolderCollectionSwitchConfirmDialog: () => null }));
vi.mock('@features/memo/store/note-store', () => ({
  useNoteStore: (select: (state: { notebooks: unknown[] }) => unknown) => select({ notebooks: [] }),
}));
vi.mock('@features/surface/document-list-view', () => ({
  DocumentListView: (props: ListActions) => { mocks.actions = props; return null; },
}));
vi.mock('./rename-media-library', () => ({ renameMediaLibrary: vi.fn() }));
vi.mock('./media-import', () => ({ importMediaLibraryFiles: mocks.importFiles }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

let root: Root;
let lifecycle: SurfaceLifecycle | null;
const register = (value: SurfaceLifecycle | null) => { lifecycle = value; };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue(serializeMediaLibrary(createMediaLibrary('Library')));
  mocks.write.mockImplementation(async ({ content }: { content: string }) => ({ status: 'saved', content }));
  lifecycle = null;
  root = createRoot(document.createElement('div'));
  await act(async () => root.render(<MediaLibraryView filePath="/book/library.lib.yaml"
    notebookPath="/book" notebookId="book" onSurfaceLifecycleReady={register} />));
});
afterEach(async () => { await act(async () => root.unmount()); });

describe('media library surface save barrier', () => {
  it('returns false for a failed config write and permits a successful retry', async () => {
    const write = deferred<{ status: 'error'; message: string }>();
    mocks.write.mockReturnValueOnce(write.promise);
    let operation!: Promise<boolean>;
    act(() => { operation = mocks.actions!.onMediaLibraryFilterChange({ file_type: 'image' }); });
    const flush = lifecycle!.flush!();
    let finished = false;
    void flush.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    await act(async () => { write.resolve({ status: 'error', message: 'write failed' }); await operation; });
    await expect(flush).resolves.toBe(false);
    await expect(lifecycle!.flush!()).resolves.toBe(false);
    await act(async () => { expect(await mocks.actions!.onMediaLibraryFilterChange({ file_type: 'image' })).toBe(true); });
    await expect(lifecycle!.flush!()).resolves.toBe(true);
  });

  it('waits for the import transaction after its nested configuration write completes', async () => {
    const tail = deferred<void>();
    mocks.importFiles.mockImplementation(async ({ persist }: { persist: (mutate: (value: ReturnType<typeof createMediaLibrary>) => ReturnType<typeof createMediaLibrary>) => Promise<boolean> }) => {
      await persist((current) => current);
      await tail.promise;
      return { completed: ['image.png'], failed: 0, recordSaveFailed: false, cleanupFailed: 0 };
    });
    let operation!: Promise<boolean>;
    await act(async () => { operation = mocks.actions!.onAddMedia(); });
    expect(mocks.write).toHaveBeenCalledOnce();
    const flush = lifecycle!.flush!();
    let finished = false;
    void flush.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    await act(async () => { tail.resolve(); await operation; });
    await expect(flush).resolves.toBe(true);
  });
});
