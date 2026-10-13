import { Component, act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentPage, MediaResourcePage } from '@platform/tauri/client';
import { DocumentListView } from './document-list-view';
import type { DocumentListSurface } from './types';

const probe = vi.hoisted(() => ({
  read: vi.fn<(request: unknown) => Promise<DocumentPage>>(),
  mediaRead: vi.fn<(...args: unknown[]) => Promise<MediaResourcePage>>(),
  listeners: new Map<string, Set<(payload: unknown) => void>>(),
}));
vi.mock('@platform/tauri/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@platform/tauri/client')>();
  return { ...actual, files: { ...actual.files, listDocumentPage: probe.read }, mediaResources: { ...actual.mediaResources, listPage: probe.mediaRead } };
});
vi.mock('@platform/tauri/event-bus', () => ({ subscribe: (event: string, listener: (payload: unknown) => void) => {
  const listeners = probe.listeners.get(event) ?? new Set();
  listeners.add(listener);
  probe.listeners.set(event, listeners);
  return () => listeners.delete(listener);
} }));

class RequestLoopBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div>Directory request loop</div> : this.props.children; }
}

const surface: DocumentListSurface = {
  kind: 'document-list', instanceKey: 'folder', displayId: 'folder',
  folderPath: '/notes/empty', notebookPath: '/notes', notebookId: 'notes', filters: {},
};
const emptyPage: DocumentPage = { folders: [], items: [], nextCursor: null, hasMore: false };
const mediaPage = (folder: string): MediaResourcePage => ({
  resources: [{ id: 'photo', notebookId: 'notes', relativePath: `${folder}/photo.png`, kind: 'image', sizeBytes: 10,
    modifiedMs: 1, fingerprint: null, properties: {}, propertiesRevision: 0, createdAt: 1, updatedAt: 1 }],
  nextCursor: null, hasMore: false,
});

