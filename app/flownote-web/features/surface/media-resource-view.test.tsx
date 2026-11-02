import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SurfacePresentationUpdate } from '@features/workspace/model/surface-contract';
import { MediaResourceView } from './media-resource-view';

const mocks = vi.hoisted(() => ({ readImage: vi.fn(), toAssetUrl: vi.fn(), mediaGet: vi.fn(), cancelThumbnail: vi.fn() }));
vi.mock('@platform/tauri/client', () => ({
  files: { readImage: mocks.readImage, toAssetUrl: mocks.toAssetUrl },
  mediaResources: { get: mocks.mediaGet, cancelThumbnail: mocks.cancelThumbnail },
}));
vi.mock('./video-preview-cache', () => ({ getNotebookVideoPreview: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

let host: HTMLDivElement;
let root: Root;
let updates: SurfacePresentationUpdate[];
const reportPresentation = (update: SurfacePresentationUpdate) => updates.push(update);

function latestState() {
  const stateUpdates = updates.filter((update) => update.state);
  return stateUpdates[stateUpdates.length - 1]?.state;
}

async function render(filePath: string) {
  await act(async () => root.render(<MediaResourceView filePath={filePath} notebookPath="/book" resourceKind="image" reportPresentation={reportPresentation} />));
}

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement('div');
  root = createRoot(host);
  updates = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
});

describe('media resource presentation', () => {
  it('publishes loading, error, retry and ready after the image is loaded', async () => {
    const first = deferred<string | null>();
    const second = deferred<string | null>();
    mocks.readImage.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await render('/book/photo.png');
    expect(latestState()?.status).toBe('loading');

    await act(async () => first.reject(new Error('read failed')));
    expect(latestState()?.status).toBe('error');
    const errorState = latestState();
    const retry = errorState && (errorState.status === 'error' || errorState.status === 'unavailable')
      ? errorState.actions?.find((action) => action.id === 'retry')
      : undefined;
    expect(retry).toBeDefined();
    await act(async () => retry?.run());
    await act(async () => second.resolve('data:image/png;base64,abc'));

    const image = host.querySelector('img');
    expect(image).not.toBeNull();
    await act(async () => image!.dispatchEvent(new Event('load')));
    expect(latestState()?.status).toBe('ready');
    expect(mocks.readImage).toHaveBeenCalledTimes(2);
  });

  it('ignores an image read that finishes after switching to another file', async () => {
    const stale = deferred<string | null>();
    const current = deferred<string | null>();
    mocks.readImage.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    await render('/book/old.png');
    await render('/book/new.png');

    await act(async () => stale.resolve('data:image/png;base64,old'));
    expect(host.querySelector('img')).toBeNull();
    await act(async () => current.resolve('data:image/png;base64,new'));
    expect(host.querySelector('img')?.alt).toBe('new.png');
    expect(updates.some((update) => update.title === 'old.png' && update.state?.status === 'ready')).toBe(false);
  });
});
