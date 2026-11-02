import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { files } from '@platform/tauri/client';
import { useTableImages, type TableImageReference } from './use-table-images';

vi.mock('@platform/tauri/client', () => ({ files: { readImage: vi.fn(async (path: string) => `url:${path}`) } }));

it('reuses appended images under StrictMode and resets on table reload or notebook change', async () => {
  let images: Record<string, string | null> = {};
  function Probe({ references, generation = 1, notebook = '/notebook' }: {
    references: TableImageReference[]; generation?: number; notebook?: string;
  }) {
    images = useTableImages(references, notebook, generation);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  const first = [{ key: 'a', path: 'a.png' }];
  const appended = [...first, { key: 'b', path: 'b.png' }];
  try {
    await act(async () => root.render(<StrictMode><Probe references={first} /></StrictMode>));
    expect(files.readImage).toHaveBeenCalledTimes(1);
    expect(images.a).toBe('url:/notebook/a.png');
    await act(async () => root.render(<StrictMode><Probe references={appended} /></StrictMode>));
    expect(files.readImage).toHaveBeenCalledTimes(2);
    expect(images.b).toBe('url:/notebook/b.png');
    await act(async () => root.render(<StrictMode><Probe references={first} generation={2} /></StrictMode>));
    expect(files.readImage).toHaveBeenCalledTimes(3);
    await act(async () => root.render(<StrictMode><Probe references={first} generation={2} notebook="/other" /></StrictMode>));
    expect(images.a).toBe('url:/other/a.png');
    expect(files.readImage).toHaveBeenCalledTimes(4);
  } finally { act(() => root.unmount()); }
});