describe('DocumentListView folder loading', () => {
  let host: HTMLDivElement;
  let root: Root;
  let scrollToDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    probe.read.mockReset();
    probe.mediaRead.mockReset();
    probe.listeners.clear();
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} });
    scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host, { onCaughtError: () => {} });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    if (scrollToDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollToDescriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
    vi.unstubAllGlobals();
  });

  function respondWith(page: Promise<DocumentPage>) {
    probe.read.mockImplementation(() => {
      // Fail boundedly if the loading effect starts requesting on every render.
      if (probe.read.mock.calls.length > 5) throw new Error('Directory request loop');
      return page;
    });
  }

  async function render(nextSurface = surface) {
    await act(async () => root.render(
      <RequestLoopBoundary><DocumentListView surface={nextSurface} /></RequestLoopBoundary>,
    ));
  }

  it('requests an empty folder once and exits loading when it resolves', async () => {
    let resolve!: (page: DocumentPage) => void;
    respondWith(new Promise<DocumentPage>((done) => { resolve = done; }));
    await render();
    expect(probe.read).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('正在整理文件列表');

    await act(async () => resolve(emptyPage));
    expect(host.textContent).toContain('列表内容为空');
    expect(host.textContent).not.toContain('正在整理文件列表');
    await render();
    expect(probe.read).toHaveBeenCalledTimes(1);
  });

  it('renders directory entries and reloads when the selected folder changes', async () => {
    respondWith(Promise.resolve({
      ...emptyPage,
      folders: [{ name: 'subfolder', fullPath: '/notes/empty/subfolder', resourceKind: 'folder', sizeBytes: null, modifiedMs: null, createdMs: null }],
      items: [{ name: 'readme.txt', fullPath: '/notes/empty/readme.txt', resourceKind: 'other', sizeBytes: 4, modifiedMs: null, createdMs: null }],
    }));
    await render();
    expect(probe.read).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('subfolder');
    expect(host.textContent).toContain('readme');
    expect(host.textContent).not.toContain('正在整理文件列表');

    respondWith(Promise.resolve(emptyPage));
    await render({ ...surface, displayId: 'other', folderPath: '/notes/other' });
    expect(probe.read).toHaveBeenCalledTimes(2);
    expect(probe.read).toHaveBeenLastCalledWith(expect.objectContaining({ folderPath: '/notes/other' }));
    expect(host.textContent).toContain('列表内容为空');
    expect(host.textContent).not.toContain('subfolder');
  });

  it('keeps folder media visible through a rename and coalesces a large event burst', async () => {
    probe.mediaRead.mockResolvedValueOnce(mediaPage('before'));
    const mediaSurface = (folder: string): DocumentListSurface => ({
      ...surface, displayId: 'folder-library', filters: { resourceKinds: ['image'] },
      mediaScope: { relativePath: folder, depth: 'descendants' },
    });
    const renderLibrary = async (folder: string, paused = false) => {
      await act(async () => root.render(<DocumentListView surface={mediaSurface(folder)} mediaLibrary libraryActionsDisabled={paused} refreshPaused={paused} />));
    };
    await renderLibrary('before');
    // A containing-folder source must work without explicit records or a path filter.
    expect(probe.mediaRead).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[title="photo.png"]')).not.toBeNull();

    await renderLibrary('before', true);
    await renderLibrary('after', true);
    await act(async () => {
      for (let index = 0; index < 200; index += 1) {
        for (const listener of probe.listeners.get('file-management-changed') ?? []) listener({ notebookId: 'notes' });
      }
    });
    expect(probe.mediaRead).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[title="photo.png"]')).not.toBeNull();

    let finish!: (page: MediaResourcePage) => void;
    probe.mediaRead.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await renderLibrary('after');
    expect(probe.mediaRead).toHaveBeenCalledTimes(2);
    expect(probe.mediaRead).toHaveBeenLastCalledWith('/notes', ['image'], null, 30, 'after', 'descendants');
    expect(host.querySelector('[title="photo.png"]')).not.toBeNull();
    probe.mediaRead.mockResolvedValue(mediaPage('after'));
    await act(async () => {
      for (let index = 0; index < 200; index += 1) {
        for (const listener of probe.listeners.get('file-management-changed') ?? []) listener({ notebookId: 'notes' });
      }
    });
    expect(probe.mediaRead).toHaveBeenCalledTimes(2);
    await act(async () => finish(mediaPage('after')));
    // One follow-up refresh catches the changes received during the request.
    expect(probe.mediaRead).toHaveBeenCalledTimes(3);
    expect(host.querySelector('[title="photo.png"]')).not.toBeNull();
    expect(host.textContent).not.toContain('未设置数据集合');
  });

  it('recovers an early empty query when media index reconciliation completes without changing filters', async () => {
    probe.mediaRead.mockResolvedValueOnce({ resources: [], nextCursor: null, hasMore: false });
    const scopedSurface: DocumentListSurface = {
      ...surface, displayId: 'reconciled-library', filters: { resourceKinds: ['image'] },
      mediaScope: { relativePath: 'renamed', depth: 'descendants' },
    };
    await act(async () => root.render(<DocumentListView surface={scopedSurface} mediaLibrary />));
    expect(probe.mediaRead).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('列表内容为空');
    expect(host.textContent).not.toContain('未设置数据集合');

    probe.mediaRead.mockResolvedValueOnce(mediaPage('renamed'));
    await act(async () => {
      for (const listener of probe.listeners.get('file-management-changed') ?? []) listener({ notebookId: 'notes' });
    });
    expect(probe.mediaRead).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[title="photo.png"]')).not.toBeNull();
  });

  it('loads a readable library when its actions are disabled', async () => {
    probe.mediaRead.mockResolvedValue(mediaPage('readonly'));
    const scopedSurface: DocumentListSurface = {
      ...surface, displayId: 'readonly-library', filters: { resourceKinds: ['image'] },
      mediaScope: { relativePath: 'readonly', depth: 'descendants' },
    };
    await act(async () => root.render(<DocumentListView surface={scopedSurface} mediaLibrary libraryActionsDisabled />));
    expect(probe.mediaRead).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[title="photo.png"]')).not.toBeNull();
  });
});
